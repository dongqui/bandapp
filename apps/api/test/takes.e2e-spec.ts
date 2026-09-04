import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { comments, sessions, takes } from "../src/db/schema.js";
import { FakeStorage, createTestApp, loginAs, providerUser } from "./app-util.js";
import { createTestDb, truncateAll } from "./db-util.js";

describe("takes API", () => {
  const db = createTestDb();
  let app: INestApplication;
  let owner: { accessToken: string; userId: string };
  let bandId: string;
  let sessionId: string;

  beforeEach(async () => {
    await truncateAll(db);
    app = await createTestApp({ google: providerUser("owner-1"), storage: new FakeStorage() });
    owner = await loginAs(app);
    const band = await request(app.getHttpServer()).post("/bands").set(auth(owner.accessToken)).send({ name: "B" }).expect(201);
    bandId = band.body.id;
    const [s] = await db
      .insert(sessions)
      .values({ bandId, createdBy: owner.userId, title: "Sep 4 Rehearsal", status: "ready", startedAt: new Date(), durationMs: 600_000, takeCount: 2 })
      .returning();
    sessionId = s!.id;
    await db.insert(takes).values([
      { sessionId, index: 1, name: "Take 2", startMs: 300_000, endMs: 420_000, type: "PARTIAL_PRACTICE", confidence: 0.6, objectKey: `bands/${bandId}/sessions/${sessionId}/takes/t2.m4a` },
      { sessionId, index: 0, name: "Take 1", startMs: 10_000, endMs: 250_500, type: "PERFORMANCE", confidence: 0.9, objectKey: `bands/${bandId}/sessions/${sessionId}/takes/t1.m4a` },
    ]);
  });
  afterEach(() => app.close());

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  it("세션의 take를 index 순으로 commentCount와 함께 준다", async () => {
    const [first] = await db.select().from(takes).where(eq(takes.index, 0));
    await db.insert(comments).values({ takeId: first!.id, authorId: owner.userId, atMs: 1000, text: "x" });
    const res = await request(app.getHttpServer()).get(`/sessions/${sessionId}/takes`).set(auth(owner.accessToken)).expect(200);
    expect(res.body).toEqual([
      { id: first!.id, sessionId, index: 0, name: "Take 1", durationSec: 241, startMs: 10_000, endMs: 250_500, type: "PERFORMANCE", commentCount: 1 },
      expect.objectContaining({ index: 1, name: "Take 2", durationSec: 120, commentCount: 0 }),
    ]);
  });

  it("take 오디오 URL은 take 객체 키로 서명된다", async () => {
    const [first] = await db.select().from(takes).where(eq(takes.index, 0));
    const res = await request(app.getHttpServer()).get(`/takes/${first!.id}/audio`).set(auth(owner.accessToken)).expect(200);
    expect(res.body.url).toContain("/takes/t1.m4a");
  });

  it("비멤버는 403, 없는 take는 404", async () => {
    const other = await createTestApp({ google: providerUser("stranger-1", "S"), storage: new FakeStorage() });
    const stranger = await loginAs(other);
    await other.close();
    await request(app.getHttpServer()).get(`/sessions/${sessionId}/takes`).set(auth(stranger.accessToken)).expect(403);
    const [first] = await db.select().from(takes).where(eq(takes.index, 0));
    await request(app.getHttpServer()).get(`/takes/${first!.id}/audio`).set(auth(stranger.accessToken)).expect(403);
    await request(app.getHttpServer()).get("/takes/00000000-0000-0000-0000-000000000000/audio").set(auth(owner.accessToken)).expect(404);
  });
});
