import { NotFoundException } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { asc, eq, sql } from "drizzle-orm";
import type { AudioUrl, Take, TakeCandidateType } from "@bandapp/types";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { takes } from "../db/schema.js";
import { PRESIGN_EXPIRES_SEC, SessionsService } from "../sessions/sessions.service.js";
import { StorageService } from "../storage/storage.service.js";

export const TAKE_WITH_COUNT = {
  id: takes.id,
  sessionId: takes.sessionId,
  index: takes.index,
  name: takes.name,
  startMs: takes.startMs,
  endMs: takes.endMs,
  type: takes.type,
  objectKey: takes.objectKey,
  // ${takes.id}는 단일 테이블 select에서 테이블 접두어 없이 "id"로 렌더링돼 서브쿼리 안의
  // comments.id와 충돌한다 — 상관 서브쿼리이므로 테이블명을 직접 명시해 모호성을 없앤다.
  commentCount: sql<number>`(select count(*)::int from comments c where c.take_id = "takes"."id")`,
};

export interface TakeRow {
  id: string;
  sessionId: string;
  index: number;
  name: string;
  startMs: number;
  endMs: number;
  type: TakeCandidateType;
  objectKey: string;
  commentCount: number;
}

export function toTake(row: TakeRow): Take {
  return {
    id: row.id,
    sessionId: row.sessionId,
    index: row.index,
    name: row.name,
    durationSec: Math.round((row.endMs - row.startMs) / 1000),
    startMs: row.startMs,
    endMs: row.endMs,
    type: row.type,
    commentCount: row.commentCount,
  };
}

export class TakesService {
  constructor(
    private readonly db: Db,
    private readonly sessions: SessionsService,
    private readonly storage: StorageService,
  ) {}

  async list(sessionId: string, userId: string): Promise<Take[]> {
    await this.sessions.loadForMember(sessionId, userId);
    const rows = await this.db.select(TAKE_WITH_COUNT).from(takes).where(eq(takes.sessionId, sessionId)).orderBy(asc(takes.index));
    return rows.map(toTake);
  }

  /** take → 세션 순으로 검증한다 (sessions.loadForMember가 멤버십을 확인한다). 없으면 404, 멤버가 아니면 403. */
  async loadForMember(takeId: string, userId: string): Promise<TakeRow> {
    const [row] = await this.db.select(TAKE_WITH_COUNT).from(takes).where(eq(takes.id, takeId));
    if (!row) throw new NotFoundException("Take를 찾을 수 없어요.");
    await this.sessions.loadForMember(row.sessionId, userId);
    return row;
  }

  async audioUrl(takeId: string, userId: string): Promise<AudioUrl> {
    const take = await this.loadForMember(takeId, userId);
    return {
      url: await this.storage.presignGet(take.objectKey, PRESIGN_EXPIRES_SEC),
      expiresAt: new Date(Date.now() + PRESIGN_EXPIRES_SEC * 1000).toISOString(),
    };
  }
}

export const takesServiceProvider: Provider = {
  provide: TakesService,
  useFactory: (db: Db, sessions: SessionsService, storage: StorageService) => new TakesService(db, sessions, storage),
  inject: [DB, SessionsService, StorageService],
};
