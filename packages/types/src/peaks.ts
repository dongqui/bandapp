/**
 * Take.peaks / Session.peaks 길이. 값은 0~255 정수이고 객체(take 하나, 또는 세션 전체) 안의 최댓값이 255다.
 * 완전 무음이면 전부 0 (2026-09-10 스펙 결정 2).
 */
export const PEAK_BUCKETS = 128;
