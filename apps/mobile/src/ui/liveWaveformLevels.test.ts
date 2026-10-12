import { describe, expect, it } from "vitest";
import { fitLevels } from "./liveWaveformLevels";

describe("fitLevels", () => {
  it("짧으면 왼쪽을 0으로 채운다 (최근이 오른쪽)", () => {
    expect(fitLevels([0.5, 1], 4)).toEqual([0, 0, 0.5, 1]);
  });
  it("길면 뒤에서 bars개만 쓴다", () => {
    expect(fitLevels([0.1, 0.2, 0.3, 0.4], 2)).toEqual([0.3, 0.4]);
  });
  it("비어 있으면 전부 0 (PREPARING 평평)", () => {
    expect(fitLevels([], 3)).toEqual([0, 0, 0]);
  });
  it("길이가 같으면 그대로", () => {
    expect(fitLevels([0.2, 0.4], 2)).toEqual([0.2, 0.4]);
  });
});
