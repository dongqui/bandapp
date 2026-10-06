import { ConflictException, ForbiddenException } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { BandBilling } from "@bandapp/types";
import { bandError } from "../bands/band-errors.js";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { bandMembers, bands, billingPools, users } from "../db/schema.js";
import { MembershipsService } from "../memberships/memberships.service.js";
import { BillingChargeService } from "./billing-charge.service.js";
import { PLANS } from "./plans.js";

type PoolRow = typeof billingPools.$inferSelect;

/** 밴드 결제 조회·풀 연결 (스펙 "API"). 풀 상태 자체는 BillingSyncService가 RevenueCat에서 받아 쓴다. */
export class BillingService {
  constructor(
    private readonly db: Db,
    private readonly memberships: MembershipsService,
    private readonly charges: BillingChargeService,
  ) {}

  async bandBilling(bandId: string, userId: string): Promise<BandBilling> {
    const role = await this.memberships.assertMember(bandId, userId);
    return this.build(bandId, userId, role === "owner");
  }

  async link(bandId: string, userId: string): Promise<BandBilling> {
    await this.assertOwner(bandId, userId);
    const pool = await this.poolOf(userId);
    if (!pool || pool.status === "expired" || !pool.plan) throw new ConflictException(bandError("billing_no_active_pool"));
    // 동시에 transferOwnership(poolId=null)이 커밋되면 옛 오너가 양도 뒤에 밴드를 자기 풀에 다시 붙일 수 있다.
    // 밴드 행을 잠그고 오너 여부를 트랜잭션 안에서 다시 확인한다. 잠금 순서는 밴드 → (풀은 잠그지 않음)이라
    // reserve의 밴드 → 풀 순서와 순환하지 않는다.
    await this.db.transaction(async (tx) => {
      const [band] = await tx.select({ poolId: bands.poolId }).from(bands).where(eq(bands.id, bandId)).for("update");
      const [member] = await tx
        .select({ role: bandMembers.role })
        .from(bandMembers)
        .where(and(eq(bandMembers.bandId, bandId), eq(bandMembers.userId, userId)));
      if (member?.role !== "owner") throw new ForbiddenException(bandError("billing_owner_only"));
      if (band?.poolId && band.poolId !== pool.id) throw new ConflictException(bandError("billing_band_linked_elsewhere"));
      await tx.update(bands).set({ poolId: pool.id, updatedAt: new Date() }).where(eq(bands.id, bandId));
    });
    return this.build(bandId, userId, true);
  }

  async unlink(bandId: string, userId: string): Promise<BandBilling> {
    await this.assertOwner(bandId, userId);
    await this.db.update(bands).set({ poolId: null, updatedAt: new Date() }).where(eq(bands.id, bandId));
    return this.build(bandId, userId, true);
  }

  private async assertOwner(bandId: string, userId: string): Promise<void> {
    if ((await this.memberships.assertMember(bandId, userId)) !== "owner") {
      throw new ForbiddenException(bandError("billing_owner_only"));
    }
  }

  private async poolOf(userId: string): Promise<PoolRow | undefined> {
    const [pool] = await this.db.select().from(billingPools).where(eq(billingPools.ownerUserId, userId));
    return pool;
  }

  private async build(bandId: string, userId: string, isOwner: boolean): Promise<BandBilling> {
    const [band] = await this.db.select().from(bands).where(eq(bands.id, bandId));
    if (!band) throw new ForbiddenException(bandError("band_forbidden"));
    const linkedPool = band.poolId ? (await this.db.select().from(billingPools).where(eq(billingPools.id, band.poolId)))[0] : undefined;
    const a = await this.charges.allowanceOf(bandId);
    const state: BandBilling["state"] = !linkedPool ? "free" : a.source === "pool" ? "linked" : "expired";
    const [ownerRow] = await this.db
      .select({ id: users.id, displayName: users.displayName })
      .from(bandMembers)
      .innerJoin(users, eq(users.id, bandMembers.userId))
      .where(and(eq(bandMembers.bandId, bandId), eq(bandMembers.role, "owner")));
    const linkedBandCount = linkedPool ? await this.countLinked(linkedPool.id) : 0;
    // 오너가 아닌 밴드에서도 채운다 — Me 화면의 "내 구독" 카드가 현재 밴드와 무관하게 내 풀을 보여준다
    const myPool = await this.myPool(userId);
    const monthlyTotalSec = state === "linked" && linkedPool?.plan ? PLANS[linkedPool.plan].monthlySec : 0;
    return {
      state,
      plan: linkedPool?.plan ?? null,
      periodEnd: linkedPool?.periodEnd?.toISOString() ?? null,
      willRenew: linkedPool?.willRenew ?? false,
      store: linkedPool?.store ?? null,
      availableSec: a.availableSec,
      monthlyTotalSec,
      monthlyLeftSec: a.monthlyLeftSec,
      monthlyUsedSec: state === "linked" ? Math.max(0, monthlyTotalSec - a.monthlyLeftSec) : 0,
      extraSec: a.extraSec,
      freeLeftSec: a.freeLeftSec,
      owner: { id: ownerRow?.id ?? "", displayName: ownerRow?.displayName ?? "" },
      isOwner,
      linkedBandCount,
      canBuyExtra: state === "linked",
      myPool,
    };
  }

  private async myPool(userId: string): Promise<BandBilling["myPool"]> {
    const pool = await this.poolOf(userId);
    if (!pool) return null;
    const rows = await this.db
      .select({
        id: bands.id,
        name: bands.name,
        poolId: bands.poolId,
        memberCount: sql<number>`(select count(*)::int from band_members bm where bm.band_id = ${bands.id})`,
      })
      .from(bandMembers)
      .innerJoin(bands, eq(bands.id, bandMembers.bandId))
      .where(and(eq(bandMembers.userId, userId), eq(bandMembers.role, "owner"), isNull(bands.deletedAt)))
      .orderBy(bandMembers.joinedAt);
    const reservedSec = await this.charges.reservedSecOf(pool.id); // 월 남은 시간은 연결된 밴드 전체 공통
    const monthlyLeftSec = pool.plan && pool.status !== "expired" ? Math.max(0, PLANS[pool.plan].monthlySec - pool.usedSec - reservedSec) : 0;
    return {
      plan: pool.plan,
      status: pool.status,
      periodEnd: pool.periodEnd?.toISOString() ?? null,
      willRenew: pool.willRenew,
      store: pool.store,
      monthlyLeftSec,
      bands: rows.map((r) => ({ id: r.id, name: r.name, memberCount: r.memberCount, linked: r.poolId === pool.id })),
    };
  }

  private async countLinked(poolId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(bands)
      .where(and(eq(bands.poolId, poolId), isNull(bands.deletedAt)));
    return row?.n ?? 0;
  }
}

export const billingServiceProvider: Provider = {
  provide: BillingService,
  useFactory: (db: Db, memberships: MembershipsService, charges: BillingChargeService) => new BillingService(db, memberships, charges),
  inject: [DB, MembershipsService, BillingChargeService],
};
