import { Logger, UnauthorizedException } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import type { AuthTokens, LoginResponse } from "@bandapp/types";
import { UsersService } from "../users/users.service.js";
import { AppleAuthService } from "./apple-auth.service.js";
import { AuthSessionsService } from "./auth-sessions.service.js";
import { GoogleAuthService } from "./google-auth.service.js";
import type { VerifiedProviderToken } from "./provider-token.js";
import { TokenService } from "./token.service.js";

export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly google: GoogleAuthService,
    private readonly apple: AppleAuthService,
    private readonly users: UsersService,
    private readonly sessions: AuthSessionsService,
    private readonly tokens: TokenService,
  ) {}

  async loginWithGoogle(idToken: string): Promise<LoginResponse> {
    const verified = await this.verifyOrThrow(() => this.google.verifyIdToken(idToken));
    return this.login("GOOGLE", verified);
  }

  async loginWithApple(idToken: string, displayName?: string): Promise<LoginResponse> {
    const verified = await this.verifyOrThrow(() => this.apple.verifyIdToken(idToken));
    // Apple 이름은 토큰에 없다 — 최초 가입일 때만 클라이언트 전달값이 저장된다
    return this.login("APPLE", { ...verified, displayName: displayName ?? verified.displayName });
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    const rotated = await this.sessions.rotate(refreshToken);
    if (!rotated) throw new UnauthorizedException("세션이 만료됐어요. 다시 로그인해 주세요.");
    return {
      accessToken: await this.tokens.signAccessToken(rotated.userId),
      refreshToken: rotated.refreshToken,
    };
  }

  async logout(refreshToken: string): Promise<void> {
    await this.sessions.revoke(refreshToken);
  }

  private async verifyOrThrow(
    verify: () => Promise<VerifiedProviderToken>,
  ): Promise<VerifiedProviderToken> {
    try {
      return await verify();
    } catch (err) {
      // OAuth 내부 오류 문자열을 클라이언트에 노출하지 않는다 (기획서 19장)
      this.logger.warn(`provider token verification failed: ${(err as Error).message}`);
      throw new UnauthorizedException("로그인에 실패했어요. 다시 시도해 주세요.");
    }
  }

  private async login(
    provider: "GOOGLE" | "APPLE",
    verified: VerifiedProviderToken,
  ): Promise<LoginResponse> {
    const { user, isNewUser } = await this.users.findOrCreateByIdentity(provider, verified);
    const refreshToken = await this.sessions.issue(user.id);
    const accessToken = await this.tokens.signAccessToken(user.id);
    return { accessToken, refreshToken, user, isNewUser };
  }
}

export const authServiceProvider: Provider = {
  provide: AuthService,
  useFactory: (
    google: GoogleAuthService,
    apple: AppleAuthService,
    users: UsersService,
    sessions: AuthSessionsService,
    tokens: TokenService,
  ) => new AuthService(google, apple, users, sessions, tokens),
  inject: [GoogleAuthService, AppleAuthService, UsersService, AuthSessionsService, TokenService],
};
