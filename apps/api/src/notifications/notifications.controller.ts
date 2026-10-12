import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { NOTIFICATIONS_PAGE_MAX, NOTIFICATIONS_PAGE_SIZE, type NotificationPage, type NotificationSettings, type RegisterPushTokenInput, type UpdateNotificationSettingsInput } from "@bandapp/types";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUserId } from "../auth/current-user-id.decorator.js";
import { requireBoolean, requireOneOf, requireString, requireUuidParam } from "../common/validation.js";
import { NotificationsService } from "./notifications.service.js";
import { PushTokensService } from "./push-tokens.service.js";

const TOKEN_MAX = 4096;
const LOCALE_MAX = 35; // BCP 47 최대 길이

function parseSettings(body: unknown): UpdateNotificationSettingsInput {
  return {
    sessionReady: requireBoolean(body, "sessionReady"),
    comments: requireBoolean(body, "comments"),
    commentScope: requireOneOf(body, "commentScope", ["all", "mine"] as const),
  };
}

function parsePushToken(body: unknown): RegisterPushTokenInput {
  const token = requireString(body, "token");
  if (token.length > TOKEN_MAX) throw new BadRequestException(`token must be at most ${TOKEN_MAX} characters`);
  const locale = requireString(body, "locale");
  if (locale.length > LOCALE_MAX) throw new BadRequestException(`locale must be at most ${LOCALE_MAX} characters`);
  return { token, platform: requireOneOf(body, "platform", ["ios", "android"] as const), locale };
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return NOTIFICATIONS_PAGE_SIZE;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > NOTIFICATIONS_PAGE_MAX) throw new BadRequestException(`limit must be 1-${NOTIFICATIONS_PAGE_MAX}`);
  return n;
}

@Controller()
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly tokens: PushTokensService,
  ) {}

  @Get("bands/:id/notifications")
  list(@CurrentUserId() userId: string, @Param("id") bandId: string, @Query("cursor") cursor?: string, @Query("limit") limit?: string): Promise<NotificationPage> {
    requireUuidParam(bandId, "id");
    return this.notifications.list(bandId, userId, cursor ?? null, parseLimit(limit));
  }

  @Get("bands/:id/notifications/unread-count")
  async unreadCount(@CurrentUserId() userId: string, @Param("id") bandId: string): Promise<{ count: number }> {
    requireUuidParam(bandId, "id");
    return { count: await this.notifications.unreadCount(bandId, userId) };
  }

  @Post("notifications/:id/read")
  @HttpCode(204)
  async markRead(@CurrentUserId() userId: string, @Param("id") id: string): Promise<void> {
    requireUuidParam(id, "id");
    await this.notifications.markRead(id, userId);
  }

  @Post("bands/:id/notifications/read-all")
  @HttpCode(204)
  async markAllRead(@CurrentUserId() userId: string, @Param("id") bandId: string): Promise<void> {
    requireUuidParam(bandId, "id");
    await this.notifications.markAllRead(bandId, userId);
  }

  /** 내 모든 밴드 — Me 행 요약과 설정 화면이 한 번에 쓴다 */
  @Get("me/notification-settings")
  settings(@CurrentUserId() userId: string): Promise<NotificationSettings[]> {
    return this.notifications.settingsForUser(userId);
  }

  @Put("bands/:id/notification-settings")
  updateSettings(@CurrentUserId() userId: string, @Param("id") bandId: string, @Body() body: unknown): Promise<NotificationSettings> {
    requireUuidParam(bandId, "id");
    return this.notifications.updateSettings(bandId, userId, parseSettings(body));
  }

  @Put("me/push-tokens")
  @HttpCode(204)
  async registerToken(@CurrentUserId() userId: string, @Body() body: unknown): Promise<void> {
    await this.tokens.upsert(userId, parsePushToken(body));
  }

  /** 로그아웃·탈퇴 직전. 내 토큰만 지우고, 아니어도 204 */
  @Delete("me/push-tokens/:token")
  @HttpCode(204)
  async removeToken(@CurrentUserId() userId: string, @Param("token") token: string): Promise<void> {
    await this.tokens.remove(token, userId);
  }
}
