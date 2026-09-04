import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TakeCandidate } from "@bandapp/types";
import type { GeminiService } from "../analysis/gemini.service.js";
import type { Db } from "../db/db.module.js";
import type { StorageService } from "../storage/storage.service.js";
import type { FfmpegRunner } from "./ffmpeg.js";
import { SessionAnalysisService } from "./session-analysis.service.js";

const MIN = 60_000;

/** drizzle 대신 이 서비스가 쓰는 최소 표면만 흉내 낸다. */
function fakeDb(session: { id: string; bandId: string; status: string } | undefined, recording = { objectKey: "bands/b/sessions/s/original.m4a" }) {
  const state = {
    session,
    updates: [] as Array<Record<string, unknown>>,
    insertedTakes: [] as Array<Record<string, unknown>>,
    deletedTakes: 0,
    existingTakes: [{ objectKey: "bands/b/sessions/s/takes/old.m4a" }],
  };
  const db = {
    query: {
      sessions: { findFirst: async () => state.session },
      recordings: { findFirst: async () => recording },
      takes: { findMany: async () => state.existingTakes },
    },
    update: () => ({ set: (v: Record<string, unknown>) => ({ where: async () => { state.updates.push(v); } }) }),
    delete: () => ({ where: async () => { state.deletedTakes += 1; } }),
    insert: () => ({ values: async (rows: Record<string, unknown>[]) => { state.insertedTakes.push(...rows); } }),
    transaction: async (fn: (tx: unknown) => Promise<void>) => fn(db),
  };
  return { db: db as unknown as Db, state };
}

function fakeStorage() {
  const calls = { downloads: [] as string[], puts: [] as string[], deleted: [] as string[] };
  const storage = {
    downloadToFile: async (key: string) => { calls.downloads.push(key); },
    putFile: async (key: string) => { calls.puts.push(key); },
    deleteObjects: async (keys: string[]) => { calls.deleted.push(...keys); },
  } as unknown as StorageService;
  return { storage, calls };
}

function fakeFfmpeg(durationMs: number) {
  const cuts: Array<{ startMs: number; endMs: number }> = [];
  const ffmpeg: FfmpegRunner = {
    probeDurationMs: async () => durationMs,
    cut: async (_i, startMs, endMs) => { cuts.push({ startMs, endMs }); },
  };
  return { ffmpeg, cuts };
}

