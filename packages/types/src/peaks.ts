/**
 * Take.peaks / Session.peaks 길이. 값은 0~255 정수이고 객체(take 하나, 또는 세션 전체) 안의 최댓값이 255다.
 * 완전 무음이면 전부 0 (2026-09-10 스펙 결정 2).
 */
export const PEAK_BUCKETS = 128;

/**
 * 고해상도 피크 사이드카(peaks.bin) 헤더 — 워커 인코더와 앱 파서가 공유한다 (2026-09-11 스펙 결정 4).
 * 바이트 0..3 "TNPK", 4 version, 5..6 peaksPerSec(u16 LE), 7 reserved(0), 8.. 피크 바이트(0~255).
 */
export const PEAKS_FILE_MAGIC = "TNPK";
export const PEAKS_FILE_VERSION = 1;
export const PEAKS_FILE_HEADER_BYTES = 8;
