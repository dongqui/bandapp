import { describe, expect, it } from "vitest";
import { barHeight, resamplePeaks } from "./peaks";

describe("resamplePeaks", () => {
  it("창 안 max를 0~1로 돌려준다", () => {
    expect(resamplePeaks([0, 255, 51, 102], 2)).toEqual([1, 0.4]);
  });
  it("bars가 입력보다 많으면 값이 반복된다", () => {
    expect(resamplePeaks([255, 0], 4)).toEqual([1, 1, 0, 0]);
  });
  it("null·빈 배열은 전부 0 (플레이스홀더)", () => {
    expect(resamplePeaks(null, 3)).toEqual([0, 0, 0]);
    expect(resamplePeaks([], 2)).toEqual([0, 0]);
  });
  it("128개를 36·64개로 줄여도 길이가 맞다", () => {
    const peaks = Array.from({ length: 128 }, (_, i) => i * 2);
    expect(resamplePeaks(peaks, 36)).toHaveLength(36);
    expect(resamplePeaks(peaks, 64)).toHaveLength(64);
    expect(resamplePeaks(peaks, 64).at(-1)).toBe(254 / 255);
  });
});

describe("barHeight", () => {
  it("지금까지의 공식과 같다 — 12% 바닥, 88% 스케일, 최소 픽셀", () => {
    expect(barHeight(0, 26, 2)).toBe(3);
    expect(barHeight(1, 26, 2)).toBe(26);
    expect(barHeight(0, 88, 3)).toBe(11);
    expect(barHeight(0.5, 88, 3)).toBe(49);
    expect(barHeight(0, 10, 3)).toBe(3);
  });
});
