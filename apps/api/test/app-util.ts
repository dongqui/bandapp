import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { UploadedPart } from "@bandapp/types";
import { AppModule } from "../src/app.module.js";
import { AnalysisProducer } from "../src/analysis/analysis.producer.js";
import { AppleAuthService } from "../src/auth/apple-auth.service.js";
import { AppleTokenService } from "../src/auth/apple-token.service.js";
import { GoogleAuthService } from "../src/auth/google-auth.service.js";
import type { VerifiedProviderToken } from "../src/auth/provider-token.js";
import { StorageService } from "../src/storage/storage.service.js";

export interface ProviderStub {
  verifyIdToken(idToken: string): Promise<VerifiedProviderToken>;
}

const rejecting: ProviderStub = {
  verifyIdToken: async () => {
    throw new Error("provider verification not stubbed");
  },
};

const noopAppleTokens: Pick<AppleTokenService, "exchangeAuthorizationCode" | "revokeAll"> = {
  exchangeAuthorizationCode: async () => null,
  revokeAll: async () => undefined,
};

export function providerUser(subject: string, displayName: string | null = "Dongjin"): ProviderStub {
  return {
    verifyIdToken: async () => ({
      subject,
      email: `${subject}@test.dev`,
      emailVerified: true,
      displayName,
      profileImageUrl: null,
    }),
  };
}

/** R2를 흉내 낸다 — 호출 기록만 남기고 파트는 listParts로 되돌려준다. */
export class FakeStorage extends StorageService {
  uploads = new Map<string, { key: string; contentType: string; parts: UploadedPart[]; completed: boolean }>();
  put: Array<{ key: string; path: string }> = [];
  deleted: string[] = [];
  downloads: Array<{ key: string; path: string }> = [];
  failNextCreate = false;
  private seq = 0;

  async createMultipartUpload(key: string, contentType: string) {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error("r2 down");
    }
    const uploadId = `upload-${++this.seq}`;
    this.uploads.set(uploadId, { key, contentType, parts: [], completed: false });
    return { uploadId };
  }
  async presignUploadPart(key: string, uploadId: string, partNumber: number) {
    return `https://fake.r2/${key}?uploadId=${uploadId}&partNumber=${partNumber}`;
  }
  async listParts(_key: string, uploadId: string) {
    return [...(this.uploads.get(uploadId)?.parts ?? [])];
  }
  async completeMultipartUpload(_key: string, uploadId: string, parts: UploadedPart[]) {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw new Error("NoSuchUpload");
    upload.parts = parts;
    upload.completed = true;
  }
  async abortMultipartUpload(_key: string, uploadId: string) {
    this.uploads.delete(uploadId);
  }
  async presignGet(key: string) {
    return `https://fake.r2/${key}?signed`;
  }
  async downloadToFile(key: string, path: string) {
    this.downloads.push({ key, path });
  }
  async putFile(key: string, path: string) {
    this.put.push({ key, path });
  }
  async deleteObjects(keys: string[]) {
    this.deleted.push(...keys);
  }
}

export class FakeProducer {
  enqueued: string[] = [];
  failNext = false;
  async enqueueAnalysis(sessionId: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("sqs down");
    }
    this.enqueued.push(sessionId);
  }
}

export async function createTestApp(overrides?: {
  google?: ProviderStub;
  apple?: ProviderStub;
  appleTokens?: Pick<AppleTokenService, "exchangeAuthorizationCode" | "revokeAll">;
  storage?: StorageService;
  producer?: FakeProducer;
}): Promise<INestApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(GoogleAuthService)
    .useValue(overrides?.google ?? rejecting)
    .overrideProvider(AppleAuthService)
    .useValue(overrides?.apple ?? rejecting)
    // 항상 오버라이드한다 — 실 서비스는 오늘은 자격증명 부재로 no-op이지만, .p8이 들어오는 순간
    // 이 기본값이 없으면 테스트가 실제 appleid.apple.com에 요청을 보내게 된다.
    .overrideProvider(AppleTokenService)
    .useValue(overrides?.appleTokens ?? noopAppleTokens)
    .overrideProvider(StorageService)
    .useValue(overrides?.storage ?? new FakeStorage())
    .overrideProvider(AnalysisProducer)
    .useValue(overrides?.producer ?? new FakeProducer());
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

/** google 스텁이 subject로 응답하도록 만들어진 app에서 로그인해 토큰을 얻는다. */
export async function loginAs(
  app: INestApplication,
  path: "/auth/google" | "/auth/apple" = "/auth/google",
): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
  const res = await request(app.getHttpServer()).post(path).send({ idToken: "stubbed" }).expect(201);
  return {
    accessToken: res.body.accessToken,
    refreshToken: res.body.refreshToken,
    userId: res.body.user.id,
  };
}
