import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bandMembers, bands, billingEvents, billingPools, extraPurchases } from "../src/db/schema.js";
import { FakeRevenueCat, createTestApp, loginAs, providerUser } from "./app-util.js";
import { createTestDb, truncateAll } from "./db-util.js";

const H = 3600;
const SECRET = "whsec-test";
const activeBand = (expires = "2099-01-01T00:00:00Z", purchase = "2026-10-03T00:00:00Z") => ({
  "rehearsal.band.monthly": { purchase_date: purchase, expires_date: expires, store: "app_store", unsubscribe_detected_at: null, billing_issues_detected_at: null, period_type: "normal" },
});

describe("billing sync + webhook", () => {
  const db = createTestDb();
  let app: INestApplication;
  let rc: FakeRevenueCat;
  let owner: { accessToken: string; userId: string };
  let bandId: string;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeEach(async () => {
    process.env.REVENUECAT_WEBHOOK_SECRET = SECRET;
    await truncateAll(db);
    rc = new FakeRevenueCat();
    app = await createTestApp({ google: providerUser("owner-1"), revenueCat: rc });
    owner = await loginAs(app);
    const res = await request(app.getHttpServer()).post("/bands").set(auth(owner.accessToken)).send({ name: "B" }).expect(201);
    bandId = res.body.id;
  });
  afterEach(() => app.close());

  // async로 만들면 supertest Test가 await되어 .expect를 못 쓴다 — 그냥 Test를 돌려준다
  function webhook(event: Record<string, unknown>, secret = SECRET) {
    return request(app.getHttpServer()).post("/webhooks/revenuecat").set({ authorization: `Bearer ${secret}` }).send({ api_version: "1.0", event });
  }

  it("sync(bandId): 구독을 풀에 반영하고 그 밴드를 자동 연결한다", async () => {
    rc.subscribers.set(owner.userId, { subscriptions: activeBand(), non_subscriptions: {} });
    const res = await request(app.getHttpServer()).post("/billing/sync").set(auth(owner.accessToken)).send({ bandId }).expect(201);
    expect(res.body).toMatchObject({ state: "linked", plan: "band", monthlyLeftSec: 20 * H, periodEnd: "2099-01-01T00:00:00.000Z" });
    const [pool] = await db.select().from(billingPools).where(eq(billingPools.ownerUserId, owner.userId));
    expect(pool).toMatchObject({ plan: "band", status: "active", willRenew: true, store: "app_store" });
  });

  it("sync 없이 bandId만 멤버가 아닌 밴드면 403", async () => {
    const other = await createTestApp({ google: providerUser("x-1", "X"), revenueCat: rc });
    const x = await loginAs(other);
    await other.close();
    await request(app.getHttpServer()).post("/billing/sync").set(auth(x.accessToken)).send({ bandId }).expect(403);
  });

  it("갱신(period_start 변경)이면 used_sec이 0이 된다", async () => {
    rc.subscribers.set(owner.userId, { subscriptions: activeBand("2026-11-03T00:00:00Z", "2026-10-03T00:00:00Z"), non_subscriptions: {} });
    await request(app.getHttpServer()).post("/billing/sync").set(auth(owner.accessToken)).send({}).expect(201);
    await db.update(billingPools).set({ usedSec: 7 * H }).where(eq(billingPools.ownerUserId, owner.userId));
    rc.subscribers.set(owner.userId, { subscriptions: activeBand("2026-12-03T00:00:00Z", "2026-11-03T00:00:00Z"), non_subscriptions: {} });
    await request(app.getHttpServer()).post("/billing/sync").set(auth(owner.accessToken)).send({}).expect(201);
    const [pool] = await db.select().from(billingPools).where(eq(billingPools.ownerUserId, owner.userId));
    expect(pool!.usedSec).toBe(0);
  });

  it("같은 기간의 재동기화는 used_sec을 유지한다", async () => {
    rc.subscribers.set(owner.userId, { subscriptions: activeBand(), non_subscriptions: {} });
    await request(app.getHttpServer()).post("/billing/sync").set(auth(owner.accessToken)).send({}).expect(201);
    await db.update(billingPools).set({ usedSec: 7 * H }).where(eq(billingPools.ownerUserId, owner.userId));
    await request(app.getHttpServer()).post("/billing/sync").set(auth(owner.accessToken)).send({}).expect(201);
    const [pool] = await db.select().from(billingPools).where(eq(billingPools.ownerUserId, owner.userId));
    expect(pool!.usedSec).toBe(7 * H);
  });

  it("추가 시간: 멤버가 sync(bandId)하면 밴드 extra_sec에 3h, 두 번째 sync는 중복 반영 안 함", async () => {
    const other = await createTestApp({ google: providerUser("member-1", "M"), revenueCat: rc });
    const m = await loginAs(other);
    await other.close();
    await db.insert(bandMembers).values({ bandId, userId: m.userId, role: "member" });
    rc.subscribers.set(m.userId, { subscriptions: {}, non_subscriptions: { "rehearsal.extra.3h": [{ id: "tx-1", purchase_date: "2026-10-04T00:00:00Z", store: "play_store" }] } });
    await request(app.getHttpServer()).post("/billing/sync").set(auth(m.accessToken)).send({ bandId }).expect(201);
    await request(app.getHttpServer()).post("/billing/sync").set(auth(m.accessToken)).send({ bandId }).expect(201);
    const [band] = await db.select().from(bands).where(eq(bands.id, bandId));
    expect(band!.extraSec).toBe(3 * H);
    const [p] = await db.select().from(extraPurchases).where(eq(extraPurchases.transactionId, "tx-1"));
    expect(p).toMatchObject({ userId: m.userId, bandId, sec: 3 * H });
    expect(p!.appliedAt).not.toBeNull();
  });

  it("웹훅: 시크릿이 틀리면 401, 맞으면 동기화되고 같은 event id는 한 번만 저장", async () => {
    rc.subscribers.set(owner.userId, { subscriptions: activeBand(), non_subscriptions: {} });
    await webhook({ id: "ev-1", type: "INITIAL_PURCHASE", app_user_id: owner.userId }, "wrong").expect(401);
    await webhook({ id: "ev-1", type: "INITIAL_PURCHASE", app_user_id: owner.userId }).expect(200);
    await webhook({ id: "ev-1", type: "INITIAL_PURCHASE", app_user_id: owner.userId }).expect(200);
    expect(await db.select().from(billingEvents)).toHaveLength(1);
    const [pool] = await db.select().from(billingPools).where(eq(billingPools.ownerUserId, owner.userId));
    expect(pool).toMatchObject({ plan: "band", status: "active" });
  });

  it("웹훅의 소모성 거래는 subscriber_attributes.band_id로 배정하고, 없으면 미배정으로 남긴다", async () => {
    rc.subscribers.set(owner.userId, {
      subscriptions: activeBand(),
      non_subscriptions: { "rehearsal.extra.3h": [{ id: "tx-a", purchase_date: "2026-10-04T00:00:00Z", store: "app_store" }] },
      subscriber_attributes: { band_id: { value: bandId } },
    });
    await webhook({ id: "ev-a", type: "NON_RENEWING_PURCHASE", app_user_id: owner.userId }).expect(200);
    let [band] = await db.select().from(bands).where(eq(bands.id, bandId));
    expect(band!.extraSec).toBe(3 * H);

    rc.subscribers.set(owner.userId, {
      subscriptions: activeBand(),
      non_subscriptions: { "rehearsal.extra.3h": [{ id: "tx-a", purchase_date: "2026-10-04T00:00:00Z", store: "app_store" }, { id: "tx-b", purchase_date: "2026-10-05T00:00:00Z", store: "app_store" }] },
    });
    await webhook({ id: "ev-b", type: "NON_RENEWING_PURCHASE", app_user_id: owner.userId }).expect(200);
    const [pending] = await db.select().from(extraPurchases).where(eq(extraPurchases.transactionId, "tx-b"));
    expect(pending!.bandId).toBeNull();
    expect(pending!.appliedAt).toBeNull();

    // 나중에 앱이 bandId로 sync하면 배정된다
    await request(app.getHttpServer()).post("/billing/sync").set(auth(owner.accessToken)).send({ bandId }).expect(201);
    [band] = await db.select().from(bands).where(eq(bands.id, bandId));
    expect(band!.extraSec).toBe(6 * H);
  });

  it("웹훅: 모르는 사용자 id는 200으로 무시한다", async () => {
    await webhook({ id: "ev-z", type: "RENEWAL", app_user_id: "00000000-0000-0000-0000-000000000000" }).expect(200);
    await webhook({ id: "ev-y", type: "RENEWAL", app_user_id: "$RCAnonymousID:abc" }).expect(200);
  });
});
