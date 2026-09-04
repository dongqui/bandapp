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
      takeId,
      authorId: owner.userId,
      authorName: "Dongjin",
      parentId: null,
      atSec: 120.7,
      text: "Rushing here",
      createdAt: expect.any(String),
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
});
