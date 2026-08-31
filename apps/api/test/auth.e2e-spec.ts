import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userIdentities } from "../src/db/schema.js";
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

describe("POST /auth/apple — authorizationCode 교환", () => {
  const db = createTestDb();
  let app: INestApplication;
  let appleTokens: {
    exchangeAuthorizationCode: ReturnType<typeof vi.fn>;
    revokeAll: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    await truncateAll(db);
    appleTokens = {
      exchangeAuthorizationCode: vi.fn(async () => "rt-from-apple"),
      revokeAll: vi.fn(async () => undefined),
    };
    app = await createTestApp({ apple: providerUser("apple-1"), appleTokens });
  });
  afterEach(() => app.close());

  it("authorizationCode를 교환해 저장한다", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/apple")
      .send({ idToken: "stubbed", authorizationCode: "code-1" })
      .expect(201);

    expect(appleTokens.exchangeAuthorizationCode).toHaveBeenCalledWith("code-1");
    const identity = await db.query.userIdentities.findFirst({
      where: eq(userIdentities.userId, res.body.user.id),
    });
    expect(identity?.providerRefreshToken).toBe("rt-from-apple");
  });

  it("이미 저장된 토큰이 있으면 다시 교환하지 않는다", async () => {
    await request(app.getHttpServer())
      .post("/auth/apple")
      .send({ idToken: "stubbed", authorizationCode: "code-1" })
      .expect(201);
    appleTokens.exchangeAuthorizationCode.mockClear();

    await request(app.getHttpServer())
      .post("/auth/apple")
      .send({ idToken: "stubbed", authorizationCode: "code-2" })
      .expect(201);

    expect(appleTokens.exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it("authorizationCode가 없어도 로그인은 성공한다", async () => {
    await request(app.getHttpServer()).post("/auth/apple").send({ idToken: "stubbed" }).expect(201);
    expect(appleTokens.exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it("교환이 실패해도 로그인은 성공한다", async () => {
    appleTokens.exchangeAuthorizationCode.mockResolvedValue(null);
    const res = await request(app.getHttpServer())
      .post("/auth/apple")
      .send({ idToken: "stubbed", authorizationCode: "code-1" })
      .expect(201);

    const identity = await db.query.userIdentities.findFirst({
      where: eq(userIdentities.userId, res.body.user.id),
    });
    expect(identity?.providerRefreshToken).toBeNull();
  });

  it("교환이 예외를 던져도 로그인은 성공한다", async () => {
    appleTokens.exchangeAuthorizationCode.mockRejectedValue(new Error("boom"));
    await request(app.getHttpServer())
      .post("/auth/apple")
      .send({ idToken: "stubbed", authorizationCode: "code-1" })
      .expect(201);
  });
});
