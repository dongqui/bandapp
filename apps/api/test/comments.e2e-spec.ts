import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bandMembers, sessions, takes } from "../src/db/schema.js";
import { FakeStorage, createTestApp, loginAs, providerUser } from "./app-util.js";
import { createTestDb, truncateAll } from "./db-util.js";

describe("comments API", () => {
  const db = createTestDb();
  let app: INestApplication;
  let owner: { accessToken: string; userId: string };
  let bandId: string;
  let takeId: string;
  let sessionId: string;

  beforeEach(async () => {
    await truncateAll(db);
    app = await createTestApp({ google: providerUser("owner-1"), storage: new FakeStorage() });
    owner = await loginAs(app);
    const band = await request(app.getHttpServer()).post("/bands").set(auth(owner.accessToken)).send({ name: "B" }).expect(201);
    bandId = band.body.id;
    const [s] = await db
      .insert(sessions)
      .values({ bandId, createdBy: owner.userId, title: "t", status: "ready", startedAt: new Date(), durationMs: 600_000, takeCount: 1 })
      .returning();
    sessionId = s!.id;
    const [t] = await db
      .insert(takes)
      .values({ sessionId, index: 0, name: "Take 1", startMs: 0, endMs: 240_000, type: "PERFORMANCE", confidence: 0.9, objectKey: "k" })
      .returning();
    takeId = t!.id;
  });
  afterEach(() => app.close());

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  it("코멘트를 남기면 작성자 이름과 함께 돌아오고 목록은 시점 순이다", async () => {
    const later = await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ atSec: 120.7, text: "Rushing here" }).expect(201);
    expect(later.body).toEqual({
      id: expect.any(String),
      sessionId,
      takeId,
      authorId: owner.userId,
      authorName: "Dongjin",
      parentId: null,
      atSec: 120.7,
      text: "Rushing here",
      createdAt: expect.any(String),
      updatedAt: null,
    });
    await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ atSec: 5, text: "Count-in" }).expect(201);
    const res = await request(app.getHttpServer()).get(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).expect(200);
    expect(res.body.map((c: { text: string }) => c.text)).toEqual(["Count-in", "Rushing here"]);
    const takesRes = await request(app.getHttpServer()).get(`/sessions/${sessionId}/takes`).set(auth(owner.accessToken)).expect(200);
    expect(takesRes.body[0].commentCount).toBe(2);
  });

  it.each([
    ["빈 텍스트", { atSec: 1, text: "   " }],
    ["500자 초과", { atSec: 1, text: "a".repeat(501) }],
    ["음수 시점", { atSec: -1, text: "x" }],
    ["take 길이 초과", { atSec: 241, text: "x" }],
    ["문자열 시점", { atSec: "1", text: "x" }],
  ])("잘못된 입력은 400: %s", async (_label, body) => {
    await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send(body).expect(400);
  });

  it("답글은 부모의 시점을 물려받고, 목록에서 부모 뒤에 온다", async () => {
    const parent = await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ atSec: 133, text: "Rushing" }).expect(201);
    await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ atSec: 150, text: "later" }).expect(201);
    const reply = await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ parentId: parent.body.id, text: "felt it too" }).expect(201);
    expect(reply.body).toMatchObject({ parentId: parent.body.id, atSec: 133, text: "felt it too" });
    const res = await request(app.getHttpServer()).get(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).expect(200);
    expect(res.body.map((c: { text: string; parentId: string | null }) => [c.text, c.parentId])).toEqual([
      ["Rushing", null],
      ["felt it too", parent.body.id],
      ["later", null],
    ]);
  });

  it("답글은 commentCount에 세지 않는다", async () => {
    const parent = await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ atSec: 1, text: "a" }).expect(201);
    await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ parentId: parent.body.id, text: "b" }).expect(201);
    const takesRes = await request(app.getHttpServer()).get(`/sessions/${sessionId}/takes`).set(auth(owner.accessToken)).expect(200);
    expect(takesRes.body[0].commentCount).toBe(1);
    const sessionRes = await request(app.getHttpServer()).get(`/sessions/${sessionId}`).set(auth(owner.accessToken)).expect(200);
    expect(sessionRes.body.commentCount).toBe(1);
  });

  it("부모가 이 take의 최상위 코멘트가 아니면 400", async () => {
    const parent = await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ atSec: 1, text: "a" }).expect(201);
    const reply = await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ parentId: parent.body.id, text: "b" }).expect(201);
    // 답글의 답글은 막는다 — 스레드는 1단계
    await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ parentId: reply.body.id, text: "c" }).expect(400);
    // 다른 take의 코멘트
    const [other] = await db
      .insert(takes)
      .values({ sessionId, index: 1, name: "Take 2", startMs: 300_000, endMs: 400_000, type: "PERFORMANCE", confidence: 0.9, objectKey: "k2" })
      .returning();
    await request(app.getHttpServer()).post(`/takes/${other!.id}/comments`).set(auth(owner.accessToken)).send({ parentId: parent.body.id, text: "c" }).expect(400);
    // 없는 부모, UUID 아님, parentId 없이 atSec도 없음
    await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ parentId: "00000000-0000-0000-0000-000000000000", text: "c" }).expect(400);
    await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ parentId: "nope", text: "c" }).expect(400);
    await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ text: "c" }).expect(400);
  });

  it("다른 멤버의 코멘트도 보이고, 비멤버는 403", async () => {
    const other = await createTestApp({ google: providerUser("member-1", "Minsoo"), storage: new FakeStorage() });
    const member = await loginAs(other);
    await other.close();
    await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(member.accessToken)).send({ atSec: 1, text: "x" }).expect(403);
    await db.insert(bandMembers).values({ bandId, userId: member.userId, role: "member" });
    await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(member.accessToken)).send({ atSec: 1, text: "from minsoo" }).expect(201);
    const res = await request(app.getHttpServer()).get(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).expect(200);
    expect(res.body[0]).toMatchObject({ authorName: "Minsoo", text: "from minsoo" });
  });

  describe("수정·삭제", () => {
    async function memberOf(id: string, name: string) {
      const other = await createTestApp({ google: providerUser(id, name), storage: new FakeStorage() });
      const login = await loginAs(other);
      await other.close();
      await db.insert(bandMembers).values({ bandId, userId: login.userId, role: "member" });
      return login;
    }

    it("PATCH는 본문만 바꾸고 updatedAt을 채우며 목록에 반영된다", async () => {
      const c = await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ atSec: 10, text: "typo" }).expect(201);
      const res = await request(app.getHttpServer()).patch(`/comments/${c.body.id}`).set(auth(owner.accessToken)).send({ text: "  fixed  " }).expect(200);
      expect(res.body).toMatchObject({ id: c.body.id, text: "fixed", atSec: 10, updatedAt: expect.any(String) });
      const list = await request(app.getHttpServer()).get(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).expect(200);
      expect(list.body[0]).toMatchObject({ text: "fixed", updatedAt: res.body.updatedAt });
    });

    it.each([
      ["빈 텍스트", { text: "   " }],
      ["500자 초과", { text: "a".repeat(501) }],
      ["text 없음", {}],
    ])("PATCH 잘못된 입력은 400: %s", async (_label, body) => {
      const c = await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ atSec: 10, text: "x" }).expect(201);
      await request(app.getHttpServer()).patch(`/comments/${c.body.id}`).set(auth(owner.accessToken)).send(body).expect(400);
    });

    it("타인 코멘트는 수정·삭제 403, 비멤버는 403, 없는 id는 404", async () => {
      const minsoo = await memberOf("member-1", "Minsoo");
      const c = await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ atSec: 10, text: "mine" }).expect(201);
      await request(app.getHttpServer()).patch(`/comments/${c.body.id}`).set(auth(minsoo.accessToken)).send({ text: "hijack" }).expect(403);
      await request(app.getHttpServer()).delete(`/comments/${c.body.id}`).set(auth(minsoo.accessToken)).expect(403);
      const strangerApp = await createTestApp({ google: providerUser("stranger-1", "S"), storage: new FakeStorage() });
      const stranger = await loginAs(strangerApp);
      await strangerApp.close();
      await request(app.getHttpServer()).patch(`/comments/${c.body.id}`).set(auth(stranger.accessToken)).send({ text: "x" }).expect(403);
      await request(app.getHttpServer()).delete(`/comments/${c.body.id}`).set(auth(stranger.accessToken)).expect(403);
      await request(app.getHttpServer()).patch(`/comments/00000000-0000-0000-0000-000000000000`).set(auth(owner.accessToken)).send({ text: "x" }).expect(404);
      await request(app.getHttpServer()).delete(`/comments/00000000-0000-0000-0000-000000000000`).set(auth(owner.accessToken)).expect(404);
      await request(app.getHttpServer()).delete(`/comments/nope`).set(auth(owner.accessToken)).expect(400);
      // 아무것도 안 바뀌었다
      const list = await request(app.getHttpServer()).get(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0]).toMatchObject({ text: "mine", updatedAt: null });
    });

    it("부모를 지우면 답글도 사라지고 take·세션 commentCount가 준다", async () => {
      const minsoo = await memberOf("member-1", "Minsoo");
      const parent = await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ atSec: 10, text: "p" }).expect(201);
      await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(minsoo.accessToken)).send({ parentId: parent.body.id, text: "r" }).expect(201);
      await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ atSec: 20, text: "other" }).expect(201);
      await request(app.getHttpServer()).delete(`/comments/${parent.body.id}`).set(auth(owner.accessToken)).expect(204);
      const list = await request(app.getHttpServer()).get(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).expect(200);
      expect(list.body.map((c: { text: string }) => c.text)).toEqual(["other"]);
      const takesRes = await request(app.getHttpServer()).get(`/sessions/${sessionId}/takes`).set(auth(owner.accessToken)).expect(200);
      expect(takesRes.body[0].commentCount).toBe(1);
      const sessionRes = await request(app.getHttpServer()).get(`/sessions/${sessionId}`).set(auth(owner.accessToken)).expect(200);
      expect(sessionRes.body.commentCount).toBe(1);
    });

    it("답글은 작성자가 따로 지울 수 있고 부모는 남는다", async () => {
      const minsoo = await memberOf("member-1", "Minsoo");
      const parent = await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ atSec: 10, text: "p" }).expect(201);
      const reply = await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(minsoo.accessToken)).send({ parentId: parent.body.id, text: "r" }).expect(201);
      await request(app.getHttpServer()).delete(`/comments/${reply.body.id}`).set(auth(minsoo.accessToken)).expect(204);
      const list = await request(app.getHttpServer()).get(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).expect(200);
      expect(list.body.map((c: { text: string }) => c.text)).toEqual(["p"]);
    });
  });

  describe("원본 녹음 코멘트", () => {
    it("세션에 코멘트를 남기면 takeId가 null이고 take 목록에는 섞이지 않으며 세션 commentCount에 든다", async () => {
      const c = await request(app.getHttpServer()).post(`/sessions/${sessionId}/comments`).set(auth(owner.accessToken)).send({ atSec: 412.5, text: "Soundcheck ends here" }).expect(201);
      expect(c.body).toMatchObject({ sessionId, takeId: null, parentId: null, atSec: 412.5, text: "Soundcheck ends here", updatedAt: null });
      await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ atSec: 1, text: "on take" }).expect(201);
      const orig = await request(app.getHttpServer()).get(`/sessions/${sessionId}/comments`).set(auth(owner.accessToken)).expect(200);
      expect(orig.body.map((x: { text: string }) => x.text)).toEqual(["Soundcheck ends here"]);
      const takeList = await request(app.getHttpServer()).get(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).expect(200);
      expect(takeList.body.map((x: { text: string }) => x.text)).toEqual(["on take"]);
      const sessionRes = await request(app.getHttpServer()).get(`/sessions/${sessionId}`).set(auth(owner.accessToken)).expect(200);
      expect(sessionRes.body.commentCount).toBe(2);
      const takesRes = await request(app.getHttpServer()).get(`/sessions/${sessionId}/takes`).set(auth(owner.accessToken)).expect(200);
      expect(takesRes.body[0].commentCount).toBe(1);
    });

    it("원본 코멘트의 답글은 부모 시점을 물려받고, take 코멘트와 원본 코멘트는 서로 부모가 될 수 없다", async () => {
      const orig = await request(app.getHttpServer()).post(`/sessions/${sessionId}/comments`).set(auth(owner.accessToken)).send({ atSec: 100, text: "o" }).expect(201);
      const onTake = await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ atSec: 5, text: "t" }).expect(201);
      const reply = await request(app.getHttpServer()).post(`/sessions/${sessionId}/comments`).set(auth(owner.accessToken)).send({ parentId: orig.body.id, text: "r" }).expect(201);
      expect(reply.body).toMatchObject({ parentId: orig.body.id, atSec: 100, takeId: null });
      await request(app.getHttpServer()).post(`/sessions/${sessionId}/comments`).set(auth(owner.accessToken)).send({ parentId: onTake.body.id, text: "x" }).expect(400);
      await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ parentId: orig.body.id, text: "x" }).expect(400);
    });

    it("세션 길이를 넘는 시점은 400, 비멤버는 403, 없는 세션은 404", async () => {
      await request(app.getHttpServer()).post(`/sessions/${sessionId}/comments`).set(auth(owner.accessToken)).send({ atSec: 601, text: "x" }).expect(400);
      const strangerApp = await createTestApp({ google: providerUser("stranger-1", "S"), storage: new FakeStorage() });
      const stranger = await loginAs(strangerApp);
      await strangerApp.close();
      await request(app.getHttpServer()).get(`/sessions/${sessionId}/comments`).set(auth(stranger.accessToken)).expect(403);
      await request(app.getHttpServer()).get(`/sessions/00000000-0000-0000-0000-000000000000/comments`).set(auth(owner.accessToken)).expect(404);
    });

    it("원본 코멘트도 작성자가 수정·삭제할 수 있다", async () => {
      const c = await request(app.getHttpServer()).post(`/sessions/${sessionId}/comments`).set(auth(owner.accessToken)).send({ atSec: 1, text: "a" }).expect(201);
      await request(app.getHttpServer()).patch(`/comments/${c.body.id}`).set(auth(owner.accessToken)).send({ text: "b" }).expect(200);
      await request(app.getHttpServer()).delete(`/comments/${c.body.id}`).set(auth(owner.accessToken)).expect(204);
      const orig = await request(app.getHttpServer()).get(`/sessions/${sessionId}/comments`).set(auth(owner.accessToken)).expect(200);
      expect(orig.body).toEqual([]);
      const session = await request(app.getHttpServer()).get(`/sessions/${sessionId}`).set(auth(owner.accessToken)).expect(200);
      expect(session.body.commentCount).toBe(0);
    });
  });
});
