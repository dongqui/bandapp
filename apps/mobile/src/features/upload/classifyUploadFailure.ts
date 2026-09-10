import { ApiError, UploadRecordingError } from "@bandapp/api-client";
import { MissingUploadFileError } from "./uploadErrors";

export interface UploadFailure {
  /** 화면 캡션. refetch면 빈 문자열 (세션을 다시 받아 흐름에 합류하므로 표시할 게 없다) */
  message: string;
  /** 로컬 레코드·파일을 지울지 */
  discard: boolean;
  /** "Try again" 칩을 보일지 */
  retryable: boolean;
  /** sessions.get으로 현재 상태를 받아 analyzing/ready 흐름에 합류할지 */
  refetch: boolean;
}

export const UPLOAD_ERROR = "Couldn’t upload this recording — check your connection and try again";
export const RESUME_ERROR = "Couldn’t resume the upload — check your connection and try again";

/**
 * 업로드/재개 오류를 화면 상태로 바꾼다 (2026-09-10 업로드 재개 스펙 결정 6). 순수 함수라 훅 없이 테스트한다.
 * 파일·레코드 없음과 404는 재시도해도 소용없으니 레코드를 지우고 칩을 숨긴다. 409는 다른 경로로 이미
 * 업로드가 끝난 것이라 레코드를 지우고 세션을 다시 받는다. 그 외(네트워크)는 레코드를 남겨 다시 시도한다.
 *
 * 404/409 분기는 재개(resume) 모드에서만 적용한다 — 결정 6의 표는 resumeRecordingUpload가 던지는
 * ApiError를 위한 것이다. 첫 업로드(upload) 모드에서 raw ApiError가 나올 수 있는 곳은 sessions.create
 * 뿐이라, 거기서 404가 나면 "세션이 없다"가 아니라 그냥 생성 자체가 실패한 것 — generic 메시지가 맞다.
 */
export function classifyUploadFailure(err: unknown, mode: "upload" | "resume"): UploadFailure {
  // uploadRecording은 실패를 UploadRecordingError로 감싼다 — 진짜 원인은 cause에 있으므로 그걸 분류한다.
  // 예: 첫 파트 PUT 전에 파일이 없어서 실패하면 cause가 MissingUploadFileError다.
  const cause = err instanceof UploadRecordingError && err.cause !== undefined ? err.cause : err;

  if (cause instanceof MissingUploadFileError) {
    return { message: "Recording file is missing", discard: true, retryable: false, refetch: false };
  }
  if (mode === "resume" && cause instanceof ApiError && cause.status === 404) {
    return { message: "This session no longer exists", discard: true, retryable: false, refetch: false };
  }
  if (mode === "resume" && cause instanceof ApiError && cause.status === 409) {
    return { message: "", discard: true, retryable: false, refetch: true };
  }
  return { message: mode === "resume" ? RESUME_ERROR : UPLOAD_ERROR, discard: false, retryable: true, refetch: false };
}
