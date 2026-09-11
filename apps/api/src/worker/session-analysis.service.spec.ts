import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TakeCandidate } from "@bandapp/types";
import type { GeminiService } from "../analysis/gemini.service.js";
import type { Db } from "../db/db.module.js";
import type { StorageService } from "../storage/storage.service.js";
import type { FfmpegRunner } from "./ffmpeg.js";
import { SessionAnalysisService } from "./session-analysis.service.js";

const MIN = 60_000;

/**
 * drizzle 대신 이 서비스가 쓰는 최소 표면만 흉내 낸다.
 * `staleOnReady`는 중복 전달 경합 테스트용 — true면 마무리 트랜잭션의 ready 갱신이 0행을 반환해서
 * (다른 워커가 먼저 세션을 처리한 상황을 흉내 냄) 서비스가 트랜잭션을 롤백해야 한다.
 */
function fakeDb(
  session: { id: string; bandId: string; status: string } | undefined,
  recording = { objectKey: "bands/b/sessions/s/original.m4a" },
  opts: { staleOnReady?: boolean } = {},
) {
  const state = {
    session,
    updates: [] as Array<Record<string, unknown>>,
    insertedTakes: [] as Array<Record<string, unknown>>,
    deletedTakes: 0,
    existingTakes: [{ objectKey: "bands/b/sessions/s/takes/old.m4a" }],
    // and(eq(id,...), eq(status,"analyzing")) 가드가 실제로 걸렸는지만 센다 — SQL 조건 자체는 검사하지 않는다.
    guardedWhereCalls: 0,
  };

  function mutators(pushInsert: (rows: Record<string, unknown>[]) => void) {
    return {
      update: () => ({
        set: (v: Record<string, unknown>) => ({
          where: (_cond: unknown) => {
            state.updates.push(v);
            state.guardedWhereCalls += 1;
            return {
              // drizzle의 QueryPromise는 .returning() 없이 await해도 동작한다 — thenable로 흉내 낸다.
              then: (resolve: (v: undefined) => void) => resolve(undefined),
              returning: async () => (v.status === "ready" && opts.staleOnReady ? [] : [{ id: session?.id }]),
            };
          },
        }),
      }),
      delete: () => ({ where: async () => { state.deletedTakes += 1; } }),
      insert: () => ({ values: async (rows: Record<string, unknown>[]) => { pushInsert(rows); } }),
    };
  }

  const db = {
    query: {
      sessions: { findFirst: async () => state.session },
      recordings: { findFirst: async () => recording },
      takes: { findMany: async () => state.existingTakes },
    },
    ...mutators((rows) => state.insertedTakes.push(...rows)),
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      // 트랜잭션 안에서의 insert는 버퍼에 쌓아 두고, fn이 성공했을 때만 state에 커밋한다 — throw하면
      // 버려져서 실제 롤백을 흉내 낸다.
      const buffered: Record<string, unknown>[] = [];
      const tx = mutators((rows) => buffered.push(...rows));
      await fn(tx);
      state.insertedTakes.push(...buffered);
    },
  };
  return { db: db as unknown as Db, state };
}

function fakeStorage(orphanKeys: string[] = ["bands/b/sessions/s/takes/orphan.m4a"], opts: { failPutKeys?: string[] } = {}) {
  const calls = {
    downloads: [] as string[],
    puts: [] as string[],
    putTypes: [] as string[],
    // 사이드카는 워커가 실제로 파일을 쓰므로 업로드 시점의 본문을 남겨 헤더를 검증한다. take 컷은 가짜 ffmpeg가 파일을 안 만든다.
    putBodies: new Map<string, Buffer>(),
    deleted: [] as string[],
    listedPrefixes: [] as string[],
  };
  const storage = {
    downloadToFile: async (key: string) => { calls.downloads.push(key); },
    putFile: async (key: string, path: string, contentType: string) => {
      if (opts.failPutKeys?.includes(key)) throw new Error(`put failed: ${key}`);
      calls.puts.push(key);
      calls.putTypes.push(contentType);
      if (existsSync(path)) calls.putBodies.set(key, readFileSync(path));
    },
    deleteObjects: async (keys: string[]) => { calls.deleted.push(...keys); },
    listKeys: async (prefix: string) => { calls.listedPrefixes.push(prefix); return orphanKeys; },
  } as unknown as StorageService;
  return { storage, calls };
}

