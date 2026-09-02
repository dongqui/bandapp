export interface InvitePreview {
  band: { name: string; memberCount: number };
  invitedBy: { displayName: string | null };
  expiresAt: string;
}

export interface BandInvite {
  id: string;
  url: string;
  expiresAt: string;
}

export interface JoinInviteResult {
  bandId: string;
  alreadyMember: boolean;
}

/** 초대 조회·참여 실패 사유. 서버가 오류 본문의 code로 내려준다 (스펙 결정 7). */
export type InviteErrorCode =
  | "invite_not_found"
  | "invite_revoked"
  | "invite_expired"
  | "invite_exhausted";
