import type {
  AppleLoginCredential,
  AuthTokens,
  Band,
  BandInvite,
  BandMember,
  BandPart,
  InvitePreview,
  JoinInviteResult,
  LoginResponse,
  Session,
  Take,
  TakeComment,
  User,
} from "@bandapp/types";
import type {
  CreateCommentInput,
  CreateSessionInput,
  RehearsalApiClient,
  TokenStorage,
} from "../client";
import { MockApiClient } from "../mock/MockApiClient";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** 서버가 본문에 실어 보낸 기계 판독용 사유. 없을 수 있다. */
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface HttpApiClientOptions {
  baseUrl: string;
  tokens: TokenStorage;
  onSessionExpired?: () => void;
  fetchFn?: typeof fetch;
  /** 서버 미구현 도메인(sessions/takes/comments) 위임처. 기본은 MockApiClient. */
  fallback?: RehearsalApiClient;
}

interface RequestConfig {
  auth?: boolean; // false면 Authorization 헤더 생략 (로그인·refresh·초대 preview)
  isRetry?: boolean;
}

export class HttpApiClient implements RehearsalApiClient {
  private readonly listeners = new Set<() => void>();
  private readonly fetchFn: typeof fetch;
  private readonly fallback: RehearsalApiClient;
  private refreshing: Promise<boolean> | null = null;

  constructor(private readonly opts: HttpApiClientOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.fallback = opts.fallback ?? new MockApiClient();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    const unsubFallback = this.fallback.subscribe(listener);
    return () => {
      this.listeners.delete(listener);
      unsubFallback();
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    config?: RequestConfig,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (config?.auth !== false) {
      const access = await this.opts.tokens.getAccessToken();
      if (access) headers.authorization = `Bearer ${access}`;
    }
    const res = await this.fetchFn(`${this.opts.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && config?.auth !== false && !config?.isRetry) {
      if (await this.refreshOnce()) {
        return this.request<T>(method, path, body, { ...config, isRetry: true });
      }
      this.opts.onSessionExpired?.();
      throw new ApiError(401, "세션이 만료됐어요. 다시 로그인해 주세요.");
    }
    if (!res.ok) {
      const { message, code } = await this.errorFrom(res);
      throw new ApiError(res.status, message, code);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** 동시에 여러 요청이 401이어도 refresh는 한 번만 (rotation이라 두 번은 반드시 실패). */
  private refreshOnce(): Promise<boolean> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<boolean> {
    const refreshToken = await this.opts.tokens.getRefreshToken();
    if (!refreshToken) {
      await this.opts.tokens.clear();
      return false;
    }
    const res = await this.fetchFn(`${this.opts.baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) {
      await this.opts.tokens.clear();
      return false;
    }
    await this.opts.tokens.setTokens((await res.json()) as AuthTokens);
    return true;
  }

  private async errorFrom(res: Response): Promise<{ message: string; code?: string }> {
    // 429는 서버(ThrottlerException)가 영문 메시지를 내려주므로 본문을 읽지 않고 바로 한국어로 대체한다.
    if (res.status === 429) return { message: "잠시 후 다시 시도해 주세요." };
    try {
      const body = (await res.json()) as { message?: string | string[]; code?: string };
      const message = Array.isArray(body.message) ? body.message[0] : body.message;
      if (message) return { message, code: body.code };
    } catch {
      // JSON이 아니면 아래 기본 문구
    }
    return { message: res.status >= 500 ? "잠시 후 다시 시도해 주세요." : "요청에 실패했어요." };
  }

  private async saveLogin(login: LoginResponse): Promise<LoginResponse> {
    await this.opts.tokens.setTokens({
      accessToken: login.accessToken,
      refreshToken: login.refreshToken,
    });
    return login;
  }

  auth = {
    loginWithGoogle: (idToken: string): Promise<LoginResponse> =>
      this.request<LoginResponse>("POST", "/auth/google", { idToken }, { auth: false }).then((r) =>
        this.saveLogin(r),
      ),
    loginWithApple: (credential: AppleLoginCredential): Promise<LoginResponse> =>
      this.request<LoginResponse>("POST", "/auth/apple", credential, { auth: false }).then((r) =>
        this.saveLogin(r),
      ),
    logout: async (): Promise<void> => {
      const refreshToken = await this.opts.tokens.getRefreshToken();
      if (refreshToken) {
        try {
          await this.request<void>("POST", "/auth/logout", { refreshToken });
          // access token이 만료된 상태였다면 위 요청이 401 → refresh(rotation) → 재시도 경로를 탔을 수 있다.
          // 그 경우 서버에 전달된 refreshToken은 이미 회전되어 무효화된 옛 토큰이라 revoke가 아무 세션도 지우지 못한다.
          // 저장소를 다시 읽어 회전이 일어났는지 확인하고, 일어났다면 새 refresh token으로 한 번 더 revoke한다.
          const current = await this.opts.tokens.getRefreshToken();
          if (current && current !== refreshToken) {
            await this.request<void>("POST", "/auth/logout", { refreshToken: current });
          }
        } catch {
          // 서버 revoke가 실패해도 로컬 토큰은 지운다 — 다음 로그인에서 새 세션
        }
      }
      await this.opts.tokens.clear();
    },
    me: (): Promise<User> => this.request<User>("GET", "/me"),
    deleteAccount: async (): Promise<void> => {
      await this.request<void>("DELETE", "/me");
      await this.opts.tokens.clear();
    },
  };

  bands = {
    list: (): Promise<Band[]> => this.request<Band[]>("GET", "/bands"),
    create: async (name: string): Promise<Band> => {
      const band = await this.request<Band>("POST", "/bands", { name });
      this.emit();
      return band;
    },
    members: (bandId: string): Promise<BandMember[]> =>
      this.request<BandMember[]>("GET", `/bands/${bandId}/members`),
    setMyPart: async (bandId: string, part: BandPart | null): Promise<BandMember> => {
      const member = await this.request<BandMember>("PATCH", `/bands/${bandId}/members/me`, {
        part,
      });
      this.emit();
      return member;
    },
    removeMember: async (bandId: string, userId: string): Promise<void> => {
      await this.request<void>("DELETE", `/bands/${bandId}/members/${userId}`);
      this.emit();
    },
    leave: async (bandId: string): Promise<void> => {
      await this.request<void>("DELETE", `/bands/${bandId}/members/me`);
      this.emit();
    },
    createInvite: (bandId: string): Promise<BandInvite> =>
      this.request<BandInvite>("POST", `/bands/${bandId}/invites`),
    revokeInvite: async (bandId: string, inviteId: string): Promise<void> => {
      await this.request<void>("DELETE", `/bands/${bandId}/invites/${inviteId}`);
    },
  };

  invites = {
    preview: (token: string): Promise<InvitePreview> =>
      this.request<InvitePreview>("GET", `/invites/${encodeURIComponent(token)}`, undefined, {
        auth: false,
      }),
    join: async (token: string): Promise<JoinInviteResult> => {
      const result = await this.request<JoinInviteResult>(
        "POST",
        `/invites/${encodeURIComponent(token)}/join`,
      );
      this.emit();
      return result;
    },
  };

  // 서버에 sessions/takes/comments API가 생기기 전까지 Mock으로 위임 (스펙 결정 13)
  get sessions(): RehearsalApiClient["sessions"] {
    return this.fallback.sessions;
  }
  get takes(): RehearsalApiClient["takes"] {
    return this.fallback.takes;
  }
  get comments(): RehearsalApiClient["comments"] {
    return this.fallback.comments;
  }
}
