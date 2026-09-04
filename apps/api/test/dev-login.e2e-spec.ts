import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "./app-util.js";
import { createTestDb, truncateAll } from "./db-util.js";

describe("POST /auth/dev", () => {
  const db = createTestDb();
  let app: INestApplication;
  const originalEnv = process.env.NODE_ENV;

  beforeEach(async () => {
    await truncateAll(db);
    process.env.DEV_LOGIN_SECRET = "e2e-dev-secret";
    app = await createTestApp();
  });
  afterEach(async () => {
    process.env.NODE_ENV = originalEnv;
    process.env.DEV_LOGIN_SECRET = "e2e-dev-secret";
    await app.close();
  });

  it("올바른 secret이면 로그인되고 같은 이름은 같은 사용자다", async () => {
    const first = await request(app.getHttpServer())
      .post("/auth/dev")
      .send({ secret: "e2e-dev-secret", displayName: "Dongjin" })
      .expect(201);
    expect(first.body.user.displayName).toBe("Dongjin");
    expect(first.body.isNewUser).toBe(true);
    const again = await request(app.getHttpServer())
      .post("/auth/dev")
      .send({ secret: "e2e-dev-secret", displayName: "Dongjin" })
      .expect(201);
    expect(again.body.user.id).toBe(first.body.user.id);
    expect(again.body.isNewUser).toBe(false);
    await request(app.getHttpServer())
      .get("/me")
      .set({ authorization: `Bearer ${again.body.accessToken}` })
      .expect(200);
  });

  it("secret이 틀리면 401", async () => {
    await request(app.getHttpServer()).post("/auth/dev").send({ secret: "nope" }).expect(401);
  });

  it("DEV_LOGIN_SECRET이 없으면 404", async () => {
    delete process.env.DEV_LOGIN_SECRET;
    await request(app.getHttpServer()).post("/auth/dev").send({ secret: "e2e-dev-secret" }).expect(404);
  });

  it("production이면 404", async () => {
    process.env.NODE_ENV = "production";
    await request(app.getHttpServer()).post("/auth/dev").send({ secret: "e2e-dev-secret" }).expect(404);
  });
});
