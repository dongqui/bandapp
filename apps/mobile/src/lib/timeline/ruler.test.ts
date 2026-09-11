import { describe, expect, it } from "vitest";
import { MAX_TICKS, rulerTicks, tickStepMs } from "./ruler";

describe("tickStepMs", () => {
  it("화면에 눈금이 6개 이하로 들어오는 첫 단계 (디자인 사다리)", () => {
    expect(tickStepMs(5_000)).toBe(1_000); // 5초 창 → 1s 눈금 5개
    expect(tickStepMs(60_000)).toBe(10_000); // 1분 창 → 10s
    expect(tickStepMs(40_000)).toBe(10_000);
    expect(tickStepMs(3 * 3_600_000)).toBe(1_800_000); // 3시간 → 30분
  });
  it("사다리 끝을 넘으면 마지막 단계", () => {
    expect(tickStepMs(1e12)).toBe(7_200_000);
  });
});

describe("rulerTicks", () => {
  it("viewport 안의 step 배수마다 x와 라벨", () => {
    const ticks = rulerTicks({ startMs: 62_000, msPerPx: 100, widthPx: 400 }); // 62s~102s, step 10s
    expect(ticks.map((t) => t.ms)).toEqual([70_000, 80_000, 90_000, 100_000]);
    expect(ticks[0]!.xPx).toBe(80);
    expect(ticks.map((t) => t.label)).toEqual(["01:10", "01:20", "01:30", "01:40"]);
  });
  it("1시간 이상은 h:mm:ss", () => {
    const ticks = rulerTicks({ startMs: 3_600_000 - 1000, msPerPx: 100, widthPx: 400 });
    expect(ticks[0]!.label).toBe("1:00:00");
  });
  it("어느 줌에서도 눈금은 MAX_TICKS + 1개 이하", () => {
    for (const msPerPx of [12.82, 100, 1000, 27_692, 55_384]) {
      expect(rulerTicks({ startMs: 12_345, msPerPx, widthPx: 390 }).length).toBeLessThanOrEqual(MAX_TICKS + 1);
    }
  });
});
