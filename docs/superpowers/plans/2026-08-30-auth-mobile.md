# 인증·초대 모바일 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expo 앱에 로그인 화면, SecureStore 토큰 저장/세션 복원, 초대 딥링크(pendingInviteToken 보존), 팀 온보딩/전환, 로그아웃/회원 탈퇴를 구현하고 packages 계약을 실제 HTTP 클라이언트로 확장한다.

**Architecture:** `@bandapp/types`·`@bandapp/api-client` 계약을 auth/invites로 확장하고 fetch 기반 `HttpApiClient`(401→refresh rotation→재시도)를 추가한다. 모바일은 기존 Context 관례대로 `AuthProvider`(restoring/guest/authenticated)와 `CurrentBandProvider`를 올리고, expo-router 가드 + `/invite/[token]` 딥링크로 "초대 → 로그인 → 팀 참가" 흐름을 잇는다. sessions/takes/comments는 서버 미구현이라 HttpApiClient가 Mock으로 위임한다(브리지).

**Tech Stack:** Expo 57 / RN 0.86, expo-router, expo-secure-store, expo-apple-authentication, @react-native-google-signin/google-signin, vitest.

**Spec:** `docs/superpowers/specs/2026-08-30-auth-bands-invites-design.md`

## Global Constraints

- **Expo 57로 API가 바뀌었다. 코드 작성 전 https://docs.expo.dev/versions/v57.0.0/ 의 해당 패키지 문서를 반드시 확인** (apps/mobile/AGENTS.md의 구속 지침). @react-native-google-signin도 설치된 버전의 공식 문서 기준으로 작성.
- 이 worktree에는 `node_modules`가 없다 — 처음이면 `pnpm install` 먼저.
- `app/` 라우트 파일은 **한 줄 re-export만**, 실제 화면은 `src/features/<domain>/` (기존 관례). 경로 별칭 `@/* → ./src/*`.
- 추가 스타일링/상태관리 의존성 금지 — 기존 `src/theme` 토큰 + `src/ui` 프리미티브(AppText, Screen, PressableOpacity, BottomSheet, Toast 등)로 구성하고 상태는 React Context.
- packages는 dist 발행형: types/api-client 수정 후 `pnpm --filter @bandapp/types build && pnpm --filter @bandapp/api-client build` 없이는 소비자가 옛 dist를 본다. `@bandapp/config`의 `noUncheckedIndexedAccess: true`가 packages에 적용됨.
- 검증 명령: `pnpm --filter mobile typecheck`, `pnpm --filter mobile lint`, `pnpm --filter mobile test`, `pnpm --filter @bandapp/api-client test`(Task 2에서 신설).
- 호스트 API는 `http://localhost:3001` — 실기기에서는 LAN IP 필요 (`EXPO_PUBLIC_API_URL`).
- 네이티브 로그인은 Expo Go에서 불가 — dev build(`npx expo run:ios` 등)로만 수동 검증. env(클라이언트 ID 등)는 사용자가 추후 제공하므로, **env 없이도 Mock으로 앱이 완전히 돌아가는 상태를 항상 유지**한다.
- 로그인 화면 시안은 사용자가 추후 별도 제공 — 1차는 기획서 3장 와이어프레임 + 기존 다크 테마로 구현하고, 시안 수령 후 폴리시 패스를 따로 돈다.
- 커밋: 영어 conventional commit + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.

---

### Task 1: 계약 확장 — types + api-client 인터페이스 + Mock

**Files:**
- Create: `packages/types/src/user.ts`, `packages/types/src/auth.ts`, `packages/types/src/invite.ts`
- Modify: `packages/types/src/band.ts`, `packages/types/src/index.ts`, `packages/api-client/src/client.ts`, `packages/api-client/src/mock/MockApiClient.ts`, `packages/api-client/src/mock/seed.ts`, `packages/api-client/src/index.ts`, `apps/mobile/src/features/band/InviteSheet.tsx`

**Interfaces:**
- Consumes: 기존 `Band`/`BandMember`/`MemberRole`
- Produces (이후 모든 태스크와 서버 플랜이 참조하는 계약):
  - `User { id: string; displayName: string | null; profileImageUrl: string | null }`
  - `AuthTokens { accessToken: string; refreshToken: string }`, `LoginResponse extends AuthTokens { user: User; isNewUser: boolean }`
  - `InvitePreview { band: { name: string; memberCount: number }; invitedBy: { displayName: string | null }; expiresAt: string }`
  - `BandInvite { id: string; url: string; expiresAt: string }`, `JoinInviteResult { bandId: string; alreadyMember: boolean }`
  - `Band`에서 `inviteCode` 제거
  - `RehearsalApiClient`에 `auth`/`invites` 추가, `bands`에 `create`/`leave`/`createInvite` 추가, `bands.inviteLink` 제거

- [ ] **Step 1: types 작성**

`packages/types/src/user.ts`:

```ts
export interface User {
  id: string;
  displayName: string | null;
  profileImageUrl: string | null;
}
```

`packages/types/src/auth.ts`:

```ts
import type { User } from "./user";

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface LoginResponse extends AuthTokens {
  user: User;
  isNewUser: boolean;
}
```

`packages/types/src/invite.ts`:

```ts
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
```

`packages/types/src/band.ts`: `Band`에서 `inviteCode` 필드 삭제 (`Band { id, name, memberCount }`만 남김). `index.ts`에 `export * from "./user"; export * from "./auth"; export * from "./invite";` 추가 (기존 스타일대로 `.js` suffix 없음).

**주의:** 서버 플랜 Task 6/8이 먼저 실행됐다면 `user.ts`/`auth.ts`(또는 `band.ts` 수정)가 이미 있을 수 있다 — 있으면 내용이 위와 일치하는지 확인만 하고 넘어간다.

- [ ] **Step 2: 인터페이스 확장**

`packages/api-client/src/client.ts` — import를 확장하고 인터페이스를 다음으로 교체:

```ts
import type {
  AuthTokens,
  Band,
  BandInvite,
  BandMember,
  InvitePreview,
  JoinInviteResult,
  LoginResponse,
  Session,
  Take,
  TakeComment,
  User,
} from "@bandapp/types";

export interface CreateSessionInput {
  durationSec: number;
  source: "recording" | "import";
}

export interface CreateCommentInput {
  atSec: number;
  text: string;
}

/** 토큰 보관소 — 모바일이 SecureStore로 구현한다. */
export interface TokenStorage {
  getAccessToken(): Promise<string | null>;
  getRefreshToken(): Promise<string | null>;
  setTokens(tokens: AuthTokens): Promise<void>;
  clear(): Promise<void>;
}

export interface RehearsalApiClient {
  auth: {
    loginWithGoogle(idToken: string): Promise<LoginResponse>;
    loginWithApple(idToken: string, displayName?: string): Promise<LoginResponse>;
    /** 서버 refresh 세션 revoke + 로컬 토큰 삭제. 인자 없음 — 구현이 보관소에서 읽는다. */
    logout(): Promise<void>;
    me(): Promise<User>;
    deleteAccount(): Promise<void>;
  };
  bands: {
    list(): Promise<Band[]>;
    create(name: string): Promise<Band>;
    members(bandId: string): Promise<BandMember[]>;
    leave(bandId: string): Promise<void>;
    createInvite(bandId: string): Promise<BandInvite>;
  };
  invites: {
    preview(token: string): Promise<InvitePreview>;
    join(token: string): Promise<JoinInviteResult>;
  };
  sessions: {
    list(bandId: string): Promise<Session[]>;
    get(id: string): Promise<Session>;
    create(bandId: string, input: CreateSessionInput): Promise<Session>;
    retryAnalysis(id: string): Promise<Session>;
  };
  takes: {
    list(sessionId: string): Promise<Take[]>;
  };
  comments: {
    list(takeId: string): Promise<TakeComment[]>;
    create(takeId: string, input: CreateCommentInput): Promise<TakeComment>;
  };
  /** 데이터 변경 통지. 반환값은 구독 해제 함수. */
  subscribe(listener: () => void): () => void;
}
```

