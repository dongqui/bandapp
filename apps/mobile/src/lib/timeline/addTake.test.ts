import { describe, expect, it } from "vitest";
import { NEW_TAKE_MS, newTakeAt } from "./addTake";

const takes = [
  { id: "a", name: "Take 1", startMs: 10_000, endMs: 60_000 },
  { id: "b", name: "Take 2", startMs: 100_000, endMs: 200_000 },
];
const D = 600_000;

describe("newTakeAt", () => {
  it("플레이헤드에서 60초, 다음 take 시작에서 멈춘다", () => {
    expect(newTakeAt(70_000, takes, D)).toEqual({ draft: { startMs: 70_000, endMs: 100_000 } });
    expect(newTakeAt(300_000, takes, D)).toEqual({ draft: { startMs: 300_000, endMs: 300_000 + NEW_TAKE_MS } });
  });
  it("녹음 끝에서도 멈춘다", () => {
    expect(newTakeAt(570_000, takes, D)).toEqual({ draft: { startMs: 570_000, endMs: 600_000 } });
  });
  it("플레이헤드가 take 안이면 그 take를 알려 준다 — 시작 지점은 안, 끝 지점은 밖", () => {
    expect(newTakeAt(30_000, takes, D)).toEqual({ error: "inside", take: takes[0] });
    expect(newTakeAt(10_000, takes, D)).toEqual({ error: "inside", take: takes[0] });
    expect(newTakeAt(60_000, takes, D)).toEqual({ draft: { startMs: 60_000, endMs: 100_000 } });
  });
  it("다음 take나 녹음 끝까지 1초가 안 되면 no_room", () => {
    expect(newTakeAt(99_500, takes, D)).toEqual({ error: "no_room" });
    expect(newTakeAt(599_500, takes, D)).toEqual({ error: "no_room" });
    expect(newTakeAt(99_000, takes, D)).toEqual({ draft: { startMs: 99_000, endMs: 100_000 } });
  });
  it("ms 소수점은 정수로 — 플레이헤드는 오디오 클록이라 소수가 온다", () => {
    expect(newTakeAt(70_000.4, takes, D)).toEqual({ draft: { startMs: 70_000, endMs: 100_000 } });
  });
});
