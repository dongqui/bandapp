import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bandInvites } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { createTestApp, loginAs, providerUser } from "./app-util.js";
import { createTestDb, truncateAll } from "./db-util.js";

describe("invites API", () => {
  const db = createTestDb();
  let app: INestApplication;
  let owner: { accessToken: string; userId: string };
  let bandId: string;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeEach(async () => {
    await truncateAll(db);
    app = await createTestApp({ google: providerUser("owner-1") });
    owner = await loginAs(app);
    const band = await request(app.getHttpServer())
      .post("/bands")
      .set(auth(owner.accessToken))
      .send({ name: "FRIDAY NIGHT" })
      .expect(201);
    bandId = band.body.id;
  });
  afterEach(() => app.close());

  async function memberLogin(subject = "member-1"): Promise<{ accessToken: string; userId: string }> {
    const other = await createTestApp({ google: providerUser(subject, "Minsoo") });
    const login = await loginAs(other);
    await other.close();
    return login;
  }

  function tokenFromUrl(url: string): string {
    return url.split("/invite/")[1]!;
  }

  async function createInvite(): Promise<{ id: string; url: string; token: string }> {
    const res = await request(app.getHttpServer())
      .post(`/bands/${bandId}/invites`)
      .set(auth(owner.accessToken))
      .expect(201);
    return { id: res.body.id, url: res.body.url, token: tokenFromUrl(res.body.url) };
  }

  it("owner는 초대를 만들고 URL은 INVITE_LINK_BASE_URL/invite/<token>", async () => {
    const invite = await createInvite();
    expect(invite.url).toMatch(/^https:\/\/invite\.test\/invite\/[A-Za-z0-9_-]{20,}$/);
    // 재사용을 위해 토큰을 평문으로 저장한다 (스펙 결정 6)
    const rows = await db.query.bandInvites.findMany({ where: eq(bandInvites.bandId, bandId) });
    expect(rows[0]!.token).toBe(invite.token);
  });

  it("member는 초대를 만들 수 없다 (403)", async () => {
    const member = await memberLogin();
    const invite = await createInvite();
    await request(app.getHttpServer())
      .post(`/invites/${invite.token}/join`)
      .set(auth(member.accessToken))
      .expect(200);
    await request(app.getHttpServer())
      .post(`/bands/${bandId}/invites`)
      .set(auth(member.accessToken))
      .expect(403);
  });

  it("비로그인으로도 preview는 최소 정보를 준다 (기획서 12장)", async () => {
    const invite = await createInvite();
    const res = await request(app.getHttpServer()).get(`/invites/${invite.token}`).expect(200);
    expect(res.body.band).toEqual({ name: "FRIDAY NIGHT", memberCount: 1 });
    expect(res.body.invitedBy).toEqual({ displayName: "Dongjin" });
    expect(typeof res.body.expiresAt).toBe("string");
    expect(res.body.band.id).toBeUndefined();
  });

  it("join은 멤버로 추가하고, 재호출은 idempotent하게 alreadyMember=true (기획서 15장)", async () => {
    const invite = await createInvite();
    const member = await memberLogin();
    const first = await request(app.getHttpServer())
      .post(`/invites/${invite.token}/join`)
      .set(auth(member.accessToken))
      .expect(200);
    expect(first.body).toEqual({ bandId, alreadyMember: false });
    const again = await request(app.getHttpServer())
      .post(`/invites/${invite.token}/join`)
      .set(auth(member.accessToken))
      .expect(200);
    expect(again.body).toEqual({ bandId, alreadyMember: true });
    const members = await request(app.getHttpServer())
      .get(`/bands/${bandId}/members`)
      .set(auth(owner.accessToken))
      .expect(200);
    expect(members.body).toHaveLength(2);
    expect(members.body[1]).toMatchObject({ role: "member", name: "Minsoo" });
  });

  it("만료/취소/미존재 초대는 404", async () => {
    await request(app.getHttpServer()).get("/invites/does-not-exist-token-x").expect(404);
    const invite = await createInvite();
    await db
      .update(bandInvites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(bandInvites.id, invite.id));
    await request(app.getHttpServer()).get(`/invites/${invite.token}`).expect(404);
    const revoked = await createInvite();
    await request(app.getHttpServer())
      .delete(`/bands/${bandId}/invites/${revoked.id}`)
      .set(auth(owner.accessToken))
      .expect(204);
    await request(app.getHttpServer()).get(`/invites/${revoked.token}`).expect(404);
  });

  it("비로그인 join은 401", async () => {
    const invite = await createInvite();
    await request(app.getHttpServer()).post(`/invites/${invite.token}/join`).expect(401);
  });

  it("동시에 두 번 join해도 500 없이 멤버는 한 명만 추가된다 (race-safe)", async () => {
    const invite = await createInvite();
    const member = await memberLogin();
    const [first, second] = await Promise.all([
      request(app.getHttpServer()).post(`/invites/${invite.token}/join`).set(auth(member.accessToken)),
      request(app.getHttpServer()).post(`/invites/${invite.token}/join`).set(auth(member.accessToken)),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const members = await request(app.getHttpServer())
      .get(`/bands/${bandId}/members`)
      .set(auth(owner.accessToken))
      .expect(200);
    expect(members.body).toHaveLength(2);
  });
});
