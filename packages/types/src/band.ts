export type MemberRole = "owner" | "member";

export interface Band {
  id: string;
  name: string;
  memberCount: number;
  inviteCode: string;
}

export interface BandMember {
  id: string;
  name: string;
  role: MemberRole;
}
