import type { User } from "./user";

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface LoginResponse extends AuthTokens {
  user: User;
  isNewUser: boolean;
}
