import { randomUUID } from "node:crypto";
import type { Provider } from "@nestjs/common";
import { ConflictException } from "@nestjs/common";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { authSessions, bandMembers, bands, userIdentities, users, type AuthProviderName } from "../db/schema.js";
import type { VerifiedProviderToken } from "../auth/provider-token.js";
import { StorageService } from "../storage/storage.service.js";

export interface PublicUser {
  id: string;
  displayName: string | null;
  profileImageUrl: string | null;
  email: string | null;
}

/** presigned GET 최대치(SigV4 7일). 앱은 me()를 시작할 때마다 다시 받으므로 그 안에 갱신된다 */
const PHOTO_URL_TTL_SEC = 7 * 24 * 3600;

const PHOTO_EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

type UserRow = typeof users.$inferSelect;

export class UsersService {
  constructor(
    private readonly db: Db,
    private readonly storage: StorageService,
  ) {}

  async findOrCreateByIdentity(
    provider: AuthProviderName,
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
        return { user: await this.toPublic(user, verified.email), isNewUser: true };
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
    return this.toPublic(row, await this.emailOf(userId));
  }

  private async findByIdentity(provider: AuthProviderName, subject: string): Promise<PublicUser | null> {
    const identity = await this.db.query.userIdentities.findFirst({
      where: and(eq(userIdentities.provider, provider), eq(userIdentities.providerSubject, subject)),
    });
    if (!identity) return null;
    const user = await this.db.query.users.findFirst({ where: eq(users.id, identity.userId) });
    return user ? this.toPublic(user, identity.email) : null;
  }

  /** 첫 identity의 이메일. 애플 hide-my-email 릴레이 주소도 그대로 쓴다 */
  private async emailOf(userId: string): Promise<string | null> {
    const identity = await this.db.query.userIdentities.findFirst({
      where: eq(userIdentities.userId, userId),
      orderBy: asc(userIdentities.createdAt),
    });
    return identity?.email ?? null;
  }

  private async toPublic(row: UserRow, email: string | null): Promise<PublicUser> {
    const profileImageUrl = row.profileImageKey
      ? await this.storage.presignGet(row.profileImageKey, PHOTO_URL_TTL_SEC)
      : row.profileImageUrl;
    return { id: row.id, displayName: row.displayName, profileImageUrl, email };
  }

  /** 이름 변경. 호출자가 trim·길이 검증을 끝낸 값을 준다 */
  async updateDisplayName(userId: string, displayName: string): Promise<PublicUser> {
    const [row] = await this.db
      .update(users)
      .set({ displayName, updatedAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .returning();
    if (!row) throw new Error("user not found");
    return this.toPublic(row, await this.emailOf(userId));
  }

  /**
   * 프로필 사진 교체. 새 객체를 먼저 올리고 DB를 바꾼 뒤 이전 객체를 지운다 —
   * 업로드가 실패하면 이전 사진이 그대로 남고, 삭제 실패는 고아 객체 하나로 끝난다.
   */
  async setProfilePhoto(userId: string, body: Uint8Array, contentType: string): Promise<PublicUser> {
    const ext = PHOTO_EXT[contentType];
    if (!ext) throw new Error(`unsupported photo type ${contentType}`);
    const key = `avatars/${userId}/${randomUUID()}.${ext}`;
    await this.storage.putObject(key, body, contentType);
    const [row] = await this.db
      .update(users)
      .set({ profileImageKey: key, updatedAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .returning();
    if (!row) {
      await this.storage.deleteObjects([key]).catch(() => undefined);
      throw new Error("user not found");
    }
    await this.deleteOtherPhotos(userId, key);
    return this.toPublic(row, await this.emailOf(userId));
  }

  /** 사진 제거. 제공자 URL도 같이 비운다 — 디자인의 "Remove photo" 뒤엔 이니셜이 보여야 한다 */
  async removeProfilePhoto(userId: string): Promise<PublicUser> {
    const [row] = await this.db
      .update(users)
      .set({ profileImageKey: null, profileImageUrl: null, updatedAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .returning();
    if (!row) throw new Error("user not found");
    await this.deleteOtherPhotos(userId, null);
    return this.toPublic(row, await this.emailOf(userId));
  }

  private async deleteOtherPhotos(userId: string, keep: string | null): Promise<void> {
    try {
      const keys = (await this.storage.listKeys(`avatars/${userId}/`)).filter((k) => k !== keep);
      if (keys.length) await this.storage.deleteObjects(keys);
    } catch (err) {
      console.warn("profile photo cleanup failed", err); // 고아 객체는 남아도 동작엔 영향 없다
    }
  }

  /** 해당 provider identity에 refresh token이 이미 저장돼 있는지. */
  async hasProviderRefreshToken(userId: string, provider: AuthProviderName): Promise<boolean> {
    const row = await this.db.query.userIdentities.findFirst({
      where: and(eq(userIdentities.userId, userId), eq(userIdentities.provider, provider)),
    });
    return typeof row?.providerRefreshToken === "string" && row.providerRefreshToken.length > 0;
  }

  /** 해당 provider identity에 refresh token을 저장한다. */
  async saveProviderRefreshToken(
    userId: string,
    provider: AuthProviderName,
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
    const result = await this.db.transaction(async (tx) => {
      // soft delete된 밴드(bands.deleted_at)는 여기서 완전히 무시한다 — 409 판정에도 끼지 않고
      // count===1 분기로 하드 삭제되지도 않는다 (스펙 결정 3, 이미 삭제된 밴드는 다시 지우지 않는다).
      const memberships = await tx
        .select({ bandId: bandMembers.bandId, role: bandMembers.role })
        .from(bandMembers)
        .innerJoin(bands, eq(bands.id, bandMembers.bandId))
        .where(and(eq(bandMembers.userId, userId), isNull(bands.deletedAt)));
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
        .set({ displayName: null, profileImageUrl: null, profileImageKey: null, deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(users.id, userId));
      return {
        appleRefreshTokens: deletedIdentities
          .filter((i) => i.provider === "APPLE")
          .map((i) => i.providerRefreshToken)
          .filter((t): t is string => typeof t === "string" && t.length > 0),
      };
    });
    // 커밋 뒤 best-effort — 비식별화된 계정의 사진을 R2에 남기지 않는다
    await this.deleteOtherPhotos(userId, null);
    return result;
  }
}

export const usersServiceProvider: Provider = {
  provide: UsersService,
  useFactory: (db: Db, storage: StorageService) => new UsersService(db, storage),
  inject: [DB, StorageService],
};
