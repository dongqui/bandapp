import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bandMembers, bands, userIdentities, users } from "../src/db/schema.js";
import { createTestApp, loginAs, providerUser } from "./app-util.js";
import { createTestDb, truncateAll } from "./db-util.js";

describe("DELETE /me", () => {
  const db = createTestDb();
  let app: INestApplication;
  let me: { accessToken: string; refreshToken: string; userId: string };

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeEach(async () => {
    await truncateAll(db);
    app = await createTestApp({ google: providerUser("g-1") });
    me = await loginAs(app);
  });
  afterEach(() => app.close());

  it("탈퇴하면 세션 revoke + identity 삭제 + user 비식별화", async () => {
    await request(app.getHttpServer()).delete("/me").set(auth(me.accessToken)).expect(204);
    // 모든 로그인 세션 무효화 (완료 조건 10)
    await request(app.getHttpServer()).post("/auth/refresh").send({ refreshToken: me.refreshToken }).expect(401);
    // 잔여 access token으로도 /me는 401
    await request(app.getHttpServer()).get("/me").set(auth(me.accessToken)).expect(401);
    const identities = await db.query.userIdentities.findMany({
      where: eq(userIdentities.userId, me.userId),
    });
    expect(identities).toHaveLength(0);
    const row = await db.query.users.findFirst({ where: eq(users.id, me.userId) });
    expect(row?.deletedAt).toBeTruthy();
    expect(row?.displayName).toBeNull();
  });

  it("member로 속한 밴드에서는 자동 탈퇴된다", async () => {
    const [band] = await db.insert(bands).values({ name: "OTHERS" }).returning();
    const [other] = await db.insert(users).values({ displayName: "Owner" }).returning();
    await db.insert(bandMembers).values([
      { bandId: band!.id, userId: other!.id, role: "owner" },
      { bandId: band!.id, userId: me.userId, role: "member" },
    ]);
    await request(app.getHttpServer()).delete("/me").set(auth(me.accessToken)).expect(204);
    const remaining = await db.query.bandMembers.findMany({ where: eq(bandMembers.bandId, band!.id) });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.userId).toBe(other!.id);
  });

  it("혼자인 밴드는 함께 삭제된다", async () => {
    await request(app.getHttpServer()).post("/bands").set(auth(me.accessToken)).send({ name: "SOLO" }).expect(201);
    await request(app.getHttpServer()).delete("/me").set(auth(me.accessToken)).expect(204);
    expect(await db.query.bands.findMany()).toHaveLength(0);
  });

  it("다른 멤버가 있는 밴드의 유일 owner면 409 — 선행 처리 필요 (기획서 18장)", async () => {
    const res = await request(app.getHttpServer()).post("/bands").set(auth(me.accessToken)).send({ name: "FRIDAY NIGHT" }).expect(201);
    const [other] = await db.insert(users).values({ displayName: "Minsoo" }).returning();
    await db.insert(bandMembers).values({ bandId: res.body.id, userId: other!.id, role: "member" });
    await request(app.getHttpServer()).delete("/me").set(auth(me.accessToken)).expect(409);
    // 아무것도 지워지지 않았어야 한다
    await request(app.getHttpServer()).get("/me").set(auth(me.accessToken)).expect(200);
  });
});
