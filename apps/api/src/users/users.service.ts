import type { Provider } from "@nestjs/common";
import { ConflictException } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { authSessions, bandMembers, bands, userIdentities, users } from "../db/schema.js";
import type { VerifiedProviderToken } from "../auth/provider-token.js";

export interface PublicUser {
  id: string;
  displayName: string | null;
  profileImageUrl: string | null;
}

export class UsersService {
  constructor(private readonly db: Db) {}

  async findOrCreateByIdentity(
    provider: "GOOGLE" | "APPLE",
    verified: VerifiedProviderToken,
  ): Promise<{ user: PublicUser; isNewUser: boolean }> {
    const found = await this.findByIdentity(provider, verified.subject);
    if (found) return { user: found, isNewUser: false };
    try {
      return await this.db.transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({ displayName: verified.displayName, profileImageUrl: verified.profileImageUrl })
          .returning();
        if (!user) throw new Error("failed to insert user");
        await tx.insert(userIdentities).values({
          userId: user.id,
          provider,
          providerSubject: verified.subject,
          email: verified.email,
          emailVerified: verified.emailVerified,
        });
        return { user: this.toPublic(user), isNewUser: true };
      });
    } catch (err) {
      // 동시 최초 로그인으로 unique(provider, subject) 충돌 시 기존 계정으로 수렴
      const existing = await this.findByIdentity(provider, verified.subject);
      if (existing) return { user: existing, isNewUser: false };
      throw err;
    }
  }

  async findById(userId: string): Promise<PublicUser | null> {
    const row = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!row || row.deletedAt) return null;
    return this.toPublic(row);
  }

  private async findByIdentity(provider: "GOOGLE" | "APPLE", subject: string): Promise<PublicUser | null> {
    const identity = await this.db.query.userIdentities.findFirst({
      where: and(eq(userIdentities.provider, provider), eq(userIdentities.providerSubject, subject)),
    });
    if (!identity) return null;
    const user = await this.db.query.users.findFirst({ where: eq(users.id, identity.userId) });
    return user ? this.toPublic(user) : null;
  }

  private toPublic(row: typeof users.$inferSelect): PublicUser {
    return { id: row.id, displayName: row.displayName, profileImageUrl: row.profileImageUrl };
  }

  /** 해당 provider identity에 refresh token이 이미 저장돼 있는지. */
  async hasProviderRefreshToken(userId: string, provider: "GOOGLE" | "APPLE"): Promise<boolean> {
    const row = await this.db.query.userIdentities.findFirst({
      where: and(eq(userIdentities.userId, userId), eq(userIdentities.provider, provider)),
    });
    return typeof row?.providerRefreshToken === "string" && row.providerRefreshToken.length > 0;
  }

  /** 해당 provider identity에 refresh token을 저장한다. */
  async saveProviderRefreshToken(
    userId: string,
    provider: "GOOGLE" | "APPLE",
    token: string,
  ): Promise<void> {
    await this.db
      .update(userIdentities)
      .set({ providerRefreshToken: token, updatedAt: new Date() })
      .where(and(eq(userIdentities.userId, userId), eq(userIdentities.provider, provider)));
  }

  /**
   * 회원 탈퇴 (기획서 18장, 스펙 결정 9):
   * - 다른 멤버가 있는 밴드의 유일한 owner면 409 (전체 롤백)
   * - 혼자인 밴드는 삭제, member인 밴드는 탈퇴
   * - 모든 세션 revoke, identity 삭제, user 비식별화(soft delete)
   * - 삭제된 identity의 Apple refresh token을 돌려준다. 실제 revoke는 호출자가
   *   트랜잭션 커밋 후에 한다 (외부 HTTP를 트랜잭션 안에서 하지 않는다).
   */
  async deleteAccount(userId: string): Promise<{ appleRefreshTokens: string[] }> {
    return this.db.transaction(async (tx) => {
      const memberships = await tx.query.bandMembers.findMany({
        where: eq(bandMembers.userId, userId),
      });
      for (const membership of memberships) {
        const [count] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(bandMembers)
          .where(eq(bandMembers.bandId, membership.bandId));
        if ((count?.n ?? 0) === 1) {
          await tx.delete(bands).where(eq(bands.id, membership.bandId));
          continue;
        }
        if (membership.role === "owner") {
          const owners = await tx.query.bandMembers.findMany({
            where: and(eq(bandMembers.bandId, membership.bandId), eq(bandMembers.role, "owner")),
          });
          if (owners.every((o) => o.userId === userId)) {
            throw new ConflictException(
              "관리자로 있는 팀이 있어요. 먼저 소유권을 넘기거나 팀을 삭제해 주세요.",
            );
          }
        }
        await tx
          .delete(bandMembers)
          .where(and(eq(bandMembers.bandId, membership.bandId), eq(bandMembers.userId, userId)));
      }
      await tx
        .update(authSessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)));
      const deletedIdentities = await tx
        .delete(userIdentities)
        .where(eq(userIdentities.userId, userId))
        .returning();
      await tx
        .update(users)
        .set({ displayName: null, profileImageUrl: null, deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(users.id, userId));
      return {
        appleRefreshTokens: deletedIdentities
          .filter((i) => i.provider === "APPLE")
          .map((i) => i.providerRefreshToken)
          .filter((t): t is string => typeof t === "string" && t.length > 0),
      };
    });
  }
}

export const usersServiceProvider: Provider = {
  provide: UsersService,
  useFactory: (db: Db) => new UsersService(db),
  inject: [DB],
};
