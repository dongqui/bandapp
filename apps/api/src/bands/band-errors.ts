import type { BandErrorCode } from "@bandapp/types";

const MESSAGES: Record<BandErrorCode, string> = {
  band_forbidden: "이 밴드에 접근할 수 없어요.",
  band_owner_only: "밴드 관리자만 할 수 있어요.",
  band_owner_must_transfer: "관리자는 먼저 소유권을 넘기거나 팀을 삭제해야 해요.",
  band_member_not_found: "팀원을 찾을 수 없어요.",
  band_cannot_remove_self: "자기 자신은 내보낼 수 없어요. 팀 나가기를 사용해 주세요.",
  band_cannot_remove_owner: "팀장은 내보낼 수 없어요.",
  band_transfer_self: "이미 소유자예요.",
};

/**
 * HttpException에 객체를 넘기면 그 객체가 그대로 응답 본문이 된다. 클라이언트는 code로 번역하고,
 * code를 모르는 옛 클라이언트는 message를 그대로 보여준다 (2026-09-08 스펙 결정 8).
 */
export function bandError(code: BandErrorCode): { message: string; code: BandErrorCode } {
  return { message: MESSAGES[code], code };
}
