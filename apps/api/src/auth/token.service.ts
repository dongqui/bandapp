import { createHash, randomBytes } from "node:crypto";
import type { Provider } from "@nestjs/common";
import { SignJWT, jwtVerify } from "jose";

// 스펙 결정 3: Access 30분, Refresh 60일 + rotation
const ACCESS_TOKEN_TTL = "30m";
const REFRESH_TOKEN_TTL_DAYS = 60;

export class TokenService {
  constructor(
    private readonly getSecret: () => Uint8Array = () => {
      const secret = process.env.JWT_ACCESS_SECRET;
      if (!secret) throw new Error("JWT_ACCESS_SECRET is not set");
      return new TextEncoder().encode(secret);
    },
  ) {}

  /** payload는 최소화한다 — sub만 넣는다 (기획서 7장). */
  async signAccessToken(userId: string): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime(ACCESS_TOKEN_TTL)
      .sign(this.getSecret());
  }

  /** 유효하면 userId(sub)를 반환, 아니면 throw. */
  async verifyAccessToken(token: string): Promise<string> {
    const { payload } = await jwtVerify(token, this.getSecret(), { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new Error("access token has no sub");
    }
    return payload.sub;
  }

  generateRefreshToken(): string {
    return randomBytes(32).toString("base64url");
  }

  sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }

  refreshTokenExpiry(now: Date = new Date()): Date {
    return new Date(now.getTime() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  }
}

export const tokenServiceProvider: Provider = {
  provide: TokenService,
  useFactory: () => new TokenService(),
};
