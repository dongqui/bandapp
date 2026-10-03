import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analysisCharges, bandMembers, bands, billingPools, sessions } from "../src/db/schema.js";
import { createTestApp, loginAs, providerUser } from "./app-util.js";
import { createTestDb, truncateAll } from "./db-util.js";

const H = 3600;

// 고정 날짜는 stale-active 규칙(기간 끝 3일 경과) 때문에 시간이 지나면 깨지므로 지금 기준 상대값으로 만든다.
const PERIOD_END = new Date(Date.now() + 30 * 24 * 3600 * 1000);

describe("billing API", () => {
  const db = createTestDb();
  let app: INestApplication;
  let owner: { accessToken: string; userId: string };
  let bandId: string;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function createBand(token: string, name = "B"): Promise<string> {
    const res = await request(app.getHttpServer()).post("/bands").set(auth(token)).send({ name }).expect(201);
    return res.body.id;
  }
  async function otherUser(subject: string) {
    const other = await createTestApp({ google: providerUser(subject, "Minsoo") });
    const login = await loginAs(other);
    await other.close();
    return login;
  }
  async function activePool(userId: string, plan: "band" | "plus" = "band", usedSec = 0): Promise<string> {
    const [p] = await db
      .insert(billingPools)
      .values({ ownerUserId: userId, plan, status: "active", usedSec, periodEnd: PERIOD_END, willRenew: true, store: "app_store" })
      .returning({ id: billingPools.id });
    return p!.id;
  }

  beforeEach(async () => {
    await truncateAll(db);
    app = await createTestApp({ google: providerUser("owner-1") });
    owner = await loginAs(app);
    bandId = await createBand(owner.accessToken);
  });
  afterEach(() => app.close());

  it("무료 밴드: state free, 무료 잔여 3h, 오너", async () => {
    const res = await request(app.getHttpServer()).get(`/bands/${bandId}/billing`).set(auth(owner.accessToken)).expect(200);
    expect(res.body).toMatchObject({
      state: "free", plan: null, availableSec: 3 * H, freeLeftSec: 3 * H, monthlyTotalSec: 0, extraSec: 0,
      isOwner: true, linkedBandCount: 0, canBuyExtra: false, myPool: null,
      owner: { id: owner.userId, displayName: "Dongjin" },
    });
  });

  it("비멤버는 403", async () => {
    const s = await otherUser("stranger-1");
    await request(app.getHttpServer()).get(`/bands/${bandId}/billing`).set(auth(s.accessToken)).expect(403);
  });

  it("오너가 풀을 가지면 myPool에 내가 오너인 밴드 전부가 linked 여부와 함께 온다 (삭제된 밴드 제외)", async () => {
    await activePool(owner.userId, "band", 5 * H);
    const second = await createBand(owner.accessToken, "Second");
    const deleted = await createBand(owner.accessToken, "Gone");
    await request(app.getHttpServer()).delete(`/bands/${deleted}`).set(auth(owner.accessToken)).expect(204);
    const res = await request(app.getHttpServer()).get(`/bands/${bandId}/billing`).set(auth(owner.accessToken)).expect(200);
    expect(res.body.state).toBe("free");
    expect(res.body.myPool).toMatchObject({ plan: "band", status: "active", monthlyLeftSec: 15 * H });
    expect(res.body.myPool.bands).toEqual([
      { id: bandId, name: "B", memberCount: 1, linked: false },
      { id: second, name: "Second", memberCount: 1, linked: false },
    ]);
  });

  it("link: 오너가 활성 풀에 연결하면 state linked, 월 시간이 보인다", async () => {
    await activePool(owner.userId, "plus", 2 * H);
    const res = await request(app.getHttpServer()).post(`/bands/${bandId}/billing/link`).set(auth(owner.accessToken)).expect(201);
    expect(res.body).toMatchObject({
      state: "linked", plan: "plus", monthlyTotalSec: 40 * H, monthlyLeftSec: 38 * H, monthlyUsedSec: 2 * H, availableSec: 38 * H,
      periodEnd: PERIOD_END.toISOString(), willRenew: true, store: "app_store", linkedBandCount: 1, canBuyExtra: true,
    });
    expect(res.body.myPool.bands[0].linked).toBe(true);
  });

  it("link: 활성 풀이 없으면 409 billing_no_active_pool", async () => {
    const res = await request(app.getHttpServer()).post(`/bands/${bandId}/billing/link`).set(auth(owner.accessToken)).expect(409);
    expect(res.body.code).toBe("billing_no_active_pool");
  });

  it("link/unlink: 멤버는 403 billing_owner_only", async () => {
    const m = await otherUser("member-1");
    await db.insert(bandMembers).values({ bandId, userId: m.userId, role: "member" });
    await activePool(m.userId);
    const res = await request(app.getHttpServer()).post(`/bands/${bandId}/billing/link`).set(auth(m.accessToken)).expect(403);
    expect(res.body.code).toBe("billing_owner_only");
    await request(app.getHttpServer()).post(`/bands/${bandId}/billing/unlink`).set(auth(m.accessToken)).expect(403);
  });

  it("멤버 시점: linked 밴드는 isOwner false, canBuyExtra true, myPool null, owner 이름", async () => {
    const poolId = await activePool(owner.userId);
    await db.update(bands).set({ poolId }).where(eq(bands.id, bandId));
    const m = await otherUser("member-2");
    await db.insert(bandMembers).values({ bandId, userId: m.userId, role: "member" });
    const res = await request(app.getHttpServer()).get(`/bands/${bandId}/billing`).set(auth(m.accessToken)).expect(200);
    expect(res.body).toMatchObject({ state: "linked", isOwner: false, canBuyExtra: true, myPool: null, owner: { displayName: "Dongjin" } });
  });

  it("만료 풀에 연결된 밴드: state expired, 무료 잔여 + 추가 시간, canBuyExtra false", async () => {
    const poolId = await activePool(owner.userId);
    await db.update(billingPools).set({ status: "expired", willRenew: false }).where(eq(billingPools.id, poolId));
    await db.update(bands).set({ poolId, freeUsedSec: 3 * H, extraSec: H }).where(eq(bands.id, bandId));
    const res = await request(app.getHttpServer()).get(`/bands/${bandId}/billing`).set(auth(owner.accessToken)).expect(200);
    expect(res.body).toMatchObject({ state: "expired", plan: "band", availableSec: H, freeLeftSec: 0, extraSec: H, canBuyExtra: false });
  });

  it("active인데 기간 끝이 한참 지난 풀(만료 웹훅 누락): state expired, canBuyExtra false", async () => {
    const poolId = await activePool(owner.userId);
    await db.update(billingPools).set({ periodEnd: new Date(Date.now() - 10 * 24 * H * 1000) }).where(eq(billingPools.id, poolId));
    await db.update(bands).set({ poolId }).where(eq(bands.id, bandId));
    const res = await request(app.getHttpServer()).get(`/bands/${bandId}/billing`).set(auth(owner.accessToken)).expect(200);
    expect(res.body).toMatchObject({ state: "expired", availableSec: 3 * H, canBuyExtra: false });
  });

  it("unlink: 밴드는 무료로 돌아가고 추가 시간은 남는다", async () => {
    const poolId = await activePool(owner.userId);
    await db.update(bands).set({ poolId, extraSec: H }).where(eq(bands.id, bandId));
    const res = await request(app.getHttpServer()).post(`/bands/${bandId}/billing/unlink`).set(auth(owner.accessToken)).expect(201);
    expect(res.body).toMatchObject({ state: "free", availableSec: 4 * H, extraSec: H, linkedBandCount: 0 });
  });

  it("오너를 양도하면 연결이 풀린다", async () => {
    const poolId = await activePool(owner.userId);
    await db.update(bands).set({ poolId }).where(eq(bands.id, bandId));
    const m = await otherUser("member-3");
    await db.insert(bandMembers).values({ bandId, userId: m.userId, role: "member" });
    await request(app.getHttpServer()).post(`/bands/${bandId}/transfer`).set(auth(owner.accessToken)).send({ userId: m.userId }).expect(204);
    const [band] = await db.select().from(bands).where(eq(bands.id, bandId));
    expect(band!.poolId).toBeNull();
  });

  it("link: 다른 사람의 활성 풀에 연결된 밴드는 409 billing_band_linked_elsewhere", async () => {
    const other = await otherUser("pool-owner-1");
    const otherPoolId = await activePool(other.userId);
    await db.update(bands).set({ poolId: otherPoolId }).where(eq(bands.id, bandId));
    await activePool(owner.userId);
    const res = await request(app.getHttpServer()).post(`/bands/${bandId}/billing/link`).set(auth(owner.accessToken)).expect(409);
    expect(res.body.code).toBe("billing_band_linked_elsewhere");
  });

  it("link: grace 풀도 연결된다", async () => {
    const poolId = await activePool(owner.userId);
    await db.update(billingPools).set({ status: "grace" }).where(eq(billingPools.id, poolId));
    const res = await request(app.getHttpServer()).post(`/bands/${bandId}/billing/link`).set(auth(owner.accessToken)).expect(201);
    expect(res.body.state).toBe("linked");
  });

  it("link: 만료된 풀이면 409 billing_no_active_pool", async () => {
    const poolId = await activePool(owner.userId);
    await db.update(billingPools).set({ status: "expired" }).where(eq(billingPools.id, poolId));
    const res = await request(app.getHttpServer()).post(`/bands/${bandId}/billing/link`).set(auth(owner.accessToken)).expect(409);
    expect(res.body.code).toBe("billing_no_active_pool");
  });

  it("예약된 차감은 myPool·본문의 monthlyLeftSec에서 빠진다", async () => {
    const poolId = await activePool(owner.userId, "band", 5 * H);
    await db.update(bands).set({ poolId }).where(eq(bands.id, bandId));
    const [s] = await db
      .insert(sessions)
      .values({ bandId, createdBy: owner.userId, title: "T", status: "analyzing", startedAt: new Date() })
      .returning({ id: sessions.id });
    await db.insert(analysisCharges).values({ sessionId: s!.id, bandId, poolId, monthlySec: 2 * H, state: "reserved" });
    const res = await request(app.getHttpServer()).get(`/bands/${bandId}/billing`).set(auth(owner.accessToken)).expect(200);
    expect(res.body.myPool.monthlyLeftSec).toBe(13 * H);
    expect(res.body.monthlyLeftSec).toBe(13 * H);
  });

  it("linkedBandCount는 같은 풀에 연결된 밴드 수", async () => {
    const poolId = await activePool(owner.userId);
    const second = await createBand(owner.accessToken, "Second");
    await db.update(bands).set({ poolId }).where(eq(bands.id, bandId));
    await db.update(bands).set({ poolId }).where(eq(bands.id, second));
    const res = await request(app.getHttpServer()).get(`/bands/${bandId}/billing`).set(auth(owner.accessToken)).expect(200);
    expect(res.body.linkedBandCount).toBe(2);
  });
});
