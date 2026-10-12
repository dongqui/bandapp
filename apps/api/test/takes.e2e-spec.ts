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

  it("세션의 take를 시간 순으로 commentCount와 함께 준다", async () => {
    const [first] = await db.select().from(takes).where(eq(takes.index, 0));
    await db.insert(comments).values({ sessionId, takeId: first!.id, authorId: owner.userId, atMs: 1000, text: "x" });
    const res = await request(app.getHttpServer()).get(`/sessions/${sessionId}/takes`).set(auth(owner.accessToken)).expect(200);
    expect(res.body).toEqual([
      { id: first!.id, sessionId, index: 0, name: "Take 1", durationSec: 241, startMs: 10_000, endMs: 250_500, type: "PERFORMANCE", commentCount: 1, unreadCommentCount: 0, peaks: SEED_PEAKS, version: 1, audioStatus: "ready" },
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

    it("세션이 분석 중이면 409 session_not_ready", async () => {
      await db.update(sessions).set({ status: "analyzing" }).where(eq(sessions.id, sessionId));
      const t1 = await takeByIndex(0);
      const res = await request(app.getHttpServer()).patch(`/takes/${t1.id}`).set(auth(owner.accessToken)).send({ startMs: 20_000, endMs: 240_000, version: 1 }).expect(409);
      expect(res.body.code).toBe("session_not_ready");
    });

    it("분석 안 한 세션(waiting_for_time)의 수동 take는 고칠 수 있다 (2026-10-08)", async () => {
      await db.update(sessions).set({ status: "waiting_for_time" }).where(eq(sessions.id, sessionId));
      const t1 = await takeByIndex(0);
      await request(app.getHttpServer()).patch(`/takes/${t1.id}`).set(auth(owner.accessToken)).send({ startMs: 20_000, endMs: 240_000, version: 1 }).expect(200);
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

  describe("PATCH /takes/:id/name", () => {
    it("이름을 다듬어 저장하고, 비우거나 null이면 기본 이름으로 돌아간다 — version·audioStatus는 그대로", async () => {
      const t1 = await takeByIndex(0);
      const renamed = await request(app.getHttpServer()).patch(`/takes/${t1.id}/name`).set(auth(owner.accessToken)).send({ name: "  Intro jam  " }).expect(200);
      expect(renamed.body).toMatchObject({ id: t1.id, name: "Intro jam", version: 1, audioStatus: "ready", commentCount: 0 });
      const reset = await request(app.getHttpServer()).patch(`/takes/${t1.id}/name`).set(auth(owner.accessToken)).send({ name: "   " }).expect(200);
      expect(reset.body.name).toBe("Take 1");
      await request(app.getHttpServer()).patch(`/takes/${t1.id}/name`).set(auth(owner.accessToken)).send({ name: "Chorus" }).expect(200);
      const nulled = await request(app.getHttpServer()).patch(`/takes/${t1.id}/name`).set(auth(owner.accessToken)).send({ name: null }).expect(200);
      expect(nulled.body.name).toBe("Take 1");
      expect(producer.recuts).toEqual([]);
    });

    it("40자를 넘거나 문자열이 아니면 400, 비멤버는 403, 없는 take는 404", async () => {
      const t1 = await takeByIndex(0);
      await request(app.getHttpServer()).patch(`/takes/${t1.id}/name`).set(auth(owner.accessToken)).send({ name: "x".repeat(41) }).expect(400);
      await request(app.getHttpServer()).patch(`/takes/${t1.id}/name`).set(auth(owner.accessToken)).send({ name: 3 }).expect(400);
      const other = await createTestApp({ google: providerUser("stranger-3", "S"), storage: new FakeStorage() });
      const stranger = await loginAs(other);
      await other.close();
      await request(app.getHttpServer()).patch(`/takes/${t1.id}/name`).set(auth(stranger.accessToken)).send({ name: "x" }).expect(403);
      await request(app.getHttpServer()).patch("/takes/00000000-0000-4000-8000-000000000000/name").set(auth(owner.accessToken)).send({ name: "x" }).expect(404);
    });
  });

  describe("POST /sessions/:id/takes (2026-10-08 수동 take)", () => {
    const create = (body: unknown, token = owner.accessToken) => request(app.getHttpServer()).post(`/sessions/${sessionId}/takes`).set(auth(token)).send(body);

    it("다음 index·기본 이름으로 updating 상태의 take를 만들고 재컷 잡을 v1로 발행한다", async () => {
      const res = await create({ startMs: 260_000, endMs: 290_000 }).expect(201);
      expect(res.body).toMatchObject({ sessionId, index: 2, name: "Take 3", startMs: 260_000, endMs: 290_000, durationSec: 30, type: "PERFORMANCE", commentCount: 0, peaks: null, version: 1, audioStatus: "updating" });
      const [row] = await db.select().from(takes).where(eq(takes.id, res.body.id));
      expect(row!.manual).toBe(true);
      expect(row!.objectKey).toBe(`bands/${bandId}/sessions/${sessionId}/takes/${res.body.id}-v1.m4a`);
      expect(producer.recuts).toEqual([{ takeId: res.body.id, version: 1 }]);
      const [s] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
      expect(s!.takeCount).toBe(3);
    });

    it("목록은 시간 순이라 중간에 넣은 take가 가운데 온다", async () => {
      const res = await create({ startMs: 260_000, endMs: 290_000 }).expect(201);
      const list = await request(app.getHttpServer()).get(`/sessions/${sessionId}/takes`).set(auth(owner.accessToken)).expect(200);
      expect(list.body.map((t: { id: string }) => t.id)).toEqual([(await takeByIndex(0)).id, res.body.id, (await takeByIndex(1)).id]);
    });

    it("기존 take와 겹치면 400 take_overlap, 범위 밖이면 400 take_range_invalid", async () => {
      expect((await create({ startMs: 240_000, endMs: 290_000 }).expect(400)).body.code).toBe("take_overlap");
      expect((await create({ startMs: 260_000, endMs: 310_000 }).expect(400)).body.code).toBe("take_overlap");
      expect((await create({ startMs: 500_000, endMs: 600_001 }).expect(400)).body.code).toBe("take_range_invalid");
      await create({ startMs: 1.5, endMs: 5000 }).expect(400);
      await create({ startMs: 260_000 }).expect(400);
    });

    it("분석 중이면 409 session_not_ready, 분석 안 한 세션(waiting_for_time·failed)엔 만들 수 있다", async () => {
      await db.update(sessions).set({ status: "analyzing" }).where(eq(sessions.id, sessionId));
      expect((await create({ startMs: 260_000, endMs: 290_000 }).expect(409)).body.code).toBe("session_not_ready");
      await db.update(sessions).set({ status: "waiting_for_time" }).where(eq(sessions.id, sessionId));
      await create({ startMs: 260_000, endMs: 290_000 }).expect(201);
      await db.update(sessions).set({ status: "failed" }).where(eq(sessions.id, sessionId));
      await create({ startMs: 500_000, endMs: 560_000 }).expect(201);
    });

    it("길이를 모르는 세션(durationMs null)이면 409 session_not_ready", async () => {
      await db.update(sessions).set({ status: "waiting_for_time", durationMs: null }).where(eq(sessions.id, sessionId));
      expect((await create({ startMs: 260_000, endMs: 290_000 }).expect(409)).body.code).toBe("session_not_ready");
    });

    it("큐 발행이 실패하면 failed로 만들어진다", async () => {
      producer.failNext = true;
      const res = await create({ startMs: 260_000, endMs: 290_000 }).expect(201);
      expect(res.body.audioStatus).toBe("failed");
    });

    it("비멤버는 403, 없는 세션은 404", async () => {
      const other = await createTestApp({ google: providerUser("stranger-1", "S"), storage: new FakeStorage() });
      const stranger = await loginAs(other);
      await other.close();
      await create({ startMs: 260_000, endMs: 290_000 }, stranger.accessToken).expect(403);
      await request(app.getHttpServer()).post("/sessions/00000000-0000-0000-0000-000000000000/takes").set(auth(owner.accessToken)).send({ startMs: 0, endMs: 1000 }).expect(404);
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

    it("세션이 분석 중이면 409, waiting_for_time이면 지울 수 있다", async () => {
      await db.update(sessions).set({ status: "analyzing" }).where(eq(sessions.id, sessionId));
      const t1 = await takeByIndex(0);
      await request(app.getHttpServer()).delete(`/takes/${t1.id}`).set(auth(owner.accessToken)).expect(409);
      await db.update(sessions).set({ status: "waiting_for_time" }).where(eq(sessions.id, sessionId));
      await request(app.getHttpServer()).delete(`/takes/${t1.id}`).set(auth(owner.accessToken)).expect(204);
    });

    it("비멤버는 403, 없는 take는 404", async () => {
      const other = await createTestApp({ google: providerUser("stranger-1", "S"), storage: new FakeStorage() });
      const stranger = await loginAs(other);
      await other.close();
      const t1 = await takeByIndex(0);
      await request(app.getHttpServer()).delete(`/takes/${t1.id}`).set(auth(stranger.accessToken)).expect(403);
      await request(app.getHttpServer()).delete("/takes/00000000-0000-0000-0000-000000000000").set(auth(owner.accessToken)).expect(404);
    });
  });
});
