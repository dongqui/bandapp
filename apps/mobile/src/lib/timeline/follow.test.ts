import { describe, expect, it } from "vitest";
import { followViewport, playheadEdge } from "./follow";
import { timeToX } from "./viewport";

const HOUR = 3_600_000;
const v = { startMs: 60_000, msPerPx: 100, widthPx: 400 }; // 60s ~ 100s

describe("followViewport", () => {
  it("playhead가 80% 안쪽이면 움직이지 않는다", () => {
    expect(followViewport(v, 60_000 + 100 * 320, HOUR)).toBeNull();
    expect(followViewport(v, 60_000, HOUR)).toBeNull();
  });
  it("80%를 넘으면 playhead를 30% 위치에 놓는다", () => {
    const ms = 60_000 + 100 * 330;
    const out = followViewport(v, ms, HOUR)!;
    expect(timeToX(out, ms)).toBeCloseTo(120);
    expect(out.msPerPx).toBe(v.msPerPx);
  });
  it("화면 왼쪽 밖(뒤로 seek)이어도 30% 위치로 데려온다", () => {
    const out = followViewport(v, 30_000, HOUR)!;
    expect(timeToX(out, 30_000)).toBeCloseTo(120);
  });
  it("녹음 시작 근처에서는 0에서 멈춘다 (30% 위치를 못 만들어도 clamp)", () => {
    const out = followViewport(v, 10_000, HOUR)!;
    expect(out.startMs).toBe(0);
  });
  it("녹음 끝에서는 clamp된 viewport를 준다", () => {
    const end = { startMs: HOUR - 40_000, msPerPx: 100, widthPx: 400 };
    const out = followViewport(end, HOUR - 1000, HOUR)!;
    expect(out.startMs).toBe(HOUR - 40_000);
  });
});

describe("playheadEdge", () => {
  it("화면 밖이면 방향, 안이면 null", () => {
    expect(playheadEdge(v, 59_000)).toBe("left");
    expect(playheadEdge(v, 101_000)).toBe("right");
    expect(playheadEdge(v, 80_000)).toBeNull();
  });
});
