import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { comments, sessions, takes } from "../src/db/schema.js";
import { FakeProducer, FakeStorage, createTestApp, loginAs, providerUser } from "./app-util.js";
import { createTestDb, truncateAll } from "./db-util.js";

/** 길이 128, 0~254 — 워커가 저장한 피크가 그대로 돌아오는지 본다 */
const SEED_PEAKS = Array.from({ length: 128 }, (_, i) => i * 2);

describe("takes API", () => {
  const db = createTestDb();
  let app: INestApplication;
  let owner: { accessToken: string; userId: string };
  let bandId: string;
  let sessionId: string;
  let producer: FakeProducer;
  let storage: FakeStorage;

  beforeEach(async () => {
    await truncateAll(db);
    producer = new FakeProducer();
    storage = new FakeStorage();
    app = await createTestApp({ google: providerUser("owner-1"), storage, producer });
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
      { sessionId, index: 0, name: "Take 1", startMs: 10_000, endMs: 250_500, type: "PERFORMANCE", confidence: 0.9, objectKey: `bands/${bandId}/sessions/${sessionId}/takes/t1.m4a`, peaks: SEED_PEAKS },
    ]);
  });
  afterEach(() => app.close());

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  it("세션의 take를 index 순으로 commentCount와 함께 준다", async () => {
    const [first] = await db.select().from(takes).where(eq(takes.index, 0));
    await db.insert(comments).values({ sessionId, takeId: first!.id, authorId: owner.userId, atMs: 1000, text: "x" });
    const res = await request(app.getHttpServer()).get(`/sessions/${sessionId}/takes`).set(auth(owner.accessToken)).expect(200);
    expect(res.body).toEqual([
      { id: first!.id, sessionId, index: 0, name: "Take 1", durationSec: 241, startMs: 10_000, endMs: 250_500, type: "PERFORMANCE", commentCount: 1, peaks: SEED_PEAKS, version: 1, audioStatus: "ready" },
      expect.objectContaining({ index: 1, name: "Take 2", durationSec: 120, commentCount: 0, peaks: null }),
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

  async function takeByIndex(index: number) {
    const [row] = await db.select().from(takes).where(eq(takes.index, index));
    return row!;
  }

  describe("PATCH /takes/:id", () => {
    it("경계를 바꾸면 version+1, updating, 코멘트 시각 이동, 재컷 잡 발행", async () => {
      const t1 = await takeByIndex(0); // 10_000 ~ 250_500
      await db.insert(comments).values({ sessionId, takeId: t1.id, authorId: owner.userId, atMs: 30_000, text: "x" });
      const res = await request(app.getHttpServer())
        .patch(`/takes/${t1.id}`)
        .set(auth(owner.accessToken))
        .send({ startMs: 20_000, endMs: 240_000, version: 1 })
        .expect(200);
      expect(res.body).toMatchObject({ id: t1.id, startMs: 20_000, endMs: 240_000, durationSec: 220, version: 2, audioStatus: "updating" });
      const [c] = await db.select().from(comments).where(eq(comments.takeId, t1.id));
      expect(c!.atMs).toBe(20_000); // 절대 시각 40s 유지: 30s − (20s − 10s)
      expect(producer.recuts).toEqual([{ takeId: t1.id, version: 2 }]);
    });

    it("version이 다르면 409 take_version_conflict", async () => {
      const t1 = await takeByIndex(0);
      const res = await request(app.getHttpServer()).patch(`/takes/${t1.id}`).set(auth(owner.accessToken)).send({ startMs: 20_000, endMs: 240_000, version: 5 }).expect(409);
      expect(res.body.code).toBe("take_version_conflict");
    });

    it("이웃과 겹치면 400 take_overlap, 범위 밖·짧으면 400 take_range_invalid", async () => {
      const t1 = await takeByIndex(0);
      const overlap = await request(app.getHttpServer()).patch(`/takes/${t1.id}`).set(auth(owner.accessToken)).send({ startMs: 10_000, endMs: 300_001, version: 1 }).expect(400);
      expect(overlap.body.code).toBe("take_overlap");
      const short = await request(app.getHttpServer()).patch(`/takes/${t1.id}`).set(auth(owner.accessToken)).send({ startMs: 10_000, endMs: 10_100, version: 1 }).expect(400);
      expect(short.body.code).toBe("take_range_invalid");
      const beyond = await request(app.getHttpServer()).patch(`/takes/${t1.id}`).set(auth(owner.accessToken)).send({ startMs: 10_000, endMs: 600_001, version: 1 }).expect(400);
      expect(beyond.body.code).toBe("take_range_invalid");
    });

    it("세션이 ready가 아니면 409 session_not_ready", async () => {
      await db.update(sessions).set({ status: "analyzing" }).where(eq(sessions.id, sessionId));
      const t1 = await takeByIndex(0);
      const res = await request(app.getHttpServer()).patch(`/takes/${t1.id}`).set(auth(owner.accessToken)).send({ startMs: 20_000, endMs: 240_000, version: 1 }).expect(409);
      expect(res.body.code).toBe("session_not_ready");
    });

    it("큐 발행이 실패하면 failed로 남는다", async () => {
      producer.failNext = true;
      const t1 = await takeByIndex(0);
      const res = await request(app.getHttpServer()).patch(`/takes/${t1.id}`).set(auth(owner.accessToken)).send({ startMs: 20_000, endMs: 240_000, version: 1 }).expect(200);
      expect(res.body).toMatchObject({ version: 2, audioStatus: "failed" });
    });

    it("비멤버는 403", async () => {
      const other = await createTestApp({ google: providerUser("stranger-1", "S"), storage: new FakeStorage() });
      const stranger = await loginAs(other);
      await other.close();
      const t1 = await takeByIndex(0);
      await request(app.getHttpServer()).patch(`/takes/${t1.id}`).set(auth(stranger.accessToken)).send({ startMs: 20_000, endMs: 240_000, version: 1 }).expect(403);
    });
  });

  describe("DELETE /takes/:id", () => {
    it("행·코멘트가 사라지고 takeCount가 줄고 객체가 지워진다", async () => {
      const t1 = await takeByIndex(0);
      await db.insert(comments).values({ sessionId, takeId: t1.id, authorId: owner.userId, atMs: 1000, text: "x" });
      await request(app.getHttpServer()).delete(`/takes/${t1.id}`).set(auth(owner.accessToken)).expect(204);
      expect(await db.select().from(takes).where(eq(takes.id, t1.id))).toEqual([]);
      expect(await db.select().from(comments).where(eq(comments.takeId, t1.id))).toEqual([]);
      const [s] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
      expect(s!.takeCount).toBe(1);
      expect(storage.deleted).toEqual([t1.objectKey]);
      // 남은 take의 이름·index는 그대로 (결정 6)
      const list = await request(app.getHttpServer()).get(`/sessions/${sessionId}/takes`).set(auth(owner.accessToken)).expect(200);
      expect(list.body.map((t: { index: number; name: string }) => [t.index, t.name])).toEqual([[1, "Take 2"]]);
      await request(app.getHttpServer()).get(`/takes/${t1.id}/audio`).set(auth(owner.accessToken)).expect(404);
    });

    it("세션이 ready가 아니면 409", async () => {
      await db.update(sessions).set({ status: "analyzing" }).where(eq(sessions.id, sessionId));
      const t1 = await takeByIndex(0);
      await request(app.getHttpServer()).delete(`/takes/${t1.id}`).set(auth(owner.accessToken)).expect(409);
    });
  });
});
