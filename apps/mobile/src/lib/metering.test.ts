import { describe, expect, it } from "vitest";
import { METER_CEIL_DB, METER_FLOOR_DB, dbToUnit, pushLevel } from "./metering";

describe("dbToUnit", () => {
  it("상수는 -60~0 dB", () => {
    expect(METER_FLOOR_DB).toBe(-60);
    expect(METER_CEIL_DB).toBe(0);
  });
  it("undefined·무음(-160)·바닥(-60)은 0", () => {
    expect(dbToUnit(undefined)).toBe(0);
    expect(dbToUnit(-160)).toBe(0);
    expect(dbToUnit(-60)).toBe(0);
  });
  it("-30 dB는 0.5, 0 dB는 1", () => {
    expect(dbToUnit(-30)).toBeCloseTo(0.5);
    expect(dbToUnit(0)).toBe(1);
  });
  it("천장 위는 1로 clamp", () => {
    expect(dbToUnit(5)).toBe(1);
  });
  it("NaN은 0", () => {
    expect(dbToUnit(Number.NaN)).toBe(0);
  });
});

describe("pushLevel", () => {
  it("빈 배열에 하나 넣으면 [u]", () => {
    expect(pushLevel([], 0.3, 34)).toEqual([0.3]);
  });
  it("size를 넘으면 가장 오래된 것부터 버린다", () => {
    expect(pushLevel([0.1, 0.2, 0.3], 0.4, 3)).toEqual([0.2, 0.3, 0.4]);
  });
  it("입력 배열을 바꾸지 않는다", () => {
    const prev = [0.1, 0.2];
    const next = pushLevel(prev, 0.3, 34);
    expect(prev).toEqual([0.1, 0.2]);
    expect(next).not.toBe(prev);
  });
  it("size가 0 이하면 빈 배열", () => {
    expect(pushLevel([0.1, 0.2], 0.3, 0)).toEqual([]);
    expect(pushLevel([0.1], 0.3, -1)).toEqual([]);
  });
});
