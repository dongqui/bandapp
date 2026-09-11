import { describe, expect, it } from "vitest";
import { BAR_PX, barsForViewport, bucketsToLevels, buildLevels, peaksPerBar, selectLevel } from "./levels";

describe("buildLevels", () => {
  it("512 이하가 될 때까지 2개씩 max로 접고, 전체 max를 기억한다", () => {
    const hires = Uint8Array.from({ length: 5000 }, (_, i) => i % 200);
    const p = buildLevels(hires, 50);
    expect(p.levels.map((l) => l.length)).toEqual([5000, 2500, 1250, 625, 313]);
    expect(p.max).toBe(199);
    expect(p.peaksPerSec).toBe(50);
    // 레벨 1의 0번은 hires 0·1의 max
    expect(p.levels[1]![0]).toBe(1);
    // 홀수 길이의 마지막 원소는 짝이 없어도 살아남는다
    const odd = buildLevels(Uint8Array.from([1, 2, 3]), 50);
    expect(Array.from(odd.levels[0]!)).toEqual([1, 2, 3]);
  });
  it("무음이면 max 0", () => {
    expect(buildLevels(new Uint8Array(10), 50).max).toBe(0);
  });
  it("bucketsToLevels는 레벨 하나, peaksPerSec = 버킷 수 / 길이", () => {
    const p = bucketsToLevels(Array.from({ length: 128 }, (_, i) => i * 2), 128_000);
    expect(p.levels).toHaveLength(1);
    expect(p.peaksPerSec).toBeCloseTo(1);
    expect(p.max).toBe(254);
  });
});

describe("selectLevel", () => {
  const p = buildLevels(new Uint8Array(3 * 3600 * 50), 50); // 3시간
  it("처음에는 바당 피크가 2 이하인 첫 레벨, 없으면 가장 거친 레벨", () => {
    // 전체 보기 390px: 레벨 0에서 바당 피크 수천. 가장 거친 레벨에서도 2를 넘으니 마지막 레벨
    const fullView = (3 * 3600 * 1000) / 390;
    expect(selectLevel(p, fullView, BAR_PX, -1)).toBe(p.levels.length - 1);
    // 1분 창: 첫 레벨이 2 이하가 되는 k, 그 아래 레벨은 2 초과
    const minuteView = 60_000 / 390;
    const k = selectLevel(p, minuteView, BAR_PX, -1);
    expect(k).toBeGreaterThan(0);
    expect(peaksPerBar(p, k, minuteView, BAR_PX)).toBeLessThanOrEqual(2);
    expect(peaksPerBar(p, k - 1, minuteView, BAR_PX)).toBeGreaterThan(2);
    // 5초 창: 바당 피크가 2 이하 → 레벨 0
    expect(selectLevel(p, 5000 / 390, BAR_PX, -1)).toBe(0);
  });
  it("hysteresis — 경계 근처에서 왔다 갔다 하지 않는다", () => {
    // 레벨 k에서 바당 피크가 ppb가 되는 msPerPx
    const mAt = (k: number, ppb: number) => (ppb * 1000 * 2 ** k) / (BAR_PX * 50);
    expect(selectLevel(p, mAt(2, 3.4), BAR_PX, 2)).toBe(2);
    expect(selectLevel(p, mAt(2, 3.6), BAR_PX, 2)).toBe(3);
    // 레벨 3으로 간 뒤 3.6/2 = 1.8 — 0.8보다 크니 그대로
    expect(selectLevel(p, mAt(2, 3.6), BAR_PX, 3)).toBe(3);
    expect(selectLevel(p, mAt(3, 0.79), BAR_PX, 3)).toBe(2);
    expect(selectLevel(p, mAt(3, 0.81), BAR_PX, 3)).toBe(3);
  });
  it("레벨 범위를 벗어난 current는 처음처럼 고른다", () => {
    expect(selectLevel(p, 5000 / 390, BAR_PX, 99)).toBe(0);
  });
});

describe("barsForViewport", () => {
  it("바마다 픽셀 구간에 걸친 피크의 max / 전체 max", () => {
    // 10 peaks/s = 100ms/peak. viewport 0~1s, 폭 10px, 바 1px, 100ms/px → 10바, 바당 피크 정확히 1개 (부동소수 경계 없음)
    const p = buildLevels(Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]), 10);
    const bars = barsForViewport(p, 0, { startMs: 0, msPerPx: 100, widthPx: 10 }, 1);
    expect(bars).toHaveLength(10);
    expect(bars[0]).toBeCloseTo(0.1);
    expect(bars[9]).toBeCloseTo(1);
  });
  it("범위 밖 바는 0, 무음 피라미드는 전부 0", () => {
    const p = buildLevels(Uint8Array.from([255, 255]), 10);
    const bars = barsForViewport(p, 0, { startMs: 0, msPerPx: 100, widthPx: 30 }, 3); // 0~3s, 피크는 0.2s까지만
    expect(bars[0]).toBe(1);
    expect(bars[9]).toBe(0);
    const silent = buildLevels(new Uint8Array(20), 10);
    expect(barsForViewport(silent, 0, { startMs: 0, msPerPx: 100, widthPx: 30 }, 3).every((u) => u === 0)).toBe(true);
  });
  it("거친 레벨은 2^k 피크를 한 원소로 본다", () => {
    const hires = Uint8Array.from({ length: 2048 }, (_, i) => (i === 2047 ? 255 : 0));
    const p = buildLevels(hires, 50); // 레벨 0..2 (2048→1024→512)
    expect(p.levels).toHaveLength(3);
    // 전체 40.96s를 30px에 — 마지막 바에 255가 있어야 한다
    const bars = barsForViewport(p, 2, { startMs: 0, msPerPx: 40960 / 30, widthPx: 30 }, 3);
    expect(bars[9]).toBe(1);
    expect(bars[0]).toBe(0);
  });
});
