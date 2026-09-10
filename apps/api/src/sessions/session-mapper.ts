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
  peaks: number[] | null;
  updatedAt: Date;
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
    peaks: row.peaks ?? null,
  };
  if (row.name !== null) session.name = row.name;
  return session;
}

/** 세션 목록·단건 조회가 공유하는 select 컬럼. commentCount는 session_id로 직접 집계한다 (take 코멘트·원본 녹음 코멘트 모두 포함). */
export const SESSION_WITH_COUNTS = {
  id: sessions.id,
  bandId: sessions.bandId,
  title: sessions.title,
  name: sessions.name,
  status: sessions.status,
  startedAt: sessions.startedAt,
  durationMs: sessions.durationMs,
  takeCount: sessions.takeCount,
  peaks: sessions.peaks,
  // retry()가 analyzing 정체 판단에 쓴다 — wire Session에는 노출하지 않는다 (toSession에서 사용 안 함).
  updatedAt: sessions.updatedAt,
  // 상관 서브쿼리이므로 "sessions"."id"를 테이블명까지 명시해 comments.id와의 모호성을 없앤다.
  // 답글은 세지 않는다 (스레드 스펙 결정 5). 원본 녹음 코멘트도 session_id로 함께 센다 (2026-09-09 스펙 결정 6).
  commentCount: sql<number>`(select count(*)::int from comments c where c.session_id = "sessions"."id" and c.parent_id is null)`,
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