/**
 * 가짜 ffmpeg. peaks는 10분 지점에서 0→255로 뛰는 계단 함수를 돌려준다 — 램프(i % 256)로는 어떤
 * 구간을 슬라이스해도 값이 나오니 per-take 슬라이싱이 실제로 startMs/endMs를 쓰는지 구분이 안 됐다.
 * 계단이면 앞쪽 구간만 자른 take는 전부 0, 뒤쪽 구간만 자른 take는 전부 255여야 해서 증명이 된다.
 * peaksError를 주면 피크 추출만 실패한다 (컷·probe는 정상).
 */
function fakeFfmpeg(durationMs: number, peaksError?: Error) {
  const cuts: Array<{ startMs: number; endMs: number }> = [];
  const peaksCalls: number[] = [];
  const ffmpeg: FfmpegRunner = {
    probeDurationMs: async () => durationMs,
    cut: async (_i, startMs, endMs) => { cuts.push({ startMs, endMs }); },
    peaks: async (_i, peaksPerSec) => {
      peaksCalls.push(peaksPerSec);
      if (peaksError) throw peaksError;
      const length = Math.ceil((durationMs / 1000) * peaksPerSec);
      const stepAt = 10 * 60 * peaksPerSec;
      return Uint8Array.from({ length }, (_, i) => (i < stepAt ? 0 : 255));
    },
  };
  return { ffmpeg, cuts, peaksCalls };
}

