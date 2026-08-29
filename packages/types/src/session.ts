export type SessionStatus = "uploading" | "analyzing" | "failed" | "ready";

export interface Session {
  id: string;
  bandId: string;
  /** 기본 표시명 (예: "Aug 27 Rehearsal") */
  title: string;
  /** 사용자가 붙인 이름 (예: "Full set run-through") */
  name?: string;
  status: SessionStatus;
  /** 로컬 시각 ISO 문자열, 타임존 접미사 없음 (예: "2026-08-27T19:03:00") */
  startedAt: string;
  durationSec: number;
  takeCount: number;
  /** 세션 내 전체 코멘트 수 (목록 meta 표시용) */
  commentCount: number;
}
