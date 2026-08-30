import { and, eq, isNull } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthSessionsService } from "../src/auth/auth-sessions.service.js";
import { TokenService } from "../src/auth/token.service.js";
import { authSessions, users } from "../src/db/schema.js";
import { createTestDb, truncateAll } from "./db-util.js";

describe("AuthSessionsService", () => {
  const db = createTestDb();
  const tokens = new TokenService();
  const service = new AuthSessionsService(db, tokens);
  let userId: string;

  beforeEach(async () => {
    await truncateAll(db);
    const [user] = await db.insert(users).values({ displayName: "u" }).returning();
    userId = user!.id;
  });

  it("issue는 원문을 반환하고 DB에는 해시만 저장한다", async () => {
    const refreshToken = await service.issue(userId);
    const rows = await db.query.authSessions.findMany({ where: eq(authSessions.userId, userId) });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.refreshTokenHash).toBe(tokens.sha256(refreshToken));
    expect(rows[0]!.refreshTokenHash).not.toBe(refreshToken);
  });

  it("rotate는 새 refresh를 주고 이전 것을 무효화한다", async () => {
    const first = await service.issue(userId);
    const rotated = await service.rotate(first);
    expect(rotated?.userId).toBe(userId);
    expect(rotated?.refreshToken).not.toBe(first);
    expect(await service.rotate(first)).toBeNull(); // 재사용 거부
    expect(await service.rotate(rotated!.refreshToken)).not.toBeNull();
  });

  it("만료된 세션은 rotate되지 않는다", async () => {
    const refreshToken = tokens.generateRefreshToken();
    await db.insert(authSessions).values({
      userId,
      refreshTokenHash: tokens.sha256(refreshToken),
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await service.rotate(refreshToken)).toBeNull();
  });

  it("revoke 후 rotate는 null", async () => {
    const refreshToken = await service.issue(userId);
    await service.revoke(refreshToken);
    expect(await service.rotate(refreshToken)).toBeNull();
  });

  it("revokeAllForUser는 활성 세션을 전부 폐기한다", async () => {
    await service.issue(userId);
    await service.issue(userId);
    await service.revokeAllForUser(userId);
    const active = await db.query.authSessions.findMany({
      where: and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)),
    });
    expect(active).toHaveLength(0);
  });
});
