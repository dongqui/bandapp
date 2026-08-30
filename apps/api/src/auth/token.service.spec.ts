import { describe, expect, it } from "vitest";
import { TokenService } from "./token.service.js";

const secret = (value: string) => () => new TextEncoder().encode(value);

describe("TokenService", () => {
  const service = new TokenService(secret("unit-test-secret"));

  it("서명한 access token에서 sub(userId)를 복원한다", async () => {
    const token = await service.signAccessToken("user-1");
    await expect(service.verifyAccessToken(token)).resolves.toBe("user-1");
  });

  it("다른 시크릿으로 서명된 토큰을 거부한다", async () => {
    const other = new TokenService(secret("other-secret"));
    const token = await other.signAccessToken("user-1");
    await expect(service.verifyAccessToken(token)).rejects.toThrow();
  });

  it("변조된 토큰을 거부한다", async () => {
    const token = await service.signAccessToken("user-1");
    await expect(service.verifyAccessToken(`${token}x`)).rejects.toThrow();
  });

  it("refresh token은 매번 다르고 해시는 64자 hex로 결정적이다", () => {
    const a = service.generateRefreshToken();
    const b = service.generateRefreshToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(service.sha256(a)).toBe(service.sha256(a));
    expect(service.sha256(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refresh 만료는 60일 뒤다", () => {
    const now = new Date("2026-08-30T00:00:00Z");
    const expiry = service.refreshTokenExpiry(now);
    expect(expiry.getTime() - now.getTime()).toBe(60 * 24 * 60 * 60 * 1000);
  });
});
