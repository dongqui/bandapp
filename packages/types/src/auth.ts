import type { User } from "./user";

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface LoginResponse extends AuthTokens {
  user: User;
  isNewUser: boolean;
}

/** 네이티브 Apple 로그인이 내려주는 값. authorizationCode는 탈퇴 시 revoke용으로 서버가 교환한다. */
export interface AppleLoginCredential {
  idToken: string;
  displayName?: string;
  authorizationCode?: string;
}
