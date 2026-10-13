import { BadRequestException } from "@nestjs/common";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * (created_at desc, id desc) 페이지 커서. 불투명 base64url — 클라이언트는 그대로 돌려준다.
 * createdAt은 DB가 준 마이크로초 정밀도 문자열 그대로 — JS Date(ms)로 바꾸면 µs 단위 차이로 행이 건너뛰어진다
 */
export function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt, id }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { t?: unknown; id?: unknown };
    if (typeof parsed.t !== "string" || typeof parsed.id !== "string") throw new Error("shape");
    if (Number.isNaN(new Date(parsed.t).getTime())) throw new Error("date");
    // uuid가 아니면 쿼리에서 22P02(500)가 나므로 여기서 400으로 막는다
    if (!UUID_RE.test(parsed.id)) throw new Error("id");
    return { createdAt: parsed.t, id: parsed.id };
  } catch {
    throw new BadRequestException("cursor is invalid");
  }
}
