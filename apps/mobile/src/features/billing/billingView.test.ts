import type { BandBilling } from "@bandapp/types";
import { describe, expect, it } from "vitest";
import { fmtH, monthDay, noTimeActions, phaseAfterSync } from "./billingView";

const H = 3600;
const base: BandBilling = {
  state: "free", plan: null, periodEnd: null, willRenew: false, store: null,
  availableSec: 3 * H, monthlyTotalSec: 0, monthlyLeftSec: 0, monthlyUsedSec: 0, extraSec: 0, freeLeftSec: 3 * H,
  owner: { id: "u1", displayName: "Minsu" }, isOwner: true, linkedBandCount: 0, canBuyExtra: false, myPool: null,
};
const linked: BandBilling = { ...base, state: "linked", plan: "band", monthlyTotalSec: 20 * H, monthlyLeftSec: 5 * H, availableSec: 5 * H, canBuyExtra: true, linkedBandCount: 1 };

describe("fmtH", () => {
  it.each([[0, "0h"], [45 * 60, "45m"], [2 * H, "2h"], [2 * H + 30 * 60, "2h 30m"], [-5, "0h"]])("%s → %s", (sec, out) => {
    expect(fmtH(sec)).toBe(out);
  });
});

describe("monthDay", () => {
  it("ISO를 'Nov 3'로", () => expect(monthDay("2026-11-03T00:00:00.000Z")).toBe("Nov 3"));
  it("null은 빈 문자열", () => expect(monthDay(null)).toBe(""));
});

describe("phaseAfterSync", () => {
  it("구독이 linked로 반영되면 success", () => expect(phaseAfterSync("success", base, linked, "band")).toBe("success"));
  it("구독했는데 아직 free면 delayed", () => expect(phaseAfterSync("success", base, base, "band")).toBe("delayed"));
  it("추가 시간이 늘었으면 success, 아니면 delayed", () => {
    expect(phaseAfterSync("success", linked, { ...linked, extraSec: 3 * H }, "extra")).toBe("success");
    expect(phaseAfterSync("success", linked, linked, "extra")).toBe("delayed");
  });
  it("pending/failed는 그대로", () => {
    expect(phaseAfterSync("pending", base, null, "band")).toBe("pending");
    expect(phaseAfterSync("failed", base, null, "band")).toBe("failed");
  });
});

describe("noTimeActions", () => {
  it("오너 + 무료 → View plans", () => expect(noTimeActions(base, 4 * H)).toEqual(["viewPlans", "notNow"]));
  it("멤버 + 무료 → Not now만", () => expect(noTimeActions({ ...base, isOwner: false }, 4 * H)).toEqual(["notNow"]));
  it("오너 + 풀 있음 + 미연결 → Add to my plan", () => {
    const b: BandBilling = { ...base, myPool: { plan: "band", status: "active", monthlyLeftSec: 10 * H, bands: [] } };
    expect(noTimeActions(b, 4 * H)).toEqual(["addToPlan", "notNow"]);
  });
  it("오너 + 만료 → Resubscribe", () => expect(noTimeActions({ ...base, state: "expired", plan: "band" }, 4 * H)).toEqual(["resubscribe", "notNow"]));
  it("linked band 플랜 → Buy 3h + View Plus", () => expect(noTimeActions(linked, 6 * H)).toEqual(["buyExtra", "viewPlus", "notNow"]));
  it("linked plus 플랜 → Buy 3h만", () => expect(noTimeActions({ ...linked, plan: "plus" }, 6 * H)).toEqual(["buyExtra", "notNow"]));
  it("linked 멤버 → Buy 3h만", () => expect(noTimeActions({ ...linked, isOwner: false }, 6 * H)).toEqual(["buyExtra", "notNow"]));
});