- [ ] **Step 3: Mock 확장**

`packages/api-client/src/mock/seed.ts`: `Band` 시드에서 `inviteCode` 제거. `MockState`에 현재 사용자 개념은 두지 않는다(아래 상수 사용).

`packages/api-client/src/mock/MockApiClient.ts` — `inviteLink` 제거 후 다음 구현 추가 (기존 `bands.list/members`는 유지):

```ts
const MOCK_USER: User = { id: "u-mock", displayName: "Dongjin", profileImageUrl: null };
const week = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

auth = {
  loginWithGoogle: async (): Promise<LoginResponse> => this.loginResult(),
  loginWithApple: async (_idToken: string, displayName?: string): Promise<LoginResponse> =>
    this.loginResult(displayName),
  logout: async (): Promise<void> => {},
  me: async (): Promise<User> => ({ ...MOCK_USER }),
  deleteAccount: async (): Promise<void> => {},
};

private loginResult(displayName?: string): LoginResponse {
  return {
    accessToken: "mock-access",
    refreshToken: "mock-refresh",
    user: { ...MOCK_USER, displayName: displayName ?? MOCK_USER.displayName },
    isNewUser: false,
  };
}

bands = {
  list: async (): Promise<Band[]> => [...this.state.bands],
  members: async (bandId: string): Promise<BandMember[]> => [...(this.state.members[bandId] ?? [])],
  create: async (name: string): Promise<Band> => {
    const band: Band = { id: `b${this.nextId++}`, name, memberCount: 1 };
    this.state.bands.push(band);
    this.state.members[band.id] = [{ id: MOCK_USER.id, name: MOCK_USER.displayName ?? "나", role: "owner" }];
    this.emit();
    return { ...band };
  },
  leave: async (bandId: string): Promise<void> => {
    this.state.bands = this.state.bands.filter((b) => b.id !== bandId);
    delete this.state.members[bandId];
    this.emit();
  },
  createInvite: async (bandId: string): Promise<BandInvite> => ({
    id: `i${this.nextId++}`,
    url: `https://band.app/invite/mock-${bandId}`,
    expiresAt: week(),
  }),
};

invites = {
  preview: async (token: string): Promise<InvitePreview> => {
    const band = this.bandFromInviteToken(token);
    return {
      band: { name: band.name, memberCount: band.memberCount },
      invitedBy: { displayName: "Minsoo" },
      expiresAt: week(),
    };
  },
  join: async (token: string): Promise<JoinInviteResult> => {
    const band = this.bandFromInviteToken(token);
    const members = (this.state.members[band.id] ??= []);
    if (members.some((m) => m.id === MOCK_USER.id)) return { bandId: band.id, alreadyMember: true };
    members.push({ id: MOCK_USER.id, name: MOCK_USER.displayName ?? "나", role: "member" });
    band.memberCount = members.length;
    this.emit();
    return { bandId: band.id, alreadyMember: false };
  },
};

/** mock 토큰 형식: mock-<bandId>. 그 외에는 첫 밴드로 처리한다. */
private bandFromInviteToken(token: string): Band {
  const bandId = token.startsWith("mock-") ? token.slice(5) : undefined;
  const band = this.state.bands.find((b) => b.id === bandId) ?? this.state.bands[0];
  if (!band) throw new Error("초대장을 찾을 수 없어요.");
  return band;
}
```

(`@bandapp/types`에서 `User`, `LoginResponse`, `BandInvite`, `InvitePreview`, `JoinInviteResult` import 추가. `bands.list`의 memberCount는 `members` 길이와 어긋나지 않게 seed에서 일치시킨다.)

`packages/api-client/src/index.ts`: `TokenStorage` 타입이 export되는지 확인 (client.ts 재export면 자동).

- [ ] **Step 4: 소비자 수정 + 빌드로 실패 확인**

```bash
pnpm --filter @bandapp/types build
pnpm --filter @bandapp/api-client build
pnpm --filter mobile typecheck
```

Expected: mobile typecheck FAIL — `InviteSheet.tsx`가 제거된 `bands.inviteLink`를 호출.

- [ ] **Step 5: InviteSheet를 createInvite로 교체**

`apps/mobile/src/features/band/InviteSheet.tsx`에서 `api.bands.inviteLink(bandId)` 호출을 `api.bands.createInvite(bandId)`로 바꾸고 반환 객체의 `.url`을 기존 링크 문자열 자리에 사용한다 (url은 이미 `https://` 포함이므로 복사 시 prefix를 덧붙이던 코드는 제거). 그 외 UI는 그대로.

- [ ] **Step 6: 통과 확인 + 커밋**

```bash
pnpm --filter @bandapp/types build && pnpm --filter @bandapp/api-client build
pnpm --filter mobile typecheck && pnpm --filter mobile lint
```

Expected: 모두 PASS

```bash
git add packages apps/mobile
git commit -m "feat(types): auth, invite contracts and http-ready api client interface

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: HttpApiClient — fetch + 401 자동 refresh

**Files:**
- Create: `packages/api-client/src/http/HttpApiClient.ts`, `packages/api-client/src/http/HttpApiClient.spec.ts`, `packages/api-client/vitest.config.ts`
- Modify: `packages/api-client/src/index.ts`, `packages/api-client/package.json`

**Interfaces:**
- Consumes: Task 1의 계약(`RehearsalApiClient`, `TokenStorage`), `MockApiClient`(sessions/takes/comments 위임용)
- Produces:
  - `class ApiError extends Error { status: number }`
  - `interface HttpApiClientOptions { baseUrl: string; tokens: TokenStorage; onSessionExpired?: () => void; fetchFn?: typeof fetch; fallback?: RehearsalApiClient }`
  - `class HttpApiClient implements RehearsalApiClient` — 로그인/refresh 성공 시 `tokens.setTokens` 자동 호출, 401이면 refresh 후 1회 재시도(동시 401은 refresh 1회로 병합), refresh 실패면 `tokens.clear()` + `onSessionExpired()`. sessions/takes/comments는 `fallback`(기본 `new MockApiClient()`)으로 위임.

- [ ] **Step 1: vitest 셋업**

```bash
pnpm --filter @bandapp/api-client add -D vitest
```

`packages/api-client/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { globals: true, include: ["src/**/*.spec.ts"] },
});
```

`packages/api-client/package.json` scripts에 `"test": "vitest run"` 추가. (turbo `test`가 이 패키지도 잡도록 기존 turbo.json 설정 확인 — `test` task는 이미 전역이므로 스크립트만 추가하면 된다.)

- [ ] **Step 2: 실패하는 테스트 작성**

`packages/api-client/src/http/HttpApiClient.spec.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { AuthTokens } from "@bandapp/types";
import type { TokenStorage } from "../client";
import { ApiError, HttpApiClient } from "./HttpApiClient";

