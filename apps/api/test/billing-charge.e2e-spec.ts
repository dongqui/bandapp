import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { BillingChargeService } from "../src/billing/billing-charge.service.js";
import { analysisCharges, bands, billingPools, sessions, users } from "../src/db/schema.js";
import { createTestDb, truncateAll } from "./db-util.js";

const H = 3600;

describe("BillingChargeService", () => {
  const db = createTestDb();
  const svc = new BillingChargeService(db);
  let userId: string;
  let bandId: string;

  async function makeSession(): Promise<string> {
    const [s] = await db
      .insert(sessions)
      .values({ bandId, createdBy: userId, title: "T", status: "analyzing", startedAt: new Date() })
      .returning({ id: sessions.id });
    return s!.id;
  }

  async function makePool(overrides: Partial<typeof billingPools.$inferInsert> = {}): Promise<string> {
    const [p] = await db
      .insert(billingPools)
      .values({ ownerUserId: userId, plan: "band", status: "active", usedSec: 0, ...overrides })
      .returning({ id: billingPools.id });
    await db.update(bands).set({ poolId: p!.id }).where(eq(bands.id, bandId));
    return p!.id;
  }

  beforeEach(async () => {
    await truncateAll(db);
    const [u] = await db.insert(users).values({ displayName: "O" }).returning({ id: users.id });
    userId = u!.id;
    const [b] = await db.insert(bands).values({ name: "B" }).returning({ id: bands.id });
    bandId = b!.id;
  });

  it("미연결 밴드: 무료 3h 안이면 예약되고 free_used_sec이 바로 오른다", async () => {
    const sid = await makeSession();
    expect(await svc.reserve(sid, bandId, 2 * H)).toEqual({ ok: true, alreadyCharged: false });
    const [band] = await db.select().from(bands).where(eq(bands.id, bandId));
    expect(band!.freeUsedSec).toBe(2 * H);
    const [c] = await db.select().from(analysisCharges).where(eq(analysisCharges.sessionId, sid));
    expect(c).toMatchObject({ state: "reserved", freeSec: 2 * H, monthlySec: 0, extraSec: 0 });
  });

  it("부족하면 ok:false와 남은 시간을 돌려주고 아무것도 바꾸지 않는다", async () => {
    const sid = await makeSession();
    expect(await svc.reserve(sid, bandId, 4 * H)).toEqual({ ok: false, availableSec: 3 * H });
    expect(await db.select().from(analysisCharges)).toHaveLength(0);
  });

  it("활성 풀: 월 시간을 먼저 쓰고 모자라면 밴드 추가 시간을 쓴다", async () => {
    await makePool({ usedSec: 19 * H });
    await db.update(bands).set({ extraSec: 3 * H }).where(eq(bands.id, bandId));
    const sid = await makeSession();
    expect(await svc.reserve(sid, bandId, 2 * H)).toEqual({ ok: true, alreadyCharged: false });
    const [c] = await db.select().from(analysisCharges).where(eq(analysisCharges.sessionId, sid));
    expect(c).toMatchObject({ monthlySec: H, extraSec: H, freeSec: 0 });
    const [band] = await db.select().from(bands).where(eq(bands.id, bandId));
    expect(band!.extraSec).toBe(2 * H);
    expect(band!.freeUsedSec).toBe(0);
  });

  it("예약은 다른 세션의 월 시간 계산에 바로 반영된다", async () => {
    await makePool({ usedSec: 0 });
    const a = await makeSession();
    const b = await makeSession();
    expect(await svc.reserve(a, bandId, 19 * H)).toMatchObject({ ok: true });
    expect(await svc.reserve(b, bandId, 2 * H)).toEqual({ ok: false, availableSec: H });
  });

  it("commit은 월 시간분을 used_sec에 더하고 charged로 바꾼다", async () => {
    const poolId = await makePool();
    const sid = await makeSession();
    await svc.reserve(sid, bandId, 2 * H);
    await svc.commit(sid);
    const [p] = await db.select().from(billingPools).where(eq(billingPools.id, poolId));
    expect(p!.usedSec).toBe(2 * H);
    const [c] = await db.select().from(analysisCharges).where(eq(analysisCharges.sessionId, sid));
    expect(c!.state).toBe("charged");
  });

  it("commit(sessionId, tx)는 넘긴 트랜잭션 안에서 동작한다", async () => {
    const poolId = await makePool();
    const sid = await makeSession();
    await svc.reserve(sid, bandId, 2 * H);
    await db.transaction(async (tx) => { await svc.commit(sid, tx); });
    const [p] = await db.select().from(billingPools).where(eq(billingPools.id, poolId));
    expect(p!.usedSec).toBe(2 * H);
    const [c] = await db.select().from(analysisCharges).where(eq(analysisCharges.sessionId, sid));
    expect(c!.state).toBe("charged");
  });

  it("refund는 무료·추가 시간을 되돌리고 used_sec은 건드리지 않는다", async () => {
    const poolId = await makePool({ usedSec: 19 * H });
    await db.update(bands).set({ extraSec: 3 * H }).where(eq(bands.id, bandId));
    const sid = await makeSession();
    await svc.reserve(sid, bandId, 2 * H);
    await svc.refund(sid);
    const [band] = await db.select().from(bands).where(eq(bands.id, bandId));
    expect(band!.extraSec).toBe(3 * H);
    const [p] = await db.select().from(billingPools).where(eq(billingPools.id, poolId));
    expect(p!.usedSec).toBe(19 * H);
    const [c] = await db.select().from(analysisCharges).where(eq(analysisCharges.sessionId, sid));
    expect(c!.state).toBe("refunded");
  });

  it("refunded 세션을 다시 예약하면 새로 차감한다", async () => {
    const sid = await makeSession();
    await svc.reserve(sid, bandId, H);
    await svc.refund(sid);
    expect(await svc.reserve(sid, bandId, H)).toEqual({ ok: true, alreadyCharged: false });
    const [band] = await db.select().from(bands).where(eq(bands.id, bandId));
    expect(band!.freeUsedSec).toBe(H);
  });

  it("charged 세션의 재예약은 차감 없이 alreadyCharged", async () => {
    const sid = await makeSession();
    await svc.reserve(sid, bandId, H);
    await svc.commit(sid);
    expect(await svc.reserve(sid, bandId, 3 * H)).toEqual({ ok: true, alreadyCharged: true });
    const [band] = await db.select().from(bands).where(eq(bands.id, bandId));
    expect(band!.freeUsedSec).toBe(H);
  });

  it("reserved 세션의 재예약은 기존 예약을 그대로 쓴다", async () => {
    const sid = await makeSession();
    await svc.reserve(sid, bandId, H);
    expect(await svc.reserve(sid, bandId, H)).toEqual({ ok: true, alreadyCharged: false });
    expect(await db.select().from(analysisCharges)).toHaveLength(1);
  });

  it("만료 풀에 연결된 밴드는 무료 → 추가 시간", async () => {
    await makePool({ status: "expired", usedSec: 20 * H });
    await db.update(bands).set({ extraSec: H, freeUsedSec: 2 * H }).where(eq(bands.id, bandId));
    const sid = await makeSession();
    expect(await svc.reserve(sid, bandId, 2 * H)).toMatchObject({ ok: true });
    const [c] = await db.select().from(analysisCharges).where(eq(analysisCharges.sessionId, sid));
    expect(c).toMatchObject({ freeSec: H, extraSec: H, monthlySec: 0 });
  });

  it("allowanceOf는 예약 합계를 뺀 값을 준다", async () => {
    await makePool({ usedSec: 5 * H });
    const sid = await makeSession();
    await svc.reserve(sid, bandId, 2 * H);
    expect((await svc.allowanceOf(bandId)).monthlyLeftSec).toBe(13 * H);
  });

  it("같은 세션의 동시 예약은 둘 다 ok이고 차감은 한 번뿐이다", async () => {
    const sid = await makeSession();
    const r = await Promise.all([svc.reserve(sid, bandId, H), svc.reserve(sid, bandId, H)]);
    expect(r).toEqual([
      { ok: true, alreadyCharged: false },
      { ok: true, alreadyCharged: false },
    ]);
    expect(await db.select().from(analysisCharges)).toHaveLength(1);
    const [band] = await db.select().from(bands).where(eq(bands.id, bandId));
    expect(band!.freeUsedSec).toBe(H);
  });

  it("같은 풀의 두 밴드가 동시에 예약해도 월 시간을 초과하지 않는다", async () => {
    const poolId = await makePool({ usedSec: 0 });
    const [b2] = await db.insert(bands).values({ name: "B2", poolId }).returning({ id: bands.id });
    const a = await makeSession();
    const [s2] = await db
      .insert(sessions)
      .values({ bandId: b2!.id, createdBy: userId, title: "T2", status: "analyzing", startedAt: new Date() })
      .returning({ id: sessions.id });
    const r = await Promise.all([svc.reserve(a, bandId, 15 * H), svc.reserve(s2!.id, b2!.id, 15 * H)]);
    expect(r.filter((x) => x.ok)).toHaveLength(1);
    expect(r.filter((x) => !x.ok)).toHaveLength(1);
  });

  it("needSec가 0 이하이면 예외", async () => {
    const sid = await makeSession();
    await expect(svc.reserve(sid, bandId, 0)).rejects.toThrow();
    await expect(svc.reserve(sid, bandId, -H)).rejects.toThrow();
  });
});
