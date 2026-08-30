import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module.js";
import { AppleAuthService } from "../src/auth/apple-auth.service.js";
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
}): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(GoogleAuthService)
    .useValue(overrides?.google ?? rejecting)
    .overrideProvider(AppleAuthService)
    .useValue(overrides?.apple ?? rejecting)
    .compile();
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
