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
