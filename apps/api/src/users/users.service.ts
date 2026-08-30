import type { Provider } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { userIdentities, users } from "../db/schema.js";
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
}

export const usersServiceProvider: Provider = {
  provide: UsersService,
  useFactory: (db: Db) => new UsersService(db),
  inject: [DB],
};
