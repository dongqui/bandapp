export type TakeCandidateType = "PERFORMANCE" | "PARTIAL_PRACTICE";

/** AI 분석이 추출한 연주 구간 후보. 사용자가 수정 가능한 초안이다. */
export interface TakeCandidate {
  startMs: number;
  endMs: number;
  type: TakeCandidateType;
  /** 0..1 */
  confidence: number;
}

/** SQS recording-analysis 큐 메시지 본문 */
export interface AnalyzeSessionJob {
  sessionId: string;
}

/** take 재컷 잡 — AnalyzeSessionJob과 같은 큐를 쓴다. type이 없으면 분석 잡이다 (스펙 B §타입·API 계약) */
export type RecutTakeJob = { type: "recut"; takeId: string; version: number };
export type QueueJob = AnalyzeSessionJob | RecutTakeJob;