function memoryTokens(initial?: Partial<AuthTokens>): TokenStorage & { state: Partial<AuthTokens> } {
  const state: Partial<AuthTokens> = { ...initial };
  return {
    state,
    getAccessToken: async () => state.accessToken ?? null,
    getRefreshToken: async () => state.refreshToken ?? null,
    setTokens: async (tokens) => {
      state.accessToken = tokens.accessToken;
      state.refreshToken = tokens.refreshToken;
    },
    clear: async () => {
      delete state.accessToken;
      delete state.refreshToken;
    },
  };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("HttpApiClient", () => {
  it("로그인 성공 시 토큰을 저장한다", async () => {
    const tokens = memoryTokens();
    const fetchFn = vi.fn(async () =>
      json(201, { accessToken: "a1", refreshToken: "r1", user: { id: "u1", displayName: "D", profileImageUrl: null }, isNewUser: true }),
    );
    const client = new HttpApiClient({ baseUrl: "https://api.test", tokens, fetchFn });
    const res = await client.auth.loginWithGoogle("id-token");
    expect(res.isNewUser).toBe(true);
    expect(tokens.state).toEqual({ accessToken: "a1", refreshToken: "r1" });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.test/auth/google",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("401이면 refresh 후 원요청을 재시도한다 (기획서 8장)", async () => {
    const tokens = memoryTokens({ accessToken: "stale", refreshToken: "r1" });
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/auth/refresh")) return json(201, { accessToken: "a2", refreshToken: "r2" });
      const authed = (fetchFn.mock.calls.length ?? 0) > 2; // 세 번째 호출(재시도)부터 성공
      return authed ? json(200, { id: "u1", displayName: "D", profileImageUrl: null }) : json(401, { message: "unauthorized" });
    });
    const client = new HttpApiClient({ baseUrl: "https://api.test", tokens, fetchFn });
    const me = await client.auth.me();
    expect(me.id).toBe("u1");
    expect(tokens.state).toEqual({ accessToken: "a2", refreshToken: "r2" });
    expect(fetchFn).toHaveBeenCalledTimes(3); // 원요청 → refresh → 재시도
  });

  it("동시 401은 refresh를 한 번만 수행한다", async () => {
    const tokens = memoryTokens({ accessToken: "stale", refreshToken: "r1" });
    let refreshCalls = 0;
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("/auth/refresh")) {
        refreshCalls += 1;
        await new Promise((r) => setTimeout(r, 10));
        return json(201, { accessToken: "a2", refreshToken: "r2" });
      }
      const token = (init?.headers as Record<string, string>)?.authorization;
      return token === "Bearer a2"
        ? json(200, [])
        : json(401, { message: "unauthorized" });
    });
    const client = new HttpApiClient({ baseUrl: "https://api.test", tokens, fetchFn });
    await Promise.all([client.bands.list(), client.bands.list(), client.bands.list()]);
    expect(refreshCalls).toBe(1);
  });

  it("refresh 실패면 토큰을 지우고 onSessionExpired를 호출한다", async () => {
    const tokens = memoryTokens({ accessToken: "stale", refreshToken: "dead" });
    const onSessionExpired = vi.fn();
    const fetchFn = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith("/auth/refresh") ? json(401, {}) : json(401, {}),
    );
    const client = new HttpApiClient({ baseUrl: "https://api.test", tokens, fetchFn, onSessionExpired });
    await expect(client.auth.me()).rejects.toBeInstanceOf(ApiError);
    expect(tokens.state).toEqual({});
    expect(onSessionExpired).toHaveBeenCalledOnce();
  });

  it("서버 오류 메시지를 ApiError로 전달한다", async () => {
    const tokens = memoryTokens();
    const fetchFn = vi.fn(async () => json(409, { message: "관리자로 있는 팀이 있어요." }));
    const client = new HttpApiClient({ baseUrl: "https://api.test", tokens, fetchFn });
    await expect(client.auth.deleteAccount()).rejects.toMatchObject({
      status: 409,
      message: "관리자로 있는 팀이 있어요.",
    });
  });

  it("preview는 인증 헤더 없이 호출된다", async () => {
    const tokens = memoryTokens({ accessToken: "a1", refreshToken: "r1" });
    const fetchFn = vi.fn(async () =>
      json(200, { band: { name: "FRIDAY NIGHT", memberCount: 4 }, invitedBy: { displayName: "Minsoo" }, expiresAt: "2026-09-06T00:00:00Z" }),
    );
    const client = new HttpApiClient({ baseUrl: "https://api.test", tokens, fetchFn });
    await client.invites.preview("tok123");
    const headers = fetchFn.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers?.authorization).toBeUndefined();
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `pnpm --filter @bandapp/api-client test`
Expected: FAIL (모듈 없음)

- [ ] **Step 4: 구현**

`packages/api-client/src/http/HttpApiClient.ts`:

```ts
import type {
  AuthTokens,
  Band,
  BandInvite,
  BandMember,
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
    if (!res.ok) throw new ApiError(res.status, await this.errorMessage(res));
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
    if (!refreshToken) return false;
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

  private async errorMessage(res: Response): Promise<string> {
    try {
      const body = (await res.json()) as { message?: string | string[] };
      const message = Array.isArray(body.message) ? body.message[0] : body.message;
      if (message) return message;
    } catch {
      // JSON이 아니면 아래 기본 문구
    }
    return res.status >= 500 ? "잠시 후 다시 시도해 주세요." : "요청에 실패했어요.";
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
    loginWithApple: (idToken: string, displayName?: string): Promise<LoginResponse> =>
      this.request<LoginResponse>("POST", "/auth/apple", { idToken, displayName }, { auth: false }).then(
        (r) => this.saveLogin(r),
      ),
    logout: async (): Promise<void> => {
      const refreshToken = await this.opts.tokens.getRefreshToken();
      if (refreshToken) {
        try {
          await this.request<void>("POST", "/auth/logout", { refreshToken });
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
    leave: async (bandId: string): Promise<void> => {
      await this.request<void>("DELETE", `/bands/${bandId}/members/me`);
      this.emit();
    },
    createInvite: (bandId: string): Promise<BandInvite> =>
      this.request<BandInvite>("POST", `/bands/${bandId}/invites`),
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
```

`packages/api-client/src/index.ts`에 `export { ApiError, HttpApiClient } from "./http/HttpApiClient";` (및 `TokenStorage` 재export 확인) 추가.

- [ ] **Step 5: 통과 확인 + 커밋**

Run: `pnpm --filter @bandapp/api-client test`
Expected: PASS (6 tests)

```bash
pnpm --filter @bandapp/api-client build && pnpm --filter mobile typecheck
git add packages
git commit -m "feat(api-client): http client with automatic refresh rotation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: 모바일 인증 기반 — 패키지 설치 + app.json + 저장소 서비스

**Files:**
- Create: `apps/mobile/src/services/secure-storage.ts`, `apps/mobile/src/services/token-storage.ts`, `apps/mobile/src/services/session-events.ts`
- Modify: `apps/mobile/app.json`, `apps/mobile/package.json`(expo install 결과)

**Interfaces:**
- Consumes: `TokenStorage`(Task 2)
- Produces:
  - `secureStorage.get/set/remove(key: "refreshToken" | "pendingInviteToken" | "lastBandId")`
  - `tokenStorage: TokenStorage` — access는 메모리, refresh는 SecureStore (기획서 8장)
  - `sessionEvents.setHandler(h: (() => void) | null)` / `sessionEvents.emitExpired()`

- [ ] **Step 1: 패키지 설치 (Expo 57 문서 확인 후)**

```bash
pnpm --filter mobile exec npx expo install expo-secure-store expo-apple-authentication @react-native-google-signin/google-signin
```

- [ ] **Step 2: app.json 수정**

`expo` 항목에 추가/수정 (기존 `scheme: "bandapp"`, plugins는 유지하고 확장):

```json
"ios": {
  "bundleIdentifier": "com.bandapp.app",
  "usesAppleSignIn": true
},
"android": {
  "package": "com.bandapp.app"
},
"plugins": ["expo-router", "expo-font", "expo-secure-store", "expo-apple-authentication"]
```

`com.bandapp.app`은 placeholder — 출시 전 사용자 확정 필요. `@react-native-google-signin` config plugin은 iOS URL scheme(iOS client id 기반)이 필요하므로 **사용자 env 제공 후에 추가**한다(이 플랜 마지막 수동 검증 단계에 명시).

- [ ] **Step 3: 서비스 구현**

`apps/mobile/src/services/secure-storage.ts`:

```ts
import * as SecureStore from "expo-secure-store";

const KEYS = {
  refreshToken: "auth.refreshToken",
  pendingInviteToken: "invite.pendingToken",
  lastBandId: "band.lastId",
} as const;

export type SecureKey = keyof typeof KEYS;

export const secureStorage = {
  get: (key: SecureKey): Promise<string | null> => SecureStore.getItemAsync(KEYS[key]),
  set: (key: SecureKey, value: string): Promise<void> => SecureStore.setItemAsync(KEYS[key], value),
  remove: (key: SecureKey): Promise<void> => SecureStore.deleteItemAsync(KEYS[key]),
};
```

`apps/mobile/src/services/token-storage.ts`:

```ts
import type { TokenStorage } from "@bandapp/api-client";
import { secureStorage } from "./secure-storage";

// Access token은 짧게 살다 가므로 메모리에만, refresh token만 SecureStore에 (기획서 7·8장)
let accessToken: string | null = null;

export const tokenStorage: TokenStorage = {
  getAccessToken: async () => accessToken,
  getRefreshToken: () => secureStorage.get("refreshToken"),
  setTokens: async (tokens) => {
    accessToken = tokens.accessToken;
    await secureStorage.set("refreshToken", tokens.refreshToken);
  },
  clear: async () => {
    accessToken = null;
    await secureStorage.remove("refreshToken");
  },
};
```

`apps/mobile/src/services/session-events.ts`:

```ts
// HttpApiClient(생성 시점)와 AuthProvider(마운트 후)를 잇는 최소 이벤트 브리지
type Handler = () => void;
let handler: Handler | null = null;

export const sessionEvents = {
  setHandler(next: Handler | null): void {
    handler = next;
  },
  emitExpired(): void {
    handler?.();
  },
};
```

- [ ] **Step 4: 검증 + 커밋**

```bash
pnpm --filter mobile typecheck && pnpm --filter mobile lint
git add apps/mobile
git commit -m "feat(mobile): secure token storage and auth packages

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: AuthProvider + 세션 복원 + 실클라이언트 연결

**Files:**
- Create: `apps/mobile/src/features/auth/AuthProvider.tsx`
- Modify: `apps/mobile/src/api/ApiProvider.tsx`, `apps/mobile/app/_layout.tsx`

**Interfaces:**
- Consumes: `HttpApiClient`/`MockApiClient`, `tokenStorage`, `sessionEvents`, `useApi()`
- Produces:
  - `type AuthState = { status: "restoring" } | { status: "guest" } | { status: "authenticated"; user: User }`
  - `useAuth(): { state: AuthState; signInWithGoogle(): Promise<LoginResponse>; signInWithApple(): Promise<LoginResponse>; signOut(): Promise<void>; deleteAccount(): Promise<void> }`
  - `EXPO_PUBLIC_API_URL` 있으면 HttpApiClient, 없으면 MockApiClient(+즉시 authenticated — 기존 개발 흐름 유지)

- [ ] **Step 1: ApiProvider가 실클라이언트를 만들도록 수정**

`apps/mobile/src/api/ApiProvider.tsx`의 기본 클라이언트 생성부를 다음으로 교체 (Context/useApi 형태는 유지):

```tsx
import { HttpApiClient, MockApiClient, type RehearsalApiClient } from "@bandapp/api-client";
import { sessionEvents } from "@/services/session-events";
import { tokenStorage } from "@/services/token-storage";

export function createDefaultClient(): RehearsalApiClient {
  const baseUrl = process.env.EXPO_PUBLIC_API_URL;
  if (!baseUrl) return new MockApiClient();
  return new HttpApiClient({
    baseUrl,
    tokens: tokenStorage,
    onSessionExpired: () => sessionEvents.emitExpired(),
  });
}
```

기존 `new MockApiClient()` 자리에서 `createDefaultClient()`를 호출.

- [ ] **Step 2: AuthProvider 구현**

`apps/mobile/src/features/auth/AuthProvider.tsx`:

```tsx
import type { LoginResponse, User } from "@bandapp/types";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useApi } from "@/api";
import { sessionEvents } from "@/services/session-events";
import { tokenStorage } from "@/services/token-storage";
import { appleCredential } from "./providers/apple";
import { googleIdToken } from "./providers/google";

export type AuthState =
  | { status: "restoring" }
  | { status: "guest" }
  | { status: "authenticated"; user: User };

interface AuthContextValue {
  state: AuthState;
  signInWithGoogle(): Promise<LoginResponse>;
  signInWithApple(): Promise<LoginResponse>;
  signOut(): Promise<void>;
  deleteAccount(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const usingMock = !process.env.EXPO_PUBLIC_API_URL;

export function AuthProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [state, setState] = useState<AuthState>({ status: "restoring" });

  useEffect(() => {
    sessionEvents.setHandler(() => setState({ status: "guest" }));
    return () => sessionEvents.setHandler(null);
  }, []);

  useEffect(() => {
    // 앱 시작 시 세션 복원 (기획서 23장)
    let cancelled = false;
    (async () => {
      if (usingMock) {
        // 서버 없이도 앱이 돌게 Mock에서는 로그인된 상태로 시작
        const user = await api.auth.me();
        if (!cancelled) setState({ status: "authenticated", user });
        return;
      }
      const refreshToken = await tokenStorage.getRefreshToken();
      if (!refreshToken) {
        if (!cancelled) setState({ status: "guest" });
        return;
      }
      try {
        // access는 메모리에 없으므로 me() 호출이 401 → 자동 refresh → 재시도로 복원된다
        const user = await api.auth.me();
        if (!cancelled) setState({ status: "authenticated", user });
      } catch {
        await tokenStorage.clear();
        if (!cancelled) setState({ status: "guest" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function signInWithGoogle(): Promise<LoginResponse> {
    const idToken = await googleIdToken();
    const res = await api.auth.loginWithGoogle(idToken);
    setState({ status: "authenticated", user: res.user });
    return res;
  }

  async function signInWithApple(): Promise<LoginResponse> {
    const { idToken, displayName } = await appleCredential();
    const res = await api.auth.loginWithApple(idToken, displayName);
    setState({ status: "authenticated", user: res.user });
    return res;
  }

  async function signOut(): Promise<void> {
    await api.auth.logout(); // 서버 세션 revoke + 로컬 토큰 삭제 (기획서 17장)
    setState({ status: "guest" });
  }

  async function deleteAccount(): Promise<void> {
    await api.auth.deleteAccount();
    setState({ status: "guest" });
  }

  return (
    <AuthContext.Provider value={{ state, signInWithGoogle, signInWithApple, signOut, deleteAccount }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within AuthProvider");
  return value;
}
```

(providers/google·apple은 Task 5에서 작성 — 이 태스크에서는 시그니처만 맞춘 빈 구현 파일을 만들어 컴파일을 유지: `export async function googleIdToken(): Promise<string> { throw new Error("not implemented"); }` / `export async function appleCredential(): Promise<{ idToken: string; displayName?: string }> { throw new Error("not implemented"); }`)

- [ ] **Step 3: _layout에 배선**

`apps/mobile/app/_layout.tsx`: `ApiProvider` 안쪽, `ToastProvider` 바깥에 `<AuthProvider>` 추가 (`import { AuthProvider } from "@/features/auth/AuthProvider";`).

- [ ] **Step 4: 검증 + 커밋**

```bash
pnpm --filter mobile typecheck && pnpm --filter mobile lint
```

Expected: PASS. Mock 모드 스모크: `pnpm --filter mobile exec npx expo start`로 기존 화면이 그대로 뜨는지(회귀 없음) 확인 가능하면 확인.

```bash
git add apps/mobile
git commit -m "feat(mobile): auth provider with session restore

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: 로그인 화면 + Provider 어댑터 + 라우트 가드

**Files:**
- Create: `apps/mobile/src/features/auth/providers/google.ts`, `apps/mobile/src/features/auth/providers/apple.ts`, `apps/mobile/src/features/auth/errors.ts`, `apps/mobile/src/features/auth/LoginScreen.tsx`, `apps/mobile/src/features/auth/authGate.ts`, `apps/mobile/src/features/auth/authGate.test.ts`, `apps/mobile/app/login.tsx`
- Modify: `apps/mobile/app/_layout.tsx`, `apps/mobile/package.json`(test glob)

**Interfaces:**
- Consumes: `useAuth()`(Task 4), `useToast`(기존 ui), 테마 토큰/프리미티브
- Produces:
  - `class AuthCancelledError extends Error` — 사용자가 Provider 로그인을 취소하면 throw (Toast 없이 무시, 기획서 19장)
  - `googleIdToken(): Promise<string>`, `appleCredential(): Promise<{ idToken: string; displayName?: string }>`
  - `gate(status, firstSegment): { redirect: string } | null` — 순수 함수 (가드 로직 테스트 대상)
  - `/login` 라우트

- [ ] **Step 1: 실패하는 gate 테스트 작성**

`apps/mobile/src/features/auth/authGate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { gate } from "./authGate";

describe("gate", () => {
  it("복원 중에는 리다이렉트하지 않는다 (스플래시 유지)", () => {
    expect(gate("restoring", undefined)).toBeNull();
    expect(gate("restoring", "login")).toBeNull();
  });

  it("guest는 공개 라우트(login, invite) 외에는 /login으로", () => {
    expect(gate("guest", "(tabs)")).toEqual({ redirect: "/login" });
    expect(gate("guest", undefined)).toEqual({ redirect: "/login" });
    expect(gate("guest", "login")).toBeNull();
    expect(gate("guest", "invite")).toBeNull(); // 초대 preview는 비로그인 열람 가능 (기획서 13장)
  });

  it("로그인 상태로 /login에 있으면 홈으로", () => {
    expect(gate("authenticated", "login")).toEqual({ redirect: "/" });
    expect(gate("authenticated", "(tabs)")).toBeNull();
    expect(gate("authenticated", "invite")).toBeNull();
  });
});
```

`apps/mobile/package.json`의 test 스크립트를 `"test": "vitest run src"`로 확장 (기존 `src/lib`만 돌던 것을 src 전체로).

Run: `pnpm --filter mobile test`
Expected: FAIL (authGate 없음)

- [ ] **Step 2: gate + 어댑터 + 화면 구현**

`apps/mobile/src/features/auth/authGate.ts`:

```ts
export type GateStatus = "restoring" | "guest" | "authenticated";

const PUBLIC_SEGMENTS = new Set(["login", "invite"]);

/** 루트 세그먼트 기준 리다이렉트 결정. null이면 그대로 둔다. */
export function gate(status: GateStatus, firstSegment: string | undefined): { redirect: string } | null {
  if (status === "restoring") return null;
  const segment = firstSegment ?? "";
  if (status === "guest" && !PUBLIC_SEGMENTS.has(segment)) return { redirect: "/login" };
  if (status === "authenticated" && segment === "login") return { redirect: "/" };
  return null;
}
```

`apps/mobile/src/features/auth/errors.ts`:

```ts
/** 사용자가 Provider 로그인 시트를 닫은 경우 — 오류 Toast 없이 조용히 무시한다 (기획서 19장) */
export class AuthCancelledError extends Error {
  constructor() {
    super("auth cancelled by user");
    this.name = "AuthCancelledError";
  }
}
```

`apps/mobile/src/features/auth/providers/google.ts` (Task 4의 스텁 교체 — **설치된 @react-native-google-signin 버전 문서로 API 확인 후 작성**):

```ts
import { AuthCancelledError } from "../errors";

// Expo Go에는 google-signin 네이티브 모듈이 없다 — 정적 import 대신 호출 시점 lazy import로
// Mock 모드(Expo Go)에서 앱이 깨지지 않게 한다. 실제 로그인은 dev build에서만 동작.
let configured = false;

export async function googleIdToken(): Promise<string> {
  const { GoogleSignin } = await import("@react-native-google-signin/google-signin");
  if (!configured) {
    const webClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
    if (!webClientId) throw new Error("EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID is not set");
    GoogleSignin.configure({ webClientId });
    configured = true;
  }
  await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  const result = await GoogleSignin.signIn();
  if (result.type === "cancelled") throw new AuthCancelledError();
  const idToken = result.data.idToken;
  if (!idToken) throw new Error("google sign-in returned no idToken");
  return idToken;
}
```

`apps/mobile/src/features/auth/providers/apple.ts` (스텁 교체):

```ts
import * as AppleAuthentication from "expo-apple-authentication";
import { AuthCancelledError } from "../errors";

export async function appleCredential(): Promise<{ idToken: string; displayName?: string }> {
  try {
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });
    const idToken = credential.identityToken;
    if (!idToken) throw new Error("apple sign-in returned no identityToken");
    // 이름은 최초 인증 때만 온다 — 서버가 최초 가입 시에만 저장 (스펙 결정 8)
    const displayName = [credential.fullName?.familyName, credential.fullName?.givenName]
      .filter(Boolean)
      .join("");
    return { idToken, displayName: displayName || undefined };
  } catch (err) {
    if ((err as { code?: string }).code === "ERR_REQUEST_CANCELED") throw new AuthCancelledError();
    throw err;
  }
}
```

`apps/mobile/src/features/auth/LoginScreen.tsx` — 기획서 3장 구성 그대로, 기존 프리미티브 사용. **시안은 추후 별도 수령 — 이 버전은 구조 우선, 시안 수령 후 폴리시 패스**:

```tsx
import * as AppleAuthentication from "expo-apple-authentication";
import { useState } from "react";
import { Platform, View } from "react-native";
import { useRouter } from "expo-router";
import { AppText, PressableOpacity, Screen, useToast } from "@/ui";
import { useTheme } from "@/theme";
import { useAuth } from "./AuthProvider";
import { AuthCancelledError } from "./errors";
import { resolvePendingInvite } from "@/features/invites/pendingInvite";
import { useApi } from "@/api";

