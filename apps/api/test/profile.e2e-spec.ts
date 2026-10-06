import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { users } from "../src/db/schema.js";
import { createTestApp, FakeStorage, loginAs, providerUser } from "./app-util.js";
import { createTestDb, truncateAll } from "./db-util.js";

describe("PATCH /me · PUT/DELETE /me/photo", () => {
  const db = createTestDb();
  let app: INestApplication;
  let storage: FakeStorage;
  let me: { accessToken: string; userId: string };
  const auth = () => ({ authorization: `Bearer ${me.accessToken}` });

  beforeEach(async () => {
    await truncateAll(db);
    storage = new FakeStorage();
    app = await createTestApp({ google: providerUser("g-1"), storage });
    me = await loginAs(app);
  });
  afterEach(() => app.close());

  it("이름을 바꾸면 trim된 값이 저장되고 GET /me에도 반영된다", async () => {
    const res = await request(app.getHttpServer()).patch("/me").set(auth()).send({ displayName: "  New Name  " }).expect(200);
    expect(res.body).toMatchObject({ id: me.userId, displayName: "New Name", email: "g-1@test.dev" });
    const again = await request(app.getHttpServer()).get("/me").set(auth()).expect(200);
    expect(again.body.displayName).toBe("New Name");
  });

  it("빈 이름·51자 이름은 400", async () => {
    await request(app.getHttpServer()).patch("/me").set(auth()).send({ displayName: "   " }).expect(400);
    await request(app.getHttpServer()).patch("/me").set(auth()).send({ displayName: "x".repeat(51) }).expect(400);
    await request(app.getHttpServer()).patch("/me").set(auth()).send({}).expect(400);
  });

  it("사진을 올리면 R2 키가 저장되고 presigned URL이 내려온다; 다시 올리면 이전 객체를 지운다", async () => {
    const first = await request(app.getHttpServer())
      .put("/me/photo")
      .set(auth())
      .attach("photo", Buffer.from([0xff, 0xd8, 0xff, 0xe0]), { filename: "a.jpg", contentType: "image/jpeg" })
      .expect(200);
    const [row] = await db.select().from(users).where(eq(users.id, me.userId));
    expect(row!.profileImageKey).toMatch(new RegExp(`^avatars/${me.userId}/[0-9a-f-]+\\.jpg$`));
    expect(first.body.profileImageUrl).toBe(`https://fake.r2/${row!.profileImageKey}?signed`);
    expect(storage.objects.get(row!.profileImageKey!)).toEqual({ contentType: "image/jpeg", size: 4 });

    // FakeStorage.listKeys는 putFile 기록만 보므로 두 번째 업로드의 정리 대상을 흉내 내려면 put에 넣어 둔다
    storage.put.push({ key: row!.profileImageKey!, path: "" });
    await request(app.getHttpServer())
      .put("/me/photo")
      .set(auth())
      .attach("photo", Buffer.from([0x89, 0x50]), { filename: "b.png", contentType: "image/png" })
      .expect(200);
    expect(storage.deleted).toEqual([row!.profileImageKey]);
  });

  it("지원하지 않는 타입·파일 없음은 400", async () => {
    await request(app.getHttpServer())
      .put("/me/photo")
      .set(auth())
      .attach("photo", Buffer.from("gif"), { filename: "a.gif", contentType: "image/gif" })
      .expect(400);
    await request(app.getHttpServer()).put("/me/photo").set(auth()).expect(400);
  });

  it("사진을 지우면 키와 제공자 URL이 모두 비워진다", async () => {
    await db.update(users).set({ profileImageUrl: "https://lh3.googleusercontent.com/x", profileImageKey: `avatars/${me.userId}/old.jpg` }).where(eq(users.id, me.userId));
    storage.put.push({ key: `avatars/${me.userId}/old.jpg`, path: "" });
    await request(app.getHttpServer()).delete("/me/photo").set(auth()).expect(204);
    const [row] = await db.select().from(users).where(eq(users.id, me.userId));
    expect(row!.profileImageKey).toBeNull();
    expect(row!.profileImageUrl).toBeNull();
    expect(storage.deleted).toEqual([`avatars/${me.userId}/old.jpg`]);
    const res = await request(app.getHttpServer()).get("/me").set(auth()).expect(200);
    expect(res.body.profileImageUrl).toBeNull();
  });

  it("토큰 없이 401", async () => {
    await request(app.getHttpServer()).patch("/me").send({ displayName: "x" }).expect(401);
    await request(app.getHttpServer()).delete("/me/photo").expect(401);
  });
});
