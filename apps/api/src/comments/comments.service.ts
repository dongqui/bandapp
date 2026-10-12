import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { and, asc, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { CreateCommentInput, TakeComment, UpdateCommentInput } from "@bandapp/types";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { commentReadMarks, comments, users } from "../db/schema.js";
import { SessionsService } from "../sessions/sessions.service.js";
import { TakesService } from "../takes/takes.service.js";

/** 코멘트가 붙는 대상. take 코멘트와 원본 녹음(세션) 코멘트를 한 코드 경로로 다룬다 (2026-09-09 스펙 결정 4, 5) */
export interface CommentScope {
  sessionId: string;
  /** 원본 녹음이면 null */
  takeId: string | null;
  /** 시점 상한(ms). null이면 검사하지 않는다 — 가져오기 세션은 워커가 재기 전까지 길이를 모른다 */
  lengthMs: number | null;
}

const COMMENT_COLUMNS = {
  id: comments.id,
  sessionId: comments.sessionId,
  takeId: comments.takeId,
  authorId: comments.authorId,
  authorName: users.displayName,
  parentId: comments.parentId,
  atMs: comments.atMs,
  text: comments.text,
  createdAt: comments.createdAt,
  updatedAt: comments.updatedAt,
};

type CommentRow = {
  id: string;
  sessionId: string;
  takeId: string | null;
  authorId: string;
  authorName: string | null;
  parentId: string | null;
  atMs: number;
  text: string;
  createdAt: Date;
  updatedAt: Date | null;
};

/** 내 코멘트는 항상 읽음. 마크가 없으면 남의 코멘트는 전부 안 읽음 */
function isUnread(row: Pick<CommentRow, "authorId" | "createdAt">, userId: string, readAt: Date | null): boolean {
  if (row.authorId === userId) return false;
  return readAt === null || row.createdAt > readAt;
}

function toComment(row: CommentRow, unread: boolean): TakeComment {
  return {
    id: row.id,
    sessionId: row.sessionId,
    takeId: row.takeId,
    authorId: row.authorId,
    authorName: row.authorName ?? "탈퇴한 멤버",
    parentId: row.parentId,
    atSec: row.atMs / 1000,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt?.toISOString() ?? null,
    unread,
  };
}

function normalizeText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 500) throw new BadRequestException("text must be 1-500 characters");
  return trimmed;
}

/** scope 안의 코멘트만 고르는 where — take 코멘트는 take_id로, 원본 코멘트는 session_id + take_id IS NULL로 */
function inScope(scope: CommentScope): SQL {
  return scope.takeId ? eq(comments.takeId, scope.takeId) : and(eq(comments.sessionId, scope.sessionId), isNull(comments.takeId))!;
}

export class CommentsService {
  constructor(
    private readonly db: Db,
    private readonly takes: TakesService,
    private readonly sessions: SessionsService,
  ) {}

  /** 없으면 404, 멤버가 아니면 403 (takes.loadForMember) */
  async scopeForTake(takeId: string, userId: string): Promise<CommentScope> {
    const take = await this.takes.loadForMember(takeId, userId);
    return { sessionId: take.sessionId, takeId, lengthMs: take.endMs - take.startMs };
  }

  /** 없으면 404, 멤버가 아니면 403 (sessions.loadForMember) */
  async scopeForSession(sessionId: string, userId: string): Promise<CommentScope> {
    const session = await this.sessions.loadForMember(sessionId, userId);
    return { sessionId, takeId: null, lengthMs: session.durationMs };
  }

  async list(scope: CommentScope, userId: string): Promise<TakeComment[]> {
    const [rows, readAt] = await Promise.all([
      this.db.select(COMMENT_COLUMNS).from(comments).innerJoin(users, eq(users.id, comments.authorId)).where(inScope(scope)).orderBy(asc(comments.atMs), asc(comments.createdAt)),
      this.readMarkOf(scope, userId),
    ]);
    return rows.map((row) => toComment(row, isUnread(row, userId, readAt)));
  }

