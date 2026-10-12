import type { Provider } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import type { RegisterPushTokenInput } from "@bandapp/types";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { pushTokens } from "../db/schema.js";

export interface PushTokenRow {
  token: string;
  userId: string;
  locale: string;
}

export class PushTokensService {
  constructor(private readonly db: Db) {}

  /** 토큰 PK 충돌 = 같은 기기. 다른 계정이 쓰던 토큰이면 내 것으로 바뀐다 (스펙 API 절) */
  async upsert(userId: string, input: RegisterPushTokenInput): Promise<void> {
    const now = new Date();
    await this.db
      .insert(pushTokens)
      .values({ token: input.token, userId, platform: input.platform, locale: input.locale, lastSeenAt: now })
      .onConflictDoUpdate({ target: pushTokens.token, set: { userId, platform: input.platform, locale: input.locale, lastSeenAt: now } });
  }

  /** 내 토큰만 지운다. 없거나 남의 것이어도 성공 — 로그아웃 직전에 부르므로 실패로 흐름을 끊지 않는다 */
  async remove(token: string, userId: string): Promise<void> {
    await this.db.delete(pushTokens).where(and(eq(pushTokens.token, token), eq(pushTokens.userId, userId)));
  }

  async removeMany(tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;
    await this.db.delete(pushTokens).where(inArray(pushTokens.token, tokens));
  }

  async forUsers(userIds: string[]): Promise<PushTokenRow[]> {
    if (userIds.length === 0) return [];
    return this.db.select({ token: pushTokens.token, userId: pushTokens.userId, locale: pushTokens.locale }).from(pushTokens).where(inArray(pushTokens.userId, userIds));
  }
}

export const pushTokensServiceProvider: Provider = {
  provide: PushTokensService,
  useFactory: (db: Db) => new PushTokensService(db),
  inject: [DB],
};
