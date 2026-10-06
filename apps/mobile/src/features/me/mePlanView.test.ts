import type { BandBilling } from "@bandapp/types";
import { describe, expect, it } from "vitest";
import { mePlanModel } from "./mePlanView";

const base: BandBilling = {
  state: "free", plan: null, periodEnd: null, willRenew: false, store: null,
  availableSec: 0, monthlyTotalSec: 0, monthlyLeftSec: 0, monthlyUsedSec: 0, extraSec: 0, freeLeftSec: 0,
  owner: { id: "o", displayName: "Minsu" }, isOwner: true, linkedBandCount: 0, canBuyExtra: false, myPool: null,
};
const pool = (over: Partial<NonNullable<BandBilling["myPool"]>>): BandBilling["myPool"] => ({
  plan: "band", status: "active", periodEnd: "2026-11-03T00:00:00.000Z", willRenew: true, store: "app_store", monthlyLeftSec: 0,
  bands: [{ id: "b1", name: "A", memberCount: 2, linked: true }, { id: "b2", name: "B", memberCount: 1, linked: false }],
  ...over,
});

describe("mePlanModel", () => {
  it("활성 풀: 플랜·갱신·연결 수·반대 플랜 선택", () => {
    expect(mePlanModel({ ...base, myPool: pool({}) })).toEqual({
      kind: "active", plan: "band", willRenew: true, periodEnd: "2026-11-03T00:00:00.000Z", store: "app_store", linkedCount: 1, nextSel: "plus",
    });
    expect(mePlanModel({ ...base, myPool: pool({ plan: "plus", status: "grace" }) })).toMatchObject({ kind: "active", plan: "plus", nextSel: "band" });
  });

  it("현재 밴드가 남의 플랜에 있어도 내 풀이 활성이면 내 풀이 우선", () => {
    expect(mePlanModel({ ...base, state: "linked", isOwner: false, myPool: pool({}) })).toMatchObject({ kind: "active" });
  });

  it("만료된 풀", () => {
    expect(mePlanModel({ ...base, myPool: pool({ status: "expired", willRenew: false }) })).toEqual({
      kind: "expired", plan: "band", periodEnd: "2026-11-03T00:00:00.000Z",
    });
  });

  it("풀 없음 + 현재 밴드가 남의 플랜: othersPlan", () => {
    expect(mePlanModel({ ...base, state: "linked", isOwner: false, plan: "band" })).toEqual({ kind: "othersPlan", ownerName: "Minsu" });
    // plan이 null인 풀 행(구독한 적 없음)도 풀 없음으로 본다
    expect(mePlanModel({ ...base, state: "linked", isOwner: false, myPool: pool({ plan: null, status: "expired" }) })).toEqual({ kind: "othersPlan", ownerName: "Minsu" });
  });

  it("그 외는 free", () => {
    expect(mePlanModel(base)).toEqual({ kind: "free" });
    expect(mePlanModel({ ...base, state: "expired", isOwner: false })).toEqual({ kind: "free" });
  });
});
