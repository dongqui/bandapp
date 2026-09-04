import { BadRequestException } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import type { CreateCommentInput, TakeComment } from "@bandapp/types";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { comments, users } from "../db/schema.js";
import { TakesService } from "../takes/takes.service.js";

const COMMENT_COLUMNS = {
  id: comments.id,
  takeId: comments.takeId,
  authorId: comments.authorId,
  authorName: users.displayName,
  parentId: comments.parentId,
  atMs: comments.atMs,
  text: comments.text,
  createdAt: comments.createdAt,
};

type CommentRow = {
  id: string;
  takeId: string;
  authorId: string;
  authorName: string | null;
  parentId: string | null;
  atMs: number;
  text: string;
  createdAt: Date;
};

function toComment(row: CommentRow): TakeComment {
  return {
    id: row.id,
    takeId: row.takeId,
    authorId: row.authorId,
    authorName: row.authorName ?? "탈퇴한 멤버",
    parentId: row.parentId,
    atSec: row.atMs / 1000,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
  };
}

export class CommentsService {
  constructor(
    private readonly db: Db,
    private readonly takes: TakesService,
  ) {}

  async list(takeId: string, userId: string): Promise<TakeComment[]> {
    await this.takes.loadForMember(takeId, userId);
    const rows = await this.db
      .select(COMMENT_COLUMNS)
      .from(comments)
      .innerJoin(users, eq(users.id, comments.authorId))
      .where(eq(comments.takeId, takeId))
      .orderBy(asc(comments.atMs), asc(comments.createdAt));
    return rows.map(toComment);
  }

  async create(takeId: string, userId: string, input: CreateCommentInput): Promise<TakeComment> {
    const take = await this.takes.loadForMember(takeId, userId);
    const text = input.text.trim();
    if (text.length === 0 || text.length > 500) throw new BadRequestException("text must be 1-500 characters");
    const atMs = Math.round(input.atSec * 1000);
    if (atMs > take.endMs - take.startMs) throw new BadRequestException("atSec is beyond the take length");
    const [inserted] = await this.db.insert(comments).values({ takeId, authorId: userId, atMs, text }).returning({ id: comments.id });
    if (!inserted) throw new Error("failed to insert comment");
    const [row] = await this.db
      .select(COMMENT_COLUMNS)
      .from(comments)
      .innerJoin(users, eq(users.id, comments.authorId))
      .where(eq(comments.id, inserted.id));
    if (!row) throw new Error("comment vanished after insert");
    return toComment(row);
  }
}

export const commentsServiceProvider: Provider = {
  provide: CommentsService,
  useFactory: (db: Db, takes: TakesService) => new CommentsService(db, takes),
  inject: [DB, TakesService],
};
