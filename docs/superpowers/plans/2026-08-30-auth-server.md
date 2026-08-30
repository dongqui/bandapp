# 인증·Band·초대 서버 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Google/Apple ID token 검증 기반 자동 회원가입, 자체 Access/Refresh Token 세션, Band 멤버십 권한, 초대 링크 API를 NestJS + PostgreSQL(Drizzle)로 구현한다.

**Architecture:** 리포 최초의 DB 레이어(Drizzle + pg)를 `db/` 스텁 모듈에 올리고, 그 위에 auth(토큰/Provider 검증/세션) → users → bands/memberships → invites 순서로 쌓는다. Provider token 검증은 jose + JWKS, 자체 토큰은 jose HS256, refresh는 랜덤 토큰의 SHA-256만 DB 저장 + rotation.

**Tech Stack:** NestJS 12 (ESM), drizzle-orm + drizzle-kit + pg, jose, @nestjs/throttler, vitest(+supertest e2e), PostgreSQL 17 (docker).

**Spec:** `docs/superpowers/specs/2026-08-30-auth-bands-invites-design.md`

## Global Constraints

- 이 worktree에는 `node_modules`와 `.env`가 없다. Task 1 첫 단계의 준비 절차를 반드시 수행할 것.
- `apps/api`는 ESM(nodenext): **모든 상대 임포트에 `.js` suffix 필수** (`import { DB } from "./db.constants.js"`).
- 생성자 파라미터가 주입 불가능한 클래스는 `@Injectable()` 대신 **`useFactory` Provider로 등록**한다 (기존 `geminiServiceProvider` 관례).
- env는 `@nestjs/config` 없이 **호출 시점에 `process.env.X` 직접 읽고 미설정이면 throw** (기존 관례).
- 검증은 class-validator 없이 hand-rolled (기존 관례).
- 테스트: 순수 로직은 `**/*.spec.ts`(vitest.config.ts), DB/HTTP는 `**/*.e2e-spec.ts`(vitest.config.e2e.ts). 실행: `pnpm --filter @bandapp/api exec vitest run <파일>` / e2e는 `--config ./vitest.config.e2e.ts` 추가.
- e2e는 로컬 postgres(`postgresql://band:band@localhost:5432/band`) 필요: `pnpm docker:up` 또는 `docker compose up -d postgres`.
- lint는 oxlint: `pnpm --filter @bandapp/api lint`.
- 커밋: 영어 conventional commit + 마지막 줄 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- 호스트에서 API는 **3001 포트**(.env의 API_PORT=3001), 컨테이너 내부는 3000. 코드에서 포트 하드코딩 금지.
- 실 Provider 자격증명(GOOGLE_CLIENT_IDS 등)은 사용자가 추후 제공 — 테스트는 스텁/로컬 JWKS로만 검증하고 실값을 요구하지 않는다.

---

### Task 1: DB 기반 — Drizzle 스키마·마이그레이션·DbModule·e2e 인프라

**Files:**
- Create: `apps/api/src/db/db.constants.ts`, `apps/api/src/db/schema.ts`, `apps/api/drizzle.config.ts`, `apps/api/test/db-util.ts`, `apps/api/test/global-setup.ts`, `apps/api/test/db.e2e-spec.ts`, `apps/api/drizzle/` (생성물)
- Modify: `apps/api/src/db/db.module.ts` (빈 스텁), `apps/api/package.json` (deps/scripts), `apps/api/vitest.config.e2e.ts`

**Interfaces:**
- Consumes: 없음 (최하층)
- Produces: `DB` 심볼 토큰, `Db` 타입(`NodePgDatabase<typeof schema>`), `schema.ts`의 테이블 객체들(`users`, `userIdentities`, `authSessions`, `bands`, `bandMembers`, `bandInvites`), 테스트용 `createTestDb(): Db`, `truncateAll(db: Db): Promise<void>`

- [ ] **Step 1: 개발 환경 준비**

```bash
pnpm install
docker compose up -d postgres
```

`.env`가 없어도 이 플랜의 테스트는 vitest config 기본값으로 돈다. `docker compose ps`로 postgres가 healthy인지 확인.

- [ ] **Step 2: 의존성 추가**

```bash
pnpm --filter @bandapp/api add drizzle-orm pg
pnpm --filter @bandapp/api add -D drizzle-kit @types/pg
```

- [ ] **Step 3: 실패하는 e2e 테스트 작성**

`apps/api/test/db-util.ts`:

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/db.module.js";

export function createTestDb(): Db {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return drizzle(new pg.Pool({ connectionString: url }), { schema });
}

export async function truncateAll(db: Db): Promise<void> {
  await db.execute(
    sql`TRUNCATE band_invites, band_members, bands, auth_sessions, user_identities, users CASCADE`,
  );
}
```

`apps/api/test/db.e2e-spec.ts`:

```ts
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { userIdentities, users } from "../src/db/schema.js";
import { createTestDb, truncateAll } from "./db-util.js";