  /** 대상(take 또는 원본 녹음)의 코멘트를 "지금까지 봤다"고 기록한다 (2026-10-12 스펙 결정 13). 두 번 불러도 read_at만 갱신 */
  async markRead(scope: CommentScope, userId: string): Promise<void> {
    await this.db
      .insert(commentReadMarks)
      .values({ userId, sessionId: scope.sessionId, takeId: scope.takeId })
      .onConflictDoUpdate({
        target: [commentReadMarks.userId, commentReadMarks.sessionId, commentReadMarks.takeId],
        set: { readAt: sql`now()` },
      });
  }

  private async readMarkOf(scope: CommentScope, userId: string): Promise<Date | null> {
    const [mark] = await this.db
      .select({ readAt: commentReadMarks.readAt })
      .from(commentReadMarks)
      .where(and(eq(commentReadMarks.userId, userId), eq(commentReadMarks.sessionId, scope.sessionId), scope.takeId ? eq(commentReadMarks.takeId, scope.takeId) : isNull(commentReadMarks.takeId)));
    return mark?.readAt ?? null;
  }

  async create(scope: CommentScope, userId: string, input: CreateCommentInput): Promise<TakeComment> {
    const text = normalizeText(input.text);
    const parentId = input.parentId ?? null;
    let atMs: number;
    if (parentId) {
      // 스레드는 1단계 — 부모는 같은 대상의 최상위 코멘트여야 한다 (스레드 스펙 결정 1, 3; 2026-09-09 스펙 결정 5)
      const [parent] = await this.db
        .select({ atMs: comments.atMs, parentId: comments.parentId })
        .from(comments)
        .where(and(eq(comments.id, parentId), inScope(scope)));
      if (!parent || parent.parentId !== null) throw new BadRequestException("parentId must be a top-level comment on this target");
      atMs = parent.atMs;
    } else {
      if (input.atSec === undefined) throw new BadRequestException("atSec is required");
      atMs = Math.round(input.atSec * 1000);
      if (scope.lengthMs !== null && atMs > scope.lengthMs) throw new BadRequestException("atSec is beyond the recording length");
    }
    const [inserted] = await this.db
      .insert(comments)
      .values({ sessionId: scope.sessionId, takeId: scope.takeId, authorId: userId, parentId, atMs, text })
      .returning({ id: comments.id });
    if (!inserted) throw new Error("failed to insert comment");
    return this.getOne(inserted.id);
  }

  async update(id: string, userId: string, input: UpdateCommentInput): Promise<TakeComment> {
    const text = normalizeText(input.text);
    await this.loadOwn(id, userId);
    await this.db.update(comments).set({ text, updatedAt: new Date() }).where(eq(comments.id, id));
    return this.getOne(id);
  }

  /** 답글은 parent_id의 ON DELETE CASCADE로 함께 지워진다 (2026-09-09 스펙 결정 3) */
  async remove(id: string, userId: string): Promise<void> {
    await this.loadOwn(id, userId);
    await this.db.delete(comments).where(eq(comments.id, id));
  }

  /** 없으면 404 → 비멤버 403 → 작성자 아님 403 (2026-09-09 스펙 결정 7) */
  private async loadOwn(id: string, userId: string): Promise<void> {
    const [row] = await this.db.select({ sessionId: comments.sessionId, authorId: comments.authorId }).from(comments).where(eq(comments.id, id));
    if (!row) throw new NotFoundException("코멘트를 찾을 수 없어요.");
    await this.sessions.loadForMember(row.sessionId, userId);
    if (row.authorId !== userId) throw new ForbiddenException("내 코멘트만 고치거나 지울 수 있어요.");
  }

  private async getOne(id: string): Promise<TakeComment> {
    const [row] = await this.db.select(COMMENT_COLUMNS).from(comments).innerJoin(users, eq(users.id, comments.authorId)).where(eq(comments.id, id));
    if (!row) throw new Error("comment vanished");
    // 방금 쓰거나 고친 내 코멘트라 unread일 수 없다
    return toComment(row, false);
  }
}

export const commentsServiceProvider: Provider = {
  provide: CommentsService,
  useFactory: (db: Db, takes: TakesService, sessions: SessionsService) => new CommentsService(db, takes, sessions),
  inject: [DB, TakesService, SessionsService],
};
