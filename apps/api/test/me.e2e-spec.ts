import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, loginAs, providerUser } from "./app-util.js";
import { createTestDb, truncateAll } from "./db-util.js";

describe("GET /me", () => {
  let app: INestApplication;

  beforeEach(async () => {
    await truncateAll(createTestDb());
    app = await createTestApp({ google: providerUser("g-1") });
  });
  afterEach(() => app.close());

  it("토큰 없이 401", async () => {
    await request(app.getHttpServer()).get("/me").expect(401);
  });

  it("잘못된 토큰은 401", async () => {
    await request(app.getHttpServer()).get("/me").set("authorization", "Bearer garbage").expect(401);
  });

  it("유효한 access token이면 내 정보를 준다", async () => {
    const { accessToken, userId } = await loginAs(app);
    const res = await request(app.getHttpServer())
      .get("/me")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body).toEqual({ id: userId, displayName: "Dongjin", profileImageUrl: null });
  });

  it("가드 없는 access 토큰 형식(Bearer 누락)은 401", async () => {
    const { accessToken } = await loginAs(app);
    await request(app.getHttpServer()).get("/me").set("authorization", accessToken).expect(401);
  });
});
