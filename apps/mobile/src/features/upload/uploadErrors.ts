/** 이어 올릴 녹음 파일(또는 그 레코드)이 이 기기에 없다 — 재시도해도 소용없는 오류. */
export class MissingUploadFileError extends Error {
  constructor(message = "recording file not found") {
    super(message);
    this.name = "MissingUploadFileError";
  }
}