describe("db schema", () => {
  const db = createTestDb();
  beforeEach(() => truncateAll(db));

  it("user와 identity를 넣고 읽는다", async () => {
    const [user] = await db.insert(users).values({ displayName: "Dongjin" }).returning();
    expect(user?.id).toBeTruthy();
    await db.insert(userIdentities).values({
      userId: user!.id,
      provider: "GOOGLE",
      providerSubject: "g-1",
      email: "a@b.c",
      emailVerified: true,
    });
    const found = await db.query.userIdentities.findFirst({
      where: eq(userIdentities.providerSubject, "g-1"),
    });
    expect(found?.userId).toBe(user!.id);
  });

  it("(provider, provider_subject)는 unique다", async () => {
    const [user] = await db.insert(users).values({}).returning();
    const identity = { userId: user!.id, provider: "GOOGLE" as const, providerSubject: "dup" };
    await db.insert(userIdentities).values(identity);
    await expect(db.insert(userIdentities).values(identity)).rejects.toThrow();
  });
});
```

- [ ] **Step 4: 실패 확인**

Run: `pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/db.e2e-spec.ts`
Expected: FAIL (schema.ts 없음 / 테이블 없음)

- [ ] **Step 5: 스키마 구현**

`apps/api/src/db/schema.ts`:

```ts
import {
  boolean,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const authProvider = pgEnum("auth_provider", ["GOOGLE", "APPLE"]);
// @bandapp/types의 MemberRole("owner" | "member")과 값을 일치시킨다 (스펙 결정 5)
export const bandRole = pgEnum("band_role", ["owner", "member"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  displayName: text("display_name"),
  profileImageUrl: text("profile_image_url"),
  ...timestamps,
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const userIdentities = pgTable(
  "user_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: authProvider("provider").notNull(),
    providerSubject: text("provider_subject").notNull(),
    email: text("email"),
    emailVerified: boolean("email_verified"),
    ...timestamps,
  },
  (t) => [uniqueIndex("user_identities_provider_subject_uq").on(t.provider, t.providerSubject)],
);

export const authSessions = pgTable("auth_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  refreshTokenHash: text("refresh_token_hash").notNull().unique(),
  deviceName: text("device_name"),
  platform: text("platform"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const bands = pgTable("bands", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  ...timestamps,
});

export const bandMembers = pgTable(
  "band_members",
  {
    bandId: uuid("band_id")
      .notNull()
      .references(() => bands.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: bandRole("role").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.bandId, t.userId] })],
);

export const bandInvites = pgTable("band_invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  bandId: uuid("band_id")
    .notNull()
    .references(() => bands.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  maxUses: integer("max_uses"),
  usedCount: integer("used_count").notNull().default(0),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

`apps/api/src/db/db.constants.ts`:

```ts
export const DB = Symbol("DB");
```

`apps/api/src/db/db.module.ts` (스텁 교체):

```ts
import { Module } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { DB } from "./db.constants.js";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

// pg.Pool은 lazy connect라 DATABASE_URL만 있으면 DB 없이도 부팅된다.
export const dbProvider: Provider = {
  provide: DB,
  useFactory: (): Db => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    return drizzle(new pg.Pool({ connectionString: url }), { schema });
  },
};

@Module({ providers: [dbProvider], exports: [DB] })
export class DbModule {}
```

- [ ] **Step 6: drizzle-kit 설정과 마이그레이션 생성**

`apps/api/drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://band:band@localhost:5432/band",
  },
});
```

`apps/api/package.json`의 scripts에 추가:

```json
"db:generate": "drizzle-kit generate",
"db:migrate": "drizzle-kit migrate"
```

실행:

```bash
pnpm --filter @bandapp/api db:generate
pnpm --filter @bandapp/api db:migrate
```

Expected: `apps/api/drizzle/0000_*.sql` 생성, 마이그레이션 적용 성공.

- [ ] **Step 7: e2e 설정 정비**

`apps/api/test/global-setup.ts` (e2e 시작 전 마이그레이션 자동 적용):

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

export default async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "postgresql://band:band@localhost:5432/band";
  const pool = new pg.Pool({ connectionString: url });
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  await pool.end();
}
```

`apps/api/vitest.config.e2e.ts`를 수정 — **기존 옵션(plugins, globals, include)은 유지**하고 `globalSetup`과 `test.env`를 추가:

```ts
env: {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://band:band@localhost:5432/band",
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET ?? "e2e-test-secret",
  INVITE_LINK_BASE_URL: process.env.INVITE_LINK_BASE_URL ?? "https://invite.test",
  AUTH_THROTTLE_LIMIT: "1000",
},
globalSetup: ["./test/global-setup.ts"],
```

- [ ] **Step 8: 테스트 통과 확인**

Run: `pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/db.e2e-spec.ts`
Expected: PASS (2 tests)

Run: `pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts`
Expected: 기존 `test/app.e2e-spec.ts`(health) 포함 전부 PASS — DbModule 추가 후에도 AppModule 부팅이 깨지지 않는지 확인.

- [ ] **Step 9: lint + 커밋**

```bash
pnpm --filter @bandapp/api lint
git add apps/api docs/superpowers
git commit -m "feat(api): add drizzle schema and migrations for auth, bands, invites

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: TokenService — 자체 Access/Refresh Token

**Files:**
- Create: `apps/api/src/auth/token.service.ts`, `apps/api/src/auth/token.service.spec.ts`

**Interfaces:**
- Consumes: env `JWT_ACCESS_SECRET`
- Produces: `class TokenService { signAccessToken(userId: string): Promise<string>; verifyAccessToken(token: string): Promise<string>; generateRefreshToken(): string; sha256(value: string): string; refreshTokenExpiry(now?: Date): Date }`, `tokenServiceProvider: Provider`

- [ ] **Step 1: 의존성 추가**

```bash
pnpm --filter @bandapp/api add jose
```

- [ ] **Step 2: 실패하는 단위 테스트 작성**

`apps/api/src/auth/token.service.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { TokenService } from "./token.service.js";

const secret = (value: string) => () => new TextEncoder().encode(value);

describe("TokenService", () => {
  const service = new TokenService(secret("unit-test-secret"));

  it("서명한 access token에서 sub(userId)를 복원한다", async () => {
    const token = await service.signAccessToken("user-1");
    await expect(service.verifyAccessToken(token)).resolves.toBe("user-1");
  });

  it("다른 시크릿으로 서명된 토큰을 거부한다", async () => {
    const other = new TokenService(secret("other-secret"));
    const token = await other.signAccessToken("user-1");
    await expect(service.verifyAccessToken(token)).rejects.toThrow();
  });

  it("변조된 토큰을 거부한다", async () => {
    const token = await service.signAccessToken("user-1");
    await expect(service.verifyAccessToken(`${token}x`)).rejects.toThrow();
  });

  it("refresh token은 매번 다르고 해시는 64자 hex로 결정적이다", () => {
    const a = service.generateRefreshToken();
    const b = service.generateRefreshToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(service.sha256(a)).toBe(service.sha256(a));
    expect(service.sha256(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refresh 만료는 60일 뒤다", () => {
    const now = new Date("2026-08-30T00:00:00Z");
    const expiry = service.refreshTokenExpiry(now);
    expect(expiry.getTime() - now.getTime()).toBe(60 * 24 * 60 * 60 * 1000);
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/auth/token.service.spec.ts`
Expected: FAIL (모듈 없음)

- [ ] **Step 4: 구현**

`apps/api/src/auth/token.service.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";
import type { Provider } from "@nestjs/common";
import { SignJWT, jwtVerify } from "jose";

// 스펙 결정 3: Access 30분, Refresh 60일 + rotation
const ACCESS_TOKEN_TTL = "30m";
const REFRESH_TOKEN_TTL_DAYS = 60;

export class TokenService {
  constructor(
    private readonly getSecret: () => Uint8Array = () => {
      const secret = process.env.JWT_ACCESS_SECRET;
      if (!secret) throw new Error("JWT_ACCESS_SECRET is not set");
      return new TextEncoder().encode(secret);
    },
  ) {}

  /** payload는 최소화한다 — sub만 넣는다 (기획서 7장). */
  async signAccessToken(userId: string): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime(ACCESS_TOKEN_TTL)
      .sign(this.getSecret());
  }

  /** 유효하면 userId(sub)를 반환, 아니면 throw. */
  async verifyAccessToken(token: string): Promise<string> {
    const { payload } = await jwtVerify(token, this.getSecret(), { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new Error("access token has no sub");
    }
    return payload.sub;
  }

  generateRefreshToken(): string {
    return randomBytes(32).toString("base64url");
  }

  sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }

  refreshTokenExpiry(now: Date = new Date()): Date {
    return new Date(now.getTime() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  }
}

export const tokenServiceProvider: Provider = {
  provide: TokenService,
  useFactory: () => new TokenService(),
};
```

- [ ] **Step 5: 통과 확인 + 커밋**

Run: `pnpm --filter @bandapp/api exec vitest run src/auth/token.service.spec.ts`
Expected: PASS (5 tests)

```bash
pnpm --filter @bandapp/api lint
git add apps/api
git commit -m "feat(api): add token service for access/refresh tokens

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Google/Apple ID token 검증 서비스

**Files:**
- Create: `apps/api/src/auth/provider-token.ts`, `apps/api/src/auth/google-auth.service.ts`, `apps/api/src/auth/apple-auth.service.ts`, `apps/api/src/auth/provider-auth.spec.ts`

**Interfaces:**
- Consumes: env `GOOGLE_CLIENT_IDS`(쉼표 구분), `APPLE_BUNDLE_ID`
- Produces:
  - `interface VerifiedProviderToken { subject: string; email: string | null; emailVerified: boolean | null; displayName: string | null; profileImageUrl: string | null }`
  - `class GoogleAuthService { verifyIdToken(idToken: string): Promise<VerifiedProviderToken> }` + `googleAuthServiceProvider`
  - `class AppleAuthService { verifyIdToken(idToken: string): Promise<VerifiedProviderToken> }` + `appleAuthServiceProvider`

- [ ] **Step 1: 실패하는 단위 테스트 작성**

`apps/api/src/auth/provider-auth.spec.ts`:

```ts
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { JWTVerifyGetKey } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppleAuthService } from "./apple-auth.service.js";
import { GoogleAuthService } from "./google-auth.service.js";

async function makeKeys(): Promise<{ sign: (claims: Record<string, unknown>, opts: { iss: string; aud: string; expired?: boolean; sub?: string }) => Promise<string>; jwks: JWTVerifyGetKey }> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), alg: "RS256", kid: "test-key" };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const sign = (claims: Record<string, unknown>, opts: { iss: string; aud: string; expired?: boolean; sub?: string }) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(opts.iss)
      .setAudience(opts.aud)
      .setSubject(opts.sub ?? "provider-sub-1")
      .setIssuedAt()
      .setExpirationTime(opts.expired ? Math.floor(Date.now() / 1000) - 60 : "5m")
      .sign(privateKey);
  return { sign, jwks };
}

describe("GoogleAuthService", () => {
  beforeEach(() => {
    process.env.GOOGLE_CLIENT_IDS = "client-web,client-ios";
  });
  afterEach(() => {
    delete process.env.GOOGLE_CLIENT_IDS;
  });

  it("유효한 토큰에서 subject/email/이름/사진을 추출한다", async () => {
    const { sign, jwks } = await makeKeys();
    const service = new GoogleAuthService(jwks);
    const token = await sign(
      { email: "d@test.dev", email_verified: true, name: "Dongjin", picture: "https://p/img.png" },
      { iss: "https://accounts.google.com", aud: "client-ios" },
    );
    await expect(service.verifyIdToken(token)).resolves.toEqual({
      subject: "provider-sub-1",
      email: "d@test.dev",
      emailVerified: true,
      displayName: "Dongjin",
      profileImageUrl: "https://p/img.png",
    });
  });

  it("audience가 목록에 없으면 거부한다", async () => {
    const { sign, jwks } = await makeKeys();
    const service = new GoogleAuthService(jwks);
    const token = await sign({}, { iss: "https://accounts.google.com", aud: "unknown-client" });
    await expect(service.verifyIdToken(token)).rejects.toThrow();
  });

  it("issuer가 다르면 거부한다", async () => {
    const { sign, jwks } = await makeKeys();
    const service = new GoogleAuthService(jwks);
    const token = await sign({}, { iss: "https://evil.example.com", aud: "client-web" });
    await expect(service.verifyIdToken(token)).rejects.toThrow();
  });

  it("만료된 토큰을 거부한다", async () => {
    const { sign, jwks } = await makeKeys();
    const service = new GoogleAuthService(jwks);
    const token = await sign({}, { iss: "https://accounts.google.com", aud: "client-web", expired: true });
    await expect(service.verifyIdToken(token)).rejects.toThrow();
  });

  it("GOOGLE_CLIENT_IDS 미설정이면 throw", async () => {
    delete process.env.GOOGLE_CLIENT_IDS;
    const { sign, jwks } = await makeKeys();
    const service = new GoogleAuthService(jwks);
    const token = await sign({}, { iss: "https://accounts.google.com", aud: "client-web" });
    await expect(service.verifyIdToken(token)).rejects.toThrow("GOOGLE_CLIENT_IDS");
  });
});

