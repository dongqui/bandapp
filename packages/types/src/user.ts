export interface User {
  id: string;
  displayName: string | null;
  /** 직접 올린 사진이면 R2 presigned URL(7일), 아니면 로그인 제공자가 준 URL. 없으면 null */
  profileImageUrl: string | null;
  /** 로그인 identity의 이메일. dev 로그인 등 없으면 null */
  email: string | null;
}

/** 이름은 trim 후 1~DISPLAY_NAME_MAX자. 서버·Mock·입력 maxLength가 같은 값을 쓴다 */
export const DISPLAY_NAME_MAX = 50;

export interface UpdateMeInput {
  displayName: string;
}
