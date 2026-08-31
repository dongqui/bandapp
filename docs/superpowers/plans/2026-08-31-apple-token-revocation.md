# Apple 토큰 revoke 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sign in with Apple 사용자가 회원 탈퇴할 때 Apple 측 사용자 인가까지 무효화한다.

**Architecture:** 로그인 시 받은 `authorizationCode`를 Apple `/auth/token`에서 refresh token으로 교환해 `user_identities`에 저장해 두고, 탈퇴 시 그 토큰으로 `/auth/revoke`를 호출한다. Apple REST 호출은 신설 `AppleTokenService`가 전담하고, revoke는 DB 트랜잭션 커밋 후 `MeController`가 best-effort로 부른다.

**Tech Stack:** NestJS 12, Drizzle ORM, jose 6 (ES256 서명), vitest, Expo SDK 57

**Spec:** [2026-08-31-apple-token-revocation-design.md](../specs/2026-08-31-apple-token-revocation-design.md)

## Global Constraints

- **revoke·교환 실패는 절대 로그인이나 탈퇴를 막지 않는다.** best-effort. 실패는 로그만 남긴다.
- **Apple 자격증명(`APPLE_TEAM_ID`/`APPLE_KEY_ID`/`APPLE_PRIVATE_KEY`) 중 하나라도 없으면 교환·revoke는 no-op.** throw 금지. 이 리포의 다른 env는 미설정 시 throw하지만 여기만 예외다 (스펙 결정 5).
- **`client_id`는 `APPLE_BUNDLE_ID`(`com.bandapp.app`)를 재사용한다. Team ID를 섞으면 안 된다.**
- **`client_secret`**: ES256, `kid`=Key ID, `iss`=Team ID, `sub`=client_id, `aud`=`https://appleid.apple.com`.
- **`/auth/token` 요청에 `redirect_uri`를 넣지 않는다.** 네이티브 iOS 플로우는 인가 요청에 redirect_uri를 주지 않는다.
- **revoke에는 refresh token을 보낸다.** `identityToken`(id_token)은 Apple이 받지 않는다.
- 코드 주석은 한국어, 커밋 메시지는 영어 (리포 관례).
- `UsersService`는 DB 전용으로 유지한다. Apple HTTP 호출을 넣으면 users → auth → users 순환이 생긴다.

## 사전 준비

e2e 테스트는 로컬 Postgres를 쓴다. 시작 전에 한 번:

```bash
pnpm docker:up
```

## File Structure

| 파일 | 책임 | 상태 |
|---|---|---|
| `apps/api/src/auth/apple-token.service.ts` | Apple REST API 호출 + client_secret 서명. DB를 모른다 | 생성 |
| `apps/api/src/auth/apple-token.service.spec.ts` | 위 서비스 단위 테스트 (fetch 목킹) | 생성 |
| `apps/api/src/db/schema.ts` | `provider_refresh_token` 컬럼 추가 | 수정 |
| `apps/api/drizzle/000X_*.sql` | 마이그레이션 | 생성(자동) |
| `apps/api/src/users/users.service.ts` | 토큰 저장/조회, `deleteAccount` 반환 타입 | 수정 |
| `apps/api/src/auth/auth.service.ts` | 로그인 시 교환 오케스트레이션 | 수정 |
| `apps/api/src/auth/auth.controller.ts` | `authorizationCode` 수신 | 수정 |
| `apps/api/src/auth/me.controller.ts` | 탈퇴 후 revoke 호출 | 수정 |
| `apps/api/src/auth/auth.module.ts` | provider 등록 | 수정 |
| `apps/api/test/app-util.ts` | `AppleTokenService` 오버라이드 지원 | 수정 |
| `apps/api/test/delete-me.e2e-spec.ts` | revoke 호출 검증 | 수정 |
| `apps/api/test/auth.e2e-spec.ts` | 로그인 시 교환 검증 | 수정 |
| `packages/types/src/auth.ts` | `AppleLoginCredential` 타입 | 수정 |
| `packages/api-client/src/client.ts` | 인터페이스 시그니처 | 수정 |
| `packages/api-client/src/http/HttpApiClient.ts` | 요청 바디 | 수정 |
| `packages/api-client/src/mock/MockApiClient.ts` | 목 시그니처 | 수정 |
| `apps/mobile/src/features/auth/providers/apple.ts` | `authorizationCode` 반환 | 수정 |
| `apps/mobile/src/features/auth/AuthProvider.tsx` | 객체 전달 | 수정 |
| `.env.example` | Apple 자격증명 3종 | 수정 |

