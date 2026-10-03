import { describe, expect, it } from "vitest";
import { allowance, splitCharge } from "./allowance.js";

const H = 3600;

describe("allowance", () => {
  it("미연결 밴드는 무료 잔여 + 밴드 추가 시간", () => {
    const a = allowance({ pool: null, band: { freeUsedSec: H, extraSec: 2 * H } });
    expect(a).toEqual({ source: "free", monthlyLeftSec: 0, freeLeftSec: 2 * H, extraSec: 2 * H, availableSec: 4 * H });
  });

  it("활성 풀에 연결되면 무료는 쓰지 않고 월 시간 - used - reserved + 추가 시간", () => {
    const a = allowance({
      pool: { plan: "band", status: "active", usedSec: 5 * H, reservedSec: 2 * H },
      band: { freeUsedSec: 0, extraSec: H },
    });
    expect(a).toEqual({ source: "pool", monthlyLeftSec: 13 * H, freeLeftSec: 3 * H, extraSec: H, availableSec: 14 * H });
  });

  it("grace도 활성처럼 취급한다", () => {
    const a = allowance({ pool: { plan: "plus", status: "grace", usedSec: 0, reservedSec: 0 }, band: { freeUsedSec: 0, extraSec: 0 } });
    expect(a.source).toBe("pool");
    expect(a.monthlyLeftSec).toBe(40 * H);
  });

  it("만료된 풀에 연결된 밴드는 무료 잔여 + 추가 시간으로 돌아간다", () => {
    const a = allowance({ pool: { plan: "band", status: "expired", usedSec: 20 * H, reservedSec: 0 }, band: { freeUsedSec: 3 * H, extraSec: H } });
    expect(a).toEqual({ source: "free", monthlyLeftSec: 0, freeLeftSec: 0, extraSec: H, availableSec: H });
  });

  it("월 시간은 음수가 되지 않는다", () => {
    const a = allowance({ pool: { plan: "band", status: "active", usedSec: 19 * H, reservedSec: 2 * H }, band: { freeUsedSec: 0, extraSec: 0 } });
    expect(a.monthlyLeftSec).toBe(0);
  });
});

describe("splitCharge", () => {
  it("월 시간 → 추가 시간 순으로 나눈다", () => {
    const a = allowance({ pool: { plan: "band", status: "active", usedSec: 19 * H, reservedSec: 0 }, band: { freeUsedSec: 0, extraSec: 3 * H } });
    expect(splitCharge(a, 2 * H)).toEqual({ freeSec: 0, monthlySec: H, extraSec: H });
  });

  it("무료 → 추가 시간 순으로 나눈다", () => {
    const a = allowance({ pool: null, band: { freeUsedSec: 2 * H, extraSec: 3 * H } });
    expect(splitCharge(a, 2 * H)).toEqual({ freeSec: H, monthlySec: 0, extraSec: H });
  });

  it("부족하면 null — 부분 분석은 없다", () => {
    const a = allowance({ pool: null, band: { freeUsedSec: 0, extraSec: 0 } });
    expect(splitCharge(a, 3 * H + 1)).toBeNull();
    expect(splitCharge(a, 3 * H)).toEqual({ freeSec: 3 * H, monthlySec: 0, extraSec: 0 });
  });
});