describe("SessionAnalysisService.run", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "bandapp-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("downloads, chunks, analyzes, merges, cuts takes, uploads them, and marks the session ready", async () => {
    const { db, state } = fakeDb({ id: "s", bandId: "b", status: "analyzing" });
    const { storage, calls } = fakeStorage();
    const { ffmpeg, cuts } = fakeFfmpeg(45 * MIN);
    // 청크 0: 0..20:30, 청크 1: 19:30..40:30, 청크 2: 39:30..45:00
    const perChunk: TakeCandidate[][] = [
      [{ startMs: 1 * MIN, endMs: 5 * MIN, type: "PERFORMANCE", confidence: 0.9 }, { startMs: 19 * MIN, endMs: 20 * MIN + 30_000, type: "PERFORMANCE", confidence: 0.8 }],
      [{ startMs: 0, endMs: 2 * MIN, type: "PERFORMANCE", confidence: 0.85 }, { startMs: 10 * MIN, endMs: 10 * MIN + 10_000, type: "PARTIAL_PRACTICE", confidence: 0.5 }],
      [],
    ];
    const analyzeFile = vi.fn().mockImplementation(async () => perChunk.shift() ?? []);
    const gemini = { analyzeFile } as unknown as GeminiService;

    await new SessionAnalysisService(db, storage, gemini, ffmpeg, tmp).run("s");

    expect(calls.downloads).toEqual(["bands/b/sessions/s/original.m4a"]);
    expect(calls.deleted).toEqual(["bands/b/sessions/s/takes/old.m4a"]);
    expect(state.deletedTakes).toBe(1);
    expect(analyzeFile).toHaveBeenCalledTimes(3);
    // 청크 절단 3회 + take 절단 2회
    expect(cuts.slice(0, 3)).toEqual([
      { startMs: 0, endMs: 20 * MIN + 30_000 },
      { startMs: 20 * MIN - 30_000, endMs: 40 * MIN + 30_000 },
      { startMs: 40 * MIN - 30_000, endMs: 45 * MIN },
    ]);
    // 청크 1의 [0, 2분]은 오프셋 19:30을 더해 [19:30, 21:30]이 되고 청크 0의 [19:00, 20:30]과 겹쳐 하나로 합쳐진다.
    // 청크 1의 10초짜리 PARTIAL_PRACTICE는 최소 길이 미만이라 버려진다.
    expect(state.insertedTakes.map((t) => [t.index, t.name, t.startMs, t.endMs, t.type])).toEqual([
      [0, "Take 1", 1 * MIN, 5 * MIN, "PERFORMANCE"],
      [1, "Take 2", 19 * MIN, 21 * MIN + 30_000, "PERFORMANCE"],
    ]);
    expect(cuts.slice(3)).toEqual([
      { startMs: 1 * MIN, endMs: 5 * MIN },
      { startMs: 19 * MIN, endMs: 21 * MIN + 30_000 },
    ]);
    expect(calls.puts).toHaveLength(2);
    expect(calls.puts[0]).toMatch(/^bands\/b\/sessions\/s\/takes\/.+\.m4a$/);
    expect(state.updates.at(-1)).toMatchObject({ status: "ready", takeCount: 2, durationMs: 45 * MIN });
  });

  it("retries a chunk once and succeeds", async () => {
    const { db, state } = fakeDb({ id: "s", bandId: "b", status: "analyzing" });
    const { storage } = fakeStorage();
    const { ffmpeg } = fakeFfmpeg(5 * MIN);
    const analyzeFile = vi.fn().mockRejectedValueOnce(new Error("503")).mockResolvedValueOnce([]);
    await new SessionAnalysisService(db, storage, { analyzeFile } as unknown as GeminiService, ffmpeg, tmp).run("s");
    expect(analyzeFile).toHaveBeenCalledTimes(2);
    expect(state.updates.at(-1)).toMatchObject({ status: "ready", takeCount: 0 });
  });

  it("marks the session failed with the error when a chunk fails twice", async () => {
    const { db, state } = fakeDb({ id: "s", bandId: "b", status: "analyzing" });
    const { storage } = fakeStorage();
    const { ffmpeg } = fakeFfmpeg(5 * MIN);
    const analyzeFile = vi.fn().mockRejectedValue(new Error("gemini down"));
    await new SessionAnalysisService(db, storage, { analyzeFile } as unknown as GeminiService, ffmpeg, tmp).run("s");
    expect(analyzeFile).toHaveBeenCalledTimes(2);
    expect(state.updates.at(-1)).toMatchObject({ status: "failed", analysisError: expect.stringContaining("gemini down") });
  });

  it("ignores sessions that are not analyzing", async () => {
    const { db, state } = fakeDb({ id: "s", bandId: "b", status: "ready" });
    const { storage, calls } = fakeStorage();
    const analyzeFile = vi.fn();
    await new SessionAnalysisService(db, storage, { analyzeFile } as unknown as GeminiService, fakeFfmpeg(MIN).ffmpeg, tmp).run("s");
    expect(calls.downloads).toEqual([]);
    expect(analyzeFile).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });

  it("ignores unknown sessions", async () => {
    const { db } = fakeDb(undefined);
    const { storage, calls } = fakeStorage();
    await new SessionAnalysisService(db, storage, { analyzeFile: vi.fn() } as unknown as GeminiService, fakeFfmpeg(MIN).ffmpeg, tmp).run("nope");
    expect(calls.downloads).toEqual([]);
  });
});
