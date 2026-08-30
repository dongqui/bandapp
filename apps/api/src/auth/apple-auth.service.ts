import type { Provider } from "@nestjs/common";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";
import type { VerifiedProviderToken } from "./provider-token.js";

export class AppleAuthService {
  constructor(
    private readonly getKey: JWTVerifyGetKey = createRemoteJWKSet(
      new URL("https://appleid.apple.com/auth/keys"),
    ),
  ) {}

  async verifyIdToken(idToken: string): Promise<VerifiedProviderToken> {
    const audience = process.env.APPLE_BUNDLE_ID;
    if (!audience) throw new Error("APPLE_BUNDLE_ID is not set");
    const { payload } = await jwtVerify(idToken, this.getKey, {
      issuer: "https://appleid.apple.com",
      audience,
    });
    if (typeof payload.sub !== "string") throw new Error("id token has no sub");
    // Apple은 email_verified를 boolean 또는 "true"/"false" 문자열로 준다
    const rawVerified = payload.email_verified;
    const emailVerified =
      rawVerified === true || rawVerified === "true"
        ? true
        : rawVerified === false || rawVerified === "false"
          ? false
          : null;
    return {
      subject: payload.sub,
      email: typeof payload.email === "string" ? payload.email : null,
      emailVerified,
      // Apple ID token에는 이름이 없다 — 최초 가입 시 클라이언트가 body로 전달 (스펙 결정 8)
      displayName: null,
      profileImageUrl: null,
    };
  }
}

export const appleAuthServiceProvider: Provider = {
  provide: AppleAuthService,
  useFactory: () => new AppleAuthService(),
};
