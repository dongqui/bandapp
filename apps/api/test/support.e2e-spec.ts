import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { AppleAuthService } from "../src/auth/apple-auth.service.js";
import { AppleTokenService } from "../src/auth/apple-token.service.js";
import { GoogleAuthService } from "../src/auth/google-auth.service.js";
import { AnalysisProducer } from "../src/analysis/analysis.producer.js";
import { RevenueCatClient } from "../src/billing/revenuecat.client.js";
import { DB } from "../src/db/db.constants.js";
import { supportRequests } from "../src/db/schema.js";
import { StorageService } from "../src/storage/storage.service.js";
import { formatNotification, SupportService } from "../src/support/support.service.js";
import { FakeProducer, FakeRevenueCat, FakeStorage, loginAs, providerUser } from "./app-util.js";
import { createTestDb, truncateAll } from "./db-util.js";

describe("POST /support/requests", () => {
  const db = createTestDb();
  let app: INestApplication;
  let me: { accessToken: string; userId: string };
  let sent: string[];
  const auth = () => ({ authorization: `Bearer ${me.accessToken}` });

  beforeEach(async () => {
    await truncateAll(db);
    sent = [];
    // createTestApp과 같은 오버라이드에 SupportService만 기록용 notifier로 바꾼다
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GoogleAuthService).useValue(providerUser("g-1"))
      .overrideProvider(AppleAuthService).useValue(providerUser("apple-1"))
      .overrideProvider(AppleTokenService).useValue({ exchangeAuthorizationCode: async () => null, revokeAll: async () => undefined })
      .overrideProvider(StorageService).useValue(new FakeStorage())
      .overrideProvider(AnalysisProducer).useValue(new FakeProducer())
      .overrideProvider(RevenueCatClient).useValue(new FakeRevenueCat())
      .overrideProvider(SupportService)
      .useFactory({ factory: (d) => new SupportService(d, async (text) => { sent.push(text); }), inject: [DB] })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    me = await loginAs(app);
  });
  afterEach(() => app.close());

  it("저장되고 알림 본문에 이메일·주제·본문·기기 정보가 들어간다", async () => {
    const res = await request(app.getHttpServer())
      .post("/support/requests")
      .set(auth())
      .send({ topic: "broken", body: "  Upload stuck at 80%  ", appVersion: "1.0.0 (12)", device: "android 14 · Pixel 8" })
      .expect(201);
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    const rows = await db.select().from(supportRequests);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: res.body.id, userId: me.userId, email: "g-1@test.dev", topic: "broken", body: "Upload stuck at 80%",
      appVersion: "1.0.0 (12)", device: "android 14 · Pixel 8",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("broken");
    expect(sent[0]).toContain("g-1@test.dev");
    expect(sent[0]).toContain("Upload stuck at 80%");
    expect(sent[0]).toContain("Pixel 8");
  });

  it("주제가 목록 밖이거나 본문이 비면 400", async () => {
    await request(app.getHttpServer()).post("/support/requests").set(auth()).send({ topic: "spam", body: "x" }).expect(400);
    await request(app.getHttpServer()).post("/support/requests").set(auth()).send({ topic: "other", body: "   " }).expect(400);
    await request(app.getHttpServer()).post("/support/requests").set(auth()).send({ topic: "other", body: "x".repeat(2001) }).expect(400);
    expect(await db.select().from(supportRequests)).toHaveLength(0);
  });

  it("토큰 없이 401", async () => {
    await request(app.getHttpServer()).post("/support/requests").send({ topic: "other", body: "hi" }).expect(401);
  });

  it("formatNotification은 이름·이메일이 없어도 깨지지 않는다", () => {
    const text = formatNotification({ id: "r1", userId: "u1", email: null, displayName: null, topic: "idea", body: "Dark mode" });
    expect(text).toContain("(no name) <no email> · u1");
    expect(text).toContain("Dark mode");
  });
});
