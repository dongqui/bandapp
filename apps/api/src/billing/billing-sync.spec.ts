import { describe, expect, it } from "vitest";
import type { RcSubscriber } from "./revenuecat.client.js";
import { extraTransactions, toPoolSnapshot } from "./billing-sync.service.js";

const now = new Date("2026-10-10T00:00:00Z");
const sub = (over: Partial<RcSubscriber> = {}): RcSubscriber => ({ subscriptions: {}, non_subscriptions: {}, ...over });
const active = { purchase_date: "2026-10-03T00:00:00Z", expires_date: "2026-11-03T00:00:00Z", store: "app_store", unsubscribe_detected_at: null, billing_issues_detected_at: null, period_type: "normal" };

describe("toPoolSnapshot", () => {
  it("구독 없음 → expired, plan null", () => {
    expect(toPoolSnapshot(sub(), now)).toEqual({ plan: null, status: "expired", store: null, periodStart: null, periodEnd: null, willRenew: false });
  });

  it("활성 band 구독", () => {
    expect(toPoolSnapshot(sub({ subscriptions: { "rehearsal.band.monthly": active } }), now)).toEqual({
      plan: "band", status: "active", store: "app_store",
      periodStart: new Date("2026-10-03T00:00:00Z"), periodEnd: new Date("2026-11-03T00:00:00Z"), willRenew: true,
    });
  });

  it("해지 예정이면 willRenew false지만 만료 전까지 active", () => {
    const s = toPoolSnapshot(sub({ subscriptions: { "rehearsal.plus.monthly": { ...active, unsubscribe_detected_at: "2026-10-05T00:00:00Z" } } }), now);
    expect(s).toMatchObject({ plan: "plus", status: "active", willRenew: false });
  });

  it("만료일이 지났고 결제 문제가 있으면 grace, 없으면 expired", () => {
    const past = { ...active, expires_date: "2026-10-09T00:00:00Z" };
    expect(toPoolSnapshot(sub({ subscriptions: { "rehearsal.band.monthly": { ...past, billing_issues_detected_at: "2026-10-09T00:00:00Z" } } }), now).status).toBe("grace");
    expect(toPoolSnapshot(sub({ subscriptions: { "rehearsal.band.monthly": past } }), now).status).toBe("expired");
  });

  it("활성 구독이 둘이면(전환 중) 만료가 더 늦은 쪽", () => {
    const s = toPoolSnapshot(sub({ subscriptions: {
      "rehearsal.band.monthly": { ...active, expires_date: "2026-10-20T00:00:00Z" },
      "rehearsal.plus.monthly": { ...active, store: "play_store" },
    } }), now);
    expect(s).toMatchObject({ plan: "plus", store: "play_store" });
  });

  it("모르는 상품 ID는 무시한다", () => {
    expect(toPoolSnapshot(sub({ subscriptions: { "other.app.thing": active } }), now).plan).toBeNull();
  });
});

describe("extraTransactions", () => {
  it("추가 시간 상품의 거래만 id와 store로 돌려준다", () => {
    const s = sub({ non_subscriptions: {
      "rehearsal.extra.3h": [{ id: "t1", purchase_date: "2026-10-04T00:00:00Z", store: "play_store" }, { id: "t2", purchase_date: "2026-10-05T00:00:00Z", store: "play_store" }],
      "other": [{ id: "x", purchase_date: "2026-10-04T00:00:00Z", store: "app_store" }],
    } });
    expect(extraTransactions(s)).toEqual([{ id: "t1", store: "play_store" }, { id: "t2", store: "play_store" }]);
  });
});
