import { DEFAULT_CHUNKING, mergeCandidates, planChunks } from "./chunking.js";

const MIN = 60_000;

describe("planChunks", () => {
  it("returns a single chunk when the audio fits in one", () => {
    expect(planChunks(15 * MIN)).toEqual([{ index: 0, startMs: 0, endMs: 15 * MIN }]);
    expect(planChunks(20 * MIN)).toEqual([{ index: 0, startMs: 0, endMs: 20 * MIN }]);
  });

  it("overlaps neighbouring chunks by overlapMs on both sides, clamped to the file", () => {
    expect(planChunks(45 * MIN + 17_000)).toEqual([
      { index: 0, startMs: 0, endMs: 20 * MIN + 30_000 },
      { index: 1, startMs: 20 * MIN - 30_000, endMs: 40 * MIN + 30_000 },
      { index: 2, startMs: 40 * MIN - 30_000, endMs: 45 * MIN + 17_000 },
    ]);
  });

  it("honours custom options", () => {
    expect(planChunks(10_000, { chunkMs: 4_000, overlapMs: 1_000 })).toEqual([
      { index: 0, startMs: 0, endMs: 5_000 },
      { index: 1, startMs: 3_000, endMs: 9_000 },
      { index: 2, startMs: 7_000, endMs: 10_000 },
    ]);
  });

  it("rejects non-positive durations", () => {
    expect(() => planChunks(0)).toThrow();
  });

  it("exposes the spec defaults", () => {
    expect(DEFAULT_CHUNKING).toEqual({ chunkMs: 20 * MIN, overlapMs: 30_000 });
  });
});

describe("mergeCandidates", () => {
  const take = (startMs: number, endMs: number, type: "PERFORMANCE" | "PARTIAL_PRACTICE" = "PERFORMANCE", confidence = 0.9) => ({ startMs, endMs, type, confidence });

  it("merges overlapping and touching candidates into one", () => {
    expect(mergeCandidates([take(0, 100_000), take(90_000, 200_000), take(200_000, 260_000)])).toEqual([take(0, 260_000)]);
  });

  it("keeps separated candidates apart and sorts by start", () => {
    expect(mergeCandidates([take(300_000, 400_000), take(0, 100_000)])).toEqual([take(0, 100_000), take(300_000, 400_000)]);
  });

  it("prefers PERFORMANCE and the max confidence when merging", () => {
    expect(mergeCandidates([take(0, 60_000, "PARTIAL_PRACTICE", 0.4), take(50_000, 120_000, "PERFORMANCE", 0.7)])).toEqual([take(0, 120_000, "PERFORMANCE", 0.7)]);
  });

  it("drops candidates shorter than minDurationMs after merging", () => {
    expect(mergeCandidates([take(0, 15_000), take(100_000, 130_000)])).toEqual([take(100_000, 130_000)]);
    expect(mergeCandidates([take(0, 15_000), take(14_000, 25_000)])).toEqual([take(0, 25_000)]);
  });

  it("returns an empty list for no candidates", () => {
    expect(mergeCandidates([])).toEqual([]);
  });
});
