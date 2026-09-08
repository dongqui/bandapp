export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** 서버가 본문에 실어 보낸 기계 판독용 사유. 없을 수 있다. Mock도 같은 code를 던진다. */
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