---

### Task 1: AppleTokenService

Apple REST API 호출만 담당하는 서비스. DB도 다른 서비스도 모른다.

**Files:**
- Create: `apps/api/src/auth/apple-token.service.ts`
- Test: `apps/api/src/auth/apple-token.service.spec.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: 없음 (첫 태스크)
- Produces:
  - `class AppleTokenService`
  - `exchangeAuthorizationCode(code: string): Promise<string | null>`
  - `revokeAll(refreshTokens: string[]): Promise<void>` — 절대 throw하지 않음
  - `const appleTokenServiceProvider: Provider`

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/src/auth/apple-token.service.spec.ts`:

```ts
import { decodeJwt, decodeProtectedHeader, exportPKCS8, generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppleTokenService } from "./apple-token.service.js";

async function setAppleEnv(): Promise<void> {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  process.env.APPLE_TEAM_ID = "TEAM123456";
  process.env.APPLE_KEY_ID = "KEY1234567";
  process.env.APPLE_PRIVATE_KEY = await exportPKCS8(privateKey);
  process.env.APPLE_BUNDLE_ID = "com.bandapp.app";
}

function mockFetch(res: { ok: boolean; status: number; body?: unknown }) {
  const fn = vi.fn(async () => ({
    ok: res.ok,
    status: res.status,
    json: async () => res.body ?? {},
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** 목 fetch 호출에서 form 파라미터를 뽑는다. */
function formOf(fn: ReturnType<typeof vi.fn>, call = 0): URLSearchParams {
  const init = fn.mock.calls[call]![1] as { body: URLSearchParams };
  return init.body;
}

describe("AppleTokenService", () => {
  beforeEach(setAppleEnv);
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.APPLE_TEAM_ID;
    delete process.env.APPLE_KEY_ID;
    delete process.env.APPLE_PRIVATE_KEY;
    delete process.env.APPLE_BUNDLE_ID;
  });

  it("client_secret을 ES256으로 서명하고 Apple이 요구하는 클레임을 담는다", async () => {
    const fn = mockFetch({ ok: true, status: 200, body: { refresh_token: "rt-1" } });
    await new AppleTokenService().exchangeAuthorizationCode("code-1");

    const secret = formOf(fn).get("client_secret")!;
    expect(decodeProtectedHeader(secret)).toMatchObject({ alg: "ES256", kid: "KEY1234567" });
    const claims = decodeJwt(secret);
    expect(claims.iss).toBe("TEAM123456");
    expect(claims.sub).toBe("com.bandapp.app");
    expect(claims.aud).toBe("https://appleid.apple.com");
  });

  it("client_id에 Team ID를 섞지 않는다", async () => {
    const fn = mockFetch({ ok: true, status: 200, body: { refresh_token: "rt-1" } });
    await new AppleTokenService().exchangeAuthorizationCode("code-1");
    expect(formOf(fn).get("client_id")).toBe("com.bandapp.app");
  });

  it("authorization code를 refresh token으로 교환한다", async () => {
    const fn = mockFetch({ ok: true, status: 200, body: { refresh_token: "rt-1" } });
    const result = await new AppleTokenService().exchangeAuthorizationCode("code-1");

    expect(result).toBe("rt-1");
    expect(fn.mock.calls[0]![0]).toBe("https://appleid.apple.com/auth/token");
    const form = formOf(fn);
    expect(form.get("code")).toBe("code-1");
    expect(form.get("grant_type")).toBe("authorization_code");
    // 네이티브 플로우는 인가 요청에 redirect_uri를 주지 않으므로 보내면 안 된다
    expect(form.has("redirect_uri")).toBe(false);
  });

  it("교환이 400이면 null을 돌려준다", async () => {
    mockFetch({ ok: false, status: 400 });
    await expect(new AppleTokenService().exchangeAuthorizationCode("bad")).resolves.toBeNull();
  });

  it("응답에 refresh_token이 없으면 null을 돌려준다", async () => {
    mockFetch({ ok: true, status: 200, body: { access_token: "at-1" } });
    await expect(new AppleTokenService().exchangeAuthorizationCode("code-1")).resolves.toBeNull();
  });

  it("revoke는 refresh_token 힌트로 호출한다", async () => {
    const fn = mockFetch({ ok: true, status: 200 });
    await new AppleTokenService().revokeAll(["rt-1"]);

    expect(fn.mock.calls[0]![0]).toBe("https://appleid.apple.com/auth/revoke");
    const form = formOf(fn);
    expect(form.get("token")).toBe("rt-1");
    expect(form.get("token_type_hint")).toBe("refresh_token");
  });

  it("여러 토큰을 각각 revoke한다", async () => {
    const fn = mockFetch({ ok: true, status: 200 });
    await new AppleTokenService().revokeAll(["rt-1", "rt-2"]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("빈 배열이면 요청하지 않는다", async () => {
    const fn = mockFetch({ ok: true, status: 200 });
    await new AppleTokenService().revokeAll([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("fetch가 던져도 revokeAll은 throw하지 않는다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await expect(new AppleTokenService().revokeAll(["rt-1"])).resolves.toBeUndefined();
  });

  it("revoke가 400이어도 throw하지 않는다", async () => {
    mockFetch({ ok: false, status: 400 });
    await expect(new AppleTokenService().revokeAll(["rt-1"])).resolves.toBeUndefined();
  });

  it("자격증명이 없으면 아무 요청도 하지 않는다", async () => {
    delete process.env.APPLE_PRIVATE_KEY;
    const fn = mockFetch({ ok: true, status: 200 });
    const service = new AppleTokenService();

    await expect(service.exchangeAuthorizationCode("code-1")).resolves.toBeNull();
    await expect(service.revokeAll(["rt-1"])).resolves.toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
  });

  it("개행이 \\n으로 이스케이프된 개인키도 읽는다", async () => {
    process.env.APPLE_PRIVATE_KEY = process.env.APPLE_PRIVATE_KEY!.replace(/\n/g, "\\n");
    const fn = mockFetch({ ok: true, status: 200, body: { refresh_token: "rt-1" } });
    await expect(new AppleTokenService().exchangeAuthorizationCode("code-1")).resolves.toBe("rt-1");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
pnpm --filter @bandapp/api exec vitest run src/auth/apple-token.service.spec.ts
```

