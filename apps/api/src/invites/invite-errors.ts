import type { InviteErrorCode } from "@bandapp/types";

const MESSAGES: Record<InviteErrorCode, string> = {
  invite_not_found: "유효하지 않은 초대예요.",
  invite_revoked: "더 이상 사용할 수 없는 초대예요.",
  invite_expired: "초대가 만료되었어요.",
  invite_exhausted: "초대 사용 횟수가 모두 찼어요.",
};

/**
 * HttpException에 객체를 넘기면 그 객체가 그대로 응답 본문이 된다.
 * 기존 클라이언트가 body.message를 읽고 있어 하위 호환된다 (스펙 결정 9).
 */
export function inviteError(code: InviteErrorCode): { message: string; code: InviteErrorCode } {
  return { message: MESSAGES[code], code };
}
