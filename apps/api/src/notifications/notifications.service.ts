import { Logger, NotFoundException } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationItem,
  type NotificationPage,
  type NotificationSettings,
  type NotificationType,
  type TakeComment,
  type UpdateNotificationSettingsInput,
} from "@bandapp/types";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { bandMembers, bands, comments, notificationSettings, notifications, sessions, takes, users } from "../db/schema.js";
import { MembershipsService } from "../memberships/memberships.service.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { fanout, type NotificationEvent } from "./fanout.js";
import { PUSH_SENDER, type PushSender } from "./push-sender.js";
import { pushText } from "./push-text.js";
import { PushTokensService } from "./push-tokens.service.js";
import { withTimeout } from "./with-timeout.js";

const RETENTION_DAYS = 30;
/** FCM 호출 하나가 매달려도 코멘트 POST/워커가 무한히 붙잡히지 않게 하는 상한 */
const PUSH_SEND_TIMEOUT_MS = 5000;

const ITEM_COLUMNS = {
  id: notifications.id,
  type: notifications.type,
  readAt: notifications.readAt,
  createdAt: notifications.createdAt,
  // 커서용 — created_at은 µs 정밀도라 JS Date(ms)로는 같은 값을 되살릴 수 없다
  createdAtExact: sql<string>`to_char(${notifications.createdAt} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  actorId: notifications.actorId,
  actorName: users.displayName,
  actorDeletedAt: users.deletedAt,
  sessionId: sessions.id,
  sessionTitle: sessions.title,
  sessionName: sessions.name,
  sessionStartedAt: sessions.startedAt,
  sessionTakeCount: sessions.takeCount,
  sessionDurationMs: sessions.durationMs,
  takeId: takes.id,
  takeIndex: takes.index,
  takeName: takes.name,
  commentId: comments.id,
  commentAtMs: comments.atMs,
  commentText: comments.text,
};

/** ITEM_COLUMNS 조회 결과 한 행 (sessions는 inner join, 나머지는 left join이라 null 가능) */
interface ItemRow {
  id: string;
  type: NotificationType;
  readAt: Date | null;
  createdAt: Date;
  createdAtExact: string;
  actorId: string | null;
  actorName: string | null;
  actorDeletedAt: Date | null;
  sessionId: string;
  sessionTitle: string;
  sessionName: string | null;
  sessionStartedAt: Date;
  sessionTakeCount: number;
  sessionDurationMs: number | null;
  takeId: string | null;
  takeIndex: number | null;
  takeName: string | null;
  commentId: string | null;
  commentAtMs: number | null;
  commentText: string | null;
}

function toItem(row: ItemRow): NotificationItem {
  return {
    id: row.id,
    type: row.type,
    // 탈퇴(soft delete)한 사용자는 행이 남아 있으므로 actor_id가 있어도 null로 돌려준다
    actor: row.actorId && row.actorDeletedAt === null ? { id: row.actorId, name: row.actorName ?? null } : null,
    session: {
      id: row.sessionId,
      title: row.sessionTitle,
      name: row.sessionName ?? null,
      startedAt: row.sessionStartedAt.toISOString(),
      takeCount: row.sessionTakeCount,
      durationSec: Math.round((row.sessionDurationMs ?? 0) / 1000),
    },
    take: row.takeId && row.takeName !== null && row.takeIndex !== null ? { id: row.takeId, index: row.takeIndex, name: row.takeName } : null,
    comment: row.commentId && row.commentAtMs !== null && row.commentText !== null ? { id: row.commentId, atSec: row.commentAtMs / 1000, text: row.commentText } : null,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly db: Db,
    private readonly memberships: MembershipsService,
    private readonly tokens: PushTokensService,
    private readonly push: PushSender,
  ) {}

  // ---- 생성 (이벤트 지점에서 호출. 실패는 로그만 — 코멘트/세션은 이미 저장됐다) ----

  async onCommentCreated(comment: TakeComment): Promise<void> {
    try {
      const [session] = await this.db.select({ bandId: sessions.bandId }).from(sessions).where(eq(sessions.id, comment.sessionId));
      if (!session) return;
      let parentAuthorId: string | null = null;
      if (comment.parentId) {
        const [parent] = await this.db.select({ authorId: comments.authorId }).from(comments).where(eq(comments.id, comment.parentId));
        parentAuthorId = parent?.authorId ?? null;
      }
      await this.dispatch({ kind: "comment", bandId: session.bandId, sessionId: comment.sessionId, actorId: comment.authorId, commentId: comment.id, takeId: comment.takeId, parentAuthorId });
    } catch (err) {
      this.logger.error(`comment ${comment.id}: notification failed: ${String(err)}`);
    }
  }

  async onSessionReady(sessionId: string): Promise<void> {
    try {
      const [session] = await this.db
        .select({ bandId: sessions.bandId, createdBy: sessions.createdBy, bandDeletedAt: bands.deletedAt })
        .from(sessions)
        .innerJoin(bands, eq(bands.id, sessions.bandId))
        .where(eq(sessions.id, sessionId));
      // 삭제된 밴드에는 알리지 않는다
      if (!session || session.bandDeletedAt !== null) return;
      await this.dispatch({ kind: "session_ready", bandId: session.bandId, sessionId, actorId: session.createdBy });
    } catch (err) {
      this.logger.error(`session ${sessionId}: notification failed: ${String(err)}`);
    }
  }

  /** 수신자 계산 → 행 insert → 푸시. 나중에 아웃박스로 옮길 수 있게 생성과 발송을 나눈다 (스펙 결정 5) */
  private async dispatch(event: NotificationEvent): Promise<void> {
    const memberIds = (await this.db.select({ userId: bandMembers.userId }).from(bandMembers).where(eq(bandMembers.bandId, event.bandId))).map((m) => m.userId);
    if (memberIds.length === 0) return;
    const settingRows = await this.db
      .select({ userId: notificationSettings.userId, sessionReady: notificationSettings.sessionReady, comments: notificationSettings.comments, commentScope: notificationSettings.commentScope })
      .from(notificationSettings)
      .where(and(eq(notificationSettings.bandId, event.bandId), inArray(notificationSettings.userId, memberIds)));
    const settings = new Map<string, UpdateNotificationSettingsInput>(settingRows.map((r) => [r.userId, { sessionReady: r.sessionReady, comments: r.comments, commentScope: r.commentScope }]));
    const recipients = fanout(event, memberIds, settings);
    if (recipients.length === 0) return;
    const inserted = await this.db
      .insert(notifications)
      .values(
        recipients.map((r) => ({
          userId: r.userId,
          bandId: event.bandId,
          type: r.type,
          actorId: event.actorId,
          sessionId: event.sessionId,
          takeId: event.kind === "comment" ? event.takeId : null,
          commentId: event.kind === "comment" ? event.commentId : null,
        })),
      )
      .returning({ id: notifications.id, userId: notifications.userId, type: notifications.type });
    await this.sendPush(event, inserted);
  }

  private async sendPush(event: NotificationEvent, created: Array<{ id: string; userId: string; type: NotificationType }>): Promise<void> {
    const tokenRows = await this.tokens.forUsers(created.map((c) => c.userId));
    if (tokenRows.length === 0) return;
    const [actor] = await this.db.select({ name: users.displayName, deletedAt: users.deletedAt }).from(users).where(eq(users.id, event.actorId));
    const [session] = await this.db.select({ title: sessions.title, name: sessions.name, takeCount: sessions.takeCount }).from(sessions).where(eq(sessions.id, event.sessionId));
    if (!session) return;
    const takeId = event.kind === "comment" ? event.takeId : null;
    const take = takeId ? (await this.db.select({ name: takes.name }).from(takes).where(eq(takes.id, takeId)))[0] : undefined;
    const comment = event.kind === "comment" ? (await this.db.select({ text: comments.text, atMs: comments.atMs }).from(comments).where(eq(comments.id, event.commentId)))[0] : undefined;
    const actorName = actor && actor.deletedAt === null ? (actor.name ?? "") : null;
    // 전송 단위 = (수신자, locale). 모두 동시에 보내고 전체가 끝날 때까지만 기다린다 (e2e 결정성).
    // FCM 호출 하나가 매달려도 코멘트 POST/워커가 붙잡히지 않도록 호출마다 시간 상한을 둔다.
    const sends: Array<Promise<string[]>> = [];
    for (const n of created) {
      const mine = tokenRows.filter((t) => t.userId === n.userId);
      if (mine.length === 0) continue;
      // FCM data 값은 문자열만 허용 (아니면 invalid-argument)
      const data: Record<string, string> = { notificationId: n.id, bandId: event.bandId, sessionId: event.sessionId, type: n.type };
      if (takeId) data.takeId = takeId;
      if (comment) data.atMs = String(comment.atMs);
      // 같은 사용자의 기기가 언어가 다를 수 있어 locale별로 문구를 만든다
      const byLocale = new Map<string, string[]>();
      for (const t of mine) byLocale.set(t.locale, [...(byLocale.get(t.locale) ?? []), t.token]);
      for (const [locale, tokens] of byLocale) {
        const text = pushText(locale, {
          type: n.type,
          actorName,
          isSelf: n.userId === event.actorId,
          sessionLabel: session.name ?? session.title,
          takeCount: session.takeCount,
          takeName: take?.name ?? null,
          commentText: comment?.text ?? null,
        });
        sends.push(
          withTimeout(this.push.send(tokens, { ...text, data }), PUSH_SEND_TIMEOUT_MS, "push send").then(
            (res) => res.invalidTokens,
            (err: unknown) => {
              // 한 수신자의 전송 실패·시간 초과가 다른 수신자 발송과 호출자를 막지 않는다
              this.logger.warn(`push to user ${n.userId} failed: ${String(err)}`);
              return [];
            },
          ),
        );
      }
    }
    const results = await Promise.allSettled(sends);
    const invalid = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    if (invalid.length > 0) await this.tokens.removeMany(invalid);
  }

  // ---- 조회 ----

  async list(bandId: string, userId: string, cursor: string | null, limit: number): Promise<NotificationPage> {
    await this.memberships.assertMember(bandId, userId);
    // 30일 보존 — 크론 대신 조회 때 내 오래된 행을 지운다 (스펙 결정 9)
    await this.db.delete(notifications).where(and(eq(notifications.userId, userId), lt(notifications.createdAt, sql`now() - interval '${sql.raw(String(RETENTION_DAYS))} days'`)));
    const after = cursor ? decodeCursor(cursor) : null;
    const scope = and(eq(notifications.userId, userId), eq(notifications.bandId, bandId));
    // 커서의 시각은 µs 문자열 그대로 timestamptz로 캐스팅해 비교한다 (Date로 바꾸면 µs가 잘려 행이 건너뛰어진다)
    const olderThan = (createdAt: string, id: string) =>
      or(sql`${notifications.createdAt} < ${createdAt}::timestamptz`, and(sql`${notifications.createdAt} = ${createdAt}::timestamptz`, lt(notifications.id, id)));
    const where = after ? and(scope, olderThan(after.createdAt, after.id)) : scope;
    const rows = await this.db
      .select(ITEM_COLUMNS)
      .from(notifications)
      .innerJoin(sessions, eq(sessions.id, notifications.sessionId))
      .leftJoin(users, eq(users.id, notifications.actorId))
      .leftJoin(takes, eq(takes.id, notifications.takeId))
      .leftJoin(comments, eq(comments.id, notifications.commentId))
      .where(where)
      // 인덱스가 NULLS LAST로 만들어져 있어 같은 방향으로 맞춰야 정렬에 쓰인다 (두 컬럼 모두 NOT NULL이라 결과는 동일)
      .orderBy(sql`${notifications.createdAt} desc nulls last`, sql`${notifications.id} desc nulls last`)
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const hasMore = rows.length > limit && last !== undefined;
    let remaining = 0;
    if (hasMore && last) {
      const [r] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(notifications)
        .where(and(scope, olderThan(last.createdAtExact, last.id)));
      remaining = r?.n ?? 0;
    }
    return {
      items: page.map((row) => toItem(row)),
      nextCursor: hasMore && last ? encodeCursor(last.createdAtExact, last.id) : null,
      remaining,
      unreadCount: await this.countUnread(bandId, userId),
    };
  }

  async unreadCount(bandId: string, userId: string): Promise<number> {
    await this.memberships.assertMember(bandId, userId);
    return this.countUnread(bandId, userId);
  }

  private async countUnread(bandId: string, userId: string): Promise<number> {
    const [r] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.bandId, bandId), isNull(notifications.readAt), sql`${notifications.createdAt} >= now() - interval '${sql.raw(String(RETENTION_DAYS))} days'`));
    return r?.n ?? 0;
  }

  /** 내 알림만. 이미 읽었어도 성공 */
  async markRead(id: string, userId: string): Promise<void> {
    const updated = await this.db
      .update(notifications)
      .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
      .returning({ id: notifications.id });
    if (updated.length === 0) throw new NotFoundException("알림을 찾을 수 없어요.");
  }

  async markAllRead(bandId: string, userId: string): Promise<void> {
    await this.memberships.assertMember(bandId, userId);
    await this.db
      .update(notifications)
      .set({ readAt: sql`now()` })
      .where(and(eq(notifications.userId, userId), eq(notifications.bandId, bandId), isNull(notifications.readAt)));
  }

  // ---- 설정 ----

  /** 내 모든 밴드(삭제된 밴드 제외). 행이 없는 밴드는 기본값으로 채운다 */
  async settingsForUser(userId: string): Promise<NotificationSettings[]> {
    const rows = await this.db
      .select({ bandId: bandMembers.bandId, sessionReady: notificationSettings.sessionReady, comments: notificationSettings.comments, commentScope: notificationSettings.commentScope })
      .from(bandMembers)
      .innerJoin(bands, eq(bands.id, bandMembers.bandId))
      .leftJoin(notificationSettings, and(eq(notificationSettings.bandId, bandMembers.bandId), eq(notificationSettings.userId, userId)))
      .where(and(eq(bandMembers.userId, userId), isNull(bands.deletedAt)))
      .orderBy(asc(bands.createdAt));
    return rows.map((r) => ({
      bandId: r.bandId,
      sessionReady: r.sessionReady ?? DEFAULT_NOTIFICATION_SETTINGS.sessionReady,
      comments: r.comments ?? DEFAULT_NOTIFICATION_SETTINGS.comments,
      commentScope: r.commentScope ?? DEFAULT_NOTIFICATION_SETTINGS.commentScope,
    }));
  }

  async updateSettings(bandId: string, userId: string, input: UpdateNotificationSettingsInput): Promise<NotificationSettings> {
    await this.memberships.assertMember(bandId, userId);
    await this.db
      .insert(notificationSettings)
      .values({ userId, bandId, ...input, updatedAt: new Date() })
      .onConflictDoUpdate({ target: [notificationSettings.userId, notificationSettings.bandId], set: { ...input, updatedAt: new Date() } });
    return { bandId, ...input };
  }
}

export const notificationsServiceProvider: Provider = {
  provide: NotificationsService,
  useFactory: (db: Db, memberships: MembershipsService, tokens: PushTokensService, push: PushSender) => new NotificationsService(db, memberships, tokens, push),
  inject: [DB, MembershipsService, PushTokensService, PUSH_SENDER],
};