describe("AppleAuthService", () => {
  beforeEach(() => {
    process.env.APPLE_BUNDLE_ID = "com.bandapp.app";
  });
  afterEach(() => {
    delete process.env.APPLE_BUNDLE_ID;
  });

  it("유효한 토큰에서 subject/email을 추출한다 (이름 없음)", async () => {
    const { sign, jwks } = await makeKeys();
    const service = new AppleAuthService(jwks);
    const token = await sign(
      { email: "hide@privaterelay.appleid.com", email_verified: "true" },
      { iss: "https://appleid.apple.com", aud: "com.bandapp.app", sub: "apple-sub-1" },
    );
    await expect(service.verifyIdToken(token)).resolves.toEqual({
      subject: "apple-sub-1",
      email: "hide@privaterelay.appleid.com",
      emailVerified: true,
      displayName: null,
      profileImageUrl: null,
    });
  });

  it("audience(번들 ID)가 다르면 거부한다", async () => {
    const { sign, jwks } = await makeKeys();
    const service = new AppleAuthService(jwks);
    const token = await sign({}, { iss: "https://appleid.apple.com", aud: "com.other.app" });
    await expect(service.verifyIdToken(token)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/auth/provider-auth.spec.ts`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현**

`apps/api/src/auth/provider-token.ts`:

```ts
export interface VerifiedProviderToken {
  subject: string;
  email: string | null;
  emailVerified: boolean | null;
  displayName: string | null;
  profileImageUrl: string | null;
}
```

`apps/api/src/auth/google-auth.service.ts`:

```ts
import type { Provider } from "@nestjs/common";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";
import type { VerifiedProviderToken } from "./provider-token.js";

export class GoogleAuthService {
  constructor(
    private readonly getKey: JWTVerifyGetKey = createRemoteJWKSet(
      new URL("https://www.googleapis.com/oauth2/v3/certs"),
    ),
  ) {}

  async verifyIdToken(idToken: string): Promise<VerifiedProviderToken> {
    const audience = (process.env.GOOGLE_CLIENT_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (audience.length === 0) throw new Error("GOOGLE_CLIENT_IDS is not set");
    const { payload } = await jwtVerify(idToken, this.getKey, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience,
    });
    if (typeof payload.sub !== "string") throw new Error("id token has no sub");
    return {
      subject: payload.sub,
      email: typeof payload.email === "string" ? payload.email : null,
      emailVerified: typeof payload.email_verified === "boolean" ? payload.email_verified : null,
      displayName: typeof payload.name === "string" ? payload.name : null,
      profileImageUrl: typeof payload.picture === "string" ? payload.picture : null,
    };
  }
}

export const googleAuthServiceProvider: Provider = {
  provide: GoogleAuthService,
  useFactory: () => new GoogleAuthService(),
};
```

`apps/api/src/auth/apple-auth.service.ts`:

```ts
import type { Provider } from "@nestjs/common";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";
import type { VerifiedProviderToken } from "./provider-token.js";

export class AppleAuthService {
  constructor(
    private readonly getKey: JWTVerifyGetKey = createRemoteJWKSet(
      new URL("https://appleid.apple.com/auth/keys"),
    ),
  ) {}

  async verifyIdToken(idToken: string): Promise<VerifiedProviderToken> {
    const audience = process.env.APPLE_BUNDLE_ID;
    if (!audience) throw new Error("APPLE_BUNDLE_ID is not set");
    const { payload } = await jwtVerify(idToken, this.getKey, {
      issuer: "https://appleid.apple.com",
      audience,
    });
    if (typeof payload.sub !== "string") throw new Error("id token has no sub");
    // Apple은 email_verified를 boolean 또는 "true"/"false" 문자열로 준다
    const rawVerified = payload.email_verified;
    const emailVerified =
      rawVerified === true || rawVerified === "true"
        ? true
        : rawVerified === false || rawVerified === "false"
          ? false
          : null;
    return {
      subject: payload.sub,
      email: typeof payload.email === "string" ? payload.email : null,
      emailVerified,
      // Apple ID token에는 이름이 없다 — 최초 가입 시 클라이언트가 body로 전달 (스펙 결정 8)
      displayName: null,
      profileImageUrl: null,
    };
  }
}

export const appleAuthServiceProvider: Provider = {
  provide: AppleAuthService,
  useFactory: () => new AppleAuthService(),
};
```

- [ ] **Step 4: 통과 확인 + 커밋**

Run: `pnpm --filter @bandapp/api exec vitest run src/auth/provider-auth.spec.ts`
Expected: PASS (7 tests)

```bash
pnpm --filter @bandapp/api lint
git add apps/api
git commit -m "feat(api): verify google and apple id tokens with jose

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: UsersService — identity 기반 find-or-create

**Files:**
- Create: `apps/api/src/users/users.service.ts`, `apps/api/test/users.service.e2e-spec.ts`
- Modify: `apps/api/src/users/users.module.ts` (빈 스텁)

**Interfaces:**
- Consumes: `Db`/`DB`(Task 1), `VerifiedProviderToken`(Task 3)
- Produces:
  - `interface PublicUser { id: string; displayName: string | null; profileImageUrl: string | null }`
  - `class UsersService { findOrCreateByIdentity(provider: "GOOGLE" | "APPLE", verified: VerifiedProviderToken): Promise<{ user: PublicUser; isNewUser: boolean }>; findById(userId: string): Promise<PublicUser | null> }` + `usersServiceProvider`
  - `UsersModule`이 `UsersService` export

- [ ] **Step 1: 실패하는 e2e 테스트 작성**

`apps/api/test/users.service.e2e-spec.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { UsersService } from "../src/users/users.service.js";
import type { VerifiedProviderToken } from "../src/auth/provider-token.js";
import { createTestDb, truncateAll } from "./db-util.js";

const verified = (subject: string, over?: Partial<VerifiedProviderToken>): VerifiedProviderToken => ({
  subject,
  email: `${subject}@test.dev`,
  emailVerified: true,
  displayName: "Dongjin",
  profileImageUrl: null,
  ...over,
});

describe("UsersService", () => {
  const db = createTestDb();
  const service = new UsersService(db);
  beforeEach(() => truncateAll(db));

  it("최초 로그인이면 user+identity를 만들고 isNewUser=true", async () => {
    const result = await service.findOrCreateByIdentity("GOOGLE", verified("g-1"));
    expect(result.isNewUser).toBe(true);
    expect(result.user.displayName).toBe("Dongjin");
  });

  it("같은 (provider, subject) 재로그인은 기존 user를 반환한다", async () => {
    const first = await service.findOrCreateByIdentity("GOOGLE", verified("g-1"));
    const second = await service.findOrCreateByIdentity("GOOGLE", verified("g-1"));
    expect(second.isNewUser).toBe(false);
    expect(second.user.id).toBe(first.user.id);
  });

  it("provider가 다르면 subject가 같아도 다른 user다 (자동 병합 금지)", async () => {
    const g = await service.findOrCreateByIdentity("GOOGLE", verified("same"));
    const a = await service.findOrCreateByIdentity("APPLE", verified("same"));
    expect(a.user.id).not.toBe(g.user.id);
  });

  it("findById는 없는 id에 null을 준다", async () => {
    expect(await service.findById("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/users.service.e2e-spec.ts`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현**

`apps/api/src/users/users.service.ts`:

```ts
import type { Provider } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { userIdentities, users } from "../db/schema.js";
import type { VerifiedProviderToken } from "../auth/provider-token.js";

export interface PublicUser {
  id: string;
  displayName: string | null;
  profileImageUrl: string | null;
}

export class UsersService {
  constructor(private readonly db: Db) {}

  async findOrCreateByIdentity(
    provider: "GOOGLE" | "APPLE",
    verified: VerifiedProviderToken,
  ): Promise<{ user: PublicUser; isNewUser: boolean }> {
    const found = await this.findByIdentity(provider, verified.subject);
    if (found) return { user: found, isNewUser: false };
    try {
      return await this.db.transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({ displayName: verified.displayName, profileImageUrl: verified.profileImageUrl })
          .returning();
        if (!user) throw new Error("failed to insert user");
        await tx.insert(userIdentities).values({
          userId: user.id,
          provider,
          providerSubject: verified.subject,
          email: verified.email,
          emailVerified: verified.emailVerified,
        });
        return { user: this.toPublic(user), isNewUser: true };
      });
    } catch (err) {
      // 동시 최초 로그인으로 unique(provider, subject) 충돌 시 기존 계정으로 수렴
      const existing = await this.findByIdentity(provider, verified.subject);
      if (existing) return { user: existing, isNewUser: false };
      throw err;
    }
  }

  async findById(userId: string): Promise<PublicUser | null> {
    const row = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!row || row.deletedAt) return null;
    return this.toPublic(row);
  }

  private async findByIdentity(provider: "GOOGLE" | "APPLE", subject: string): Promise<PublicUser | null> {
    const identity = await this.db.query.userIdentities.findFirst({
      where: and(eq(userIdentities.provider, provider), eq(userIdentities.providerSubject, subject)),
    });
    if (!identity) return null;
    const user = await this.db.query.users.findFirst({ where: eq(users.id, identity.userId) });
    return user ? this.toPublic(user) : null;
  }

  private toPublic(row: typeof users.$inferSelect): PublicUser {
    return { id: row.id, displayName: row.displayName, profileImageUrl: row.profileImageUrl };
  }
}

export const usersServiceProvider: Provider = {
  provide: UsersService,
  useFactory: (db: Db) => new UsersService(db),
  inject: [DB],
};
```

`apps/api/src/users/users.module.ts` (스텁 교체):

```ts
import { Module } from "@nestjs/common";
import { DbModule } from "../db/db.module.js";
import { usersServiceProvider, UsersService } from "./users.service.js";

@Module({
  imports: [DbModule],
  providers: [usersServiceProvider],
  exports: [UsersService],
})
export class UsersModule {}
```

- [ ] **Step 4: 통과 확인 + 커밋**

Run: `pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/users.service.e2e-spec.ts`
Expected: PASS (4 tests)

```bash
pnpm --filter @bandapp/api lint
git add apps/api
git commit -m "feat(api): find-or-create users from provider identities

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: AuthSessionsService — refresh 세션 발급/회전/폐기

**Files:**
- Create: `apps/api/src/auth/auth-sessions.service.ts`, `apps/api/test/auth-sessions.service.e2e-spec.ts`

**Interfaces:**
- Consumes: `Db`/`DB`, `TokenService`(Task 2), `authSessions` 테이블
- Produces: `class AuthSessionsService { issue(userId: string): Promise<string>; rotate(refreshToken: string): Promise<{ userId: string; refreshToken: string } | null>; revoke(refreshToken: string): Promise<void>; revokeAllForUser(userId: string): Promise<void> }` + `authSessionsServiceProvider`

- [ ] **Step 1: 실패하는 e2e 테스트 작성**

`apps/api/test/auth-sessions.service.e2e-spec.ts`:

```ts
import { and, eq, isNull } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthSessionsService } from "../src/auth/auth-sessions.service.js";
import { TokenService } from "../src/auth/token.service.js";
import { authSessions, users } from "../src/db/schema.js";
import { createTestDb, truncateAll } from "./db-util.js";

describe("AuthSessionsService", () => {
  const db = createTestDb();
  const tokens = new TokenService();
  const service = new AuthSessionsService(db, tokens);
  let userId: string;

  beforeEach(async () => {
    await truncateAll(db);
    const [user] = await db.insert(users).values({ displayName: "u" }).returning();
    userId = user!.id;
  });

  it("issue는 원문을 반환하고 DB에는 해시만 저장한다", async () => {
    const refreshToken = await service.issue(userId);
    const rows = await db.query.authSessions.findMany({ where: eq(authSessions.userId, userId) });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.refreshTokenHash).toBe(tokens.sha256(refreshToken));
    expect(rows[0]!.refreshTokenHash).not.toBe(refreshToken);
  });

  it("rotate는 새 refresh를 주고 이전 것을 무효화한다", async () => {
    const first = await service.issue(userId);
    const rotated = await service.rotate(first);
    expect(rotated?.userId).toBe(userId);
    expect(rotated?.refreshToken).not.toBe(first);
    expect(await service.rotate(first)).toBeNull(); // 재사용 거부
    expect(await service.rotate(rotated!.refreshToken)).not.toBeNull();
  });

  it("만료된 세션은 rotate되지 않는다", async () => {
    const refreshToken = tokens.generateRefreshToken();
    await db.insert(authSessions).values({
      userId,
      refreshTokenHash: tokens.sha256(refreshToken),
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await service.rotate(refreshToken)).toBeNull();
  });

  it("revoke 후 rotate는 null", async () => {
    const refreshToken = await service.issue(userId);
    await service.revoke(refreshToken);
    expect(await service.rotate(refreshToken)).toBeNull();
  });

  it("revokeAllForUser는 활성 세션을 전부 폐기한다", async () => {
    await service.issue(userId);
    await service.issue(userId);
    await service.revokeAllForUser(userId);
    const active = await db.query.authSessions.findMany({
      where: and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)),
    });
    expect(active).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/auth-sessions.service.e2e-spec.ts`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현**

`apps/api/src/auth/auth-sessions.service.ts`:

```ts
import type { Provider } from "@nestjs/common";
import { and, eq, gt, isNull } from "drizzle-orm";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { authSessions } from "../db/schema.js";
import { TokenService } from "./token.service.js";

export class AuthSessionsService {
  constructor(
    private readonly db: Db,
    private readonly tokens: TokenService,
  ) {}

  /** 새 refresh 세션을 만들고 토큰 원문을 반환한다. DB에는 해시만 남는다. */
  async issue(userId: string): Promise<string> {
    const refreshToken = this.tokens.generateRefreshToken();
    await this.db.insert(authSessions).values({
      userId,
      refreshTokenHash: this.tokens.sha256(refreshToken),
      expiresAt: this.tokens.refreshTokenExpiry(),
    });
    return refreshToken;
  }

  /** rotation: 유효한 세션이면 revoke하고 새 세션을 발급한다. 무효면 null. */
  async rotate(refreshToken: string): Promise<{ userId: string; refreshToken: string } | null> {
    const hash = this.tokens.sha256(refreshToken);
    return this.db.transaction(async (tx) => {
      const [session] = await tx
        .update(authSessions)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(authSessions.refreshTokenHash, hash),
            isNull(authSessions.revokedAt),
            gt(authSessions.expiresAt, new Date()),
          ),
        )
        .returning();
      if (!session) return null;
      const next = this.tokens.generateRefreshToken();
      await tx.insert(authSessions).values({
        userId: session.userId,
        refreshTokenHash: this.tokens.sha256(next),
        deviceName: session.deviceName,
        platform: session.platform,
        expiresAt: this.tokens.refreshTokenExpiry(),
        lastUsedAt: new Date(),
      });
      return { userId: session.userId, refreshToken: next };
    });
  }

  async revoke(refreshToken: string): Promise<void> {
    await this.db
      .update(authSessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(authSessions.refreshTokenHash, this.tokens.sha256(refreshToken)),
          isNull(authSessions.revokedAt),
        ),
      );
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.db
      .update(authSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)));
  }
}

export const authSessionsServiceProvider: Provider = {
  provide: AuthSessionsService,
  useFactory: (db: Db, tokens: TokenService) => new AuthSessionsService(db, tokens),
  inject: [DB, TokenService],
};
```

- [ ] **Step 4: 통과 확인 + 커밋**

Run: `pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/auth-sessions.service.e2e-spec.ts`
Expected: PASS (5 tests)

```bash
pnpm --filter @bandapp/api lint
git add apps/api
git commit -m "feat(api): refresh session issue/rotate/revoke

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Auth API — /auth/google · /auth/apple · /auth/refresh · /auth/logout

**Files:**
- Create: `apps/api/src/auth/auth.service.ts`, `apps/api/src/auth/auth.controller.ts`, `apps/api/src/common/validation.ts`, `apps/api/test/app-util.ts`, `apps/api/test/auth.e2e-spec.ts`
- Modify: `apps/api/src/auth/auth.module.ts` (빈 스텁), `apps/api/package.json`(deps), `.env.example`

**Interfaces:**
- Consumes: Task 2~5의 서비스들, `@bandapp/types`의 `LoginResponse`/`AuthTokens`(모바일 플랜 Task 1에서 추가 — 이 태스크 시점에 없으면 아래 참고)
- Produces:
  - REST: `POST /auth/google {idToken}` → LoginResponse(201) / `POST /auth/apple {idToken, displayName?}` → LoginResponse(201) / `POST /auth/refresh {refreshToken}` → AuthTokens(201) / `POST /auth/logout {refreshToken}` (Bearer) → 204
  - `class AuthService { loginWithGoogle(idToken: string): Promise<LoginResponse>; loginWithApple(idToken: string, displayName?: string): Promise<LoginResponse>; refresh(refreshToken: string): Promise<AuthTokens>; logout(refreshToken: string): Promise<void> }` + `authServiceProvider`
  - `requireString(body: unknown, field: string): string`, `optionalString(body: unknown, field: string): string | undefined`, `requireUuidParam(value: string, name: string): string`
  - 테스트 헬퍼 `createTestApp(overrides?)`, `loginAs(app, subject, name?)`

**참고:** `@bandapp/types`에 auth 타입이 아직 없으면(모바일 플랜 미실행) 이 태스크의 Step 3에서 함께 추가한다 — `packages/types/src/user.ts`/`auth.ts`를 모바일 플랜 Task 1의 코드 그대로 만들고 `index.ts`에 export 추가, `pnpm --filter @bandapp/types build`. 두 플랜 중 먼저 실행되는 쪽이 이 파일들을 만들고, 나중 쪽은 이미 있으면 건너뛴다.

- [ ] **Step 1: 의존성 추가**

```bash
pnpm --filter @bandapp/api add @nestjs/throttler "@bandapp/types@workspace:*"
pnpm --filter @bandapp/types build
```

- [ ] **Step 2: 실패하는 e2e 테스트 작성**

`apps/api/test/app-util.ts`:

```ts
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module.js";
import { AppleAuthService } from "../src/auth/apple-auth.service.js";
import { GoogleAuthService } from "../src/auth/google-auth.service.js";
import type { VerifiedProviderToken } from "../src/auth/provider-token.js";

export interface ProviderStub {
  verifyIdToken(idToken: string): Promise<VerifiedProviderToken>;
}

const rejecting: ProviderStub = {
  verifyIdToken: async () => {
    throw new Error("provider verification not stubbed");
  },
};

export function providerUser(subject: string, displayName: string | null = "Dongjin"): ProviderStub {
  return {
    verifyIdToken: async () => ({
      subject,
      email: `${subject}@test.dev`,
      emailVerified: true,
      displayName,
      profileImageUrl: null,
    }),
  };
}

export async function createTestApp(overrides?: {
  google?: ProviderStub;
  apple?: ProviderStub;
}): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(GoogleAuthService)
    .useValue(overrides?.google ?? rejecting)
    .overrideProvider(AppleAuthService)
    .useValue(overrides?.apple ?? rejecting)
    .compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

/** google 스텁이 subject로 응답하도록 만들어진 app에서 로그인해 토큰을 얻는다. */
export async function loginAs(
  app: INestApplication,
  path: "/auth/google" | "/auth/apple" = "/auth/google",
): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
  const res = await request(app.getHttpServer()).post(path).send({ idToken: "stubbed" }).expect(201);
  return {
    accessToken: res.body.accessToken,
    refreshToken: res.body.refreshToken,
    userId: res.body.user.id,
  };
}
```

`apps/api/test/auth.e2e-spec.ts`:

```ts
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, loginAs, providerUser } from "./app-util.js";
import { createTestDb, truncateAll } from "./db-util.js";

describe("auth API", () => {
  let app: INestApplication;

  beforeEach(async () => {
    await truncateAll(createTestDb());
    app = await createTestApp({ google: providerUser("g-1"), apple: providerUser("a-1", null) });
  });
  afterEach(() => app.close());

  it("최초 Google 로그인은 자동 가입한다", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/google")
      .send({ idToken: "stub" })
      .expect(201);
    expect(res.body.isNewUser).toBe(true);
    expect(res.body.user.displayName).toBe("Dongjin");
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
  });

  it("재로그인은 같은 user로 isNewUser=false", async () => {
    const first = await loginAs(app);
    const res = await request(app.getHttpServer())
      .post("/auth/google")
      .send({ idToken: "stub" })
      .expect(201);
    expect(res.body.isNewUser).toBe(false);
    expect(res.body.user.id).toBe(first.userId);
  });

  it("Apple 최초 로그인은 body displayName을 저장한다", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/apple")
      .send({ idToken: "stub", displayName: "동진" })
      .expect(201);
    expect(res.body.user.displayName).toBe("동진");
  });

  it("idToken 누락은 400", async () => {
    await request(app.getHttpServer()).post("/auth/google").send({}).expect(400);
  });

  it("Provider 검증 실패는 401이고 내부 오류 문자열을 노출하지 않는다", async () => {
    const failing = await createTestApp(); // 스텁 없음 → 검증 throw
    const res = await request(failing.getHttpServer())
      .post("/auth/google")
      .send({ idToken: "bad" })
      .expect(401);
    expect(res.body.message).not.toContain("stubbed");
    await failing.close();
  });

  it("refresh는 rotation한다 — 새 쌍 발급, 이전 refresh 재사용은 401", async () => {
    const { refreshToken } = await loginAs(app);
    const rotated = await request(app.getHttpServer())
      .post("/auth/refresh")
      .send({ refreshToken })
      .expect(201);
    expect(rotated.body.accessToken).toBeTruthy();
    expect(rotated.body.refreshToken).not.toBe(refreshToken);
    await request(app.getHttpServer()).post("/auth/refresh").send({ refreshToken }).expect(401);
    await request(app.getHttpServer())
      .post("/auth/refresh")
      .send({ refreshToken: rotated.body.refreshToken })
      .expect(201);
  });

  it("logout 후 해당 refresh는 401", async () => {
    const { accessToken, refreshToken } = await loginAs(app);
    await request(app.getHttpServer())
      .post("/auth/logout")
      .set("authorization", `Bearer ${accessToken}`)
      .send({ refreshToken })
      .expect(204);
    await request(app.getHttpServer()).post("/auth/refresh").send({ refreshToken }).expect(401);
  });
});
```

**주의:** logout 테스트는 Task 7의 AuthGuard가 필요하다. 이 태스크에서는 logout 라우트에 가드 없이 구현하고, Task 7에서 가드를 붙인다 — 위 테스트는 가드가 있어도 없어도 통과하도록 Bearer를 이미 보낸다.

- [ ] **Step 3: 실패 확인**

Run: `pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/auth.e2e-spec.ts`
Expected: FAIL (라우트 없음 — 404)

- [ ] **Step 4: 구현**

`apps/api/src/common/validation.ts`:

```ts
import { BadRequestException } from "@nestjs/common";

export function requireString(body: unknown, field: string): string {
  const value = (body as Record<string, unknown> | null | undefined)?.[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new BadRequestException(`${field} must be a non-empty string`);
  }
  return value;
}

export function optionalString(body: unknown, field: string): string | undefined {
  const value = (body as Record<string, unknown> | null | undefined)?.[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new BadRequestException(`${field} must be a string`);
  return value;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUuidParam(value: string, name: string): string {
  if (!UUID_RE.test(value)) throw new BadRequestException(`${name} must be a UUID`);
  return value;
}
```

`apps/api/src/auth/auth.service.ts`:

```ts
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
```

`apps/api/src/auth/auth.controller.ts`:

```ts
import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import type { AuthTokens, LoginResponse } from "@bandapp/types";
import { optionalString, requireString } from "../common/validation.js";
import { AuthService } from "./auth.service.js";

@Controller("auth")
@UseGuards(ThrottlerGuard)
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("google")
  google(@Body() body: unknown): Promise<LoginResponse> {
    return this.auth.loginWithGoogle(requireString(body, "idToken"));
  }

  @Post("apple")
  apple(@Body() body: unknown): Promise<LoginResponse> {
    return this.auth.loginWithApple(
      requireString(body, "idToken"),
      optionalString(body, "displayName"),
    );
  }

  @Post("refresh")
  refresh(@Body() body: unknown): Promise<AuthTokens> {
    return this.auth.refresh(requireString(body, "refreshToken"));
  }

  @Post("logout")
  @HttpCode(204)
  async logout(@Body() body: unknown): Promise<void> {
    await this.auth.logout(requireString(body, "refreshToken"));
  }
}
```

`apps/api/src/auth/auth.module.ts` (스텁 교체):

```ts
import { Module } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";
import { DbModule } from "../db/db.module.js";
import { UsersModule } from "../users/users.module.js";
import { appleAuthServiceProvider } from "./apple-auth.service.js";
import { authSessionsServiceProvider } from "./auth-sessions.service.js";
import { AuthController } from "./auth.controller.js";
import { authServiceProvider } from "./auth.service.js";
import { googleAuthServiceProvider } from "./google-auth.service.js";
import { tokenServiceProvider, TokenService } from "./token.service.js";

@Module({
  imports: [
    DbModule,
    UsersModule,
    // 로그인 API rate limit (기획서 20장). e2e에서는 AUTH_THROTTLE_LIMIT로 완화한다.
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: Number(process.env.AUTH_THROTTLE_LIMIT ?? 20) }],
    }),
  ],
  controllers: [AuthController],
  providers: [
    tokenServiceProvider,
    googleAuthServiceProvider,
    appleAuthServiceProvider,
    authSessionsServiceProvider,
    authServiceProvider,
  ],
  exports: [TokenService],
})
export class AuthModule {}
```

`.env.example`에 추가 (값은 사용자가 추후 제공):

```
JWT_ACCESS_SECRET=change-me
GOOGLE_CLIENT_IDS=web-client-id.apps.googleusercontent.com,ios-client-id.apps.googleusercontent.com
APPLE_BUNDLE_ID=com.bandapp.app
```

- [ ] **Step 5: 통과 확인 + 커밋**

Run: `pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/auth.e2e-spec.ts`
Expected: PASS (7 tests)

Run: `pnpm --filter @bandapp/api exec vitest run` (단위 테스트 회귀 확인)
Expected: PASS

```bash
pnpm --filter @bandapp/api lint
git add apps/api packages/types .env.example
git commit -m "feat(api): auth endpoints with token rotation and rate limit

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: AuthGuard + @CurrentUserId + GET /me

**Files:**
- Create: `apps/api/src/auth/auth.guard.ts`, `apps/api/src/auth/current-user-id.decorator.ts`, `apps/api/src/auth/me.controller.ts`, `apps/api/test/me.e2e-spec.ts`
- Modify: `apps/api/src/auth/auth.module.ts`, `apps/api/src/auth/auth.controller.ts` (logout에 가드 부착)

**Interfaces:**
- Consumes: `TokenService`, `UsersService`
- Produces:
  - `class AuthGuard implements CanActivate` + `authGuardProvider` — 통과 시 `request.userId: string` 세팅. **AuthModule이 `AuthGuard` export** — 다른 모듈은 `imports: [AuthModule]` 후 `@UseGuards(AuthGuard)` 사용
  - `@CurrentUserId()` 파라미터 데코레이터
  - REST: `GET /me` (Bearer) → `User { id, displayName, profileImageUrl }`

- [ ] **Step 1: 실패하는 e2e 테스트 작성**

`apps/api/test/me.e2e-spec.ts`:

```ts
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, loginAs, providerUser } from "./app-util.js";
import { createTestDb, truncateAll } from "./db-util.js";

