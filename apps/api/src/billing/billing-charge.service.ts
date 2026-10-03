import type { Provider } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { analysisCharges, bands, billingPools } from "../db/schema.js";
import { allowance, splitCharge, type Allowance } from "./allowance.js";

export type ReserveResult = { ok: true; alreadyCharged: boolean } | { ok: false; availableSec: number };

// 트랜잭션 콜백의 tx도 Db와 같은 표면을 쓴다
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * 분석 차감 원장 (스펙 "분석 게이트"). 밴드·풀 행을 FOR UPDATE로 잠근 뒤 계산하므로
 * 같은 풀의 두 세션이 동시에 들어와도 월 시간을 초과 예약하지 않는다.
 * 무료·추가 시간은 예약 시점에 바로 깎고(환불 시 되돌림), 월 시간은 reserved 합계로만 계산하다
 * commit 때 used_sec에 더한다 — 갱신으로 used_sec이 0이 돼도 예약은 계산에서 빠질 뿐이다.
 */
export class BillingChargeService {
  constructor(private readonly db: Db) {}

  async reserve(sessionId: string, bandId: string, needSec: number): Promise<ReserveResult> {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx.select().from(analysisCharges).where(eq(analysisCharges.sessionId, sessionId)).for("update");
      if (existing?.state === "charged") return { ok: true, alreadyCharged: true };
      if (existing?.state === "reserved") return { ok: true, alreadyCharged: false };

      const { band, pool, a } = await this.lockAndCompute(tx, bandId);
      const split = splitCharge(a, needSec);
      if (!split) return { ok: false, availableSec: a.availableSec };

      if (split.freeSec > 0 || split.extraSec > 0) {
        await tx
          .update(bands)
          .set({ freeUsedSec: band.freeUsedSec + split.freeSec, extraSec: band.extraSec - split.extraSec, updatedAt: new Date() })
          .where(eq(bands.id, bandId));
      }
      const row = { bandId, poolId: a.source === "pool" ? pool!.id : null, ...split, state: "reserved" as const, updatedAt: new Date() };
      if (existing) {
        // refunded였던 세션의 재분석 — 같은 행을 다시 reserved로
        await tx.update(analysisCharges).set(row).where(eq(analysisCharges.sessionId, sessionId));
      } else {
        await tx.insert(analysisCharges).values({ sessionId, ...row });
      }
      return { ok: true, alreadyCharged: false };
    });
  }

  async commit(sessionId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [c] = await tx.select().from(analysisCharges).where(eq(analysisCharges.sessionId, sessionId)).for("update");
      if (!c || c.state !== "reserved") return;
      if (c.poolId && c.monthlySec > 0) {
        await tx
          .update(billingPools)
          .set({ usedSec: sql`${billingPools.usedSec} + ${c.monthlySec}`, updatedAt: new Date() })
          .where(eq(billingPools.id, c.poolId));
      }
      await tx.update(analysisCharges).set({ state: "charged", updatedAt: new Date() }).where(eq(analysisCharges.sessionId, sessionId));
    });
  }

  async refund(sessionId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [c] = await tx.select().from(analysisCharges).where(eq(analysisCharges.sessionId, sessionId)).for("update");
      if (!c || c.state !== "reserved") return;
      if (c.freeSec > 0 || c.extraSec > 0) {
        await tx
          .update(bands)
          .set({
            freeUsedSec: sql`greatest(0, ${bands.freeUsedSec} - ${c.freeSec})`,
            extraSec: sql`${bands.extraSec} + ${c.extraSec}`,
            updatedAt: new Date(),
          })
          .where(eq(bands.id, c.bandId));
      }
      await tx.update(analysisCharges).set({ state: "refunded", updatedAt: new Date() }).where(eq(analysisCharges.sessionId, sessionId));
    });
  }

  async allowanceOf(bandId: string, tx: Db | Tx = this.db): Promise<Allowance> {
    const [band] = await tx.select().from(bands).where(eq(bands.id, bandId));
    if (!band) throw new Error(`band ${bandId} not found`);
    const pool = band.poolId ? (await tx.select().from(billingPools).where(eq(billingPools.id, band.poolId)))[0] : undefined;
    const reservedSec = pool ? await this.reservedSum(tx, pool.id) : 0;
    return allowance({
      pool: pool ? { plan: pool.plan, status: pool.status, usedSec: pool.usedSec, reservedSec } : null,
      band: { freeUsedSec: band.freeUsedSec, extraSec: band.extraSec },
    });
  }

  private async lockAndCompute(tx: Tx, bandId: string) {
    const [band] = await tx.select().from(bands).where(eq(bands.id, bandId)).for("update");
    if (!band) throw new Error(`band ${bandId} not found`);
    const pool = band.poolId ? (await tx.select().from(billingPools).where(eq(billingPools.id, band.poolId)).for("update"))[0] : undefined;
    const reservedSec = pool ? await this.reservedSum(tx, pool.id) : 0;
    const a = allowance({
      pool: pool ? { plan: pool.plan, status: pool.status, usedSec: pool.usedSec, reservedSec } : null,
      band: { freeUsedSec: band.freeUsedSec, extraSec: band.extraSec },
    });
    return { band, pool, a };
  }

  async reservedSecOf(poolId: string): Promise<number> {
    return this.reservedSum(this.db, poolId);
  }

  private async reservedSum(tx: Db | Tx, poolId: string): Promise<number> {
    const [row] = await tx
      .select({ n: sql<number>`coalesce(sum(${analysisCharges.monthlySec}), 0)::int` })
      .from(analysisCharges)
      .where(and(eq(analysisCharges.poolId, poolId), eq(analysisCharges.state, "reserved")));
    return row?.n ?? 0;
  }
}

export const billingChargeServiceProvider: Provider = {
  provide: BillingChargeService,
  useFactory: (db: Db) => new BillingChargeService(db),
  inject: [DB],
};
