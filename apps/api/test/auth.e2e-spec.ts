import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, loginAs, providerUser } from "./app-util.js";
import { createTestDb, truncateAll } from "./db-util.js";

describe("auth API", () => {
  let app: INestApplication;

  beforeEach(async () => {
    await truncateAll(createTestDb());
    app = await createTestApp({ google: providerUser("g-1"), apple: providerUser("a-1", null) });
  });
  afterEach(() => app.close());

  it("최초 Google 로그인은 자동 가입한다", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/google")
      .send({ idToken: "stub" })
      .expect(201);
    expect(res.body.isNewUser).toBe(true);
    expect(res.body.user.displayName).toBe("Dongjin");
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
  });

  it("재로그인은 같은 user로 isNewUser=false", async () => {
    const first = await loginAs(app);
    const res = await request(app.getHttpServer())
      .post("/auth/google")
      .send({ idToken: "stub" })
      .expect(201);
    expect(res.body.isNewUser).toBe(false);
    expect(res.body.user.id).toBe(first.userId);
  });

  it("Apple 최초 로그인은 body displayName을 저장한다", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/apple")
      .send({ idToken: "stub", displayName: "동진" })
      .expect(201);
    expect(res.body.user.displayName).toBe("동진");
  });

  it("idToken 누락은 400", async () => {
    await request(app.getHttpServer()).post("/auth/google").send({}).expect(400);
  });

  it("Provider 검증 실패는 401이고 내부 오류 문자열을 노출하지 않는다", async () => {
    const failing = await createTestApp(); // 스텁 없음 → 검증 throw
    const res = await request(failing.getHttpServer())
      .post("/auth/google")
      .send({ idToken: "bad" })
      .expect(401);
    expect(res.body.message).not.toContain("stubbed");
    await failing.close();
  });

  it("refresh는 rotation한다 — 새 쌍 발급, 이전 refresh 재사용은 401", async () => {
    const { refreshToken } = await loginAs(app);
    const rotated = await request(app.getHttpServer())
      .post("/auth/refresh")
      .send({ refreshToken })
      .expect(201);
    expect(rotated.body.accessToken).toBeTruthy();
    expect(rotated.body.refreshToken).not.toBe(refreshToken);
    await request(app.getHttpServer()).post("/auth/refresh").send({ refreshToken }).expect(401);
    await request(app.getHttpServer())
      .post("/auth/refresh")
      .send({ refreshToken: rotated.body.refreshToken })
      .expect(201);
  });

  it("logout 후 해당 refresh는 401", async () => {
    const { accessToken, refreshToken } = await loginAs(app);
    await request(app.getHttpServer())
      .post("/auth/logout")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ refreshToken })
      .expect(204);
    await request(app.getHttpServer()).post("/auth/refresh").send({ refreshToken }).expect(401);
  });
});