export function LoginScreen() {
  const { signInWithGoogle, signInWithApple } = useAuth();
  const api = useApi();
  const router = useRouter();
  const toast = useToast();
  const theme = useTheme();
  const [busy, setBusy] = useState(false);

  async function run(signIn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    try {
      await signIn();
      // 로그인 때문에 원래 하려던 초대 참가를 잃어버리면 안 된다 (기획서 14장)
      const invite = await resolvePendingInvite();
      router.replace(invite ? `/invite/${invite}` : "/");
    } catch (err) {
      if (err instanceof AuthCancelledError) return; // 취소 → Toast 없이 화면 유지
      // 오류 문구는 기획서 19장
      const message =
        err instanceof TypeError
          ? "연결을 확인하고 다시 시도해 주세요."
          : "로그인에 실패했어요. 다시 시도해 주세요.";
      toast.show(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: "center", gap: 12, paddingHorizontal: 24 }}>
        <AppText variant="title">BANDAPP</AppText>
        <AppText>합주를 기록하고{"\n"}함께 다시 들어보세요.</AppText>
        <View style={{ height: 32 }} />
        {Platform.OS === "ios" && (
          <AppleAuthentication.AppleAuthenticationButton
            buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
            buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
            cornerRadius={theme.radius.md}
            style={{ height: 48 }}
            onPress={() => run(signInWithApple)}
          />
        )}
        <PressableOpacity onPress={() => run(signInWithGoogle)} disabled={busy}>
          <AppText>Google로 계속하기</AppText>
        </PressableOpacity>
        <AppText variant="caption">계속하면 이용약관 및{"\n"}개인정보처리방침에 동의합니다.</AppText>
      </View>
    </Screen>
  );
}
```

(`AppText`의 variant명, `useToast`의 실제 API, `theme.radius` 키는 기존 `src/ui`/`src/theme` 코드를 열어 실제 시그니처에 맞춘다 — 이름이 다르면 기존 이름을 따른다. `resolvePendingInvite`는 Task 6에서 구현 — 이 태스크에서는 `export async function resolvePendingInvite(): Promise<string | null> { return null; }` 스텁을 `src/features/invites/pendingInvite.ts`에 만들어 둔다.)

`apps/mobile/app/login.tsx`:

```tsx
export { LoginScreen as default } from "@/features/auth/LoginScreen";
```

`apps/mobile/app/_layout.tsx` — `AuthProvider` 아래에 가드 컴포넌트를 넣는다:

```tsx
import { Stack, useRouter, useSegments } from "expo-router";
import { useEffect, type ReactNode } from "react";
import { useAuth } from "@/features/auth/AuthProvider";
import { gate } from "@/features/auth/authGate";

