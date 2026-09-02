export type MemberRole = "owner" | "member";

/** DB의 band_part enum과 값을 일치시킨다. 표시 문자열(VOCAL, Vocal)은 클라이언트 책임. */
export type BandPart = "vocal" | "guitar" | "bass" | "drums" | "keyboard" | "other";

export interface Band {
  id: string;
  name: string;
  memberCount: number;
}

export interface BandMember {
  id: string;
  name: string;
  role: MemberRole;
  /** null = 미설정. optional이 아니라 필수 nullable — "안 불러왔다"와 "설정 안 했다"를 구분한다. */
  part: BandPart | null;
}
