import { ApiError } from "@bandapp/api-client";
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
 */
export function classifyUploadFailure(err: unknown, mode: "upload" | "resume"): UploadFailure {
  if (err instanceof MissingUploadFileError) {
    return { message: "Recording file is missing", discard: true, retryable: false, refetch: false };
  }
  if (err instanceof ApiError && err.status === 404) {
    return { message: "This session no longer exists", discard: true, retryable: false, refetch: false };
  }
  if (err instanceof ApiError && err.status === 409) {
    return { message: "", discard: true, retryable: false, refetch: true };
  }
  return { message: mode === "resume" ? RESUME_ERROR : UPLOAD_ERROR, discard: false, retryable: true, refetch: false };
}
