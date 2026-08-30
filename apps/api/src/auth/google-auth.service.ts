import type { Provider } from "@nestjs/common";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";
import type { VerifiedProviderToken } from "./provider-token.js";

export class GoogleAuthService {
  constructor(
    private readonly getKey: JWTVerifyGetKey = createRemoteJWKSet(
      new URL("https://www.googleapis.com/oauth2/v3/certs"),
    ),
  ) {}

  async verifyIdToken(idToken: string): Promise<VerifiedProviderToken> {
    const audience = (process.env.GOOGLE_CLIENT_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (audience.length === 0) throw new Error("GOOGLE_CLIENT_IDS is not set");
    const { payload } = await jwtVerify(idToken, this.getKey, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience,
    });
    if (typeof payload.sub !== "string") throw new Error("id token has no sub");
    return {
      subject: payload.sub,
      email: typeof payload.email === "string" ? payload.email : null,
      emailVerified: typeof payload.email_verified === "boolean" ? payload.email_verified : null,
      displayName: typeof payload.name === "string" ? payload.name : null,
      profileImageUrl: typeof payload.picture === "string" ? payload.picture : null,
    };
  }
}

export const googleAuthServiceProvider: Provider = {
  provide: GoogleAuthService,
  useFactory: () => new GoogleAuthService(),
};
