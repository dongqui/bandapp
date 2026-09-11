import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../db/db.module.js";
import type { StorageService } from "../storage/storage.service.js";
import type { FfmpegRunner } from "./ffmpeg.js";
import { encodePeaksFile } from "./peaks.js";
import { TakeRecutService } from "./take-recut.service.js";

const MIN = 60_000;
const OLD_KEY = "bands/b/sessions/s/takes/t.m4a";
const PEAKS_KEY = "bands/b/sessions/s/peaks.bin";

/** 서비스가 쓰는 drizzle 표면만 흉내 낸다. update는 where의 version 조건 대신 opts.updateReturnsRows로 결과를 흉내 낸다 */
function fakeDb(take: { version: number; startMs: number; endMs: number; objectKey: string } | undefined, opts: { peaksKey?: string | null; updateReturnsRows?: boolean } = {}) {
  const state = { updates: [] as Array<Record<string, unknown>> };
  const db = {
    query: {
      takes: { findFirst: async () => (take ? { id: "t", sessionId: "s", ...take } : undefined) },
      sessions: { findFirst: async () => ({ id: "s", bandId: "b", peaksKey: opts.peaksKey ?? null }) },
      recordings: { findFirst: async () => ({ objectKey: "bands/b/sessions/s/original.m4a" }) },
    },
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            state.updates.push(v);
            return opts.updateReturnsRows === false ? [] : [{ id: "t" }];
          },
        }),
      }),
    }),
  };
  return { db: db as unknown as Db, state };
}

/** 10분 지점에서 0→255로 뛰는 계단 사이드카 — 슬라이스가 실제 startMs/endMs를 쓰는지 본다 */
function fakeStorage(opts: { failCutPut?: boolean } = {}) {
  const calls = { downloads: [] as string[], puts: [] as string[], deleted: [] as string[] };
  const storage = {
    downloadToFile: async (key: string, path: string) => {
      calls.downloads.push(key);
      if (key.endsWith("peaks.bin")) {
        const hires = Uint8Array.from({ length: 30 * 60 * 50 }, (_, i) => (i < 10 * 60 * 50 ? 0 : 255));
        writeFileSync(path, encodePeaksFile(hires, 50));
      }
    },
    putFile: async (key: string) => {
      if (opts.failCutPut) throw new Error("r2 down");
      calls.puts.push(key);
    },
    deleteObjects: async (keys: string[]) => {
      calls.deleted.push(...keys);
    },
  } as unknown as StorageService;
  return { storage, calls };
}

function fakeFfmpeg() {
  const cuts: Array<{ startMs: number; endMs: number; output: string }> = [];
  const ffmpeg: FfmpegRunner = {
    probeDurationMs: async () => 0,
    cut: async (_i, startMs, endMs, output) => {
      cuts.push({ startMs, endMs, output });
      writeFileSync(output, "fake m4a");
    },
    peaks: async () => new Uint8Array(0),
  };
  return { ffmpeg, cuts };
}

describe("TakeRecutService.run", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "recut-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("cuts to a new versioned key, slices peaks from the sidecar, marks ready and deletes the old key", async () => {
    const { db, state } = fakeDb({ version: 2, startMs: 12 * MIN, endMs: 15 * MIN, objectKey: OLD_KEY }, { peaksKey: PEAKS_KEY });
    const { storage, calls } = fakeStorage();
    const { ffmpeg, cuts } = fakeFfmpeg();
    await new TakeRecutService(db, storage, ffmpeg, tmp).run("t", 2);
    expect(calls.downloads).toEqual(["bands/b/sessions/s/original.m4a", PEAKS_KEY]);
    expect(cuts[0]).toMatchObject({ startMs: 12 * MIN, endMs: 15 * MIN });
    expect(calls.puts).toEqual(["bands/b/sessions/s/takes/t-v2.m4a"]);
    const done = state.updates.at(-1)!;
    expect(done).toMatchObject({ objectKey: "bands/b/sessions/s/takes/t-v2.m4a", audioStatus: "ready", audioError: null });
    const peaks = done.peaks as number[];
    expect(peaks).toHaveLength(128);
    expect(peaks.every((p) => p === 255)).toBe(true); // 12~15분은 계단 이후
    expect(calls.deleted).toEqual([OLD_KEY]);
    expect(existsSync(join(tmp))).toBe(true); // 임시 디렉터리 자체는 남지만 작업 폴더는 지워진다
  });

  it("stores null peaks when the session has no sidecar", async () => {
    const { db, state } = fakeDb({ version: 1, startMs: 0, endMs: MIN, objectKey: OLD_KEY }, { peaksKey: null });
    const { storage, calls } = fakeStorage();
    await new TakeRecutService(db, storage, fakeFfmpeg().ffmpeg, tmp).run("t", 1);
    expect(calls.downloads).toEqual(["bands/b/sessions/s/original.m4a"]);
    expect(state.updates.at(-1)).toMatchObject({ audioStatus: "ready", peaks: null });
  });

  it("skips a stale job whose version no longer matches", async () => {
    const { db, state } = fakeDb({ version: 3, startMs: 0, endMs: MIN, objectKey: OLD_KEY });
    const { storage, calls } = fakeStorage();
    await new TakeRecutService(db, storage, fakeFfmpeg().ffmpeg, tmp).run("t", 2);
    expect(calls.downloads).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  it("marks the take failed with the error when the cut upload fails", async () => {
    const { db, state } = fakeDb({ version: 1, startMs: 0, endMs: MIN, objectKey: OLD_KEY });
    const { storage, calls } = fakeStorage({ failCutPut: true });
    await new TakeRecutService(db, storage, fakeFfmpeg().ffmpeg, tmp).run("t", 1);
    expect(state.updates.at(-1)).toMatchObject({ audioStatus: "failed", audioError: "r2 down" });
    expect(calls.deleted).toEqual([]);
  });

  it("deletes the freshly uploaded object when a newer edit won the race", async () => {
    const { db } = fakeDb({ version: 1, startMs: 0, endMs: MIN, objectKey: OLD_KEY }, { updateReturnsRows: false });
    const { storage, calls } = fakeStorage();
    await new TakeRecutService(db, storage, fakeFfmpeg().ffmpeg, tmp).run("t", 1);
    expect(calls.deleted).toEqual(["bands/b/sessions/s/takes/t-v1.m4a"]);
  });

  it("does nothing when the take was deleted meanwhile", async () => {
    const { db, state } = fakeDb(undefined);
    const { storage, calls } = fakeStorage();
    await new TakeRecutService(db, storage, fakeFfmpeg().ffmpeg, tmp).run("t", 1);
    expect(calls.downloads).toEqual([]);
    expect(state.updates).toEqual([]);
  });
});
