import { Logger } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { SignJWT, importPKCS8 } from "jose";

const APPLE_ISSUER = "https://appleid.apple.com";

interface AppleCredentials {
  teamId: string;
  keyId: string;
  privateKey: string;
  clientId: string;
}

/**
 * Apple REST API(토큰 교환 / revoke) 호출 전담.
 * id_token 검증은 AppleAuthService가 하고, 여기는 Apple 서버로 요청을 보내는 쪽만 맡는다.
 *
 * 자격증명이 없으면 전 기능 no-op이다 — .p8 발급 전에도 로그인·탈퇴가 그대로 동작해야 하므로
 * 리포의 다른 env(미설정 시 throw)와 달리 예외를 둔다.
 */
export class AppleTokenService {
  private readonly logger = new Logger(AppleTokenService.name);
  private warned = false;

  /** authorization code를 refresh token으로 교환한다. 실패하면 null. */
  async exchangeAuthorizationCode(code: string): Promise<string | null> {
    const creds = this.credentials();
    if (!creds) return null;
    try {
      const res = await this.post(`${APPLE_ISSUER}/auth/token`, {
        client_id: creds.clientId,
        client_secret: await this.clientSecret(creds),
        code,
        // 네이티브 인가 요청은 redirect_uri를 주지 않으므로 여기서도 보내지 않는다
        grant_type: "authorization_code",
      });
      if (!res.ok) {
        this.logger.warn(`apple token exchange failed: ${res.status}`);
        return null;
      }
      const body = (await res.json()) as { refresh_token?: unknown };
      return typeof body.refresh_token === "string" ? body.refresh_token : null;
    } catch (err) {
      this.logger.warn(`apple token exchange error: ${(err as Error).message}`);
      return null;
    }
  }

  /** 탈퇴 시 Apple 인가를 무효화한다. best-effort — 어떤 경우에도 throw하지 않는다. */
  async revokeAll(refreshTokens: string[]): Promise<void> {
    if (refreshTokens.length === 0) return;
    const creds = this.credentials();
    if (!creds) return;
    for (const token of refreshTokens) {
      try {
        const res = await this.post(`${APPLE_ISSUER}/auth/revoke`, {
          client_id: creds.clientId,
          client_secret: await this.clientSecret(creds),
          token,
          token_type_hint: "refresh_token",
        });
        // 이미 무효한 토큰도 200이므로, 200이 아니면 실제 실패다
        if (!res.ok) this.logger.error(`apple token revoke failed: ${res.status}`);
      } catch (err) {
        this.logger.error(`apple token revoke error: ${(err as Error).message}`);
      }
    }
  }

  private post(url: string, form: Record<string, string>): Promise<Response> {
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
      // Apple이 연결만 받고 응답을 안 주는 경우 undici 기본 헤더 타임아웃(300s)까지 무한정
      // 기다리게 되므로, 여기서 짧게 끊어 준다 — 실패 시 catch에서 이미 no-op 처리한다
      signal: AbortSignal.timeout(5000),
    });
  }

  private credentials(): AppleCredentials | null {
    const teamId = process.env.APPLE_TEAM_ID;
    const keyId = process.env.APPLE_KEY_ID;
    const privateKey = process.env.APPLE_PRIVATE_KEY;
    const clientId = process.env.APPLE_BUNDLE_ID;
    if (!teamId || !keyId || !privateKey || !clientId) {
      if (!this.warned) {
        this.warned = true;
        this.logger.warn(
          "Apple 자격증명이 없어 토큰 교환·revoke를 건너뛴다 (APPLE_TEAM_ID/APPLE_KEY_ID/APPLE_PRIVATE_KEY/APPLE_BUNDLE_ID)",
        );
      }
      return null;
    }
    return { teamId, keyId, privateKey, clientId };
  }

  /** .p8로 서명한 client_secret JWT. 서명이 저렴해 매 호출 생성한다 (캐싱하면 만료 관리가 붙는다). */
  private async clientSecret(creds: AppleCredentials): Promise<string> {
    // .env에 한 줄로 넣기 위해 개행을 \n으로 이스케이프해 두는 관례를 지원한다
    const pem = creds.privateKey.includes("\\n")
      ? creds.privateKey.replace(/\\n/g, "\n")
      : creds.privateKey;
    const key = await importPKCS8(pem, "ES256");
    return new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: creds.keyId })
      .setIssuer(creds.teamId)
      .setSubject(creds.clientId)
      .setAudience(APPLE_ISSUER)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(key);
  }
}

export const appleTokenServiceProvider: Provider = {
  provide: AppleTokenService,
  useFactory: () => new AppleTokenService(),
};
