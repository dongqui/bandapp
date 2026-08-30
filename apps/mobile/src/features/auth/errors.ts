/** 사용자가 Provider 로그인 시트를 닫은 경우 — 오류 Toast 없이 조용히 무시한다 (기획서 19장) */
export class AuthCancelledError extends Error {
  constructor() {
    super("auth cancelled by user");
    this.name = "AuthCancelledError";
  }
}
