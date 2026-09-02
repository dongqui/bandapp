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

  it("없는 토큰은 404 invite_not_found", async () => {
    const res = await request(app.getHttpServer()).get("/invites/does-not-exist-token-x").expect(404);
    expect(res.body.code).toBe("invite_not_found");
  });

  it("만료된 초대는 410 invite_expired", async () => {
    const invite = await createInvite();
    await db
      .update(bandInvites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(bandInvites.id, invite.id));
    const res = await request(app.getHttpServer()).get(`/invites/${invite.token}`).expect(410);
    expect(res.body.code).toBe("invite_expired");
    const join = await request(app.getHttpServer())
      .post(`/invites/${invite.token}/join`)
      .set(auth(owner.accessToken))
      .expect(410);
    expect(join.body.code).toBe("invite_expired");
  });

  it("취소된 초대는 410 invite_revoked이고, 만료까지 겹치면 revoked가 이긴다", async () => {
    const invite = await createInvite();
    await request(app.getHttpServer())
      .delete(`/bands/${bandId}/invites/${invite.id}`)
      .set(auth(owner.accessToken))
      .expect(204);
    const res = await request(app.getHttpServer()).get(`/invites/${invite.token}`).expect(410);
    expect(res.body.code).toBe("invite_revoked");

    await db
      .update(bandInvites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(bandInvites.id, invite.id));
    const both = await request(app.getHttpServer()).get(`/invites/${invite.token}`).expect(410);
    expect(both.body.code).toBe("invite_revoked");
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

  it("활성 초대가 있으면 재발급하지 않고 같은 링크를 준다", async () => {
    const first = await createInvite();
    const second = await createInvite();
    expect(second.url).toBe(first.url);
    expect(second.id).toBe(first.id);
    const rows = await db.query.bandInvites.findMany({ where: eq(bandInvites.bandId, bandId) });
    expect(rows).toHaveLength(1);
    // 재사용된 링크가 실제로 조회된다 — 평문 저장 왕복 확인
    await request(app.getHttpServer()).get(`/invites/${second.token}`).expect(200);
  });

  it("취소된 뒤에는 새 링크가 발급된다", async () => {
    const first = await createInvite();
    await request(app.getHttpServer())
      .delete(`/bands/${bandId}/invites/${first.id}`)
      .set(auth(owner.accessToken))
      .expect(204);
    const second = await createInvite();
    expect(second.url).not.toBe(first.url);
    await request(app.getHttpServer()).get(`/invites/${second.token}`).expect(200);
  });

  it("만료된 초대만 있으면 새 링크가 발급된다", async () => {
    const first = await createInvite();
    await db
      .update(bandInvites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(bandInvites.id, first.id));
    const second = await createInvite();
    expect(second.id).not.toBe(first.id);
    await request(app.getHttpServer()).get(`/invites/${second.token}`).expect(200);
  });

  it("잔여 수명이 6시간 미만이면 재사용하지 않고 방치한 채 새로 발급한다", async () => {
    const first = await createInvite();
    await db
      .update(bandInvites)
      .set({ expiresAt: new Date(Date.now() + 3 * 60 * 60 * 1000) }) // 6시간 미만 남김
      .where(eq(bandInvites.id, first.id));
    const second = await createInvite();
    expect(second.id).not.toBe(first.id);
    // 방치된 것이지 revoke된 게 아니다 — 스스로 만료될 때까지는 여전히 유효하다.
    await request(app.getHttpServer()).get(`/invites/${first.token}`).expect(200);
    await request(app.getHttpServer()).get(`/invites/${second.token}`).expect(200);
  });

  it("활성 초대가 여러 개면 createdAt이 가장 최근인 것을 재사용한다", async () => {
    const first = await createInvite();
    const [second] = await db
      .insert(bandInvites)
      .values({
        bandId,
        token: "second-live-invite-token-000000",
        createdBy: owner.userId,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        createdAt: new Date(Date.now() + 60 * 1000), // first보다 나중
      })
      .returning();
    const rows = await db.query.bandInvites.findMany({ where: eq(bandInvites.bandId, bandId) });
    expect(rows).toHaveLength(2); // 둘 다 활성 — 결정 5/6이 다루는 그 상태

    const reused = await createInvite();
    expect(reused.id).toBe(second!.id);
    expect(reused.token).toBe("second-live-invite-token-000000");
    expect(reused.id).not.toBe(first.id);
  });

  it("팀원을 내보낸 뒤 발급하면 이전과 다른 링크가 나온다", async () => {
    const before = await createInvite();
    const member = await memberLogin("kicked-then-reinvited");
    await request(app.getHttpServer())
      .post(`/invites/${before.token}/join`)
      .set(auth(member.accessToken))
      .expect(200);

    await request(app.getHttpServer())
      .delete(`/bands/${bandId}/members/${member.userId}`)
      .set(auth(owner.accessToken))
      .expect(204);

    // 내보내기가 활성 초대를 전부 무효화했으므로 재사용 대상이 없다 (스펙 결정 5·6)
    const after = await createInvite();
    expect(after.url).not.toBe(before.url);
    await request(app.getHttpServer()).get(`/invites/${before.token}`).expect(410);
    await request(app.getHttpServer()).get(`/invites/${after.token}`).expect(200);
  });
});