describe("GET /me", () => {
  let app: INestApplication;

  beforeEach(async () => {
    await truncateAll(createTestDb());
    app = await createTestApp({ google: providerUser("g-1") });
  });
  afterEach(() => app.close());

  it("토큰 없이 401", async () => {
    await request(app.getHttpServer()).get("/me").expect(401);
  });

  it("잘못된 토큰은 401", async () => {
    await request(app.getHttpServer()).get("/me").set("authorization", "Bearer garbage").expect(401);
  });

  it("유효한 access token이면 내 정보를 준다", async () => {
    const { accessToken, userId } = await loginAs(app);
    const res = await request(app.getHttpServer())
      .get("/me")
      .set("authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body).toEqual({ id: userId, displayName: "Dongjin", profileImageUrl: null });
  });

  it("가드 없는 access 토큰 형식(Bearer 누락)은 401", async () => {
    const { accessToken } = await loginAs(app);
    await request(app.getHttpServer()).get("/me").set("authorization", accessToken).expect(401);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/me.e2e-spec.ts`
Expected: FAIL (404)

- [ ] **Step 3: 구현**

`apps/api/src/auth/auth.guard.ts`:

```ts
import { UnauthorizedException } from "@nestjs/common";
import type { CanActivate, ExecutionContext, Provider } from "@nestjs/common";
import { TokenService } from "./token.service.js";

export interface AuthedRequest {
  headers: Record<string, string | string[] | undefined>;
  userId?: string;
}

export class AuthGuard implements CanActivate {
  constructor(private readonly tokens: TokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      throw new UnauthorizedException();
    }
    try {
      request.userId = await this.tokens.verifyAccessToken(header.slice("Bearer ".length));
    } catch {
      throw new UnauthorizedException();
    }
    return true;
  }
}

export const authGuardProvider: Provider = {
  provide: AuthGuard,
  useFactory: (tokens: TokenService) => new AuthGuard(tokens),
  inject: [TokenService],
};
```

`apps/api/src/auth/current-user-id.decorator.ts`:

```ts
import { UnauthorizedException, createParamDecorator } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { AuthedRequest } from "./auth.guard.js";

export const CurrentUserId = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const request = context.switchToHttp().getRequest<AuthedRequest>();
  if (!request.userId) throw new UnauthorizedException();
  return request.userId;
});
```

`apps/api/src/auth/me.controller.ts` (기획서 6장 — /me는 인증 API 소속):

```ts
import { Controller, Get, UnauthorizedException, UseGuards } from "@nestjs/common";
import type { User } from "@bandapp/types";
import { UsersService } from "../users/users.service.js";
import { AuthGuard } from "./auth.guard.js";
import { CurrentUserId } from "./current-user-id.decorator.js";

@Controller("me")
@UseGuards(AuthGuard)
export class MeController {
  constructor(private readonly users: UsersService) {}

  @Get()
  async me(@CurrentUserId() userId: string): Promise<User> {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedException(); // 탈퇴한 계정의 잔여 access token
    return user;
  }
}
```

`auth.module.ts` 수정: `controllers: [AuthController, MeController]`, `providers`에 `authGuardProvider` 추가, `exports: [TokenService, AuthGuard]`.

`auth.controller.ts`의 logout에 가드 부착:

```ts
@Post("logout")
@HttpCode(204)
@UseGuards(AuthGuard)
async logout(@Body() body: unknown): Promise<void> {
```

- [ ] **Step 4: 통과 확인 + 커밋**

Run: `pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/me.e2e-spec.ts test/auth.e2e-spec.ts`
Expected: PASS (11 tests — logout 테스트 포함 회귀 없음)

```bash
pnpm --filter @bandapp/api lint
git add apps/api
git commit -m "feat(api): auth guard, current user decorator, GET /me

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Bands + Memberships API

**Files:**
- Create: `apps/api/src/memberships/memberships.service.ts`, `apps/api/src/bands/bands.service.ts`, `apps/api/src/bands/bands.controller.ts`, `apps/api/test/bands.e2e-spec.ts`
- Modify: `apps/api/src/memberships/memberships.module.ts`, `apps/api/src/bands/bands.module.ts` (빈 스텁)

**Interfaces:**
- Consumes: `Db`/`DB`, `AuthGuard`/`CurrentUserId`(Task 7), `requireString`/`requireUuidParam`(Task 6), `@bandapp/types`의 `Band { id, name, memberCount }`·`BandMember { id, name, role }`·`MemberRole`
- Produces:
  - `class MembershipsService { roleOf(bandId, userId): Promise<MemberRole | null>; assertMember(bandId, userId): Promise<MemberRole>; assertOwner(bandId, userId): Promise<void> }` + provider, `MembershipsModule`이 export — **Invites(Task 9)와 향후 sessions 권한 검사가 이걸 쓴다**
  - `class BandsService { create(userId, name): Promise<Band>; listForUser(userId): Promise<Band[]>; members(bandId): Promise<BandMember[]>; leave(bandId, userId): Promise<void> }`
  - REST: `POST /bands {name}`(201→Band) / `GET /bands`(200→Band[]) / `GET /bands/:bandId/members`(멤버만) / `DELETE /bands/:bandId/members/me`(204)

**참고:** `@bandapp/types`의 `Band`에서 `inviteCode` 제거는 모바일 플랜 Task 1 소관. 이 태스크가 먼저 실행되고 `Band`에 아직 `inviteCode: string`이 있다면, 모바일 플랜 Task 1의 `band.ts` 수정을 여기서 먼저 수행하고 `pnpm --filter @bandapp/types build` 후 진행한다 (api-client mock이 깨지면 mock의 `inviteLink`에서 `band.inviteCode` 참조를 임시로 `band.id`로 바꿔 컴파일 유지).

- [ ] **Step 1: 실패하는 e2e 테스트 작성**

`apps/api/test/bands.e2e-spec.ts`:

```ts
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bandMembers } from "../src/db/schema.js";
import { createTestApp, loginAs, providerUser } from "./app-util.js";
import { createTestDb, truncateAll } from "./db-util.js";

describe("bands API", () => {
  const db = createTestDb();
  let app: INestApplication;
  let owner: { accessToken: string; userId: string };

  beforeEach(async () => {
    await truncateAll(db);
    app = await createTestApp({ google: providerUser("owner-1") });
    owner = await loginAs(app);
  });
  afterEach(() => app.close());

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function createBand(token: string, name = "FRIDAY NIGHT"): Promise<string> {
    const res = await request(app.getHttpServer()).post("/bands").set(auth(token)).send({ name }).expect(201);
    return res.body.id;
  }

  async function secondUser(subject = "member-1"): Promise<{ accessToken: string; userId: string }> {
    const other = await createTestApp({ google: providerUser(subject, "Minsoo") });
    const login = await loginAs(other);
    await other.close();
    return login;
  }

  it("밴드를 만들면 만든 사람이 owner다", async () => {
    const res = await request(app.getHttpServer())
      .post("/bands")
      .set(auth(owner.accessToken))
      .send({ name: "FRIDAY NIGHT" })
      .expect(201);
    expect(res.body).toMatchObject({ name: "FRIDAY NIGHT", memberCount: 1 });
    const members = await request(app.getHttpServer())
      .get(`/bands/${res.body.id}/members`)
      .set(auth(owner.accessToken))
      .expect(200);
    expect(members.body).toEqual([{ id: owner.userId, name: "Dongjin", role: "owner" }]);
  });

  it("GET /bands는 내가 속한 밴드만 memberCount와 함께 준다", async () => {
    const bandId = await createBand(owner.accessToken);
    const stranger = await secondUser("stranger-1");
    await db.insert(bandMembers).values({ bandId, userId: stranger.userId, role: "member" });
    const mine = await request(app.getHttpServer()).get("/bands").set(auth(owner.accessToken)).expect(200);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0]).toMatchObject({ id: bandId, memberCount: 2 });
    const theirs = await request(app.getHttpServer()).get("/bands").set(auth(stranger.accessToken)).expect(200);
    expect(theirs.body).toHaveLength(1);
  });

  it("비멤버는 멤버 목록에 403 — 서버가 항상 검증한다 (기획서 9장)", async () => {
    const bandId = await createBand(owner.accessToken);
    const stranger = await secondUser("stranger-2");
    await request(app.getHttpServer())
      .get(`/bands/${bandId}/members`)
      .set(auth(stranger.accessToken))
      .expect(403);
  });

  it("member는 탈퇴할 수 있다", async () => {
    const bandId = await createBand(owner.accessToken);
    const member = await secondUser();
    await db.insert(bandMembers).values({ bandId, userId: member.userId, role: "member" });
    await request(app.getHttpServer())
      .delete(`/bands/${bandId}/members/me`)
      .set(auth(member.accessToken))
      .expect(204);
    const members = await request(app.getHttpServer())
      .get(`/bands/${bandId}/members`)
      .set(auth(owner.accessToken))
      .expect(200);
    expect(members.body).toHaveLength(1);
  });

  it("다른 멤버가 있는 밴드의 owner 탈퇴는 409", async () => {
    const bandId = await createBand(owner.accessToken);
    const member = await secondUser();
    await db.insert(bandMembers).values({ bandId, userId: member.userId, role: "member" });
    await request(app.getHttpServer())
      .delete(`/bands/${bandId}/members/me`)
      .set(auth(owner.accessToken))
      .expect(409);
  });

  it("혼자 남은 owner가 탈퇴하면 밴드가 삭제된다", async () => {
    const bandId = await createBand(owner.accessToken);
    await request(app.getHttpServer())
      .delete(`/bands/${bandId}/members/me`)
      .set(auth(owner.accessToken))
      .expect(204);
    const mine = await request(app.getHttpServer()).get("/bands").set(auth(owner.accessToken)).expect(200);
    expect(mine.body).toHaveLength(0);
  });

  it("이름이 비면 400, 토큰 없으면 401", async () => {
    await request(app.getHttpServer()).post("/bands").set(auth(owner.accessToken)).send({ name: "  " }).expect(400);
    await request(app.getHttpServer()).get("/bands").expect(401);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/bands.e2e-spec.ts`
Expected: FAIL (404)

- [ ] **Step 3: 구현**

`apps/api/src/memberships/memberships.service.ts`:

```ts
import { ForbiddenException } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { MemberRole } from "@bandapp/types";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { bandMembers } from "../db/schema.js";

export class MembershipsService {
  constructor(private readonly db: Db) {}

  async roleOf(bandId: string, userId: string): Promise<MemberRole | null> {
    const row = await this.db.query.bandMembers.findFirst({
      where: and(eq(bandMembers.bandId, bandId), eq(bandMembers.userId, userId)),
    });
    return row?.role ?? null;
  }

  /** Band 권한은 항상 서버에서 검증한다 (기획서 9장). 멤버가 아니면 403. */
  async assertMember(bandId: string, userId: string): Promise<MemberRole> {
    const role = await this.roleOf(bandId, userId);
    if (!role) throw new ForbiddenException("이 밴드에 접근할 수 없어요.");
    return role;
  }

  async assertOwner(bandId: string, userId: string): Promise<void> {
    if ((await this.assertMember(bandId, userId)) !== "owner") {
      throw new ForbiddenException("밴드 관리자만 할 수 있어요.");
    }
  }
}

export const membershipsServiceProvider: Provider = {
  provide: MembershipsService,
  useFactory: (db: Db) => new MembershipsService(db),
  inject: [DB],
};
```

`apps/api/src/memberships/memberships.module.ts` (스텁 교체):

```ts
import { Module } from "@nestjs/common";
import { DbModule } from "../db/db.module.js";
import { membershipsServiceProvider, MembershipsService } from "./memberships.service.js";

@Module({
  imports: [DbModule],
  providers: [membershipsServiceProvider],
  exports: [MembershipsService],
})
export class MembershipsModule {}
```

`apps/api/src/bands/bands.service.ts`:

```ts
import { ConflictException } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import type { Band, BandMember } from "@bandapp/types";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { bandMembers, bands, users } from "../db/schema.js";
import { MembershipsService } from "../memberships/memberships.service.js";

export class BandsService {
  constructor(
    private readonly db: Db,
    private readonly memberships: MembershipsService,
  ) {}

  async create(userId: string, name: string): Promise<Band> {
    return this.db.transaction(async (tx) => {
      const [band] = await tx.insert(bands).values({ name }).returning();
      if (!band) throw new Error("failed to insert band");
      await tx.insert(bandMembers).values({ bandId: band.id, userId, role: "owner" });
      return { id: band.id, name: band.name, memberCount: 1 };
    });
  }

  async listForUser(userId: string): Promise<Band[]> {
    return this.db
      .select({
        id: bands.id,
        name: bands.name,
        memberCount: sql<number>`(select count(*)::int from band_members bm where bm.band_id = ${bands.id})`,
      })
      .from(bandMembers)
      .innerJoin(bands, eq(bands.id, bandMembers.bandId))
      .where(eq(bandMembers.userId, userId))
      .orderBy(bandMembers.joinedAt);
  }

  async members(bandId: string): Promise<BandMember[]> {
    const rows = await this.db
      .select({ id: users.id, name: users.displayName, role: bandMembers.role })
      .from(bandMembers)
      .innerJoin(users, eq(users.id, bandMembers.userId))
      .where(eq(bandMembers.bandId, bandId))
      .orderBy(bandMembers.joinedAt);
    return rows.map((r) => ({ id: r.id, name: r.name ?? "탈퇴한 멤버", role: r.role }));
  }

  async leave(bandId: string, userId: string): Promise<void> {
    const role = await this.memberships.assertMember(bandId, userId);
    const total = await this.countMembers(bandId);
    if (total === 1) {
      // 마지막 멤버가 나가면 밴드 삭제 — cascade로 멤버·초대 함께 삭제
      await this.db.delete(bands).where(eq(bands.id, bandId));
      return;
    }
    if (role === "owner") {
      throw new ConflictException("관리자는 먼저 소유권을 넘기거나 팀을 삭제해야 해요.");
    }
    await this.db
      .delete(bandMembers)
      .where(and(eq(bandMembers.bandId, bandId), eq(bandMembers.userId, userId)));
  }

  private async countMembers(bandId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(bandMembers)
      .where(eq(bandMembers.bandId, bandId));
    return row?.n ?? 0;
  }
}

export const bandsServiceProvider: Provider = {
  provide: BandsService,
  useFactory: (db: Db, memberships: MembershipsService) => new BandsService(db, memberships),
  inject: [DB, MembershipsService],
};
```

`apps/api/src/bands/bands.controller.ts`:

```ts
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import type { Band, BandMember } from "@bandapp/types";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUserId } from "../auth/current-user-id.decorator.js";
import { requireString, requireUuidParam } from "../common/validation.js";
import { MembershipsService } from "../memberships/memberships.service.js";
import { BandsService } from "./bands.service.js";

@Controller("bands")
@UseGuards(AuthGuard)
export class BandsController {
  constructor(
    private readonly bandsService: BandsService,
    private readonly memberships: MembershipsService,
  ) {}

  @Post()
  create(@CurrentUserId() userId: string, @Body() body: unknown): Promise<Band> {
    const name = requireString(body, "name").trim();
    if (name.length === 0 || name.length > 50) {
      throw new BadRequestException("name must be 1-50 characters");
    }
    return this.bandsService.create(userId, name);
  }

  @Get()
  list(@CurrentUserId() userId: string): Promise<Band[]> {
    return this.bandsService.listForUser(userId);
  }

  @Get(":bandId/members")
  async members(
    @CurrentUserId() userId: string,
    @Param("bandId") bandId: string,
  ): Promise<BandMember[]> {
    requireUuidParam(bandId, "bandId");
    await this.memberships.assertMember(bandId, userId);
    return this.bandsService.members(bandId);
  }

  @Delete(":bandId/members/me")
  @HttpCode(204)
  async leave(@CurrentUserId() userId: string, @Param("bandId") bandId: string): Promise<void> {
    requireUuidParam(bandId, "bandId");
    await this.bandsService.leave(bandId, userId);
  }
}
```

`apps/api/src/bands/bands.module.ts` (스텁 교체):

```ts
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { DbModule } from "../db/db.module.js";
import { MembershipsModule } from "../memberships/memberships.module.js";
import { BandsController } from "./bands.controller.js";
import { bandsServiceProvider } from "./bands.service.js";

@Module({
  imports: [DbModule, AuthModule, MembershipsModule],
  controllers: [BandsController],
  providers: [bandsServiceProvider],
})
export class BandsModule {}
```

- [ ] **Step 4: 통과 확인 + 커밋**

Run: `pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/bands.e2e-spec.ts`
Expected: PASS (7 tests)

```bash
pnpm --filter @bandapp/api lint
git add apps/api packages
git commit -m "feat(api): bands and memberships api with server-side authorization

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Invites API — 생성/조회/참가/취소

**Files:**
- Create: `apps/api/src/invites/invites.service.ts`, `apps/api/src/invites/invites.controller.ts`, `apps/api/test/invites.e2e-spec.ts`
- Modify: `apps/api/src/invites/invites.module.ts` (빈 스텁), `.env.example`

**Interfaces:**
- Consumes: `Db`/`DB`, `MembershipsService`, `AuthGuard`/`CurrentUserId`, env `INVITE_LINK_BASE_URL`, `@bandapp/types`의 `BandInvite { id, url, expiresAt }`·`InvitePreview`·`JoinInviteResult { bandId, alreadyMember }` (없으면 Task 6의 참고처럼 types에 먼저 추가)
- Produces:
  - `class InvitesService { create(bandId, userId): Promise<BandInvite>; preview(token): Promise<InvitePreview>; join(token, userId): Promise<JoinInviteResult>; revoke(bandId, inviteId, userId): Promise<void> }`
  - REST: `POST /bands/:bandId/invites`(owner, 201) / `GET /invites/:token`(공개, 200) / `POST /invites/:token/join`(Bearer, 200, idempotent) / `DELETE /bands/:bandId/invites/:inviteId`(owner, 204)

- [ ] **Step 1: 실패하는 e2e 테스트 작성**

`apps/api/test/invites.e2e-spec.ts`:

```ts
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bandInvites } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { createTestApp, loginAs, providerUser } from "./app-util.js";
import { createTestDb, truncateAll } from "./db-util.js";

describe("invites API", () => {
  const db = createTestDb();
  let app: INestApplication;
  let owner: { accessToken: string; userId: string };
  let bandId: string;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeEach(async () => {
    await truncateAll(db);
    app = await createTestApp({ google: providerUser("owner-1") });
    owner = await loginAs(app);
    const band = await request(app.getHttpServer())
      .post("/bands")
      .set(auth(owner.accessToken))
      .send({ name: "FRIDAY NIGHT" })
      .expect(201);
    bandId = band.body.id;
  });
  afterEach(() => app.close());

  async function memberLogin(subject = "member-1"): Promise<{ accessToken: string; userId: string }> {
    const other = await createTestApp({ google: providerUser(subject, "Minsoo") });
    const login = await loginAs(other);
    await other.close();
    return login;
  }

  function tokenFromUrl(url: string): string {
    return url.split("/invite/")[1]!;
  }

  async function createInvite(): Promise<{ id: string; url: string; token: string }> {
    const res = await request(app.getHttpServer())
      .post(`/bands/${bandId}/invites`)
      .set(auth(owner.accessToken))
      .expect(201);
    return { id: res.body.id, url: res.body.url, token: tokenFromUrl(res.body.url) };
  }

  it("owner는 초대를 만들고 URL은 INVITE_LINK_BASE_URL/invite/<token>", async () => {
    const invite = await createInvite();
    expect(invite.url).toMatch(/^https:\/\/invite\.test\/invite\/[A-Za-z0-9_-]{20,}$/);
    // 원문 토큰은 DB에 저장되지 않는다
    const rows = await db.query.bandInvites.findMany({ where: eq(bandInvites.bandId, bandId) });
    expect(rows[0]!.tokenHash).not.toBe(invite.token);
  });

  it("member는 초대를 만들 수 없다 (403)", async () => {
    const member = await memberLogin();
    const invite = await createInvite();
    await request(app.getHttpServer())
      .post(`/invites/${invite.token}/join`)
      .set(auth(member.accessToken))
      .expect(200);
    await request(app.getHttpServer())
      .post(`/bands/${bandId}/invites`)
      .set(auth(member.accessToken))
      .expect(403);
  });

  it("비로그인으로도 preview는 최소 정보를 준다 (기획서 12장)", async () => {
    const invite = await createInvite();
    const res = await request(app.getHttpServer()).get(`/invites/${invite.token}`).expect(200);
    expect(res.body.band).toEqual({ name: "FRIDAY NIGHT", memberCount: 1 });
    expect(res.body.invitedBy).toEqual({ displayName: "Dongjin" });
    expect(typeof res.body.expiresAt).toBe("string");
    expect(res.body.band.id).toBeUndefined();
  });

  it("join은 멤버로 추가하고, 재호출은 idempotent하게 alreadyMember=true (기획서 15장)", async () => {
    const invite = await createInvite();
    const member = await memberLogin();
    const first = await request(app.getHttpServer())
      .post(`/invites/${invite.token}/join`)
      .set(auth(member.accessToken))
      .expect(200);
    expect(first.body).toEqual({ bandId, alreadyMember: false });
    const again = await request(app.getHttpServer())
      .post(`/invites/${invite.token}/join`)
      .set(auth(member.accessToken))
      .expect(200);
    expect(again.body).toEqual({ bandId, alreadyMember: true });
    const members = await request(app.getHttpServer())
      .get(`/bands/${bandId}/members`)
      .set(auth(owner.accessToken))
      .expect(200);
    expect(members.body).toHaveLength(2);
    expect(members.body[1]).toMatchObject({ role: "member", name: "Minsoo" });
  });

  it("만료/취소/미존재 초대는 404", async () => {
    await request(app.getHttpServer()).get("/invites/does-not-exist-token-x").expect(404);
    const invite = await createInvite();
    await db
      .update(bandInvites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(bandInvites.id, invite.id));
    await request(app.getHttpServer()).get(`/invites/${invite.token}`).expect(404);
    const revoked = await createInvite();
    await request(app.getHttpServer())
      .delete(`/bands/${bandId}/invites/${revoked.id}`)
      .set(auth(owner.accessToken))
      .expect(204);
    await request(app.getHttpServer()).get(`/invites/${revoked.token}`).expect(404);
  });

  it("비로그인 join은 401", async () => {
    const invite = await createInvite();
    await request(app.getHttpServer()).post(`/invites/${invite.token}/join`).expect(401);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/invites.e2e-spec.ts`
Expected: FAIL (404)

- [ ] **Step 3: 구현**

`apps/api/src/invites/invites.service.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import type { BandInvite, InvitePreview, JoinInviteResult } from "@bandapp/types";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { bandInvites, bandMembers, bands, users } from "../db/schema.js";
import { MembershipsService } from "../memberships/memberships.service.js";

// MVP 정책 (기획서 11장): 링크 방식, 7일, MEMBER, owner 생성
const INVITE_TTL_DAYS = 7;

export class InvitesService {
  constructor(
    private readonly db: Db,
    private readonly memberships: MembershipsService,
  ) {}

  async create(bandId: string, userId: string): Promise<BandInvite> {
    await this.memberships.assertOwner(bandId, userId);
    const token = randomBytes(24).toString("base64url"); // 32자 — 충분히 긴 random token
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
    const [row] = await this.db
      .insert(bandInvites)
      .values({ bandId, tokenHash: this.hash(token), createdBy: userId, expiresAt })
      .returning();
    if (!row) throw new Error("failed to insert invite");
    return { id: row.id, url: this.inviteUrl(token), expiresAt: expiresAt.toISOString() };
  }

  async preview(token: string): Promise<InvitePreview> {
    const invite = await this.findValid(token);
    const band = await this.db.query.bands.findFirst({ where: eq(bands.id, invite.bandId) });
    if (!band) throw new NotFoundException("초대장을 찾을 수 없어요.");
    const creator = await this.db.query.users.findFirst({ where: eq(users.id, invite.createdBy) });
    const [count] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(bandMembers)
      .where(eq(bandMembers.bandId, invite.bandId));
    return {
      band: { name: band.name, memberCount: count?.n ?? 0 },
      invitedBy: { displayName: creator?.displayName ?? null },
      expiresAt: invite.expiresAt.toISOString(),
    };
  }

  /** idempotent — 이미 멤버면 오류 대신 alreadyMember=true (기획서 15장). */
  async join(token: string, userId: string): Promise<JoinInviteResult> {
    const invite = await this.findValid(token);
    const existing = await this.db.query.bandMembers.findFirst({
      where: and(eq(bandMembers.bandId, invite.bandId), eq(bandMembers.userId, userId)),
    });
    if (existing) return { bandId: invite.bandId, alreadyMember: true };
    await this.db.transaction(async (tx) => {
      await tx.insert(bandMembers).values({ bandId: invite.bandId, userId, role: "member" });
      await tx
        .update(bandInvites)
        .set({ usedCount: sql`${bandInvites.usedCount} + 1` })
        .where(eq(bandInvites.id, invite.id));
    });
    return { bandId: invite.bandId, alreadyMember: false };
  }

  async revoke(bandId: string, inviteId: string, userId: string): Promise<void> {
    await this.memberships.assertOwner(bandId, userId);
    const [row] = await this.db
      .update(bandInvites)
      .set({ revokedAt: new Date() })
      .where(and(eq(bandInvites.id, inviteId), eq(bandInvites.bandId, bandId)))
      .returning();
    if (!row) throw new NotFoundException("초대장을 찾을 수 없어요.");
  }

  private hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private inviteUrl(token: string): string {
    const base = process.env.INVITE_LINK_BASE_URL;
    if (!base) throw new Error("INVITE_LINK_BASE_URL is not set");
    return `${base.replace(/\/+$/, "")}/invite/${token}`;
  }

  /** 미존재/만료/취소/소진을 구분하지 않고 404 — 토큰 존재 여부를 노출하지 않는다. */
  private async findValid(token: string): Promise<typeof bandInvites.$inferSelect> {
    const invite = await this.db.query.bandInvites.findFirst({
      where: eq(bandInvites.tokenHash, this.hash(token)),
    });
    const valid =
      invite &&
      !invite.revokedAt &&
      invite.expiresAt > new Date() &&
      (invite.maxUses === null || invite.usedCount < invite.maxUses);
    if (!valid) throw new NotFoundException("초대장을 찾을 수 없어요. 링크가 만료됐을 수 있어요.");
    return invite;
  }
}

export const invitesServiceProvider: Provider = {
  provide: InvitesService,
  useFactory: (db: Db, memberships: MembershipsService) => new InvitesService(db, memberships),
  inject: [DB, MembershipsService],
};
```

`apps/api/src/invites/invites.controller.ts`:

```ts
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import type { BandInvite, InvitePreview, JoinInviteResult } from "@bandapp/types";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUserId } from "../auth/current-user-id.decorator.js";
import { requireUuidParam } from "../common/validation.js";
import { InvitesService } from "./invites.service.js";

const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

function requireInviteToken(token: string): string {
  // 형식이 아예 다르면 조회 없이 404 (유효 토큰과 같은 응답)
  if (!INVITE_TOKEN_RE.test(token)) throw new NotFoundException("초대장을 찾을 수 없어요.");
  return token;
}

@Controller()
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

  @Post("bands/:bandId/invites")
  @UseGuards(AuthGuard)
  create(@CurrentUserId() userId: string, @Param("bandId") bandId: string): Promise<BandInvite> {
    return this.invites.create(requireUuidParam(bandId, "bandId"), userId);
  }

  /** 비로그인에도 최소 정보만 공개 (기획서 12장) */
  @Get("invites/:token")
  preview(@Param("token") token: string): Promise<InvitePreview> {
    return this.invites.preview(requireInviteToken(token));
  }

  @Post("invites/:token/join")
  @HttpCode(200)
  @UseGuards(AuthGuard)
  join(@CurrentUserId() userId: string, @Param("token") token: string): Promise<JoinInviteResult> {
    return this.invites.join(requireInviteToken(token), userId);
  }

  @Delete("bands/:bandId/invites/:inviteId")
  @HttpCode(204)
  @UseGuards(AuthGuard)
  revoke(
    @CurrentUserId() userId: string,
    @Param("bandId") bandId: string,
    @Param("inviteId") inviteId: string,
  ): Promise<void> {
    return this.invites.revoke(
      requireUuidParam(bandId, "bandId"),
      requireUuidParam(inviteId, "inviteId"),
      userId,
    );
  }
}
```

`apps/api/src/invites/invites.module.ts` (스텁 교체):

```ts
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { DbModule } from "../db/db.module.js";
import { MembershipsModule } from "../memberships/memberships.module.js";
import { InvitesController } from "./invites.controller.js";
import { invitesServiceProvider } from "./invites.service.js";

@Module({
  imports: [DbModule, AuthModule, MembershipsModule],
  controllers: [InvitesController],
  providers: [invitesServiceProvider],
})
export class InvitesModule {}
```

`.env.example`에 추가:

```
INVITE_LINK_BASE_URL=https://app.example.com
```

- [ ] **Step 4: 통과 확인 + 커밋**

Run: `pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/invites.e2e-spec.ts`
Expected: PASS (6 tests)

```bash
pnpm --filter @bandapp/api lint
git add apps/api .env.example
git commit -m "feat(api): band invite create/preview/join/revoke

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: 회원 탈퇴 — DELETE /me

**Files:**
- Create: `apps/api/test/delete-me.e2e-spec.ts`
- Modify: `apps/api/src/users/users.service.ts`, `apps/api/src/auth/me.controller.ts`

**Interfaces:**
- Consumes: Task 4·5·7·8의 산출물
- Produces: `UsersService.deleteAccount(userId: string): Promise<void>`, REST `DELETE /me`(Bearer) → 204, 유일 owner + 타 멤버 존재 시 409

- [ ] **Step 1: 실패하는 e2e 테스트 작성**

`apps/api/test/delete-me.e2e-spec.ts`:

```ts
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bandMembers, bands, userIdentities, users } from "../src/db/schema.js";
import { createTestApp, loginAs, providerUser } from "./app-util.js";
import { createTestDb, truncateAll } from "./db-util.js";

describe("DELETE /me", () => {
  const db = createTestDb();
  let app: INestApplication;
  let me: { accessToken: string; refreshToken: string; userId: string };

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeEach(async () => {
    await truncateAll(db);
    app = await createTestApp({ google: providerUser("g-1") });
    me = await loginAs(app);
  });
  afterEach(() => app.close());

  it("탈퇴하면 세션 revoke + identity 삭제 + user 비식별화", async () => {
    await request(app.getHttpServer()).delete("/me").set(auth(me.accessToken)).expect(204);
    // 모든 로그인 세션 무효화 (완료 조건 10)
    await request(app.getHttpServer()).post("/auth/refresh").send({ refreshToken: me.refreshToken }).expect(401);
    // 잔여 access token으로도 /me는 401
    await request(app.getHttpServer()).get("/me").set(auth(me.accessToken)).expect(401);
    const identities = await db.query.userIdentities.findMany({
      where: eq(userIdentities.userId, me.userId),
    });
    expect(identities).toHaveLength(0);
    const row = await db.query.users.findFirst({ where: eq(users.id, me.userId) });
    expect(row?.deletedAt).toBeTruthy();
    expect(row?.displayName).toBeNull();
  });

  it("member로 속한 밴드에서는 자동 탈퇴된다", async () => {
    const [band] = await db.insert(bands).values({ name: "OTHERS" }).returning();
    const [other] = await db.insert(users).values({ displayName: "Owner" }).returning();
    await db.insert(bandMembers).values([
      { bandId: band!.id, userId: other!.id, role: "owner" },
      { bandId: band!.id, userId: me.userId, role: "member" },
    ]);
    await request(app.getHttpServer()).delete("/me").set(auth(me.accessToken)).expect(204);
    const remaining = await db.query.bandMembers.findMany({ where: eq(bandMembers.bandId, band!.id) });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.userId).toBe(other!.id);
  });

  it("혼자인 밴드는 함께 삭제된다", async () => {
    await request(app.getHttpServer()).post("/bands").set(auth(me.accessToken)).send({ name: "SOLO" }).expect(201);
    await request(app.getHttpServer()).delete("/me").set(auth(me.accessToken)).expect(204);
    expect(await db.query.bands.findMany()).toHaveLength(0);
  });

  it("다른 멤버가 있는 밴드의 유일 owner면 409 — 선행 처리 필요 (기획서 18장)", async () => {
    const res = await request(app.getHttpServer()).post("/bands").set(auth(me.accessToken)).send({ name: "FRIDAY NIGHT" }).expect(201);
    const [other] = await db.insert(users).values({ displayName: "Minsoo" }).returning();
    await db.insert(bandMembers).values({ bandId: res.body.id, userId: other!.id, role: "member" });
    await request(app.getHttpServer()).delete("/me").set(auth(me.accessToken)).expect(409);
    // 아무것도 지워지지 않았어야 한다
    await request(app.getHttpServer()).get("/me").set(auth(me.accessToken)).expect(200);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/delete-me.e2e-spec.ts`
Expected: FAIL (404 — DELETE /me 없음)

- [ ] **Step 3: 구현**

`users.service.ts`에 추가 (import에 `ConflictException`(@nestjs/common), `and`·`isNull`·`sql`(drizzle-orm), `authSessions`·`bandMembers`·`bands` 스키마 추가):

```ts
  /**
   * 회원 탈퇴 (기획서 18장, 스펙 결정 9):
   * - 다른 멤버가 있는 밴드의 유일한 owner면 409 (전체 롤백)
   * - 혼자인 밴드는 삭제, member인 밴드는 탈퇴
   * - 모든 세션 revoke, identity 삭제, user 비식별화(soft delete)
   */
  async deleteAccount(userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const memberships = await tx.query.bandMembers.findMany({
        where: eq(bandMembers.userId, userId),
      });
      for (const membership of memberships) {
        const [count] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(bandMembers)
          .where(eq(bandMembers.bandId, membership.bandId));
        if ((count?.n ?? 0) === 1) {
          await tx.delete(bands).where(eq(bands.id, membership.bandId));
          continue;
        }
        if (membership.role === "owner") {
          const owners = await tx.query.bandMembers.findMany({
            where: and(eq(bandMembers.bandId, membership.bandId), eq(bandMembers.role, "owner")),
          });
          if (owners.every((o) => o.userId === userId)) {
            throw new ConflictException(
              "관리자로 있는 팀이 있어요. 먼저 소유권을 넘기거나 팀을 삭제해 주세요.",
            );
          }
        }
        await tx
          .delete(bandMembers)
          .where(and(eq(bandMembers.bandId, membership.bandId), eq(bandMembers.userId, userId)));
      }
      await tx
        .update(authSessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)));
      await tx.delete(userIdentities).where(eq(userIdentities.userId, userId));
      await tx
        .update(users)
        .set({ displayName: null, profileImageUrl: null, deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(users.id, userId));
    });
  }
```

`me.controller.ts`에 추가 (import에 `Delete`, `HttpCode` 추가):

```ts
  @Delete()
  @HttpCode(204)
  async deleteMe(@CurrentUserId() userId: string): Promise<void> {
    await this.users.deleteAccount(userId);
  }
```

- [ ] **Step 4: 전체 통과 확인 + 커밋**

Run: `pnpm --filter @bandapp/api test`
Expected: 단위 + e2e 전부 PASS

```bash
pnpm --filter @bandapp/api lint
git add apps/api
git commit -m "feat(api): account deletion with session revocation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 완료 검증 (서버 범위)

기획서 26장 완료 조건 중 서버로 검증 가능한 항목이 e2e로 커버됐는지 최종 확인:

- 1·2 (Google/Apple 자동 가입) → `auth.e2e-spec.ts`
- 4 (로그아웃 시 refresh revoke) → `auth.e2e-spec.ts`
- 5 (한 User 여러 Band) → `bands.e2e-spec.ts`
- 6 (Band 변경에 토큰 재발급 불필요) → 구조적으로 보장 (JWT payload에 band 없음)
- 8 (재참가 idempotent) → `invites.e2e-spec.ts`
- 9 (비멤버 API 접근 차단) → `bands.e2e-spec.ts`
- 10 (탈퇴 시 전 세션 무효화) → `delete-me.e2e-spec.ts`

남은 3·7 (모바일 세션 복원, 딥링크 왕복)은 모바일 플랜에서.
