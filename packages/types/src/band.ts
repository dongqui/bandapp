export type MemberRole = "owner" | "member";

/**
 * 파트 프리셋 키. 클라이언트가 이 키를 각 언어로 번역해 보여준다.
 * 서버는 이 목록을 참조하지 않는다 — 파트는 자유 문자열이고 프리셋은 그중 특별 취급되는 값일 뿐이다 (스펙 결정 1·2).
 */
export const BAND_PART_PRESETS = ["vocal", "guitar", "bass", "drums", "keyboard"] as const;
export type BandPartPreset = (typeof BAND_PART_PRESETS)[number];

export interface Band {
  id: string;
  name: string;
  memberCount: number;
}

export interface BandMember {
  id: string;
  name: string;
  role: MemberRole;
  /** null = 미설정. 프리셋 키(BAND_PART_PRESETS)거나 사용자가 직접 친 문자열(trim 후 1~20자). */
  part: string | null;
}

/** 밴드 관리 실패 사유. 서버가 오류 본문의 code로 내려준다. */
export type BandErrorCode =
  | "band_forbidden" // 403 멤버 아님 (삭제된 밴드 포함)
  | "band_owner_only" // 403 owner 전용
  | "band_owner_must_transfer" // 409 owner가 leave
  | "band_member_not_found" // 404 대상 userId가 멤버 아님
  | "band_cannot_remove_self" // 409 removeMember 대상이 본인
  | "band_cannot_remove_owner" // 409 removeMember 대상이 owner
  | "band_transfer_self"; // 409 transfer 대상이 본인
