import { sql } from "drizzle-orm";
import type { Session, SessionStatus } from "@bandapp/types";
import { sessions } from "../db/schema.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 클라이언트가 보낸 오프셋 문자열의 날짜 부분이 곧 사용자의 로컬 날짜다 — 서버 타임존으로 다시 계산하지 않는다. */
export function titleFor(startedAtIso: string): string {
  const month = Number(startedAtIso.slice(5, 7));
  const day = Number(startedAtIso.slice(8, 10));
  return `${MONTHS[month - 1]} ${day} Rehearsal`;
}

export interface SessionRow {
  id: string;
  bandId: string;
  title: string;
  name: string | null;
  status: SessionStatus;
  startedAt: Date;
  durationMs: number | null;
  takeCount: number;
  commentCount: number;
}

export function toSession(row: SessionRow): Session {
  const session: Session = {
    id: row.id,
    bandId: row.bandId,
    title: row.title,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    durationSec: Math.round((row.durationMs ?? 0) / 1000),
    takeCount: row.takeCount,
    commentCount: row.commentCount,
  };
  if (row.name !== null) session.name = row.name;
  return session;
}

/** 세션 목록·단건 조회가 공유하는 select 컬럼. commentCount는 takes를 거쳐 집계한다. */
export const SESSION_WITH_COUNTS = {
  id: sessions.id,
  bandId: sessions.bandId,
  title: sessions.title,
  name: sessions.name,
  status: sessions.status,
  startedAt: sessions.startedAt,
  durationMs: sessions.durationMs,
  takeCount: sessions.takeCount,
  // ${sessions.id}는 단일 테이블 select에서 테이블 접두어 없이 "id"로 렌더링돼 서브쿼리 안의
  // takes.id/comments.id와 충돌한다 — 상관 서브쿼리이므로 테이블명을 직접 명시해 모호성을 없앤다.
  commentCount: sql<number>`(select count(*)::int from comments c join takes t on t.id = c.take_id where t.session_id = "sessions"."id")`,
};

export function originalKey(bandId: string, sessionId: string): string {
  return `bands/${bandId}/sessions/${sessionId}/original.m4a`;
}

export function takeKey(bandId: string, sessionId: string, takeId: string): string {
  return `bands/${bandId}/sessions/${sessionId}/takes/${takeId}.m4a`;
}

/** takeKey가 만드는 객체 키들의 공통 접두어. DB 행 없이 R2에만 남은 take 객체를 찾을 때 쓴다. */
export function takesPrefix(bandId: string, sessionId: string): string {
  return `bands/${bandId}/sessions/${sessionId}/takes/`;
}