function AuthGate({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    const decision = gate(state.status, segments[0]);
    if (decision) router.replace(decision.redirect);
  }, [state.status, segments, router]);

  if (state.status === "restoring") return null; // 폰트 로딩과 동일한 스플래시 처리
  return <>{children}</>;
}
```

`<AuthProvider><AuthGate><ToastProvider>…` 순으로 감싼다.

- [ ] **Step 3: 검증 + 커밋**

```bash
pnpm --filter mobile test && pnpm --filter mobile typecheck && pnpm --filter mobile lint
```

Expected: PASS (gate 3 tests 포함)

```bash
git add apps/mobile
git commit -m "feat(mobile): login screen, provider adapters, route guard

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: 초대 딥링크 + pendingInviteToken 보존

**Files:**
- Create: `apps/mobile/src/features/invites/InviteLandingScreen.tsx`, `apps/mobile/src/features/invites/parseInviteToken.ts`, `apps/mobile/src/features/invites/parseInviteToken.test.ts`, `apps/mobile/app/invite/[token].tsx`
- Modify: `apps/mobile/src/features/invites/pendingInvite.ts` (Task 5 스텁 교체)

**Interfaces:**
- Consumes: `api.invites.preview/join`, `useAuth()`, `secureStorage`, `useCurrentBand`(Task 7 이전엔 미사용 — 참가 후 이동만)
- Produces:
  - `parseInviteToken(input: string): string | null` — URL(`https://…/invite/X`), 딥링크(`bandapp://invite/X`), 생 토큰 모두 수용
  - `savePendingInviteToken(token)`, `resolvePendingInvite(): Promise<string | null>` (읽고 지움)
  - `/invite/[token]` 라우트 — 기획서 13·14·15장 흐름

