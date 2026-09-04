import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bandMembers, recordings, sessions } from "../src/db/schema.js";
import { FakeProducer, FakeStorage, createTestApp, loginAs, providerUser } from "./app-util.js";
import { createTestDb, truncateAll } from "./db-util.js";

const MB = 1024 * 1024;

describe("sessions API", () => {
  const db = createTestDb();
  let app: INestApplication;
  let storage: FakeStorage;
  let producer: FakeProducer;
  let owner: { accessToken: string; userId: string };
  let bandId: string;

  beforeEach(async () => {
    await truncateAll(db);
    storage = new FakeStorage();
    producer = new FakeProducer();
    app = await createTestApp({ google: providerUser("owner-1"), storage, producer });
    owner = await loginAs(app);
    const band = await request(app.getHttpServer()).post("/bands").set(auth(owner.accessToken)).send({ name: "B" }).expect(201);
    bandId = band.body.id;
  });
  afterEach(() => app.close());

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const createInput = (overrides: Record<string, unknown> = {}) => ({
    startedAt: "2026-09-04T19:03:00+09:00",
    durationMs: 2_716_601,
    sizeBytes: 25 * MB,
    contentType: "audio/mp4",
    source: "recording",
    ...overrides,
  });

  async function createSession(token = owner.accessToken, body = createInput()) {
    const res = await request(app.getHttpServer()).post(`/bands/${bandId}/sessions`).set(auth(token)).send(body).expect(201);
    return res.body as { session: { id: string; status: string; title: string; durationSec: number }; upload: { partSize: number; partCount: number } };
  }

  async function stranger() {
    const other = await createTestApp({ google: providerUser("stranger-1", "S"), storage, producer });
    const login = await loginAs(other);
    await other.close();
    return login;
  }

  it("세션을 만들면 uploading 상태와 파트 정보를 돌려주고 multipart 업로드를 연다", async () => {
    const { session, upload } = await createSession();
    expect(session).toMatchObject({ status: "uploading", title: "Sep 4 Rehearsal", durationSec: 2717, takeCount: 0, commentCount: 0 });
    expect(upload).toEqual({ partSize: 10 * MB, partCount: 3 });
    const [rec] = await db.select().from(recordings).where(eq(recordings.sessionId, session.id));
    expect(rec).toMatchObject({ uploadId: "upload-1", partCount: 3, uploadStatus: "pending", objectKey: `bands/${bandId}/sessions/${session.id}/original.m4a` });
    expect(storage.uploads.get("upload-1")?.contentType).toBe("audio/mp4");
  });

  it("가져오기는 durationMs 없이 만들 수 있고 durationSec은 0이다", async () => {
    const { session } = await createSession(owner.accessToken, createInput({ durationMs: undefined, source: "import" }));
    expect(session.durationSec).toBe(0);
  });

  it("R2 multipart 생성이 실패하면 500이고 세션이 남지 않는다", async () => {
    storage.failNextCreate = true;
    await request(app.getHttpServer()).post(`/bands/${bandId}/sessions`).set(auth(owner.accessToken)).send(createInput()).expect(500);
    const res = await request(app.getHttpServer()).get(`/bands/${bandId}/sessions`).set(auth(owner.accessToken)).expect(200);
    expect(res.body).toEqual([]);
  });

  it.each([
    ["sizeBytes 0", { sizeBytes: 0 }],
    ["2GB 초과", { sizeBytes: 3 * 1024 * MB }],
    ["오프셋 없는 startedAt", { startedAt: "2026-09-04T19:03:00" }],
    ["지원하지 않는 contentType", { contentType: "audio/wav" }],
    ["알 수 없는 source", { source: "youtube" }],
  ])("잘못된 입력은 400: %s", async (_label, overrides) => {
    await request(app.getHttpServer()).post(`/bands/${bandId}/sessions`).set(auth(owner.accessToken)).send(createInput(overrides)).expect(400);
  });

  it("비멤버는 세션을 만들 수도 볼 수도 없다 (403)", async () => {
    const { session } = await createSession();
    const other = await stranger();
    await request(app.getHttpServer()).post(`/bands/${bandId}/sessions`).set(auth(other.accessToken)).send(createInput()).expect(403);
    await request(app.getHttpServer()).get(`/bands/${bandId}/sessions`).set(auth(other.accessToken)).expect(403);
    await request(app.getHttpServer()).get(`/sessions/${session.id}`).set(auth(other.accessToken)).expect(403);
  });

  it("없는 세션은 404", async () => {
    await request(app.getHttpServer()).get("/sessions/00000000-0000-0000-0000-000000000000").set(auth(owner.accessToken)).expect(404);
    await request(app.getHttpServer()).get("/sessions/not-a-uuid").set(auth(owner.accessToken)).expect(400);
  });

  it("파트 URL은 범위 안의 번호에만 발급된다", async () => {
    const { session } = await createSession();
    const res = await request(app.getHttpServer())
      .post(`/sessions/${session.id}/upload/parts`)
      .set(auth(owner.accessToken))
      .send({ partNumbers: [1, 3] })
      .expect(200);
    expect(res.body).toEqual([
      { partNumber: 1, url: expect.stringContaining("partNumber=1") },
      { partNumber: 3, url: expect.stringContaining("partNumber=3") },
    ]);
    await request(app.getHttpServer()).post(`/sessions/${session.id}/upload/parts`).set(auth(owner.accessToken)).send({ partNumbers: [4] }).expect(400);
    await request(app.getHttpServer()).post(`/sessions/${session.id}/upload/parts`).set(auth(owner.accessToken)).send({ partNumbers: [] }).expect(400);
  });

  it("업로드 상태는 이미 올라간 파트를 돌려준다", async () => {
    const { session } = await createSession();
    storage.uploads.get("upload-1")!.parts.push({ partNumber: 1, etag: "e1" });
    const res = await request(app.getHttpServer()).get(`/sessions/${session.id}/upload`).set(auth(owner.accessToken)).expect(200);
    expect(res.body).toEqual({ partSize: 10 * MB, partCount: 3, uploadedParts: [{ partNumber: 1, etag: "e1" }] });
  });

  it("완료하면 analyzing이 되고 분석 큐에 발행된다", async () => {
    const { session } = await createSession();
    const parts = [1, 2, 3].map((partNumber) => ({ partNumber, etag: `e${partNumber}` }));
    const res = await request(app.getHttpServer()).post(`/sessions/${session.id}/upload/complete`).set(auth(owner.accessToken)).send({ parts }).expect(200);
    expect(res.body.status).toBe("analyzing");
    expect(storage.uploads.get("upload-1")?.completed).toBe(true);
    expect(producer.enqueued).toEqual([session.id]);
    const [rec] = await db.select().from(recordings).where(eq(recordings.sessionId, session.id));
    expect(rec?.uploadStatus).toBe("completed");
    expect(rec?.completedAt).not.toBeNull();
  });

  it("파트 수가 맞지 않으면 400이고 상태는 그대로다", async () => {
    const { session } = await createSession();
    await request(app.getHttpServer()).post(`/sessions/${session.id}/upload/complete`).set(auth(owner.accessToken)).send({ parts: [{ partNumber: 1, etag: "e1" }] }).expect(400);
    const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id));
    expect(row?.status).toBe("uploading");
  });

  it("완료 요청의 파트 번호가 범위를 벗어나면 400이고 상태는 그대로다", async () => {
    const { session } = await createSession();
    const parts = [1, 2, 4].map((partNumber) => ({ partNumber, etag: `e${partNumber}` }));
    await request(app.getHttpServer()).post(`/sessions/${session.id}/upload/complete`).set(auth(owner.accessToken)).send({ parts }).expect(400);
    const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id));
    expect(row?.status).toBe("uploading");
  });

  it("큐 발행이 실패하면 failed로 남고 retry로 다시 발행할 수 있다", async () => {
    const { session } = await createSession();
    producer.failNext = true;
    const parts = [1, 2, 3].map((partNumber) => ({ partNumber, etag: `e${partNumber}` }));
    const res = await request(app.getHttpServer()).post(`/sessions/${session.id}/upload/complete`).set(auth(owner.accessToken)).send({ parts }).expect(200);
    expect(res.body.status).toBe("failed");
    const retried = await request(app.getHttpServer()).post(`/sessions/${session.id}/retry`).set(auth(owner.accessToken)).expect(200);
    expect(retried.body.status).toBe("analyzing");
    expect(producer.enqueued).toEqual([session.id]);
  });

  it("uploading이 아닌 세션에 파트를 요청하거나, failed가 아닌 세션을 retry하면 409", async () => {
    const { session } = await createSession();
    await request(app.getHttpServer()).post(`/sessions/${session.id}/retry`).set(auth(owner.accessToken)).expect(409);
    const parts = [1, 2, 3].map((partNumber) => ({ partNumber, etag: `e${partNumber}` }));
    await request(app.getHttpServer()).post(`/sessions/${session.id}/upload/complete`).set(auth(owner.accessToken)).send({ parts }).expect(200);
    await request(app.getHttpServer()).post(`/sessions/${session.id}/upload/parts`).set(auth(owner.accessToken)).send({ partNumbers: [1] }).expect(409);
    await request(app.getHttpServer()).post(`/sessions/${session.id}/upload/complete`).set(auth(owner.accessToken)).send({ parts }).expect(409);
  });

  it("목록은 밴드의 세션을 최근 순으로 준다", async () => {
    await createSession(owner.accessToken, createInput({ startedAt: "2026-09-01T10:00:00+09:00" }));
    await createSession(owner.accessToken, createInput({ startedAt: "2026-09-04T10:00:00+09:00" }));
    const res = await request(app.getHttpServer()).get(`/bands/${bandId}/sessions`).set(auth(owner.accessToken)).expect(200);
    expect(res.body.map((s: { title: string }) => s.title)).toEqual(["Sep 4 Rehearsal", "Sep 1 Rehearsal"]);
  });

  it("원본 오디오 URL은 업로드가 끝난 뒤에만 준다", async () => {
    const { session } = await createSession();
    await request(app.getHttpServer()).get(`/sessions/${session.id}/audio`).set(auth(owner.accessToken)).expect(409);
    const parts = [1, 2, 3].map((partNumber) => ({ partNumber, etag: `e${partNumber}` }));
    await request(app.getHttpServer()).post(`/sessions/${session.id}/upload/complete`).set(auth(owner.accessToken)).send({ parts }).expect(200);
    const res = await request(app.getHttpServer()).get(`/sessions/${session.id}/audio`).set(auth(owner.accessToken)).expect(200);
    expect(res.body).toEqual({ url: expect.stringContaining("original.m4a"), expiresAt: expect.any(String) });
  });

  it("멤버는 다른 멤버가 만든 세션도 본다", async () => {
    const { session } = await createSession();
    const member = await stranger();
    await db.insert(bandMembers).values({ bandId, userId: member.userId, role: "member" });
    await request(app.getHttpServer()).get(`/sessions/${session.id}`).set(auth(member.accessToken)).expect(200);
  });
});
