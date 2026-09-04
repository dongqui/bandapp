export type SessionStatus = "uploading" | "analyzing" | "failed" | "ready";

export interface Session {
  id: string;
  bandId: string;
  /** 기본 표시명 (예: "Aug 27 Rehearsal") */
  title: string;
  /** 사용자가 붙인 이름 (예: "Full set run-through") */
  name?: string;
  status: SessionStatus;
  /** ISO 8601, 오프셋 포함 (예: "2026-09-04T19:03:00.000Z"). 표시 시각은 클라이언트가 로컬로 변환한다. */
  startedAt: string;
  /** 워커가 측정하기 전(가져오기)에는 0 */
  durationSec: number;
  takeCount: number;
  /** 세션 내 전체 코멘트 수 (목록 meta 표시용) */
  commentCount: number;
}

export type RecordingContentType = "audio/mp4" | "audio/x-m4a";

export interface CreateSessionInput {
  /** ISO 8601, 오프셋 포함. 서버가 날짜 부분으로 title을 만든다. */
  startedAt: string;
  /** 녹음은 알고 있고, 가져오기는 모른다 (워커가 측정). */
  durationMs?: number;
  sizeBytes: number;
  contentType: RecordingContentType;
  source: "recording" | "import";
}

export interface CreateSessionResult {
  session: Session;
  upload: { partSize: number; partCount: number };
}

export interface UploadPartUrl {
  partNumber: number;
  url: string;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

export interface UploadStatus {
  partSize: number;
  partCount: number;
  uploadedParts: UploadedPart[];
}

export interface AudioUrl {
  url: string;
  expiresAt: string;
}
