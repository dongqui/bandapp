import { sql, type SQL } from "drizzle-orm";

/**
 * "내가 안 읽은 코멘트" 상관 서브쿼리 (2026-10-12 스펙 결정 13).
 * 대상별 read mark(comment_read_marks)가 없으면 전부, 있으면 read_at 이후 것만 센다. 내 코멘트는 제외, 답글은 포함.
 * 외부 쿼리의 테이블명("takes"/"sessions")을 직접 쓰는 이유는 takeColumns와 같다 — 단일 테이블 select에서
 * 컬럼이 접두어 없이 렌더돼 서브쿼리 안 컬럼과 충돌한다.
 */
export function unreadTakeCommentCount(userId: string): SQL<number> {
  return sql<number>`(select count(*)::int from comments c
    left join comment_read_marks m on m.user_id = ${userId}::uuid and m.session_id = c.session_id and m.take_id is not distinct from c.take_id
    where c.take_id = "takes"."id" and c.author_id <> ${userId}::uuid and (m.read_at is null or c.created_at > m.read_at))`;
}

export function unreadSessionCommentCount(userId: string): SQL<number> {
  return sql<number>`(select count(*)::int from comments c
    left join comment_read_marks m on m.user_id = ${userId}::uuid and m.session_id = c.session_id and m.take_id is not distinct from c.take_id
    where c.session_id = "sessions"."id" and c.author_id <> ${userId}::uuid and (m.read_at is null or c.created_at > m.read_at))`;
}
