import { beforeEach, describe, expect, it } from "vitest";
import { UsersService } from "../src/users/users.service.js";
import type { VerifiedProviderToken } from "../src/auth/provider-token.js";
import { createTestDb, truncateAll } from "./db-util.js";

const verified = (subject: string, over?: Partial<VerifiedProviderToken>): VerifiedProviderToken => ({
  subject,
  email: `${subject}@test.dev`,
  emailVerified: true,
  displayName: "Dongjin",
  profileImageUrl: null,
  ...over,
});

describe("UsersService", () => {
  const db = createTestDb();
  const service = new UsersService(db);
  beforeEach(() => truncateAll(db));

  it("최초 로그인이면 user+identity를 만들고 isNewUser=true", async () => {
    const result = await service.findOrCreateByIdentity("GOOGLE", verified("g-1"));
    expect(result.isNewUser).toBe(true);
    expect(result.user.displayName).toBe("Dongjin");
  });

  it("같은 (provider, subject) 재로그인은 기존 user를 반환한다", async () => {
    const first = await service.findOrCreateByIdentity("GOOGLE", verified("g-1"));
    const second = await service.findOrCreateByIdentity("GOOGLE", verified("g-1"));
    expect(second.isNewUser).toBe(false);
    expect(second.user.id).toBe(first.user.id);
  });

  it("provider가 다르면 subject가 같아도 다른 user다 (자동 병합 금지)", async () => {
    const g = await service.findOrCreateByIdentity("GOOGLE", verified("same"));
    const a = await service.findOrCreateByIdentity("APPLE", verified("same"));
    expect(a.user.id).not.toBe(g.user.id);
  });

  it("findById는 없는 id에 null을 준다", async () => {
    expect(await service.findById("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("provider refresh token은 최초에 없고, 저장하면 있다고 보고한다", async () => {
    const { user } = await service.findOrCreateByIdentity("APPLE", verified("apple-rt-1"));

    await expect(service.hasProviderRefreshToken(user.id, "APPLE")).resolves.toBe(false);
    await service.saveProviderRefreshToken(user.id, "APPLE", "rt-stored");
    await expect(service.hasProviderRefreshToken(user.id, "APPLE")).resolves.toBe(true);
  });

  it("provider refresh token은 provider별로 별개다", async () => {
    const { user } = await service.findOrCreateByIdentity("APPLE", verified("apple-rt-2"));

    await service.saveProviderRefreshToken(user.id, "APPLE", "rt-stored");
    await expect(service.hasProviderRefreshToken(user.id, "GOOGLE")).resolves.toBe(false);
  });
});
