import { Logger, UnauthorizedException } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import type { AuthTokens, LoginResponse } from "@bandapp/types";
import { UsersService } from "../users/users.service.js";
import { AppleAuthService } from "./apple-auth.service.js";
import { AppleTokenService } from "./apple-token.service.js";
import { AuthSessionsService } from "./auth-sessions.service.js";
import { GoogleAuthService } from "./google-auth.service.js";
import type { VerifiedProviderToken } from "./provider-token.js";
import { TokenService } from "./token.service.js";

export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly google: GoogleAuthService,
    private readonly apple: AppleAuthService,
    private readonly appleTokens: AppleTokenService,
    private readonly users: UsersService,
    private readonly sessions: AuthSessionsService,
    private readonly tokens: TokenService,
  ) {}

  async loginWithGoogle(idToken: string): Promise<LoginResponse> {
    const verified = await this.verifyOrThrow(() => this.google.verifyIdToken(idToken));
    return this.login("GOOGLE", verified);
  }

  async loginWithApple(input: {
    idToken: string;
    displayName?: string;
    authorizationCode?: string;
  }): Promise<LoginResponse> {
    const verified = await this.verifyOrThrow(() => this.apple.verifyIdToken(input.idToken));
    // Apple 이름은 토큰에 없다 — 최초 가입일 때만 클라이언트 전달값이 저장된다
    const res = await this.login("APPLE", {
      ...verified,
      displayName: input.displayName ?? verified.displayName,
    });
    if (input.authorizationCode) {
      await this.storeAppleRefreshToken(res.user.id, input.authorizationCode);
    }
    return res;
  }

  /**
   * 탈퇴 시 Apple 인가를 revoke하려면 refresh token이 필요한데, 그걸 얻을 수 있는
   * authorizationCode는 5분 1회용이라 로그인 시점에 교환해 둬야 한다.
   * 이미 저장돼 있으면 건너뛰고, 실패해도 로그인을 막지 않는다 (다음 로그인에 재시도된다).
   */
  private async storeAppleRefreshToken(userId: string, authorizationCode: string): Promise<void> {
    try {
      if (await this.users.hasProviderRefreshToken(userId, "APPLE")) return;
      const refreshToken = await this.appleTokens.exchangeAuthorizationCode(authorizationCode);
      if (refreshToken) await this.users.saveProviderRefreshToken(userId, "APPLE", refreshToken);
    } catch (err) {
      this.logger.warn(`apple refresh token 저장 실패: ${(err as Error).message}`);
    }
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
    appleTokens: AppleTokenService,
    users: UsersService,
    sessions: AuthSessionsService,
    tokens: TokenService,
  ) => new AuthService(google, apple, appleTokens, users, sessions, tokens),
  inject: [
    GoogleAuthService,
    AppleAuthService,
    AppleTokenService,
    UsersService,
    AuthSessionsService,
    TokenService,
  ],
};