Expected: FAIL — `Failed to resolve import "./apple-token.service.js"`

- [ ] **Step 3: 서비스 구현**

`apps/api/src/auth/apple-token.service.ts`:

```ts
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
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
pnpm --filter @bandapp/api exec vitest run src/auth/apple-token.service.spec.ts
```

Expected: PASS (12 tests)

- [ ] **Step 5: `.env.example`에 자격증명 추가**

`.env.example`의 `APPLE_BUNDLE_ID=com.bandapp.app` 줄 바로 아래에 넣는다:

```
# Apple Developer 포털 > Keys > Sign in with Apple 키(.p8)에서 얻는다.
# 셋 다 채워야 탈퇴 시 Apple 토큰 revoke가 동작한다 — 비어 있으면 조용히 건너뛴다.
# client_id는 위 APPLE_BUNDLE_ID를 재사용한다.
APPLE_TEAM_ID=5JZBZK5HDQ
APPLE_KEY_ID=
# .p8 파일 내용. 개행은 \n으로 이스케이프해서 한 줄로 넣는다.
APPLE_PRIVATE_KEY=
```

- [ ] **Step 6: 커밋**

```bash
git add apps/api/src/auth/apple-token.service.ts apps/api/src/auth/apple-token.service.spec.ts .env.example
git commit -m "feat(api): add AppleTokenService for token exchange and revocation"
```

---

