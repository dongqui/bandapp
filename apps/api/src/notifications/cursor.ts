import { BadRequestException } from "@nestjs/common";

/** (created_at desc, id desc) 페이지 커서. 불투명 base64url — 클라이언트는 그대로 돌려준다 */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt.toISOString(), id }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { t?: unknown; id?: unknown };
    if (typeof parsed.t !== "string" || typeof parsed.id !== "string") throw new Error("shape");
    const createdAt = new Date(parsed.t);
    if (Number.isNaN(createdAt.getTime())) throw new Error("date");
    return { createdAt, id: parsed.id };
  } catch {
    throw new BadRequestException("cursor is invalid");
  }
}
