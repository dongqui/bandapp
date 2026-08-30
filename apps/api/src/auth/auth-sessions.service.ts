import type { Provider } from "@nestjs/common";
import { and, eq, gt, isNull } from "drizzle-orm";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { authSessions } from "../db/schema.js";
import { TokenService } from "./token.service.js";

export class AuthSessionsService {
  constructor(
    private readonly db: Db,
    private readonly tokens: TokenService,
  ) {}

  /** 새 refresh 세션을 만들고 토큰 원문을 반환한다. DB에는 해시만 남는다. */
  async issue(userId: string): Promise<string> {
    const refreshToken = this.tokens.generateRefreshToken();
    await this.db.insert(authSessions).values({
      userId,
      refreshTokenHash: this.tokens.sha256(refreshToken),
      expiresAt: this.tokens.refreshTokenExpiry(),
    });
    return refreshToken;
  }

  /** rotation: 유효한 세션이면 revoke하고 새 세션을 발급한다. 무효면 null. */
  async rotate(refreshToken: string): Promise<{ userId: string; refreshToken: string } | null> {
    const hash = this.tokens.sha256(refreshToken);
    return this.db.transaction(async (tx) => {
      const [session] = await tx
        .update(authSessions)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(authSessions.refreshTokenHash, hash),
            isNull(authSessions.revokedAt),
            gt(authSessions.expiresAt, new Date()),
          ),
        )
        .returning();
      if (!session) return null;
      const next = this.tokens.generateRefreshToken();
      await tx.insert(authSessions).values({
        userId: session.userId,
        refreshTokenHash: this.tokens.sha256(next),
        deviceName: session.deviceName,
        platform: session.platform,
        expiresAt: this.tokens.refreshTokenExpiry(),
        lastUsedAt: new Date(),
      });
      return { userId: session.userId, refreshToken: next };
    });
  }

  async revoke(refreshToken: string): Promise<void> {
    await this.db
      .update(authSessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(authSessions.refreshTokenHash, this.tokens.sha256(refreshToken)),
          isNull(authSessions.revokedAt),
        ),
      );
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.db
      .update(authSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)));
  }
}

export const authSessionsServiceProvider: Provider = {
  provide: AuthSessionsService,
  useFactory: (db: Db, tokens: TokenService) => new AuthSessionsService(db, tokens),
  inject: [DB, TokenService],
};
