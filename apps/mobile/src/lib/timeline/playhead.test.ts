import { describe, expect, it } from "vitest";
import { interpolatePlayhead, MAX_EXTRAPOLATION_MS } from "./playhead";

describe("interpolatePlayhead", () => {
  it("정지 중이면 anchor 그대로", () => {
    expect(interpolatePlayhead({ seq: 1, posMs: 5000, playing: false }, 300)).toBe(5000);
  });
  it("재생 중이면 흐른 시간만큼 앞으로", () => {
    expect(interpolatePlayhead({ seq: 1, posMs: 5000, playing: true }, 120)).toBe(5120);
  });
  it("400ms 넘게 status가 안 오면 거기서 멈춘다 (버퍼링·인터럽션)", () => {
    expect(interpolatePlayhead({ seq: 1, posMs: 5000, playing: true }, 5000)).toBe(5000 + MAX_EXTRAPOLATION_MS);
  });
  it("음수 elapsed는 0으로", () => {
    expect(interpolatePlayhead({ seq: 1, posMs: 5000, playing: true }, -50)).toBe(5000);
  });
});
