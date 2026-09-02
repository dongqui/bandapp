import type { INestApplication } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bandMembers } from "../src/db/schema.js";
import { createTestApp, loginAs, providerUser } from "./app-util.js";
import { createTestDb, truncateAll } from "./db-util.js";

describe("bands API", () => {
  const db = createTestDb();
  let app: INestApplication;
  let owner: { accessToken: string; userId: string };

  beforeEach(async () => {
    await truncateAll(db);
    app = await createTestApp({ google: providerUser("owner-1") });
    owner = await loginAs(app);
  });
  afterEach(() => app.close());

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function createBand(token: string, name = "FRIDAY NIGHT"): Promise<string> {
    const res = await request(app.getHttpServer()).post("/bands").set(auth(token)).send({ name }).expect(201);
    return res.body.id;
  }

  async function secondUser(subject = "member-1"): Promise<{ accessToken: string; userId: string }> {
    const other = await createTestApp({ google: providerUser(subject, "Minsoo") });
    const login = await loginAs(other);
    await other.close();
    return login;
  }

  it("밴드를 만들면 만든 사람이 owner다", async () => {
    const res = await request(app.getHttpServer())
      .post("/bands")
      .set(auth(owner.accessToken))
      .send({ name: "FRIDAY NIGHT" })
      .expect(201);
    expect(res.body).toMatchObject({ name: "FRIDAY NIGHT", memberCount: 1 });
    const members = await request(app.getHttpServer())
      .get(`/bands/${res.body.id}/members`)
      .set(auth(owner.accessToken))
      .expect(200);
    expect(members.body).toEqual([
      { id: owner.userId, name: "Dongjin", role: "owner", part: null },
    ]);
  });

  it("멤버 목록은 파트를 함께 준다", async () => {
    const bandId = await createBand(owner.accessToken);
    await db
      .update(bandMembers)
      .set({ part: "guitar" })
      .where(and(eq(bandMembers.bandId, bandId), eq(bandMembers.userId, owner.userId)));
    const res = await request(app.getHttpServer())
      .get(`/bands/${bandId}/members`)
      .set(auth(owner.accessToken))
      .expect(200);
    expect(res.body[0]).toMatchObject({ role: "owner", part: "guitar" });
  });

  it("GET /bands는 내가 속한 밴드만 memberCount와 함께 준다", async () => {
    const bandId = await createBand(owner.accessToken);
    const stranger = await secondUser("stranger-1");
    await db.insert(bandMembers).values({ bandId, userId: stranger.userId, role: "member" });
    const mine = await request(app.getHttpServer()).get("/bands").set(auth(owner.accessToken)).expect(200);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0]).toMatchObject({ id: bandId, memberCount: 2 });
    const theirs = await request(app.getHttpServer()).get("/bands").set(auth(stranger.accessToken)).expect(200);
    expect(theirs.body).toHaveLength(1);
  });

  it("비멤버는 멤버 목록에 403 — 서버가 항상 검증한다 (기획서 9장)", async () => {
    const bandId = await createBand(owner.accessToken);
    const stranger = await secondUser("stranger-2");
    await request(app.getHttpServer())
      .get(`/bands/${bandId}/members`)
      .set(auth(stranger.accessToken))
      .expect(403);
  });

  it("member는 탈퇴할 수 있다", async () => {
    const bandId = await createBand(owner.accessToken);
    const member = await secondUser();
    await db.insert(bandMembers).values({ bandId, userId: member.userId, role: "member" });
    await request(app.getHttpServer())
      .delete(`/bands/${bandId}/members/me`)
      .set(auth(member.accessToken))
      .expect(204);
    const members = await request(app.getHttpServer())
      .get(`/bands/${bandId}/members`)
      .set(auth(owner.accessToken))
      .expect(200);
    expect(members.body).toHaveLength(1);
  });

  it("다른 멤버가 있는 밴드의 owner 탈퇴는 409", async () => {
    const bandId = await createBand(owner.accessToken);
    const member = await secondUser();
    await db.insert(bandMembers).values({ bandId, userId: member.userId, role: "member" });
    await request(app.getHttpServer())
      .delete(`/bands/${bandId}/members/me`)
      .set(auth(owner.accessToken))
      .expect(409);
  });

  it("혼자 남은 owner가 탈퇴하면 밴드가 삭제된다", async () => {
    const bandId = await createBand(owner.accessToken);
    await request(app.getHttpServer())
      .delete(`/bands/${bandId}/members/me`)
      .set(auth(owner.accessToken))
      .expect(204);
    const mine = await request(app.getHttpServer()).get("/bands").set(auth(owner.accessToken)).expect(200);
    expect(mine.body).toHaveLength(0);
  });

  it("본인 파트를 설정하고 해제한다", async () => {
    const bandId = await createBand(owner.accessToken);
    const set = await request(app.getHttpServer())
      .patch(`/bands/${bandId}/members/me`)
      .set(auth(owner.accessToken))
      .send({ part: "guitar" })
      .expect(200);
    expect(set.body).toMatchObject({ id: owner.userId, role: "owner", part: "guitar" });

    const cleared = await request(app.getHttpServer())
      .patch(`/bands/${bandId}/members/me`)
      .set(auth(owner.accessToken))
      .send({ part: null })
      .expect(200);
    expect(cleared.body.part).toBeNull();
  });

  it("정의되지 않은 파트는 400, 비멤버는 403", async () => {
    const bandId = await createBand(owner.accessToken);
    await request(app.getHttpServer())
      .patch(`/bands/${bandId}/members/me`)
      .set(auth(owner.accessToken))
      .send({ part: "trumpet" })
      .expect(400);
    await request(app.getHttpServer())
      .patch(`/bands/${bandId}/members/me`)
      .set(auth(owner.accessToken))
      .send({})
      .expect(400);
    const stranger = await secondUser("stranger-part");
    await request(app.getHttpServer())
      .patch(`/bands/${bandId}/members/me`)
      .set(auth(stranger.accessToken))
      .send({ part: "bass" })
      .expect(403);
  });

  it("이름이 비면 400, 토큰 없으면 401", async () => {
    await request(app.getHttpServer()).post("/bands").set(auth(owner.accessToken)).send({ name: "  " }).expect(400);
    await request(app.getHttpServer()).get("/bands").expect(401);
  });
});