- [ ] **Step 1: 실패하는 파서 테스트 작성**

`apps/mobile/src/features/invites/parseInviteToken.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseInviteToken } from "./parseInviteToken";

describe("parseInviteToken", () => {
  it("https 초대 URL에서 토큰을 뽑는다", () => {
    expect(parseInviteToken("https://app.example.com/invite/AbC123_-xyz9AbC12345")).toBe(
      "AbC123_-xyz9AbC12345",
    );
  });

  it("커스텀 스킴 딥링크도 처리한다", () => {
    expect(parseInviteToken("bandapp://invite/AbC123_-xyz9AbC12345")).toBe("AbC123_-xyz9AbC12345");
  });

  it("생 토큰은 그대로 반환한다", () => {
    expect(parseInviteToken("AbC123_-xyz9AbC12345")).toBe("AbC123_-xyz9AbC12345");
  });

  it("공백을 다듬고, 토큰이 아니면 null", () => {
    expect(parseInviteToken("  AbC123_-xyz9AbC12345  ")).toBe("AbC123_-xyz9AbC12345");
    expect(parseInviteToken("hello world")).toBeNull();
    expect(parseInviteToken("")).toBeNull();
  });
});
```

Run: `pnpm --filter mobile test`
Expected: FAIL

- [ ] **Step 2: 구현**

`apps/mobile/src/features/invites/parseInviteToken.ts`:

```ts
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** 초대 링크/딥링크/생 토큰 어느 형태든 토큰만 뽑는다. 수동 복구 경로(기획서 14장)에서도 사용. */
export function parseInviteToken(input: string): string | null {
  const trimmed = input.trim();
  if (TOKEN_RE.test(trimmed)) return trimmed;
  const match = /\/invite\/([A-Za-z0-9_-]{16,64})/.exec(trimmed);
  return match?.[1] ?? null;
}
```

`apps/mobile/src/features/invites/pendingInvite.ts` (스텁 교체):

```ts
import { secureStorage } from "@/services/secure-storage";

export function savePendingInviteToken(token: string): Promise<void> {
  return secureStorage.set("pendingInviteToken", token);
}

/** 저장된 초대 토큰을 반환하고 지운다 — 로그인 직후 한 번만 소비된다 (기획서 14장). */
export async function resolvePendingInvite(): Promise<string | null> {
  const token = await secureStorage.get("pendingInviteToken");
  if (token) await secureStorage.remove("pendingInviteToken");
  return token;
}
```

`apps/mobile/src/features/invites/InviteLandingScreen.tsx`:

```tsx
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { useApi, useApiData } from "@/api";
import { useAuth } from "@/features/auth/AuthProvider";
import { savePendingInviteToken } from "./pendingInvite";
import { AppText, PressableOpacity, Screen, useToast } from "@/ui";

export function InviteLandingScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const api = useApi();
  const router = useRouter();
  const toast = useToast();
  const { state } = useAuth();
  const [joining, setJoining] = useState(false);
  const [alreadyMember, setAlreadyMember] = useState(false);

  const { data: preview, error } = useApiData(() => api.invites.preview(token), [api, token]);

  async function join() {
    if (state.status !== "authenticated") {
      // 로그인 후 원래 하려던 참가를 이어간다 (기획서 14장)
      await savePendingInviteToken(token);
      router.push("/login");
      return;
    }
    if (joining) return;
    setJoining(true);
    try {
      const result = await api.invites.join(token);
      if (result.alreadyMember) {
        setAlreadyMember(true); // "이미 멤버예요" 상태로 전환 (기획서 15장)
        return;
      }
      toast.show(`${preview?.band.name ?? "팀"}에 참가했어요.`);
      router.replace("/");
    } catch {
      toast.show("팀 참가에 실패했어요. 다시 시도해 주세요.");
    } finally {
      setJoining(false);
    }
  }

  if (error) {
    return (
      <Screen>
        <AppText>초대장을 찾을 수 없어요.{"\n"}링크가 만료됐을 수 있어요.</AppText>
      </Screen>
    );
  }
  if (!preview) return <Screen />; // 로딩

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: "center", gap: 12, paddingHorizontal: 24 }}>
        <AppText variant="title">{preview.band.name}</AppText>
        {alreadyMember ? (
          <>
            <AppText>이미 {preview.band.name}의 멤버예요.</AppText>
            <PressableOpacity onPress={() => router.replace("/")}>
              <AppText>팀으로 이동</AppText>
            </PressableOpacity>
          </>
        ) : (
          <>
            <AppText>
              {preview.invitedBy.displayName ?? "멤버"}님이{"\n"}
              {preview.band.name}에 초대했어요.
            </AppText>
            <AppText variant="caption">멤버 {preview.band.memberCount}명</AppText>
            {state.status !== "authenticated" && (
              <AppText variant="caption">팀에 참가하려면 로그인해 주세요.</AppText>
            )}
            <PressableOpacity onPress={join} disabled={joining}>
              <AppText>{state.status === "authenticated" ? "팀 참가하기" : "로그인하고 참가하기"}</AppText>
            </PressableOpacity>
          </>
        )}
      </View>
    </Screen>
  );
}
```

