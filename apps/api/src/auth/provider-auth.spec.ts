import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { JWTVerifyGetKey } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppleAuthService } from "./apple-auth.service.js";
import { GoogleAuthService } from "./google-auth.service.js";

async function makeKeys(): Promise<{ sign: (claims: Record<string, unknown>, opts: { iss: string; aud: string; expired?: boolean; sub?: string }) => Promise<string>; jwks: JWTVerifyGetKey }> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), alg: "RS256", kid: "test-key" };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const sign = (claims: Record<string, unknown>, opts: { iss: string; aud: string; expired?: boolean; sub?: string }) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(opts.iss)
      .setAudience(opts.aud)
      .setSubject(opts.sub ?? "provider-sub-1")
      .setIssuedAt()
      .setExpirationTime(opts.expired ? Math.floor(Date.now() / 1000) - 60 : "5m")
      .sign(privateKey);
  return { sign, jwks };
}

describe("GoogleAuthService", () => {
  beforeEach(() => {
    process.env.GOOGLE_CLIENT_IDS = "client-web,client-ios";
  });
  afterEach(() => {
    delete process.env.GOOGLE_CLIENT_IDS;
  });

  it("유효한 토큰에서 subject/email/이름/사진을 추출한다", async () => {
    const { sign, jwks } = await makeKeys();
    const service = new GoogleAuthService(jwks);
    const token = await sign(
      { email: "d@test.dev", email_verified: true, name: "Dongjin", picture: "https://p/img.png" },
      { iss: "https://accounts.google.com", aud: "client-ios" },
    );
    await expect(service.verifyIdToken(token)).resolves.toEqual({
      subject: "provider-sub-1",
      email: "d@test.dev",
      emailVerified: true,
      displayName: "Dongjin",
      profileImageUrl: "https://p/img.png",
    });
  });

  it("audience가 목록에 없으면 거부한다", async () => {
    const { sign, jwks } = await makeKeys();
    const service = new GoogleAuthService(jwks);
    const token = await sign({}, { iss: "https://accounts.google.com", aud: "unknown-client" });
    await expect(service.verifyIdToken(token)).rejects.toThrow();
  });

  it("issuer가 다르면 거부한다", async () => {
    const { sign, jwks } = await makeKeys();
    const service = new GoogleAuthService(jwks);
    const token = await sign({}, { iss: "https://evil.example.com", aud: "client-web" });
    await expect(service.verifyIdToken(token)).rejects.toThrow();
  });

  it("만료된 토큰을 거부한다", async () => {
    const { sign, jwks } = await makeKeys();
    const service = new GoogleAuthService(jwks);
    const token = await sign({}, { iss: "https://accounts.google.com", aud: "client-web", expired: true });
    await expect(service.verifyIdToken(token)).rejects.toThrow();
  });

  it("GOOGLE_CLIENT_IDS 미설정이면 throw", async () => {
    delete process.env.GOOGLE_CLIENT_IDS;
    const { sign, jwks } = await makeKeys();
    const service = new GoogleAuthService(jwks);
    const token = await sign({}, { iss: "https://accounts.google.com", aud: "client-web" });
    await expect(service.verifyIdToken(token)).rejects.toThrow("GOOGLE_CLIENT_IDS");
  });
});

describe("AppleAuthService", () => {
  beforeEach(() => {
    process.env.APPLE_BUNDLE_ID = "com.taken.app";
  });
  afterEach(() => {
    delete process.env.APPLE_BUNDLE_ID;
  });

  it("유효한 토큰에서 subject/email을 추출한다 (이름 없음)", async () => {
    const { sign, jwks } = await makeKeys();
    const service = new AppleAuthService(jwks);
    const token = await sign(
      { email: "hide@privaterelay.appleid.com", email_verified: "true" },
      { iss: "https://appleid.apple.com", aud: "com.taken.app", sub: "apple-sub-1" },
    );
    await expect(service.verifyIdToken(token)).resolves.toEqual({
      subject: "apple-sub-1",
      email: "hide@privaterelay.appleid.com",
      emailVerified: true,
      displayName: null,
      profileImageUrl: null,
    });
  });

  it("audience(번들 ID)가 다르면 거부한다", async () => {
    const { sign, jwks } = await makeKeys();
    const service = new AppleAuthService(jwks);
    const token = await sign({}, { iss: "https://appleid.apple.com", aud: "com.other.app" });
    await expect(service.verifyIdToken(token)).rejects.toThrow();
  });
});
