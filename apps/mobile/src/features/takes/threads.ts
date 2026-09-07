import type { TakeComment } from "@bandapp/types";

export interface CommentThread {
  comment: TakeComment;
  /** createdAt 순 */
  replies: TakeComment[];
}

/**
 * 평면 코멘트 목록을 스레드로 묶는다. 최상위는 atSec → createdAt 순, 답글은 createdAt 순.
 * 부모가 목록에 없는 답글은 버린다 (스레드 스펙 결정 4).
 */
export function groupThreads(comments: TakeComment[]): CommentThread[] {
  const top: TakeComment[] = [];
  const repliesByParent = new Map<string, TakeComment[]>();
  for (const c of comments) {
    if (c.parentId === null) {
      top.push(c);
      continue;
    }
    const list = repliesByParent.get(c.parentId);
    if (list) list.push(c);
    else repliesByParent.set(c.parentId, [c]);
  }
  const byCreated = (a: TakeComment, b: TakeComment) => a.createdAt.localeCompare(b.createdAt);
  const byTime = (a: TakeComment, b: TakeComment) => a.atSec - b.atSec || byCreated(a, b);
  return top.sort(byTime).map((comment) => ({
    comment,
    replies: (repliesByParent.get(comment.id) ?? []).sort(byCreated),
  }));
}
