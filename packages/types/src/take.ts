import type { TakeCandidateType } from "./analysis";

/** 재컷(오디오 재생성) 진행 상태 */
export type TakeAudioStatus = "ready" | "updating" | "failed";

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
  /** 원본 타임라인의 startMs~endMs 구간 피크 (길이 PEAK_BUCKETS). 워커가 못 만들었거나 옛 데이터면 null */
  peaks: number[] | null;
  /** PATCH 낙관적 잠금용. 경계를 바꿀 때마다 +1 (2026-09-11 스펙 B 결정 4) */
  version: number;
  /** 재컷 진행 상태. updating이면 플레이어가 재생을 막는다 (결정 3) */
  audioStatus: TakeAudioStatus;
}

export interface UpdateTakeInput {
  startMs: number;
  endMs: number;
  /** 목록에서 본 값. 다르면 409 take_version_conflict */
  version: number;
}

export interface TakeComment {
  id: string;
  sessionId: string;
  /** 원본 녹음 코멘트면 null (2026-09-09 스펙 결정 4) */
  takeId: string | null;
  authorId: string;
  authorName: string;
  /** 답글이면 부모(최상위 코멘트) id. 스레드는 1단계만 허용한다 */
  parentId: string | null;
  /** 답글은 부모의 시점을 물려받는다 */
  atSec: number;
  text: string;
  createdAt: string;
  /** 본문을 수정한 적 있으면 채워진다 → 클라이언트가 "edited"를 그린다 */
  updatedAt: string | null;
}

/** 코멘트가 붙는 대상 — take 또는 원본 녹음(세션) */
export type CommentTarget = { takeId: string } | { sessionId: string };

export interface CreateCommentInput {
  text: string;
  /** parentId가 없을 때 필수 */
  atSec?: number;
  /** 있으면 답글. atSec은 무시되고 부모의 시점을 쓴다 */
  parentId?: string;
}

export interface UpdateCommentInput {
  /** 본문만 고친다. 시점은 지우고 다시 남긴다 */
  text: string;
}
