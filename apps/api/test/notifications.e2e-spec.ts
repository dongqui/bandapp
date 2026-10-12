import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bandMembers, notifications, pushTokens, sessions, takes } from "../src/db/schema.js";
import { FakePushSender, FakeStorage, createTestApp, loginAs, providerUser } from "./app-util.js";
import { createTestDb, truncateAll } from "./db-util.js";

describe("notifications API", () => {
  const db = createTestDb();
  let app: INestApplication;
  let push: FakePushSender;
  let owner: { accessToken: string; userId: string };
  let minsu: { accessToken: string; userId: string };
  let bandId: string;
  let sessionId: string;
  let takeId: string;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const server = () => app.getHttpServer();

  async function memberOf(id: string, name: string) {
    const other = await createTestApp({ google: providerUser(id, name), storage: new FakeStorage() });
    const login = await loginAs(other);
    await other.close();
    await db.insert(bandMembers).values({ bandId, userId: login.userId, role: "member" });
    return login;
  }

  beforeEach(async () => {
    await truncateAll(db);
    push = new FakePushSender();
    app = await createTestApp({ google: providerUser("owner-1"), storage: new FakeStorage(), pushSender: push });
    owner = await loginAs(app);
    const band = await request(server()).post("/bands").set(auth(owner.accessToken)).send({ name: "FRIDAY NIGHT" }).expect(201);
    bandId = band.body.id;
    minsu = await memberOf("minsu", "Minsu");
    const [s] = await db
      .insert(sessions)
      .values({ bandId, createdBy: owner.userId, title: "Aug 28 Rehearsal", name: "Full set run-through", status: "ready", startedAt: new Date("2026-08-28T10:30:00Z"), durationMs: 8_040_000, takeCount: 1 })
      .returning();
    sessionId = s!.id;
    const [t] = await db.insert(takes).values({ sessionId, index: 0, name: "Take 1", startMs: 0, endMs: 240_000, type: "PERFORMANCE", confidence: 0.9, objectKey: "k" }).returning();
    takeId = t!.id;
  });
  afterEach(() => app.close());

  describe("코멘트 → 인박스", () => {
    it("작성자를 뺀 멤버에게 comment 행이 생기고 구조화된 항목으로 조회된다", async () => {
      const c = await request(server()).post(`/takes/${takeId}/comments`).set(auth(minsu.accessToken)).send({ atSec: 133, text: "Rushing going into the chorus" }).expect(201);
      const mine = await request(server()).get(`/bands/${bandId}/notifications`).set(auth(owner.accessToken)).expect(200);
      expect(mine.body).toEqual({
        items: [
          {
            id: expect.any(String),
            type: "comment",
            actor: { id: minsu.userId, name: "Minsu" },
            session: { id: sessionId, title: "Aug 28 Rehearsal", name: "Full set run-through", startedAt: "2026-08-28T10:30:00.000Z", takeCount: 1, durationSec: 8040 },
            take: { id: takeId, index: 0, name: "Take 1" },
            comment: { id: c.body.id, atSec: 133, text: "Rushing going into the chorus" },
            readAt: null,
            createdAt: expect.any(String),
          },
        ],
        nextCursor: null,
        remaining: 0,
        unreadCount: 1,
      });
      const theirs = await request(server()).get(`/bands/${bandId}/notifications`).set(auth(minsu.accessToken)).expect(200);
      expect(theirs.body.items).toEqual([]);
      const count = await request(server()).get(`/bands/${bandId}/notifications/unread-count`).set(auth(owner.accessToken)).expect(200);
      expect(count.body).toEqual({ count: 1 });
    });

    it("답글은 부모 작성자에게 reply, 제3자에게 comment; 원본 녹음 코멘트는 take가 null", async () => {
      const jihoon = await memberOf("jihoon", "Jihoon");
      const parent = await request(server()).post(`/sessions/${sessionId}/comments`).set(auth(owner.accessToken)).send({ atSec: 5, text: "orig" }).expect(201);
      await request(server()).post(`/sessions/${sessionId}/comments`).set(auth(minsu.accessToken)).send({ parentId: parent.body.id, text: "yes" }).expect(201);
      const ownerInbox = await request(server()).get(`/bands/${bandId}/notifications`).set(auth(owner.accessToken)).expect(200);
      expect(ownerInbox.body.items[0]).toMatchObject({ type: "reply", take: null, comment: { text: "yes" } });
      const jihoonInbox = await request(server()).get(`/bands/${bandId}/notifications`).set(auth(jihoon.accessToken)).expect(200);
      // jihoon은 owner의 원본 코멘트(comment)와 minsu의 답글(comment) 둘
      expect(jihoonInbox.body.items.map((i: { type: string }) => i.type)).toEqual(["comment", "comment"]);
    });

    it("설정이 off면 행이 생기지 않고, scope=mine은 reply만 받는다", async () => {
      await request(server()).put(`/bands/${bandId}/notification-settings`).set(auth(owner.accessToken)).send({ sessionReady: true, comments: true, commentScope: "mine" }).expect(200);
      const jihoon = await memberOf("jihoon", "Jihoon");
      await request(server()).put(`/bands/${bandId}/notification-settings`).set(auth(jihoon.accessToken)).send({ sessionReady: true, comments: false, commentScope: "all" }).expect(200);
      const parent = await request(server()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ atSec: 1, text: "mine" }).expect(201);
      await request(server()).post(`/takes/${takeId}/comments`).set(auth(minsu.accessToken)).send({ atSec: 2, text: "top" }).expect(201);
      await request(server()).post(`/takes/${takeId}/comments`).set(auth(minsu.accessToken)).send({ parentId: parent.body.id, text: "reply" }).expect(201);
      const ownerInbox = await request(server()).get(`/bands/${bandId}/notifications`).set(auth(owner.accessToken)).expect(200);
      expect(ownerInbox.body.items.map((i: { type: string; comment: { text: string } }) => [i.type, i.comment.text])).toEqual([["reply", "reply"]]);
      const jihoonInbox = await request(server()).get(`/bands/${bandId}/notifications`).set(auth(jihoon.accessToken)).expect(200);
      expect(jihoonInbox.body.items).toEqual([]);
    });

    it("코멘트를 지우면 알림도 사라진다 (cascade)", async () => {
      const c = await request(server()).post(`/takes/${takeId}/comments`).set(auth(minsu.accessToken)).send({ atSec: 1, text: "x" }).expect(201);
      await request(server()).delete(`/comments/${c.body.id}`).set(auth(minsu.accessToken)).expect(204);
      const inbox = await request(server()).get(`/bands/${bandId}/notifications`).set(auth(owner.accessToken)).expect(200);
      expect(inbox.body.items).toEqual([]);
    });
  });

  describe("읽음·페이지", () => {
    async function seed(n: number) {
      // 같은 트랜잭션 insert처럼 created_at이 겹치는 상황도 섞는다
      const now = new Date();
      await db.insert(notifications).values(
        Array.from({ length: n }, (_, i) => ({
          userId: owner.userId,
          bandId,
          type: "comment" as const,
          actorId: minsu.userId,
          sessionId,
          takeId,
          createdAt: new Date(now.getTime() - Math.floor(i / 2) * 1000),
        })),
      );
    }

    it("read → unreadCount 감소, 남의 알림 read는 404, read-all", async () => {
      await seed(3);
      const page = await request(server()).get(`/bands/${bandId}/notifications`).set(auth(owner.accessToken)).expect(200);
      expect(page.body.unreadCount).toBe(3);
      await request(server()).post(`/notifications/${page.body.items[0].id}/read`).set(auth(owner.accessToken)).expect(204);
      await request(server()).post(`/notifications/${page.body.items[0].id}/read`).set(auth(owner.accessToken)).expect(204); // 두 번도 204
      await request(server()).post(`/notifications/${page.body.items[1].id}/read`).set(auth(minsu.accessToken)).expect(404);
      let count = await request(server()).get(`/bands/${bandId}/notifications/unread-count`).set(auth(owner.accessToken)).expect(200);
      expect(count.body.count).toBe(2);
      await request(server()).post(`/bands/${bandId}/notifications/read-all`).set(auth(owner.accessToken)).expect(204);
      count = await request(server()).get(`/bands/${bandId}/notifications/unread-count`).set(auth(owner.accessToken)).expect(200);
      expect(count.body.count).toBe(0);
    });

    it("같은 시각에 만들어진 알림도 커서가 건너뛰지 않는다 (limit 기본 6, remaining)", async () => {
      await seed(15);
      const seen: string[] = [];
      let cursor: string | null = null;
      let remainingSeq: number[] = [];
      do {
        const res: request.Response = await request(server()).get(`/bands/${bandId}/notifications`).query(cursor ? { cursor } : {}).set(auth(owner.accessToken)).expect(200);
        expect(res.body.items.length).toBeLessThanOrEqual(6);
        seen.push(...res.body.items.map((i: { id: string }) => i.id));
        remainingSeq.push(res.body.remaining);
        cursor = res.body.nextCursor;
      } while (cursor);
      expect(new Set(seen).size).toBe(15);
      expect(remainingSeq).toEqual([9, 3, 0]);
    });

    it("limit은 1~50, 깨진 커서는 400, 30일 지난 행은 지워진다", async () => {
      await request(server()).get(`/bands/${bandId}/notifications`).query({ limit: 0 }).set(auth(owner.accessToken)).expect(400);
      await request(server()).get(`/bands/${bandId}/notifications`).query({ limit: 51 }).set(auth(owner.accessToken)).expect(400);
      await request(server()).get(`/bands/${bandId}/notifications`).query({ cursor: "nope" }).set(auth(owner.accessToken)).expect(400);
      await db.insert(notifications).values({ userId: owner.userId, bandId, type: "comment", actorId: minsu.userId, sessionId, takeId, createdAt: new Date(Date.now() - 31 * 24 * 3600 * 1000) });
      const res = await request(server()).get(`/bands/${bandId}/notifications`).set(auth(owner.accessToken)).expect(200);
      expect(res.body.items).toEqual([]);
      expect(await db.select().from(notifications).where(eq(notifications.userId, owner.userId))).toEqual([]);
    });

    it("비멤버는 403", async () => {
      const stranger = await createTestApp({ google: providerUser("stranger"), storage: new FakeStorage() });
      const s = await loginAs(stranger);
      await stranger.close();
      await request(server()).get(`/bands/${bandId}/notifications`).set(auth(s.accessToken)).expect(403);
      await request(server()).post(`/bands/${bandId}/notifications/read-all`).set(auth(s.accessToken)).expect(403);
      await request(server()).put(`/bands/${bandId}/notification-settings`).set(auth(s.accessToken)).send({ sessionReady: true, comments: true, commentScope: "all" }).expect(403);
    });
  });

  describe("설정", () => {
    it("GET은 모든 밴드를 기본값으로 채워 주고 PUT 뒤 반영되며, 밴드를 나가면 설정이 사라진다", async () => {
      let res = await request(server()).get("/me/notification-settings").set(auth(minsu.accessToken)).expect(200);
      expect(res.body).toEqual([{ bandId, sessionReady: true, comments: true, commentScope: "all" }]);
      const put = await request(server()).put(`/bands/${bandId}/notification-settings`).set(auth(minsu.accessToken)).send({ sessionReady: false, comments: true, commentScope: "mine" }).expect(200);
      expect(put.body).toEqual({ bandId, sessionReady: false, comments: true, commentScope: "mine" });
      res = await request(server()).get("/me/notification-settings").set(auth(minsu.accessToken)).expect(200);
      expect(res.body).toEqual([{ bandId, sessionReady: false, comments: true, commentScope: "mine" }]);
      await request(server()).delete(`/bands/${bandId}/members/me`).set(auth(minsu.accessToken)).expect(204);
      res = await request(server()).get("/me/notification-settings").set(auth(minsu.accessToken)).expect(200);
      expect(res.body).toEqual([]);
    });

    it.each([
      { sessionReady: true, comments: true },
      { sessionReady: "yes", comments: true, commentScope: "all" },
      { sessionReady: true, comments: true, commentScope: "everyone" },
    ])("잘못된 입력은 400: %o", async (body) => {
      await request(server()).put(`/bands/${bandId}/notification-settings`).set(auth(owner.accessToken)).send(body).expect(400);
    });
  });

  describe("푸시 토큰", () => {
    it("upsert·다른 계정 덮어쓰기·삭제", async () => {
      await request(server()).put("/me/push-tokens").set(auth(owner.accessToken)).send({ token: "tok-1", platform: "ios", locale: "ko-KR" }).expect(204);
      await request(server()).put("/me/push-tokens").set(auth(owner.accessToken)).send({ token: "tok-1", platform: "ios", locale: "en" }).expect(204);
      let rows = await db.select().from(pushTokens);
      expect(rows).toEqual([expect.objectContaining({ token: "tok-1", userId: owner.userId, locale: "en" })]);
      await request(server()).put("/me/push-tokens").set(auth(minsu.accessToken)).send({ token: "tok-1", platform: "ios", locale: "en" }).expect(204);
      rows = await db.select().from(pushTokens);
      expect(rows[0]!.userId).toBe(minsu.userId);
      await request(server()).delete("/me/push-tokens/tok-1").set(auth(owner.accessToken)).expect(204); // 내 토큰이 아니어도 204
      await request(server()).delete("/me/push-tokens/tok-1").set(auth(minsu.accessToken)).expect(204);
      expect(await db.select().from(pushTokens)).toEqual([]);
    });

    it.each([{ platform: "ios", locale: "en" }, { token: "t", platform: "web", locale: "en" }, { token: "t", platform: "ios" }])("잘못된 입력은 400: %o", async (body) => {
      await request(server()).put("/me/push-tokens").set(auth(owner.accessToken)).send(body).expect(400);
    });

    it("코멘트가 달리면 수신자 토큰으로 locale별 문구가 가고, unregistered 토큰은 지워진다", async () => {
      await request(server()).put("/me/push-tokens").set(auth(owner.accessToken)).send({ token: "ko-dev", platform: "ios", locale: "ko-KR" }).expect(204);
      await request(server()).put("/me/push-tokens").set(auth(owner.accessToken)).send({ token: "en-dev", platform: "android", locale: "en-US" }).expect(204);
      await request(server()).put("/me/push-tokens").set(auth(minsu.accessToken)).send({ token: "minsu-dev", platform: "ios", locale: "en" }).expect(204);
      push.invalid = ["en-dev"];
      await request(server()).post(`/takes/${takeId}/comments`).set(auth(minsu.accessToken)).send({ atSec: 133, text: "Rushing" }).expect(201);
      // 작성자(minsu)에게는 안 간다
      expect(push.sent.flatMap((s) => s.tokens).sort()).toEqual(["en-dev", "ko-dev"]);
      const ko = push.sent.find((s) => s.tokens.includes("ko-dev"))!;
      expect(ko.message.title).toBe("Minsu님이 Take 1에 코멘트를 남겼어요");
      expect(ko.message.data).toEqual({ notificationId: expect.any(String), bandId, sessionId, type: "comment", takeId, atMs: "133000" });
      const en = push.sent.find((s) => s.tokens.includes("en-dev"))!;
      expect(en.message.title).toBe("Minsu commented on Take 1");
      const rows = await db.select({ token: pushTokens.token }).from(pushTokens);
      expect(rows.map((r) => r.token).sort()).toEqual(["ko-dev", "minsu-dev"]);
    });
  });
});