describe("SessionAnalysisService.run", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "bandapp-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("downloads, chunks, analyzes, merges, cuts takes, uploads them, and marks the session ready", async () => {
    const { db, state } = fakeDb({ id: "s", bandId: "b", status: "analyzing" });
    const { storage, calls } = fakeStorage();
    const { ffmpeg, cuts, peaksCalls } = fakeFfmpeg(45 * MIN);
    // 청크 0: 0..20:30, 청크 1: 19:30..40:30, 청크 2: 39:30..45:00
    const perChunk: TakeCandidate[][] = [
      [{ startMs: 1 * MIN, endMs: 5 * MIN, type: "PERFORMANCE", confidence: 0.9 }, { startMs: 19 * MIN, endMs: 20 * MIN + 30_000, type: "PERFORMANCE", confidence: 0.8 }],
      [{ startMs: 0, endMs: 2 * MIN, type: "PERFORMANCE", confidence: 0.85 }, { startMs: 10 * MIN, endMs: 10 * MIN + 10_000, type: "PARTIAL_PRACTICE", confidence: 0.5 }],
      [],
    ];
    const analyzeFile = vi.fn().mockImplementation(async () => perChunk.shift() ?? []);
    const gemini = { analyzeFile } as unknown as GeminiService;

    await new SessionAnalysisService(db, storage, gemini, ffmpeg, tmp, 0).run("s");

    expect(calls.downloads).toEqual(["bands/b/sessions/s/original.m4a"]);
    // DB 행이 있는 take(old.m4a)와, R2에만 남아있던 고아 객체(orphan.m4a, listKeys가 돌려줌) 둘 다 지운다.
    expect(calls.deleted).toEqual(["bands/b/sessions/s/takes/old.m4a", "bands/b/sessions/s/takes/orphan.m4a"]);
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
    // 사이드카가 먼저(컷 루프 앞), 그 뒤 take 2개
    expect(calls.puts).toHaveLength(3);
    expect(calls.puts[0]).toBe("bands/b/sessions/s/peaks.bin");
    expect(calls.putTypes[0]).toBe("application/octet-stream");
    const sidecar = calls.putBodies.get("bands/b/sessions/s/peaks.bin")!;
    expect(sidecar.subarray(0, 4).toString("ascii")).toBe("TNPK");
    expect(sidecar.readUInt16LE(5)).toBe(50);
    expect(sidecar.length).toBe(8 + Math.ceil((45 * MIN) / 1000) * 50);
    expect(calls.puts[1]).toMatch(/^bands\/b\/sessions\/s\/takes\/.+\.m4a$/);
    expect(state.updates.at(-1)).toMatchObject({ status: "ready", takeCount: 2, durationMs: 45 * MIN, peaksKey: "bands/b/sessions/s/peaks.bin" });
    // take 행과 세션 update 모두 128버킷 피크를 싣는다 — 원본을 한 번만 디코드한다
    expect(peaksCalls).toEqual([50]);
    for (const t of state.insertedTakes) {
      const peaks = t.peaks as number[];
      expect(peaks).toHaveLength(128);
      expect(peaks.every((p) => Number.isInteger(p) && p >= 0 && p <= 255)).toBe(true);
    }
    // 계단(10분 지점에서 0→255)을 실제로 startMs/endMs로 슬라이스했는지 증명한다.
    // Take 1(1:00~5:00)은 10분 이전이라 전부 무음(0)이고, Take 2(19:00~21:30)는 10분 이후라 전부 255다.
    const [t0, t1] = state.insertedTakes as Array<{ peaks: number[] }>;
    expect(t0!.peaks).toEqual(Array.from({ length: 128 }, () => 0));
    expect(t1!.peaks.every((p) => p === 255)).toBe(true);
    const sessionPeaks = state.updates.at(-1)!.peaks as number[];
    expect(sessionPeaks).toHaveLength(128);
    expect(sessionPeaks[0]).toBe(0);
    expect(sessionPeaks[127]).toBe(255);
  });

  it("retries a chunk once and succeeds", async () => {
    const { db, state } = fakeDb({ id: "s", bandId: "b", status: "analyzing" });
    const { storage } = fakeStorage();
    const { ffmpeg } = fakeFfmpeg(5 * MIN);
    const analyzeFile = vi.fn().mockRejectedValueOnce(new Error("503")).mockResolvedValueOnce([]);
    await new SessionAnalysisService(db, storage, { analyzeFile } as unknown as GeminiService, ffmpeg, tmp, 0).run("s");
    expect(analyzeFile).toHaveBeenCalledTimes(2);
    expect(state.updates.at(-1)).toMatchObject({ status: "ready", takeCount: 0 });
  });

  it("stores null peaks and still marks the session ready when peak extraction fails", async () => {
    const { db, state } = fakeDb({ id: "s", bandId: "b", status: "analyzing" });
    const { storage, calls } = fakeStorage();
    const { ffmpeg } = fakeFfmpeg(5 * MIN, new Error("ffmpeg peaks failed"));
    const analyzeFile = vi.fn().mockResolvedValue([{ startMs: 0, endMs: 30_000, type: "PERFORMANCE", confidence: 0.9 }]);
    await new SessionAnalysisService(db, storage, { analyzeFile } as unknown as GeminiService, ffmpeg, tmp, 0).run("s");
    expect(state.insertedTakes).toHaveLength(1);
    expect(state.insertedTakes[0]!.peaks).toBeNull();
    expect(state.updates.at(-1)).toMatchObject({ status: "ready", takeCount: 1, peaks: null, peaksKey: null });
    expect(calls.puts.some((k) => k.endsWith("peaks.bin"))).toBe(false);
  });

  it("keeps 128-bucket peaks and ready but stores a null key when the sidecar upload fails", async () => {
    const { db, state } = fakeDb({ id: "s", bandId: "b", status: "analyzing" });
    const { storage, calls } = fakeStorage(undefined, { failPutKeys: ["bands/b/sessions/s/peaks.bin"] });
    const { ffmpeg } = fakeFfmpeg(5 * MIN);
    const analyzeFile = vi.fn().mockResolvedValue([{ startMs: 0, endMs: 2 * MIN, type: "PERFORMANCE", confidence: 0.9 }]);
    await new SessionAnalysisService(db, storage, { analyzeFile } as unknown as GeminiService, ffmpeg, tmp, 0).run("s");
    expect(state.updates.at(-1)).toMatchObject({ status: "ready", takeCount: 1, peaksKey: null });
    expect(state.updates.at(-1)!.peaks as number[]).toHaveLength(128);
    expect(calls.puts).toHaveLength(1); // take 컷만
  });

  it("does not decode peaks when Gemini fails", async () => {
    const { db } = fakeDb({ id: "s", bandId: "b", status: "analyzing" });
    const { storage } = fakeStorage();
    const { ffmpeg, peaksCalls } = fakeFfmpeg(5 * MIN);
    const analyzeFile = vi.fn().mockRejectedValue(new Error("gemini down"));
    await new SessionAnalysisService(db, storage, { analyzeFile } as unknown as GeminiService, ffmpeg, tmp, 0).run("s");
    expect(peaksCalls).toEqual([]);
  });

  it("marks the session failed with the error when a chunk fails twice", async () => {
    const { db, state } = fakeDb({ id: "s", bandId: "b", status: "analyzing" });
    const { storage } = fakeStorage();
    const { ffmpeg } = fakeFfmpeg(5 * MIN);
    const analyzeFile = vi.fn().mockRejectedValue(new Error("gemini down"));
    await new SessionAnalysisService(db, storage, { analyzeFile } as unknown as GeminiService, ffmpeg, tmp, 0).run("s");
    expect(analyzeFile).toHaveBeenCalledTimes(2);
    expect(state.updates.at(-1)).toMatchObject({ status: "failed", analysisError: expect.stringContaining("gemini down") });
  });

  it("ignores sessions that are not analyzing", async () => {
    const { db, state } = fakeDb({ id: "s", bandId: "b", status: "ready" });
    const { storage, calls } = fakeStorage();
    const analyzeFile = vi.fn();
    await new SessionAnalysisService(db, storage, { analyzeFile } as unknown as GeminiService, fakeFfmpeg(MIN).ffmpeg, tmp, 0).run("s");
    expect(calls.downloads).toEqual([]);
    expect(analyzeFile).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });

  it("ignores unknown sessions", async () => {
    const { db } = fakeDb(undefined);
    const { storage, calls } = fakeStorage();
    await new SessionAnalysisService(db, storage, { analyzeFile: vi.fn() } as unknown as GeminiService, fakeFfmpeg(MIN).ffmpeg, tmp, 0).run("nope");
    expect(calls.downloads).toEqual([]);
  });

  it("also deletes take objects orphaned in R2 with no DB row (a previous run that died before its transaction committed)", async () => {
    const { db, state } = fakeDb({ id: "s", bandId: "b", status: "analyzing" });
    state.existingTakes = []; // 이전 실행이 DB 행 없이 R2 객체만 남긴 상황
    const { storage, calls } = fakeStorage(["bands/b/sessions/s/takes/orphan.m4a"]);
    const { ffmpeg } = fakeFfmpeg(MIN);
    const analyzeFile = vi.fn().mockResolvedValue([]);
    await new SessionAnalysisService(db, storage, { analyzeFile } as unknown as GeminiService, ffmpeg, tmp, 0).run("s");
    expect(calls.listedPrefixes).toEqual(["bands/b/sessions/s/takes/"]);
    expect(calls.deleted).toEqual(["bands/b/sessions/s/takes/orphan.m4a"]);
    expect(state.deletedTakes).toBe(0); // DB 행이 없었으니 delete(takes)는 호출되지 않는다
  });

  it("does not clobber a session a duplicate delivery already resolved, and rolls back the take insert", async () => {
    const { db, state } = fakeDb({ id: "s", bandId: "b", status: "analyzing" }, undefined, { staleOnReady: true });
    const { storage } = fakeStorage();
    const { ffmpeg } = fakeFfmpeg(5 * MIN);
    const analyzeFile = vi.fn().mockResolvedValue([{ startMs: 0, endMs: 30_000, type: "PERFORMANCE", confidence: 0.9 }]);
    await new SessionAnalysisService(db, storage, { analyzeFile } as unknown as GeminiService, ffmpeg, tmp, 0).run("s");
    // 마무리 갱신이 analyzing 가드에 걸려 0행을 반환했으니 트랜잭션이 롤백되고, take는 커밋되지 않는다.
    expect(state.insertedTakes).toEqual([]);
    // "더 이상 내 세션이 아니다"라는 신호라 fail()로 덮어쓰지 않는다.
    expect(state.updates.some((u) => u.status === "failed")).toBe(false);
  });
});