(Task 5와 동일하게 `AppText`/`useToast`/`useApiData`의 실제 시그니처에 맞춰 조정. `useApiData`가 error를 반환하지 않으면 기존 훅의 오류 처리 관례를 따른다.)

`apps/mobile/app/invite/[token].tsx`:

```tsx
export { InviteLandingScreen as default } from "@/features/invites/InviteLandingScreen";
```

참고: 로그인 → 참가 재개는 Task 5의 `LoginScreen.run()`이 `resolvePendingInvite()`로 이미 처리한다(로그인 성공 시 `/invite/<token>`으로 복귀 → 이 화면에서 authenticated 상태로 "팀 참가하기").

- [ ] **Step 3: 검증 + 커밋**

```bash
pnpm --filter mobile test && pnpm --filter mobile typecheck && pnpm --filter mobile lint
```

Expected: PASS (parseInviteToken 4 tests 포함)

Mock 스모크(가능하면): `npx expo start` → 브라우저/시뮬레이터에서 `bandapp://invite/mock-b1` 딥링크 열기 → preview → 참가 → 재진입 시 "이미 멤버예요".

```bash
git add apps/mobile
git commit -m "feat(mobile): invite deep link with pending invite restore

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: 현재 밴드 상태 + 온보딩(팀 없음)

**Files:**
- Create: `apps/mobile/src/features/band/CurrentBandProvider.tsx`, `apps/mobile/src/features/onboarding/OnboardingScreen.tsx`, `apps/mobile/app/onboarding.tsx`
- Modify: `apps/mobile/src/features/band/useCurrentBand.ts`, `apps/mobile/src/features/band/BandSwitchSheet.tsx`, `apps/mobile/app/_layout.tsx`

**Interfaces:**
- Consumes: `api.bands.list/create`, `secureStorage("lastBandId")`, `useAuth()`, `parseInviteToken`(Task 6)
- Produces:
  - `useCurrentBand(): { band: Band | null; bands: Band[]; loading: boolean; setCurrentBand(bandId: string): void }` — 마지막 밴드 유지(기획서 2장 "마지막 Band의 Sessions"), Band 전환에 토큰 재발급 없음(기획서 9장)
  - `/onboarding` 라우트 — 밴드 0개 사용자용 (기획서 10장)

- [ ] **Step 1: CurrentBandProvider 구현**

`apps/mobile/src/features/band/CurrentBandProvider.tsx`:

```tsx
import type { Band } from "@bandapp/types";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useApi, useApiData } from "@/api";
import { useAuth } from "@/features/auth/AuthProvider";
import { secureStorage } from "@/services/secure-storage";

interface CurrentBandValue {
  band: Band | null;
  bands: Band[];
  loading: boolean;
  setCurrentBand(bandId: string): void;
}

const CurrentBandContext = createContext<CurrentBandValue | null>(null);

export function CurrentBandProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const { state } = useAuth();
  const authed = state.status === "authenticated";
  const { data: bands } = useApiData(() => (authed ? api.bands.list() : Promise.resolve([])), [api, authed]);
  const [currentBandId, setCurrentBandId] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    secureStorage.get("lastBandId").then((saved) => {
      setCurrentBandId(saved);
      setRestored(true);
    });
  }, []);

  function setCurrentBand(bandId: string): void {
    setCurrentBandId(bandId);
    void secureStorage.set("lastBandId", bandId);
  }

  // 마지막 밴드가 사라졌으면(탈퇴 등) 첫 밴드로
  const list = bands ?? [];
  const band = list.find((b) => b.id === currentBandId) ?? list[0] ?? null;

  return (
    <CurrentBandContext.Provider
      value={{ band, bands: list, loading: !restored || bands === undefined, setCurrentBand }}
    >
      {children}
    </CurrentBandContext.Provider>
  );
}

export function useCurrentBandContext(): CurrentBandValue {
  const value = useContext(CurrentBandContext);
  if (!value) throw new Error("useCurrentBandContext must be used within CurrentBandProvider");
  return value;
}
```

(`useApiData`의 실제 반환 형태(`data`/`loading`)에 맞춰 조정.)

`apps/mobile/src/features/band/useCurrentBand.ts`를 Context 위임으로 교체 — 기존 호출부(BandScreen, SessionsScreen 등)가 쓰던 반환 형태를 유지하되 `data?.[0]` 대신 Context의 `band`를 반환하도록 수정. `BandSwitchSheet.tsx`의 밴드 선택 핸들러에서 `setCurrentBand(band.id)` 호출.

`app/_layout.tsx`: `AuthGate` 안쪽에 `<CurrentBandProvider>` 추가.

- [ ] **Step 2: 온보딩 화면**

`apps/mobile/src/features/onboarding/OnboardingScreen.tsx`:

```tsx
import { useRouter } from "expo-router";
import { useState } from "react";
import { TextInput, View } from "react-native";
import { useApi } from "@/api";
import { useCurrentBandContext } from "@/features/band/CurrentBandProvider";
import { parseInviteToken } from "@/features/invites/parseInviteToken";
import { AppText, PressableOpacity, Screen, useToast } from "@/ui";

type Mode = "menu" | "create" | "join";

