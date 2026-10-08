import { checkTakeRange, MIN_TAKE_MS, neighborsAt, neighborsOf } from "@bandapp/types";
import { describe, expect, it } from "vitest";

const D = 600_000;
const none = { prevEndMs: null, nextStartMs: null };

describe("checkTakeRange", () => {
  it("정상 범위는 null", () => {
    expect(checkTakeRange(10_000, 250_500, D, none)).toBeNull();
    expect(checkTakeRange(0, D, D, none)).toBeNull();
  });
  it("정수가 아니거나 범위 밖이면 take_range_invalid", () => {
    expect(checkTakeRange(1.5, 5000, D, none)).toBe("take_range_invalid");
    expect(checkTakeRange(-1, 5000, D, none)).toBe("take_range_invalid");
    expect(checkTakeRange(0, D + 1, D, none)).toBe("take_range_invalid");
  });
  it("최소 길이 250ms", () => {
    expect(checkTakeRange(1000, 1000 + MIN_TAKE_MS, D, none)).toBeNull();
    expect(checkTakeRange(1000, 1000 + MIN_TAKE_MS - 1, D, none)).toBe("take_range_invalid");
  });
  it("이웃과 겹치면 take_overlap — 경계에 딱 닿는 건 허용", () => {
    const n = { prevEndMs: 50_000, nextStartMs: 300_000 };
    expect(checkTakeRange(50_000, 300_000, D, n)).toBeNull();
    expect(checkTakeRange(49_999, 300_000, D, n)).toBe("take_overlap");
    expect(checkTakeRange(50_000, 300_001, D, n)).toBe("take_overlap");
  });
});

describe("neighborsOf", () => {
  const rows = [
    { index: 0, startMs: 10_000, endMs: 60_000 },
    { index: 1, startMs: 100_000, endMs: 200_000 },
    { index: 3, startMs: 400_000, endMs: 500_000 }, // index 2는 지워진 take (번호 유지)
  ];
  it("시간 기준 앞 take의 end, 뒤 take의 start", () => {
    expect(neighborsOf(rows, 1)).toEqual({ prevEndMs: 60_000, nextStartMs: 400_000 });
    expect(neighborsOf(rows, 3)).toEqual({ prevEndMs: 200_000, nextStartMs: null });
    expect(neighborsOf(rows, 0)).toEqual({ prevEndMs: null, nextStartMs: 100_000 });
  });
  it("수동 take는 index가 제일 커도 시간상 위치로 이웃을 찾는다 (2026-10-08)", () => {
    const withManual = [...rows, { index: 4, startMs: 70_000, endMs: 90_000 }];
    expect(neighborsOf(withManual, 4)).toEqual({ prevEndMs: 60_000, nextStartMs: 100_000 });
    expect(neighborsOf(withManual, 1)).toEqual({ prevEndMs: 90_000, nextStartMs: 400_000 });
    expect(neighborsOf(withManual, 0)).toEqual({ prevEndMs: null, nextStartMs: 70_000 });
  });
  it("없는 index면 이웃 없음", () => {
    expect(neighborsOf(rows, 2)).toEqual({ prevEndMs: null, nextStartMs: null });
  });
});

describe("neighborsAt", () => {
  const rows = [
    { index: 0, startMs: 10_000, endMs: 60_000 },
    { index: 1, startMs: 100_000, endMs: 200_000 },
  ];
  it("빈 자리의 앞 take end, 뒤 take start", () => {
    expect(neighborsAt(rows, 80_000)).toEqual({ prevEndMs: 60_000, nextStartMs: 100_000 });
    expect(neighborsAt(rows, 0)).toEqual({ prevEndMs: null, nextStartMs: 10_000 });
    expect(neighborsAt(rows, 300_000)).toEqual({ prevEndMs: 200_000, nextStartMs: null });
  });
  it("take 안의 지점이면 그 take가 앞 이웃이라 checkTakeRange가 겹침으로 잡는다", () => {
    const n = neighborsAt(rows, 30_000);
    expect(n).toEqual({ prevEndMs: 60_000, nextStartMs: 100_000 });
    expect(checkTakeRange(30_000, 50_000, 600_000, n)).toBe("take_overlap");
  });
  it("take 시작 지점과 같으면 그 take는 뒤 이웃", () => {
    expect(neighborsAt(rows, 100_000)).toEqual({ prevEndMs: 60_000, nextStartMs: 100_000 });
  });
});
