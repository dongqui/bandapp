import { Logger } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { bandMembers, bands, billingPools, extraPurchases } from "../db/schema.js";
import { EXTRA_PRODUCT_IDS, EXTRA_SEC, SUBSCRIPTION_PRODUCTS, type PoolPlan } from "./plans.js";
import { RevenueCatClient, type RcSubscriber } from "./revenuecat.client.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface PoolSnapshot {
  plan: PoolPlan | null;
  status: "active" | "grace" | "expired";
  store: "app_store" | "play_store" | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  willRenew: boolean;
}

function storeOf(s: string): PoolSnapshot["store"] {
  return s === "app_store" ? "app_store" : s === "play_store" ? "play_store" : null;
}

/** 구독 목록에서 풀 상태를 뽑는다. 활성이 둘이면(플랜 전환 중) 만료가 늦은 쪽을 쓴다 */
export function toPoolSnapshot(sub: RcSubscriber, now: Date): PoolSnapshot {
  let best: PoolSnapshot | null = null;
  for (const [productId, s] of Object.entries(sub.subscriptions)) {
    const plan = SUBSCRIPTION_PRODUCTS[productId];
    if (!plan) continue;
    const periodEnd = s.expires_date ? new Date(s.expires_date) : null;
    const expired = periodEnd !== null && periodEnd.getTime() <= now.getTime();
    const status: PoolSnapshot["status"] = !expired ? "active" : s.billing_issues_detected_at ? "grace" : "expired";
    const snap: PoolSnapshot = {
      plan,
      status,
      store: storeOf(s.store),
      periodStart: new Date(s.purchase_date),
      periodEnd,
      willRenew: !s.unsubscribe_detected_at && status !== "expired",
    };
    const rank = (x: PoolSnapshot) => (x.status === "expired" ? 0 : 1) * 1e13 + (x.periodEnd?.getTime() ?? 0);
    if (!best || rank(snap) > rank(best)) best = snap;
  }
  if (!best || best.status === "expired") {
    // 만료된 구독은 플랜만 남기고(디자인: "{Plan} plan ended") 나머지는 비활성으로
    return { plan: best?.plan ?? null, status: "expired", store: best?.store ?? null, periodStart: best?.periodStart ?? null, periodEnd: best?.periodEnd ?? null, willRenew: false };
  }
  return best;
}

export function extraTransactions(sub: RcSubscriber): Array<{ id: string; store: string }> {
  return EXTRA_PRODUCT_IDS.flatMap((pid) => (sub.non_subscriptions[pid] ?? []).map((t) => ({ id: t.id, store: t.store })));
}

/**
 * RevenueCat → 우리 DB. 웹훅과 /billing/sync가 같은 함수를 쓰므로 이벤트 순서에 의존하지 않는다 —
 * 어떤 이벤트가 오든 REST로 현재 상태를 다시 읽어 그대로 쓴다 (스펙 "API").
 */
export class BillingSyncService {
  private readonly logger = new Logger(BillingSyncService.name);

  constructor(
    private readonly db: Db,
    private readonly rc: RevenueCatClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** 사용자 풀을 RevenueCat 상태로 맞추고, 소모성 거래를 반영한다. bandId가 있으면 자동 연결·추가 시간 배정 */
  async syncUser(userId: string, opts: { bandId?: string; attributeBandId?: string } = {}): Promise<void> {
    const sub = await this.rc.getSubscriber(userId);
    const snap = toPoolSnapshot(sub, this.now());
    const attrBand = opts.attributeBandId ?? sub.subscriber_attributes?.band_id?.value;

    await this.db.transaction(async (tx) => {
      const [existing] = await tx.select().from(billingPools).where(eq(billingPools.ownerUserId, userId)).for("update");
      // 갱신 판단: 기간 시작이 바뀌면 월 사용량을 0으로 (스펙 "웹훅")
      const renewed = existing?.periodStart?.getTime() !== snap.periodStart?.getTime();
      const values = { ...snap, usedSec: renewed ? 0 : (existing?.usedSec ?? 0), updatedAt: new Date() };
      let poolId: string;
      if (existing) {
        await tx.update(billingPools).set(values).where(eq(billingPools.id, existing.id));
        poolId = existing.id;
      } else {
        const [row] = await tx.insert(billingPools).values({ ownerUserId: userId, ...values }).returning({ id: billingPools.id });
        poolId = row!.id;
      }

      // 결제 화면에서 들어온 밴드는 자동 연결 — 요청자가 오너이고 풀이 활성일 때만
      if (opts.bandId && snap.status !== "expired" && (await this.isOwner(tx, opts.bandId, userId))) {
        await tx.update(bands).set({ poolId, updatedAt: new Date() }).where(and(eq(bands.id, opts.bandId), isNull(bands.poolId)));
      }

      // 소모성 거래: 원장에 upsert하고, 밴드가 정해지면 한 번만 반영
      for (const t of extraTransactions(sub)) {
        await tx
          .insert(extraPurchases)
          .values({ transactionId: t.id, userId, sec: EXTRA_SEC })
          .onConflictDoNothing();
        const target = opts.bandId ?? attrBand;
        if (!target || !(await this.isMember(tx, target, userId))) continue;
        const [applied] = await tx
          .update(extraPurchases)
          .set({ bandId: target, appliedAt: new Date() })
          .where(and(eq(extraPurchases.transactionId, t.id), isNull(extraPurchases.appliedAt)))
          .returning({ sec: extraPurchases.sec });
        if (applied) {
          await tx.update(bands).set({ extraSec: sql`${bands.extraSec} + ${applied.sec}`, updatedAt: new Date() }).where(eq(bands.id, target));
        }
      }
    });
    this.logger.log(`billing sync user ${userId}: ${snap.plan ?? "none"} ${snap.status}`);
  }

  private async isOwner(tx: Db | Tx, bandId: string, userId: string): Promise<boolean> {
    const [row] = await tx.select({ role: bandMembers.role }).from(bandMembers).where(and(eq(bandMembers.bandId, bandId), eq(bandMembers.userId, userId)));
    return row?.role === "owner";
  }

  private async isMember(tx: Db | Tx, bandId: string, userId: string): Promise<boolean> {
    const [row] = await tx.select({ role: bandMembers.role }).from(bandMembers).where(and(eq(bandMembers.bandId, bandId), eq(bandMembers.userId, userId)));
    return row !== undefined;
  }
}

export const billingSyncServiceProvider: Provider = {
  provide: BillingSyncService,
  useFactory: (db: Db, rc: RevenueCatClient) => new BillingSyncService(db, rc),
  inject: [DB, RevenueCatClient],
};
