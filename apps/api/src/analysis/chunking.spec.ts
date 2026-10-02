import { DEFAULT_CHUNKING, DEFAULT_PAD, mergeCandidates, padCandidates, planChunks } from "./chunking.js";

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

describe("padCandidates", () => {
  const take = (startMs: number, endMs: number, type: "PERFORMANCE" | "PARTIAL_PRACTICE" = "PERFORMANCE", confidence = 0.9) => ({ startMs, endMs, type, confidence });

  it("widens every take by padMs on both sides", () => {
    expect(padCandidates([take(60_000, 120_000)], 10 * MIN)).toEqual([take(55_000, 125_000)]);
  });

  it("exposes a 5 second default", () => {
    expect(DEFAULT_PAD).toEqual({ padMs: 5_000 });
  });

  it("clamps to the start and end of the recording", () => {
    expect(padCandidates([take(2_000, 30_000), take(60_000, 118_000)], 120_000)).toEqual([take(0, 35_000), take(55_000, 120_000)]);
  });

  it("never lets neighbouring takes overlap — a short gap is split in the middle", () => {
    // 4초 간격: 양쪽 5초씩 넓히면 겹치므로 가운데(2초씩)에서 멈춘다
    expect(padCandidates([take(60_000, 120_000), take(124_000, 180_000)], 10 * MIN)).toEqual([take(55_000, 122_000), take(122_000, 185_000)]);
    // 10초 간격: 정확히 5초씩 넓혀 맞닿는다
    expect(padCandidates([take(60_000, 120_000), take(130_000, 180_000)], 10 * MIN)).toEqual([take(55_000, 125_000), take(125_000, 185_000)]);
  });

  it("keeps type and confidence, sorts by start, and honours custom padMs", () => {
    expect(padCandidates([take(300_000, 400_000, "PARTIAL_PRACTICE", 0.4), take(0, 100_000)], 10 * MIN, { padMs: 1_000 })).toEqual([
      take(0, 101_000),
      take(299_000, 401_000, "PARTIAL_PRACTICE", 0.4),
    ]);
  });

  it("returns an empty list for no candidates", () => {
    expect(padCandidates([], 10 * MIN)).toEqual([]);
  });
});
