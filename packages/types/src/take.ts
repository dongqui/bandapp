import type { TakeCandidateType } from "./analysis";

export interface Take {
  id: string;
  sessionId: string;
  /** 0부터 시작 */
  index: number;
  name: string;
  durationSec: number;
  /** 원본 녹음 기준 구간 */
  startMs: number;
  endMs: number;
  type: TakeCandidateType;
  commentCount: number;
}

export interface TakeComment {
  id: string;
  takeId: string;
  authorId: string;
  authorName: string;
  /** 대댓글용. 이번 범위에서는 항상 null */
  parentId: string | null;
  atSec: number;
  text: string;
  createdAt: string;
}

export interface CreateCommentInput {
  atSec: number;
  text: string;
}