export function OnboardingScreen() {
  const api = useApi();
  const router = useRouter();
  const toast = useToast();
  const { setCurrentBand } = useCurrentBandContext();
  const [mode, setMode] = useState<Mode>("menu");
  const [name, setName] = useState("");
  const [inviteInput, setInviteInput] = useState("");
  const [busy, setBusy] = useState(false);

  async function createBand() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const band = await api.bands.create(trimmed);
      setCurrentBand(band.id);
      router.replace("/");
    } catch {
      toast.show("팀 만들기에 실패했어요. 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  function openInvite() {
    const token = parseInviteToken(inviteInput);
    if (!token) {
      toast.show("초대 링크를 확인해 주세요.");
      return;
    }
    router.push(`/invite/${token}`);
  }

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: "center", gap: 12, paddingHorizontal: 24 }}>
        {mode === "menu" && (
          <>
            <AppText variant="title">함께 연습할{"\n"}팀을 만들어볼까요?</AppText>
            <PressableOpacity onPress={() => setMode("create")}>
              <AppText>새 팀 만들기</AppText>
            </PressableOpacity>
            <PressableOpacity onPress={() => setMode("join")}>
              <AppText>초대 링크로 참가</AppText>
            </PressableOpacity>
          </>
        )}
        {mode === "create" && (
          <>
            <AppText variant="title">팀 이름을 정해주세요</AppText>
            <TextInput value={name} onChangeText={setName} placeholder="FRIDAY NIGHT" autoFocus />
            <PressableOpacity onPress={createBand} disabled={busy}>
              <AppText>만들기</AppText>
            </PressableOpacity>
          </>
        )}
        {mode === "join" && (
          <>
            <AppText variant="title">초대 링크를 붙여넣어 주세요</AppText>
            <TextInput value={inviteInput} onChangeText={setInviteInput} autoFocus />
            <PressableOpacity onPress={openInvite}>
              <AppText>참가하기</AppText>
            </PressableOpacity>
          </>
        )}
      </View>
    </Screen>
  );
}
```

(TextInput 스타일은 기존 화면의 입력 스타일 관례를 따른다. mode 전환에 기존 `BottomSheet` 프리미티브가 더 자연스러우면 그걸 사용.)

`apps/mobile/app/onboarding.tsx`:

```tsx
export { OnboardingScreen as default } from "@/features/onboarding/OnboardingScreen";
```

밴드 0개 리다이렉트: `AuthGate` 또는 홈 index에서 — `authenticated`이고 `!loading && bands.length === 0`이고 현재 세그먼트가 `onboarding`/`invite`가 아니면 `/onboarding`으로 `router.replace`. `gate()`와 같은 파일에 순수 함수로 추가해 테스트를 붙인다:

```ts
export function bandGate(
  bandsCount: number | null, // null = 로딩 중
  firstSegment: string | undefined,
): { redirect: string } | null {
  if (bandsCount === null || bandsCount > 0) return null;
  const segment = firstSegment ?? "";
  if (segment === "onboarding" || segment === "invite" || segment === "login") return null;
  return { redirect: "/onboarding" };
}
```

`authGate.test.ts`에 케이스 추가:

```ts
describe("bandGate", () => {
  it("로딩 중이거나 밴드가 있으면 그대로", () => {
    expect(bandGate(null, "(tabs)")).toBeNull();
    expect(bandGate(2, "(tabs)")).toBeNull();
  });
  it("밴드 0개면 온보딩으로 (초대/온보딩/로그인 화면 제외)", () => {
    expect(bandGate(0, "(tabs)")).toEqual({ redirect: "/onboarding" });
    expect(bandGate(0, "onboarding")).toBeNull();
    expect(bandGate(0, "invite")).toBeNull();
  });
});
```

- [ ] **Step 3: 검증 + 커밋**

```bash
pnpm --filter mobile test && pnpm --filter mobile typecheck && pnpm --filter mobile lint
```

Expected: PASS

```bash
git add apps/mobile
git commit -m "feat(mobile): current band state and no-band onboarding

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: 설정 — 로그아웃 · 회원 탈퇴

**Files:**
- Create: `apps/mobile/src/features/settings/SettingsScreen.tsx`, `apps/mobile/app/settings.tsx`
- Modify: `apps/mobile/src/features/band/BandScreen.tsx` (설정 진입점)

**Interfaces:**
- Consumes: `useAuth().signOut/deleteAccount/state`, `ApiError`(409 처리)
- Produces: `/settings` 라우트 — 로그아웃(기획서 17장), 회원 탈퇴(기획서 18장, 409 안내)

- [ ] **Step 1: 화면 구현**

`apps/mobile/src/features/settings/SettingsScreen.tsx`:

```tsx
import { ApiError } from "@bandapp/api-client";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert, View } from "react-native";
import { useAuth } from "@/features/auth/AuthProvider";
import { AppText, PressableOpacity, Screen, useToast } from "@/ui";

export function SettingsScreen() {
  const { state, signOut, deleteAccount } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const displayName = state.status === "authenticated" ? state.user.displayName : null;

  function confirmSignOut() {
    Alert.alert("로그아웃할까요?", undefined, [
      { text: "취소", style: "cancel" },
      {
        text: "로그아웃",
        style: "destructive",
        onPress: () => void runSignOut(),
      },
    ]);
  }

  async function runSignOut() {
    if (busy) return;
    setBusy(true);
    try {
      await signOut(); // 서버 refresh 세션 revoke + SecureStore 삭제 → 가드가 /login으로
    } finally {
      setBusy(false);
    }
  }

  function confirmDelete() {
    Alert.alert("정말 탈퇴할까요?", "모든 기기에서 로그아웃되고 계정 정보가 삭제돼요.", [
      { text: "취소", style: "cancel" },
      { text: "탈퇴하기", style: "destructive", onPress: () => void runDelete() },
    ]);
  }

  async function runDelete() {
    if (busy) return;
    setBusy(true);
    try {
      await deleteAccount();
    } catch (err) {
      // 유일 owner인 밴드가 있으면 서버가 409로 막는다 (기획서 18장)
      const message =
        err instanceof ApiError && err.status === 409
          ? err.message
          : "탈퇴에 실패했어요. 잠시 후 다시 시도해 주세요.";
      toast.show(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <View style={{ flex: 1, gap: 12, paddingHorizontal: 24, paddingTop: 24 }}>
        <AppText variant="title">설정</AppText>
        {displayName && <AppText>{displayName}</AppText>}
        <PressableOpacity onPress={confirmSignOut} disabled={busy}>
          <AppText>로그아웃</AppText>
        </PressableOpacity>
        <PressableOpacity onPress={confirmDelete} disabled={busy}>
          <AppText>회원 탈퇴</AppText>
        </PressableOpacity>
        <PressableOpacity onPress={() => router.back()}>
          <AppText>닫기</AppText>
        </PressableOpacity>
      </View>
    </Screen>
  );
}
```

`apps/mobile/app/settings.tsx`:

```tsx
export { SettingsScreen as default } from "@/features/settings/SettingsScreen";
```

`BandScreen.tsx` 헤더 영역에 설정 진입 버튼 추가 (`router.push("/settings")`) — 기존 헤더 우측 액션 관례(아이콘/텍스트 버튼)를 따른다.

- [ ] **Step 2: 검증 + 커밋**

```bash
pnpm --filter mobile test && pnpm --filter mobile typecheck && pnpm --filter mobile lint
pnpm build   # turbo 전체 빌드 회귀 확인
```

Expected: 전부 PASS

```bash
git add apps/mobile
git commit -m "feat(mobile): settings with logout and account deletion

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 수동 검증 체크리스트 (사용자 env 제공 + dev build 이후)

env 수령 후 순서대로:

1. `.env`에 `JWT_ACCESS_SECRET`/`GOOGLE_CLIENT_IDS`/`APPLE_BUNDLE_ID`/`INVITE_LINK_BASE_URL` 추가, `docker compose up --build -V`(새 deps 반영) → API가 `http://localhost:3001`에서 응답.
2. 마이그레이션: `pnpm --filter @bandapp/api db:migrate` (호스트에서 localhost:5432 대상).
3. `apps/mobile/.env`(또는 셸)에 `EXPO_PUBLIC_API_URL=http://<LAN IP>:3001`, `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=<web client id>`.
4. `app.json`에 `@react-native-google-signin/google-signin` config plugin + `iosUrlScheme`(iOS client id 역순) 추가, 번들 ID를 사용자 확정값으로 교체.
5. dev build: `pnpm --filter mobile exec npx expo run:ios` (Apple 로그인은 실기기/시뮬레이터 iOS).
6. 기획서 26장 완료 조건 확인:
   - [ ] 1·2 신규 사용자가 Google/Apple로 자동 가입
   - [ ] 3 앱 재실행 후 세션 복원
   - [ ] 4 로그아웃 시 refresh 세션 revoke (재실행 시 로그인 화면)
   - [ ] 7 비로그인 → 초대 링크 → 로그인 → 원래 밴드 참가 → 해당 밴드 화면
   - [ ] 8 이미 가입한 초대 재열람 → "이미 멤버예요" → 팀으로 이동
7. 로그인 화면 시안(사용자 추후 제공) 수령 후 LoginScreen/InviteLandingScreen 폴리시 패스.