### Task 2: provider_refresh_token 컬럼과 저장/조회

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Modify: `apps/api/src/users/users.service.ts`
- Create: `apps/api/drizzle/000X_*.sql` (drizzle-kit이 생성)
- Test: `apps/api/test/users.service.e2e-spec.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `userIdentities.providerRefreshToken` 컬럼
  - `UsersService.hasProviderRefreshToken(userId: string, provider: "GOOGLE" | "APPLE"): Promise<boolean>`
  - `UsersService.saveProviderRefreshToken(userId: string, provider: "GOOGLE" | "APPLE", token: string): Promise<void>`

- [ ] **Step 1: 실패하는 e2e 테스트 작성**

`apps/api/test/users.service.e2e-spec.ts`의 **`describe("UsersService", ...)` 블록 안쪽** 맨 아래(파일 마지막 `});` 바로 앞)에 추가한다. 그래야 이미 선언된 `service`와 `verified()` 헬퍼, 그리고 바깥 `beforeEach`의 `truncateAll`을 그대로 쓴다.

```ts
  it("provider refresh token은 최초에 없고, 저장하면 있다고 보고한다", async () => {
    const { user } = await service.findOrCreateByIdentity("APPLE", verified("apple-rt-1"));

    await expect(service.hasProviderRefreshToken(user.id, "APPLE")).resolves.toBe(false);
    await service.saveProviderRefreshToken(user.id, "APPLE", "rt-stored");
    await expect(service.hasProviderRefreshToken(user.id, "APPLE")).resolves.toBe(true);
  });

  it("provider refresh token은 provider별로 별개다", async () => {
    const { user } = await service.findOrCreateByIdentity("APPLE", verified("apple-rt-2"));

    await service.saveProviderRefreshToken(user.id, "APPLE", "rt-stored");
    await expect(service.hasProviderRefreshToken(user.id, "GOOGLE")).resolves.toBe(false);
  });
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/users.service.e2e-spec.ts
```

Expected: FAIL — `service.hasProviderRefreshToken is not a function`

- [ ] **Step 3: 스키마에 컬럼 추가**

`apps/api/src/db/schema.ts`의 `userIdentities` 정의에서 `emailVerified` 줄 다음에 추가한다:

```ts
    emailVerified: boolean("email_verified"),
    // Apple /auth/revoke에 필요한 refresh token. id_token으로는 revoke가 안 되고,
    // authorizationCode는 5분 1회용이라 로그인 때 교환해 보관해야 한다.
    providerRefreshToken: text("provider_refresh_token"),
    ...timestamps,
```

- [ ] **Step 4: 마이그레이션 생성**

```bash
pnpm --filter @bandapp/api db:generate
```

`apps/api/drizzle/` 아래에 새 `.sql` 파일이 생긴다. 열어서 `ALTER TABLE "user_identities" ADD COLUMN "provider_refresh_token" text;` 한 줄인지 확인한다. 다른 변경이 섞여 있으면 스키마를 잘못 건드린 것이니 되돌린다.

- [ ] **Step 5: UsersService에 메서드 추가**

`apps/api/src/users/users.service.ts`의 `toPublic` 아래, `deleteAccount` 주석 위에 넣는다:

```ts
  /** 해당 provider identity에 Apple refresh token이 이미 저장돼 있는지. */
  async hasProviderRefreshToken(userId: string, provider: "GOOGLE" | "APPLE"): Promise<boolean> {
    const row = await this.db.query.userIdentities.findFirst({
      where: and(eq(userIdentities.userId, userId), eq(userIdentities.provider, provider)),
    });
    return typeof row?.providerRefreshToken === "string" && row.providerRefreshToken.length > 0;
  }

  async saveProviderRefreshToken(
    userId: string,
    provider: "GOOGLE" | "APPLE",
    token: string,
  ): Promise<void> {
    await this.db
      .update(userIdentities)
      .set({ providerRefreshToken: token, updatedAt: new Date() })
      .where(and(eq(userIdentities.userId, userId), eq(userIdentities.provider, provider)));
  }
```

- [ ] **Step 6: 테스트 통과 확인**

마이그레이션은 컨테이너 기동 시 적용된다. 로컬 DB에 컬럼을 반영한 뒤 실행한다:

```bash
pnpm --filter @bandapp/api db:migrate
```
```bash
pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/users.service.e2e-spec.ts
```

Expected: PASS

- [ ] **Step 7: 커밋**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle apps/api/src/users/users.service.ts apps/api/test/users.service.e2e-spec.ts
git commit -m "feat(api): store provider refresh token on user identities"
```

---

### Task 3: 로그인 시 authorizationCode 교환

