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
