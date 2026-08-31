import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module.js";
import { AppleAuthService } from "../src/auth/apple-auth.service.js";
import { AppleTokenService } from "../src/auth/apple-token.service.js";
import { GoogleAuthService } from "../src/auth/google-auth.service.js";
import type { VerifiedProviderToken } from "../src/auth/provider-token.js";

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

export async function createTestApp(overrides?: {
  google?: ProviderStub;
  apple?: ProviderStub;
  appleTokens?: Pick<AppleTokenService, "exchangeAuthorizationCode" | "revokeAll">;
}): Promise<INestApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(GoogleAuthService)
    .useValue(overrides?.google ?? rejecting)
    .overrideProvider(AppleAuthService)
    .useValue(overrides?.apple ?? rejecting)
    // 항상 오버라이드한다 — 실 서비스는 오늘은 자격증명 부재로 no-op이지만, .p8이 들어오는 순간
    // 이 기본값이 없으면 테스트가 실제 appleid.apple.com에 요청을 보내게 된다.
    .overrideProvider(AppleTokenService)
    .useValue(overrides?.appleTokens ?? noopAppleTokens);
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