**Files:**
- Modify: `apps/api/src/auth/auth.service.ts`
- Modify: `apps/api/src/auth/auth.controller.ts`
- Modify: `apps/api/src/auth/auth.module.ts`
- Modify: `apps/api/test/app-util.ts`
- Test: `apps/api/test/auth.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 1의 `AppleTokenService.exchangeAuthorizationCode`, `appleTokenServiceProvider` / Task 2의 `hasProviderRefreshToken`, `saveProviderRefreshToken`
- Produces:
  - `AuthService.loginWithApple(input: { idToken: string; displayName?: string; authorizationCode?: string }): Promise<LoginResponse>` — **위치 인자에서 객체 인자로 바뀐다**
  - `createTestApp` 옵션에 `appleTokens?: Pick<AppleTokenService, "exchangeAuthorizationCode" | "revokeAll">`

- [ ] **Step 1: app-util에 오버라이드 지원 추가**

`apps/api/test/app-util.ts`. import에 추가:

```ts
import { AppleTokenService } from "../src/auth/apple-token.service.js";
```

`createTestApp`을 통째로 교체:

```ts
export async function createTestApp(overrides?: {
  google?: ProviderStub;
  apple?: ProviderStub;
  appleTokens?: Pick<AppleTokenService, "exchangeAuthorizationCode" | "revokeAll">;
}): Promise<INestApplication> {
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(GoogleAuthService)
    .useValue(overrides?.google ?? rejecting)
    .overrideProvider(AppleAuthService)
    .useValue(overrides?.apple ?? rejecting);
  // 오버라이드가 없으면 실제 서비스가 돈다. e2e env에는 Apple 자격증명이 없어 no-op이다.
  if (overrides?.appleTokens) {
    builder = builder.overrideProvider(AppleTokenService).useValue(overrides.appleTokens);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}
```

- [ ] **Step 2: 실패하는 e2e 테스트 작성**

`apps/api/test/auth.e2e-spec.ts` 맨 아래에, 기존 `describe("auth API", ...)`가 **닫힌 뒤** 형제 describe로 추가한다 (바깥 describe의 `beforeEach`가 다른 스텁으로 앱을 만들기 때문에 안에 넣으면 안 된다).

```ts
describe("POST /auth/apple — authorizationCode 교환", () => {
  const db = createTestDb();
  let app: INestApplication;
  let appleTokens: {
    exchangeAuthorizationCode: ReturnType<typeof vi.fn>;
    revokeAll: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    await truncateAll(db);
    appleTokens = {
      exchangeAuthorizationCode: vi.fn(async () => "rt-from-apple"),
      revokeAll: vi.fn(async () => undefined),
    };
    app = await createTestApp({ apple: providerUser("apple-1"), appleTokens });
  });
  afterEach(() => app.close());

  it("authorizationCode를 교환해 저장한다", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/apple")
      .send({ idToken: "stubbed", authorizationCode: "code-1" })
      .expect(201);

    expect(appleTokens.exchangeAuthorizationCode).toHaveBeenCalledWith("code-1");
    const identity = await db.query.userIdentities.findFirst({
      where: eq(userIdentities.userId, res.body.user.id),
    });
    expect(identity?.providerRefreshToken).toBe("rt-from-apple");
  });

  it("이미 저장된 토큰이 있으면 다시 교환하지 않는다", async () => {
    await request(app.getHttpServer())
      .post("/auth/apple")
      .send({ idToken: "stubbed", authorizationCode: "code-1" })
      .expect(201);
    appleTokens.exchangeAuthorizationCode.mockClear();

    await request(app.getHttpServer())
      .post("/auth/apple")
      .send({ idToken: "stubbed", authorizationCode: "code-2" })
      .expect(201);

    expect(appleTokens.exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it("authorizationCode가 없어도 로그인은 성공한다", async () => {
    await request(app.getHttpServer()).post("/auth/apple").send({ idToken: "stubbed" }).expect(201);
    expect(appleTokens.exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it("교환이 실패해도 로그인은 성공한다", async () => {
    appleTokens.exchangeAuthorizationCode.mockResolvedValue(null);
    const res = await request(app.getHttpServer())
      .post("/auth/apple")
      .send({ idToken: "stubbed", authorizationCode: "code-1" })
      .expect(201);

    const identity = await db.query.userIdentities.findFirst({
      where: eq(userIdentities.userId, res.body.user.id),
    });
    expect(identity?.providerRefreshToken).toBeNull();
  });

  it("교환이 예외를 던져도 로그인은 성공한다", async () => {
    appleTokens.exchangeAuthorizationCode.mockRejectedValue(new Error("boom"));
    await request(app.getHttpServer())
      .post("/auth/apple")
      .send({ idToken: "stubbed", authorizationCode: "code-1" })
      .expect(201);
  });
});
```

파일 상단 import에 없으면 추가한다:

```ts
import { vi } from "vitest";
import { eq } from "drizzle-orm";
import { userIdentities } from "../src/db/schema.js";
```

- [ ] **Step 3: 테스트가 실패하는지 확인**

```bash
pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/auth.e2e-spec.ts
```

Expected: FAIL — `providerRefreshToken`이 `null`이고 `exchangeAuthorizationCode`가 호출되지 않음

- [ ] **Step 4: AuthService 수정**

`apps/api/src/auth/auth.service.ts`. import에 추가:

```ts
import { AppleTokenService } from "./apple-token.service.js";
```

생성자에 의존성 추가 (`private readonly apple: AppleAuthService,` 다음 줄):

```ts
    private readonly appleTokens: AppleTokenService,
```

`loginWithApple`을 교체:

```ts
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
```

파일 맨 아래 `authServiceProvider`를 교체:

```ts
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
```

- [ ] **Step 5: 컨트롤러 수정**

`apps/api/src/auth/auth.controller.ts`의 `apple` 핸들러를 교체:

```ts
  @Post("apple")
  apple(@Body() body: unknown): Promise<LoginResponse> {
    return this.auth.loginWithApple({
      idToken: requireString(body, "idToken"),
      displayName: optionalString(body, "displayName"),
      authorizationCode: optionalString(body, "authorizationCode"),
    });
  }
```

- [ ] **Step 6: 모듈에 provider 등록**

`apps/api/src/auth/auth.module.ts`. import에 추가:

```ts
import { appleTokenServiceProvider } from "./apple-token.service.js";
```

`providers` 배열의 `appleAuthServiceProvider,` 다음 줄에 추가:

```ts
    appleTokenServiceProvider,
```

- [ ] **Step 7: 테스트 통과 확인**

```bash
pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/auth.e2e-spec.ts
```

Expected: PASS

- [ ] **Step 8: 커밋**

```bash
git add apps/api/src/auth/auth.service.ts apps/api/src/auth/auth.controller.ts apps/api/src/auth/auth.module.ts apps/api/test/app-util.ts apps/api/test/auth.e2e-spec.ts
git commit -m "feat(api): exchange Apple authorization code at login"
```

---

### Task 4: 탈퇴 시 revoke

**Files:**
- Modify: `apps/api/src/users/users.service.ts`
- Modify: `apps/api/src/auth/me.controller.ts`
- Test: `apps/api/test/delete-me.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 1의 `AppleTokenService.revokeAll` / Task 2의 `providerRefreshToken` 컬럼 / Task 3의 `createTestApp({ appleTokens })`
- Produces: `UsersService.deleteAccount(userId: string): Promise<{ appleRefreshTokens: string[] }>` — **반환 타입이 `void`에서 바뀐다**

- [ ] **Step 1: 실패하는 e2e 테스트 작성**

`apps/api/test/delete-me.e2e-spec.ts`. 파일 상단 import에 추가:

```ts
import { vi } from "vitest";
```

기존 `beforeEach`를 교체해 스텁을 주입한다:

```ts
  let appleTokens: {
    exchangeAuthorizationCode: ReturnType<typeof vi.fn>;
    revokeAll: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    await truncateAll(db);
    appleTokens = {
      exchangeAuthorizationCode: vi.fn(async () => "rt-from-apple"),
      revokeAll: vi.fn(async () => undefined),
    };
    app = await createTestApp({
      google: providerUser("g-1"),
      apple: providerUser("apple-1"),
      appleTokens,
    });
    me = await loginAs(app);
  });
```

파일 맨 아래 `});` 앞에 추가:

```ts
  it("Apple로 가입한 계정은 탈퇴 시 Apple 토큰을 revoke한다", async () => {
    const apple = await request(app.getHttpServer())
      .post("/auth/apple")
      .send({ idToken: "stubbed", authorizationCode: "code-1" })
      .expect(201);

    await request(app.getHttpServer())
      .delete("/me")
      .set(auth(apple.body.accessToken))
      .expect(204);

    expect(appleTokens.revokeAll).toHaveBeenCalledWith(["rt-from-apple"]);
  });

  it("Apple 토큰이 없으면 revoke할 것도 없다", async () => {
    await request(app.getHttpServer()).delete("/me").set(auth(me.accessToken)).expect(204);
    expect(appleTokens.revokeAll).toHaveBeenCalledWith([]);
  });

  it("409로 롤백되면 revoke하지 않는다", async () => {
    const band = await request(app.getHttpServer())
      .post("/bands")
      .set(auth(me.accessToken))
      .send({ name: "FRIDAY NIGHT" })
      .expect(201);
    const [other] = await db.insert(users).values({ displayName: "Minsoo" }).returning();
    await db.insert(bandMembers).values({ bandId: band.body.id, userId: other!.id, role: "member" });

    await request(app.getHttpServer()).delete("/me").set(auth(me.accessToken)).expect(409);
    expect(appleTokens.revokeAll).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/delete-me.e2e-spec.ts
```

Expected: FAIL — `revokeAll`이 호출되지 않음

- [ ] **Step 3: deleteAccount가 토큰을 회수하도록 수정**

`apps/api/src/users/users.service.ts`. JSDoc 마지막 줄에 한 줄 추가하고 시그니처를 바꾼다:

```ts
  /**
   * 회원 탈퇴 (기획서 18장, 스펙 결정 9):
   * - 다른 멤버가 있는 밴드의 유일한 owner면 409 (전체 롤백)
   * - 혼자인 밴드는 삭제, member인 밴드는 탈퇴
   * - 모든 세션 revoke, identity 삭제, user 비식별화(soft delete)
   * - 삭제된 identity의 Apple refresh token을 돌려준다. 실제 revoke는 호출자가
   *   트랜잭션 커밋 후에 한다 (외부 HTTP를 트랜잭션 안에서 하지 않는다).
   */
  async deleteAccount(userId: string): Promise<{ appleRefreshTokens: string[] }> {
    return this.db.transaction(async (tx) => {
```

트랜잭션 안, `userIdentities` 삭제 줄을 교체:

```ts
      const deletedIdentities = await tx
        .delete(userIdentities)
        .where(eq(userIdentities.userId, userId))
        .returning();
```

트랜잭션 마지막 `users` update 다음에 return을 추가한다:

```ts
      await tx
        .update(users)
        .set({ displayName: null, profileImageUrl: null, deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(users.id, userId));
      return {
        appleRefreshTokens: deletedIdentities
          .filter((i) => i.provider === "APPLE")
          .map((i) => i.providerRefreshToken)
          .filter((t): t is string => typeof t === "string" && t.length > 0),
      };
    });
  }
```

- [ ] **Step 4: MeController가 revoke를 호출하도록 수정**

`apps/api/src/auth/me.controller.ts`. import에 추가:

```ts
import { AppleTokenService } from "./apple-token.service.js";
```

생성자와 `deleteMe`를 교체:

```ts
  constructor(
    private readonly users: UsersService,
    private readonly appleTokens: AppleTokenService,
  ) {}
```

```ts
  @Delete()
  @HttpCode(204)
  async deleteMe(@CurrentUserId() userId: string): Promise<void> {
    const { appleRefreshTokens } = await this.users.deleteAccount(userId);
    // 트랜잭션 커밋 후 best-effort. revokeAll이 실패를 자체적으로 삼키므로 여기서 감싸지 않는다.
    await this.appleTokens.revokeAll(appleRefreshTokens);
  }
```

여기서 `try/catch`로 감싸지 **않는다.** `revokeAll`의 계약이 "절대 throw하지 않는다"이고 Task 1에 그걸 검증하는 테스트가 있다. 호출부에서 또 방어하면 계약이 두 군데로 흩어지고 빈 catch 블록이 남는다.

- [ ] **Step 5: 테스트 통과 확인**

```bash
pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/delete-me.e2e-spec.ts
```

Expected: PASS

- [ ] **Step 6: API 전체 테스트**

```bash
pnpm --filter @bandapp/api test
```

Expected: 전부 PASS. `deleteAccount` 반환 타입 변경으로 깨지는 호출부가 있으면 여기서 잡힌다.

- [ ] **Step 7: 커밋**

```bash
git add apps/api/src/users/users.service.ts apps/api/src/auth/me.controller.ts apps/api/test/delete-me.e2e-spec.ts
git commit -m "feat(api): revoke Apple tokens when an account is deleted"
```

---

### Task 5: 클라이언트 계약 — authorizationCode 전달

**Files:**
- Modify: `packages/types/src/auth.ts`
- Modify: `packages/api-client/src/client.ts`
- Modify: `packages/api-client/src/http/HttpApiClient.ts`
- Modify: `packages/api-client/src/mock/MockApiClient.ts`
- Modify: `apps/mobile/src/features/auth/providers/apple.ts`
- Modify: `apps/mobile/src/features/auth/AuthProvider.tsx`

**Interfaces:**
- Consumes: Task 3의 `POST /auth/apple { idToken, displayName?, authorizationCode? }`
- Produces:
  - `AppleLoginCredential` (from `@bandapp/types`)
  - `client.auth.loginWithApple(credential: AppleLoginCredential): Promise<LoginResponse>`
  - `appleCredential(): Promise<AppleLoginCredential>`

- [ ] **Step 1: 타입 추가**

`packages/types/src/auth.ts` 맨 아래에 추가:

```ts
/** 네이티브 Apple 로그인이 내려주는 값. authorizationCode는 탈퇴 시 revoke용으로 서버가 교환한다. */
export interface AppleLoginCredential {
  idToken: string;
  displayName?: string;
  authorizationCode?: string;
}
```

`packages/types/src/index.ts`는 이미 `export * from "./auth"`라 수정 불필요.

- [ ] **Step 2: api-client 인터페이스 수정**

`packages/api-client/src/client.ts`. import에 `AppleLoginCredential`을 추가하고(기존 `@bandapp/types` import 구문에 합친다), 36번 줄을 교체:

```ts
    loginWithApple(credential: AppleLoginCredential): Promise<LoginResponse>;
```

- [ ] **Step 3: HttpApiClient 수정**

`packages/api-client/src/http/HttpApiClient.ts`. import에 `AppleLoginCredential` 추가 후 `loginWithApple`을 교체:

```ts
    loginWithApple: (credential: AppleLoginCredential): Promise<LoginResponse> =>
      this.request<LoginResponse>("POST", "/auth/apple", credential, { auth: false }).then((r) =>
        this.saveLogin(r),
      ),
```

- [ ] **Step 4: MockApiClient 수정**

`packages/api-client/src/mock/MockApiClient.ts`. import에 `AppleLoginCredential` 추가 후 교체:

```ts
    loginWithApple: async (credential: AppleLoginCredential): Promise<LoginResponse> =>
      this.loginResult(credential.displayName),
```

- [ ] **Step 5: 모바일 어댑터 수정**

`apps/mobile/src/features/auth/providers/apple.ts`의 반환 타입과 return을 교체:

```ts
export async function appleCredential(): Promise<AppleLoginCredential> {
```

```ts
    return {
      idToken,
      displayName: displayName || undefined,
      authorizationCode: credential.authorizationCode ?? undefined,
    };
```

파일 상단 import에 추가:

```ts
import type { AppleLoginCredential } from "@bandapp/types";
```

- [ ] **Step 6: AuthProvider 호출부 수정**

`apps/mobile/src/features/auth/AuthProvider.tsx`. mock 분기(93번 줄)를 교체:

```ts
      const res = await api.auth.loginWithApple({ idToken: "mock" });
```

실제 로그인 분기(97~98번 줄)를 교체:

```ts
    const credential = await appleCredential();
    const res = await api.auth.loginWithApple(credential);
```

- [ ] **Step 7: 빌드 후 타입 검사**

`@bandapp/types`와 `@bandapp/api-client`는 `dist/`로 해석되므로 모바일 타입 검사 전에 빌드해야 한다.

```bash
pnpm build
```
```bash
pnpm --filter mobile typecheck
```

Expected: 에러 없음

- [ ] **Step 8: 전체 테스트**

```bash
pnpm test
```

Expected: 전부 PASS

- [ ] **Step 9: 커밋**

```bash
git add packages/types/src/auth.ts packages/api-client/src apps/mobile/src/features/auth
git commit -m "feat(mobile): send Apple authorization code with login"
```

---

## 완료 후 확인

- [ ] `pnpm test` 전부 통과
- [ ] `pnpm --filter @bandapp/api lint` 통과
- [ ] `.env.example`에 `APPLE_TEAM_ID`/`APPLE_KEY_ID`/`APPLE_PRIVATE_KEY`가 있고, 값 없이도 서버가 뜨는지 확인
- [ ] 자격증명 없이 `DELETE /me`가 204인지 수동 확인

## 이 계획이 검증하지 못하는 것

`.p8` 키 발급은 Apple Developer Program 멤버십이 활성화된 뒤에야 가능하다 (2026-08-31 기준 갱신 결제 완료·반영 대기). 따라서 위 테스트는 전부 목킹된 Apple 서버를 상대로 돈다. **실제 Apple `/auth/token`·`/auth/revoke` 왕복은 키 발급 후 별도로 확인해야 한다.**

키를 받은 뒤 확인할 것:
1. `.env`에 세 값을 채우고 API 재기동 — "Apple 자격증명이 없어…" warn이 사라지는지
2. 실기기 dev build로 Apple 로그인 → `user_identities.provider_refresh_token`이 채워지는지
3. 앱에서 탈퇴 → iPhone 설정 > Apple 계정 > 로그인 및 보안 > Apple로 로그인 목록에서 이 앱이 사라지는지
