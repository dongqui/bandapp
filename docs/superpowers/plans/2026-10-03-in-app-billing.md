# 인앱 결제 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 오너가 스토어 구독으로 "시간 풀"을 만들고 자기 밴드들을 연결해 분석 시간을 공유하며, 무료 밴드는 3h를 평생 1회 쓰고, 워커가 분석 전에 시간을 예약·차감하는 결제 기능을 만든다.

**Architecture:** 서버가 유일한 판단 기준이다. `billing_pools`(오너당 1행)·`bands.pool_id`·`bands.free_used_sec`·`bands.extra_sec`가 상태이고, `analysis_charges`(세션당 1행)가 차감 원장이다. 순수 함수 모듈 `billing/allowance.ts`가 차감 순서를 계산하고, `BillingChargeService`가 트랜잭션 안에서 예약→확정/환불을 한다. 워커는 ffprobe 직후 게이트를 통과해야 Gemini를 부른다. RevenueCat 상태는 웹훅과 `/billing/sync` 둘 다 같은 `BillingSyncService.syncUser()`로 반영해 순서에 의존하지 않는다. 앱은 `react-native-purchases`로 구매하고 결과를 서버 sync로 확정한다.

**Tech Stack:** NestJS 12 + drizzle-orm 0.45 (Postgres), vitest 4 (단위 + 실 Postgres e2e, supertest), `@bandapp/types`·`@bandapp/api-client`(dist 소비, Http/Mock 두 구현), Expo SDK 57 / RN 0.86 / expo-router, react-native-purchases (RevenueCat), i18next.

**Spec:** [docs/superpowers/specs/2026-10-03-in-app-billing-design.md](../specs/2026-10-03-in-app-billing-design.md)

## Global Constraints

- 코드 주석은 한국어, 커밋 제목은 영어 conventional commit. 커밋 트레일러 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` 필수.
- `@bandapp/types`·`@bandapp/api-client`는 `dist`로 소비된다 — 바꾸면 `pnpm --filter @bandapp/types build` / `pnpm --filter @bandapp/api-client build` 후에야 다른 패키지의 typecheck가 맞는다.
- 타입 확인: `pnpm --filter mobile typecheck` + `pnpm --filter @bandapp/api build`. spec 파일은 tsconfig에서 제외돼 타입 오류를 못 잡는다 — spec 코드는 그대로 옮겨 적는다.
- `pnpm --filter @bandapp/api lint`(oxlint). `new Array(n)` 금지. `Array.from<number>(...)` 제네릭 금지.
- 플랜표(`PLANS`)는 서버 `billing/plans.ts` 한 곳이다: `free` 3h 평생 1회(초기화 없음), `band` 월 20h, `plus` 월 40h, `extra` 밴드에 3h 추가. 가격은 코드에 없다 — 앱이 스토어에서 받는다.
- 차감 순서: 연결+풀 활성/grace → 풀 월 시간 → 밴드 추가 시간. 연결+풀 만료 또는 미연결 → 밴드 무료 잔여 → 밴드 추가 시간. 전부 분석하거나 아예 안 한다.
- 구독은 밴드 오너만, 추가 시간은 활성 풀에 연결된 밴드의 멤버 누구나. 오너 양도 시 `pool_id = null`. 추가 시간은 밴드 것이라 어떤 경우에도 밴드에 남는다.
- 환경변수는 쓰는 시점에 `process.env`로 lazy하게 읽는다 (기존 패턴). 서버: `REVENUECAT_WEBHOOK_SECRET`, `REVENUECAT_API_KEY`. 모바일: `EXPO_PUBLIC_RC_IOS_KEY`, `EXPO_PUBLIC_RC_ANDROID_KEY`.
- e2e는 로컬 Postgres(docker compose `postgres`)가 떠 있어야 한다. 마이그레이션은 `pnpm --filter @bandapp/api db:migrate`로 테스트 DB에 먼저 적용한다. `test/db-util.ts`의 TRUNCATE 목록에 새 테이블을 넣는다.
- 모바일 i18n은 `en.ts`·`ko.ts` 둘 다 같은 키를 가져야 한다 (`resources.test.ts`가 검사). 보간 변수명에 `count`를 쓰지 않는다.
- 모바일 화면 검증은 Browser pane 웹 Mock 프리뷰(`preview_start({name:"mobile-web-mock"})`)로 한다. 실제 구매는 iOS Sandbox / Google 라이선스 테스터 기기에서만 된다 (Task 17 체크리스트).
- 화면 문구·분기는 Claude Design 프로토타입(B01, B01a, B02~B06)이 명세다. 디자인은 영어 문구이고 `ko.ts`는 같은 뜻의 한국어로 쓴다.

## Review Focus

1. 같은 세션의 SQS 중복 전달이 동시에 게이트에 들어오면 `analysis_charges.session_id` unique로 두 번째 insert가 실패해야 하고, 그 실패가 세션을 `failed`로 만들면 안 된다 — Task 4 `StaleSessionError` 취급 테스트.
2. 예약 중인 세션이 있는 상태에서 갱신(새 기간)이 오면 `used_sec = 0`이 되고, 그 뒤 확정되는 예약은 새 기간의 `used_sec`에 더해진다 — Task 4 확정 테스트, Task 6 갱신 테스트.
3. 오너가 풀을 가진 채 밴드를 삭제(soft delete)하면 `myPool.bands`와 `linkedBandCount`에서 빠져야 한다 — Task 5 billing 조회 테스트.
4. 소모성 거래가 `bandId` 없이 웹훅으로만 오고 `subscriber_attributes.band_id`도 없으면 `extra_purchases.band_id = null`로 남고, 나중에 sync(bandId)가 배정한다 — Task 6 테스트.
5. 비멤버가 `/billing/sync`에 남의 `bandId`를 넣어도 그 밴드에 추가 시간이 들어가면 안 된다 — Task 6 e2e.

---

### Task 1: 스키마·마이그레이션 — 풀, 원장, 밴드 컬럼, `waiting_for_time`

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Modify: `packages/types/src/session.ts` (`SessionStatus`)
- Create: `apps/api/drizzle/0010_billing.sql` (+ `meta/0010_snapshot.json`, `_journal.json` — drizzle-kit이 만든다)
- Modify: `apps/api/test/db-util.ts`

**Interfaces:**
- Produces: drizzle 테이블 `billingPools`, `analysisCharges`, `billingEvents`, `extraPurchases`; `bands.poolId`, `bands.freeUsedSec`, `bands.extraSec`; enum `poolPlan("band"|"plus")`, `poolStatus("active"|"grace"|"expired")`, `chargeState("reserved"|"charged"|"refunded")`, `sessionStatus`에 `"waiting_for_time"` 추가.

- [ ] **Step 1: `SessionStatus`에 `waiting_for_time` 추가**

`packages/types/src/session.ts`:

```ts
export type SessionStatus = "uploading" | "analyzing" | "waiting_for_time" | "failed" | "ready";
```

`pnpm --filter @bandapp/types build` 실행.

- [ ] **Step 2: 스키마 추가**

`apps/api/src/db/schema.ts`의 `sessionStatus`를 바꾸고, `bands` 아래에 테이블을 추가한다.

```ts
export const sessionStatus = pgEnum("session_status", ["uploading", "analyzing", "waiting_for_time", "failed", "ready"]);
// 결제 (2026-10-03 스펙)
export const poolPlan = pgEnum("pool_plan", ["band", "plus"]);
export const poolStatus = pgEnum("pool_status", ["active", "grace", "expired"]);
export const chargeState = pgEnum("charge_state", ["reserved", "charged", "refunded"]);
export const billingStore = pgEnum("billing_store", ["app_store", "play_store"]);
```

`bands` 테이블은 `billingPools`를 참조하므로 `billingPools`를 `bands`보다 **앞에** 둔다.

```ts
// 구독자(오너) 1명당 1행. 월 시간은 used_sec + 예약 합계로 계산하므로 남은 시간 컬럼은 없다.
export const billingPools = pgTable("billing_pools", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  plan: poolPlan("plan"),
  status: poolStatus("status").notNull().default("expired"),
  store: billingStore("store"),
  periodStart: timestamp("period_start", { withTimezone: true }),
  periodEnd: timestamp("period_end", { withTimezone: true }),
  willRenew: boolean("will_renew").notNull().default(false),
  // 이번 기간에 확정(charged)된 월 시간 사용량. 갱신(period_start 변경)마다 0
  usedSec: integer("used_sec").notNull().default(0),
  ...timestamps,
});

export const bands = pgTable("bands", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  // 연결된 풀. 오너 양도·연결 해제 시 null. 풀이 지워지면 null
  poolId: uuid("pool_id").references(() => billingPools.id, { onDelete: "set null" }),
  // 밴드당 무료 3h는 평생 1회 — 초기화하지 않는다
  freeUsedSec: integer("free_used_sec").notNull().default(0),
  // 밴드가 산 추가 시간 잔여. 연결 해제·만료·양도 뒤에도 밴드에 남는다
  extraSec: integer("extra_sec").notNull().default(0),
  ...timestamps,
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});
```

`sessions` 아래에:

```ts
// 분석 차감 원장. 세션당 1행이라 재시도·중복 전달이 이중 차감되지 않는다
export const analysisCharges = pgTable("analysis_charges", {
  sessionId: uuid("session_id")
    .primaryKey()
    .references(() => sessions.id, { onDelete: "cascade" }),
  bandId: uuid("band_id")
    .notNull()
    .references(() => bands.id, { onDelete: "cascade" }),
  poolId: uuid("pool_id").references(() => billingPools.id, { onDelete: "set null" }),
  freeSec: integer("free_sec").notNull().default(0),
  monthlySec: integer("monthly_sec").notNull().default(0),
  extraSec: integer("extra_sec").notNull().default(0),
  state: chargeState("state").notNull(),
  ...timestamps,
});

// RevenueCat 웹훅 원본. id 충돌 = 중복 전달
export const billingEvents = pgTable("billing_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  appUserId: text("app_user_id").notNull(),
  payload: jsonb("payload").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

// 소모성(추가 시간) 거래 원장. 같은 거래가 웹훅·sync 양쪽에서 와도 applied_at으로 한 번만 반영
export const extraPurchases = pgTable("extra_purchases", {
  transactionId: text("transaction_id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  bandId: uuid("band_id").references(() => bands.id, { onDelete: "set null" }),
  sec: integer("sec").notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

import에 `jsonb` 추가.

- [ ] **Step 3: 마이그레이션 생성**

```bash
pnpm --filter @bandapp/api db:generate
```

생성된 `apps/api/drizzle/0010_*.sql`에 enum ALTER TYPE ADD VALUE(`waiting_for_time`), 새 enum 4개, 테이블 4개(billing_pools, analysis_charges, billing_events, extra_purchases), `bands` 컬럼 3개가 있는지 눈으로 확인한다. Postgres는 `ALTER TYPE ... ADD VALUE`를 트랜잭션 안에서 못 쓰는 경우가 있다 — drizzle-kit이 `--> statement-breakpoint`로 나눈다.

- [ ] **Step 4: 테스트 DB에 적용하고 TRUNCATE 목록 갱신**

```bash
pnpm --filter @bandapp/api db:migrate
```

`apps/api/test/db-util.ts`:

```ts
await db.execute(
  sql`TRUNCATE analysis_charges, extra_purchases, billing_events, comments, takes, recordings, sessions, band_invites, band_members, bands, billing_pools, auth_sessions, user_identities, users CASCADE`,
);
```

- [ ] **Step 5: 빌드·기존 테스트 통과 확인**

```bash
pnpm --filter @bandapp/api build
pnpm --filter @bandapp/api test
```

Expected: 모두 PASS (스키마만 늘었다).

- [ ] **Step 6: Commit**

```bash
git add packages/types/src/session.ts apps/api/src/db/schema.ts apps/api/drizzle apps/api/test/db-util.ts
git commit -m "feat(api): billing schema — pools, charges, events, extra purchases, waiting_for_time"
```

---

### Task 2: 플랜표와 시간 계산 순수 함수

**Files:**
- Create: `apps/api/src/billing/plans.ts`
- Create: `apps/api/src/billing/allowance.ts`
- Test: `apps/api/src/billing/allowance.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  // plans.ts
  export const FREE_SEC = 3 * 3600;
  export const EXTRA_SEC = 3 * 3600;
  export const PLANS = { band: { monthlySec: 20 * 3600 }, plus: { monthlySec: 40 * 3600 } } as const;
  export type PoolPlan = keyof typeof PLANS;
  export const SUBSCRIPTION_PRODUCTS: Record<string, PoolPlan>; // 스토어 상품 ID → 플랜
  export const EXTRA_PRODUCT_IDS: readonly string[];
  // allowance.ts
  export type PoolState = "active" | "grace" | "expired";
  export interface AllowanceInput {
    pool: { plan: PoolPlan | null; status: PoolState; usedSec: number; reservedSec: number } | null; // 밴드가 연결된 풀, 없으면 null
    band: { freeUsedSec: number; extraSec: number };
  }
  export interface Allowance { source: "pool" | "free"; monthlyLeftSec: number; freeLeftSec: number; extraSec: number; availableSec: number }
  export function allowance(input: AllowanceInput): Allowance;
  export interface Split { freeSec: number; monthlySec: number; extraSec: number }
  export function splitCharge(a: Allowance, needSec: number): Split | null; // null = 부족
  ```

- [ ] **Step 1: 테스트 작성**

`apps/api/src/billing/allowance.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { allowance, splitCharge } from "./allowance.js";

const H = 3600;

describe("allowance", () => {
  it("미연결 밴드는 무료 잔여 + 밴드 추가 시간", () => {
    const a = allowance({ pool: null, band: { freeUsedSec: H, extraSec: 2 * H } });
    expect(a).toEqual({ source: "free", monthlyLeftSec: 0, freeLeftSec: 2 * H, extraSec: 2 * H, availableSec: 4 * H });
  });

  it("활성 풀에 연결되면 무료는 쓰지 않고 월 시간 - used - reserved + 추가 시간", () => {
    const a = allowance({
      pool: { plan: "band", status: "active", usedSec: 5 * H, reservedSec: 2 * H },
      band: { freeUsedSec: 0, extraSec: H },
    });
    expect(a).toEqual({ source: "pool", monthlyLeftSec: 13 * H, freeLeftSec: 3 * H, extraSec: H, availableSec: 14 * H });
  });

  it("grace도 활성처럼 취급한다", () => {
    const a = allowance({ pool: { plan: "plus", status: "grace", usedSec: 0, reservedSec: 0 }, band: { freeUsedSec: 0, extraSec: 0 } });
    expect(a.source).toBe("pool");
    expect(a.monthlyLeftSec).toBe(40 * H);
  });

  it("만료된 풀에 연결된 밴드는 무료 잔여 + 추가 시간으로 돌아간다", () => {
    const a = allowance({ pool: { plan: "band", status: "expired", usedSec: 20 * H, reservedSec: 0 }, band: { freeUsedSec: 3 * H, extraSec: H } });
    expect(a).toEqual({ source: "free", monthlyLeftSec: 0, freeLeftSec: 0, extraSec: H, availableSec: H });
  });

  it("월 시간은 음수가 되지 않는다", () => {
    const a = allowance({ pool: { plan: "band", status: "active", usedSec: 19 * H, reservedSec: 2 * H }, band: { freeUsedSec: 0, extraSec: 0 } });
    expect(a.monthlyLeftSec).toBe(0);
  });
});

describe("splitCharge", () => {
  it("월 시간 → 추가 시간 순으로 나눈다", () => {
    const a = allowance({ pool: { plan: "band", status: "active", usedSec: 19 * H, reservedSec: 0 }, band: { freeUsedSec: 0, extraSec: 3 * H } });
    expect(splitCharge(a, 2 * H)).toEqual({ freeSec: 0, monthlySec: H, extraSec: H });
  });

  it("무료 → 추가 시간 순으로 나눈다", () => {
    const a = allowance({ pool: null, band: { freeUsedSec: 2 * H, extraSec: 3 * H } });
    expect(splitCharge(a, 2 * H)).toEqual({ freeSec: H, monthlySec: 0, extraSec: H });
  });

  it("부족하면 null — 부분 분석은 없다", () => {
    const a = allowance({ pool: null, band: { freeUsedSec: 0, extraSec: 0 } });
    expect(splitCharge(a, 3 * H + 1)).toBeNull();
    expect(splitCharge(a, 3 * H)).toEqual({ freeSec: 3 * H, monthlySec: 0, extraSec: 0 });
  });
});
```

- [ ] **Step 2: 실패 확인**

```bash
pnpm --filter @bandapp/api exec vitest run src/billing/allowance.spec.ts
```

Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현**

`apps/api/src/billing/plans.ts`:

```ts
/**
 * 플랜표 — 결제의 유일한 기준 (2026-10-03 스펙). 가격은 앱이 스토어에서 받는다.
 * 플랜을 늘리려면 여기와 스토어 콘솔(같은 구독 그룹)만 바꾼다.
 */
export const FREE_SEC = 3 * 3600;
export const EXTRA_SEC = 3 * 3600;
export const PLANS = {
  band: { monthlySec: 20 * 3600 },
  plus: { monthlySec: 40 * 3600 },
} as const;
export type PoolPlan = keyof typeof PLANS;

/** 스토어 상품 ID → 플랜. iOS·Android 모두 같은 ID를 쓴다 */
export const SUBSCRIPTION_PRODUCTS: Record<string, PoolPlan> = {
  "rehearsal.band.monthly": "band",
  "rehearsal.plus.monthly": "plus",
};
export const EXTRA_PRODUCT_IDS: readonly string[] = ["rehearsal.extra.3h"];
```

`apps/api/src/billing/allowance.ts`:

```ts
import { FREE_SEC, PLANS, type PoolPlan } from "./plans.js";

export type PoolState = "active" | "grace" | "expired";

export interface AllowanceInput {
  /** 밴드가 연결된 풀. 미연결이면 null. reservedSec는 이 풀의 reserved 차감 합 */
  pool: { plan: PoolPlan | null; status: PoolState; usedSec: number; reservedSec: number } | null;
  band: { freeUsedSec: number; extraSec: number };
}

export interface Allowance {
  /** pool = 풀 월 시간을 쓴다, free = 밴드 무료 잔여를 쓴다 */
  source: "pool" | "free";
  monthlyLeftSec: number;
  freeLeftSec: number;
  extraSec: number;
  availableSec: number;
}

/** 차감 순서 규칙 (스펙 "사용 가능 시간 규칙"). 추가 시간은 밴드 것이라 어느 경우에도 마지막에 쓴다 */
export function allowance({ pool, band }: AllowanceInput): Allowance {
  const freeLeftSec = Math.max(0, FREE_SEC - band.freeUsedSec);
  const extraSec = Math.max(0, band.extraSec);
  const poolActive = pool !== null && pool.plan !== null && pool.status !== "expired";
  if (poolActive) {
    const monthlyLeftSec = Math.max(0, PLANS[pool.plan!].monthlySec - pool.usedSec - pool.reservedSec);
    return { source: "pool", monthlyLeftSec, freeLeftSec, extraSec, availableSec: monthlyLeftSec + extraSec };
  }
  return { source: "free", monthlyLeftSec: 0, freeLeftSec, extraSec, availableSec: freeLeftSec + extraSec };
}

export interface Split {
  freeSec: number;
  monthlySec: number;
  extraSec: number;
}

/** 전부 분석하거나 아예 안 한다 — 부족하면 null */
export function splitCharge(a: Allowance, needSec: number): Split | null {
  if (needSec > a.availableSec) return null;
  const primary = a.source === "pool" ? a.monthlyLeftSec : a.freeLeftSec;
  const fromPrimary = Math.min(primary, needSec);
  const fromExtra = needSec - fromPrimary;
  return a.source === "pool"
    ? { freeSec: 0, monthlySec: fromPrimary, extraSec: fromExtra }
    : { freeSec: fromPrimary, monthlySec: 0, extraSec: fromExtra };
}
```

- [ ] **Step 4: 통과 확인**

```bash
pnpm --filter @bandapp/api exec vitest run src/billing/allowance.spec.ts
```

Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/billing
git commit -m "feat(api): billing plan table and allowance calculation"
```

---

### Task 3: `BillingChargeService` — 예약·확정·환불 (DB)

**Files:**
- Create: `apps/api/src/billing/billing-charge.service.ts`
- Create: `apps/api/src/billing/billing.module.ts`
- Test: `apps/api/test/billing-charge.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 2 `allowance`, `splitCharge`.
- Produces:
  ```ts
  export type ReserveResult = { ok: true; alreadyCharged: boolean } | { ok: false; availableSec: number };
  export class BillingChargeService {
    constructor(db: Db) {}
    /** 세션의 밴드·풀을 잠그고 needSec만큼 예약. 이미 charged면 ok+alreadyCharged, 이미 reserved면 ok */
    reserve(sessionId: string, bandId: string, needSec: number): Promise<ReserveResult>;
    /** reserved → charged. 월 시간분을 pool.used_sec에 더한다 */
    commit(sessionId: string): Promise<void>;
    /** reserved → refunded. 무료·추가 시간을 되돌린다 (월 시간은 예약 합계에서 빠질 뿐) */
    refund(sessionId: string): Promise<void>;
    /** 밴드 기준 현재 Allowance (조회 API가 쓴다). 풀 reserved 합계 포함 */
    allowanceOf(bandId: string, tx?: Db): Promise<Allowance>;
    /** 풀의 reserved 월 시간 합 (Task 5의 myPool 계산이 쓴다) */
    reservedSecOf(poolId: string): Promise<number>;
  }
  export const billingChargeServiceProvider: Provider;
  ```

- [ ] **Step 1: e2e 테스트 작성**

`apps/api/test/billing-charge.e2e-spec.ts`:

```ts
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { BillingChargeService } from "../src/billing/billing-charge.service.js";
import { analysisCharges, bands, billingPools, recordings, sessions, users } from "../src/db/schema.js";
import { createTestDb, truncateAll } from "./db-util.js";

const H = 3600;

describe("BillingChargeService", () => {
  const db = createTestDb();
  const svc = new BillingChargeService(db);
  let userId: string;
  let bandId: string;

  async function makeSession(): Promise<string> {
    const [s] = await db
      .insert(sessions)
      .values({ bandId, createdBy: userId, title: "T", status: "analyzing", startedAt: new Date() })
      .returning({ id: sessions.id });
    return s!.id;
  }

  async function makePool(overrides: Partial<typeof billingPools.$inferInsert> = {}): Promise<string> {
    const [p] = await db
      .insert(billingPools)
      .values({ ownerUserId: userId, plan: "band", status: "active", usedSec: 0, ...overrides })
      .returning({ id: billingPools.id });
    await db.update(bands).set({ poolId: p!.id }).where(eq(bands.id, bandId));
    return p!.id;
  }

  beforeEach(async () => {
    await truncateAll(db);
    const [u] = await db.insert(users).values({ displayName: "O" }).returning({ id: users.id });
    userId = u!.id;
    const [b] = await db.insert(bands).values({ name: "B" }).returning({ id: bands.id });
    bandId = b!.id;
  });

  it("미연결 밴드: 무료 3h 안이면 예약되고 free_used_sec이 바로 오른다", async () => {
    const sid = await makeSession();
    expect(await svc.reserve(sid, bandId, 2 * H)).toEqual({ ok: true, alreadyCharged: false });
    const [band] = await db.select().from(bands).where(eq(bands.id, bandId));
    expect(band!.freeUsedSec).toBe(2 * H);
    const [c] = await db.select().from(analysisCharges).where(eq(analysisCharges.sessionId, sid));
    expect(c).toMatchObject({ state: "reserved", freeSec: 2 * H, monthlySec: 0, extraSec: 0 });
  });

  it("부족하면 ok:false와 남은 시간을 돌려주고 아무것도 바꾸지 않는다", async () => {
    const sid = await makeSession();
    expect(await svc.reserve(sid, bandId, 4 * H)).toEqual({ ok: false, availableSec: 3 * H });
    expect(await db.select().from(analysisCharges)).toHaveLength(0);
  });

  it("활성 풀: 월 시간을 먼저 쓰고 모자라면 밴드 추가 시간을 쓴다", async () => {
    await makePool({ usedSec: 19 * H });
    await db.update(bands).set({ extraSec: 3 * H }).where(eq(bands.id, bandId));
    const sid = await makeSession();
    expect(await svc.reserve(sid, bandId, 2 * H)).toEqual({ ok: true, alreadyCharged: false });
    const [c] = await db.select().from(analysisCharges).where(eq(analysisCharges.sessionId, sid));
    expect(c).toMatchObject({ monthlySec: H, extraSec: H, freeSec: 0 });
    const [band] = await db.select().from(bands).where(eq(bands.id, bandId));
    expect(band!.extraSec).toBe(2 * H);
    expect(band!.freeUsedSec).toBe(0);
  });

  it("예약은 다른 세션의 월 시간 계산에 바로 반영된다", async () => {
    await makePool({ usedSec: 0 });
    const a = await makeSession();
    const b = await makeSession();
    expect(await svc.reserve(a, bandId, 19 * H)).toMatchObject({ ok: true });
    expect(await svc.reserve(b, bandId, 2 * H)).toEqual({ ok: false, availableSec: H });
  });

  it("commit은 월 시간분을 used_sec에 더하고 charged로 바꾼다", async () => {
    const poolId = await makePool();
    const sid = await makeSession();
    await svc.reserve(sid, bandId, 2 * H);
    await svc.commit(sid);
    const [p] = await db.select().from(billingPools).where(eq(billingPools.id, poolId));
    expect(p!.usedSec).toBe(2 * H);
    const [c] = await db.select().from(analysisCharges).where(eq(analysisCharges.sessionId, sid));
    expect(c!.state).toBe("charged");
  });

  it("refund는 무료·추가 시간을 되돌리고 used_sec은 건드리지 않는다", async () => {
    const poolId = await makePool({ usedSec: 19 * H });
    await db.update(bands).set({ extraSec: 3 * H }).where(eq(bands.id, bandId));
    const sid = await makeSession();
    await svc.reserve(sid, bandId, 2 * H);
    await svc.refund(sid);
    const [band] = await db.select().from(bands).where(eq(bands.id, bandId));
    expect(band!.extraSec).toBe(3 * H);
    const [p] = await db.select().from(billingPools).where(eq(billingPools.id, poolId));
    expect(p!.usedSec).toBe(19 * H);
    const [c] = await db.select().from(analysisCharges).where(eq(analysisCharges.sessionId, sid));
    expect(c!.state).toBe("refunded");
  });

  it("refunded 세션을 다시 예약하면 새로 차감한다", async () => {
    const sid = await makeSession();
    await svc.reserve(sid, bandId, H);
    await svc.refund(sid);
    expect(await svc.reserve(sid, bandId, H)).toEqual({ ok: true, alreadyCharged: false });
    const [band] = await db.select().from(bands).where(eq(bands.id, bandId));
    expect(band!.freeUsedSec).toBe(H);
  });

  it("charged 세션의 재예약은 차감 없이 alreadyCharged", async () => {
    const sid = await makeSession();
    await svc.reserve(sid, bandId, H);
    await svc.commit(sid);
    expect(await svc.reserve(sid, bandId, 3 * H)).toEqual({ ok: true, alreadyCharged: true });
    const [band] = await db.select().from(bands).where(eq(bands.id, bandId));
    expect(band!.freeUsedSec).toBe(H);
  });

  it("reserved 세션의 재예약은 기존 예약을 그대로 쓴다", async () => {
    const sid = await makeSession();
    await svc.reserve(sid, bandId, H);
    expect(await svc.reserve(sid, bandId, H)).toEqual({ ok: true, alreadyCharged: false });
    expect(await db.select().from(analysisCharges)).toHaveLength(1);
  });

  it("만료 풀에 연결된 밴드는 무료 → 추가 시간", async () => {
    await makePool({ status: "expired", usedSec: 20 * H });
    await db.update(bands).set({ extraSec: H, freeUsedSec: 2 * H }).where(eq(bands.id, bandId));
    const sid = await makeSession();
    expect(await svc.reserve(sid, bandId, 2 * H)).toMatchObject({ ok: true });
    const [c] = await db.select().from(analysisCharges).where(eq(analysisCharges.sessionId, sid));
    expect(c).toMatchObject({ freeSec: H, extraSec: H, monthlySec: 0 });
  });

  it("allowanceOf는 예약 합계를 뺀 값을 준다", async () => {
    await makePool({ usedSec: 5 * H });
    const sid = await makeSession();
    await svc.reserve(sid, bandId, 2 * H);
    expect((await svc.allowanceOf(bandId)).monthlyLeftSec).toBe(13 * H);
  });
});
```

- [ ] **Step 2: 실패 확인**

```bash
pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/billing-charge.e2e-spec.ts
```

Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현**

`apps/api/src/billing/billing-charge.service.ts`:

```ts
import type { Provider } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { analysisCharges, bands, billingPools } from "../db/schema.js";
import { allowance, splitCharge, type Allowance } from "./allowance.js";

export type ReserveResult = { ok: true; alreadyCharged: boolean } | { ok: false; availableSec: number };

// 트랜잭션 콜백의 tx도 Db와 같은 표면을 쓴다
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * 분석 차감 원장 (스펙 "분석 게이트"). 밴드·풀 행을 FOR UPDATE로 잠근 뒤 계산하므로
 * 같은 풀의 두 세션이 동시에 들어와도 월 시간을 초과 예약하지 않는다.
 * 무료·추가 시간은 예약 시점에 바로 깎고(환불 시 되돌림), 월 시간은 reserved 합계로만 계산하다
 * commit 때 used_sec에 더한다 — 갱신으로 used_sec이 0이 돼도 예약은 계산에서 빠질 뿐이다.
 */
export class BillingChargeService {
  constructor(private readonly db: Db) {}

  async reserve(sessionId: string, bandId: string, needSec: number): Promise<ReserveResult> {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx.select().from(analysisCharges).where(eq(analysisCharges.sessionId, sessionId)).for("update");
      if (existing?.state === "charged") return { ok: true, alreadyCharged: true };
      if (existing?.state === "reserved") return { ok: true, alreadyCharged: false };

      const { band, pool, a } = await this.lockAndCompute(tx, bandId);
      const split = splitCharge(a, needSec);
      if (!split) return { ok: false, availableSec: a.availableSec };

      if (split.freeSec > 0 || split.extraSec > 0) {
        await tx
          .update(bands)
          .set({ freeUsedSec: band.freeUsedSec + split.freeSec, extraSec: band.extraSec - split.extraSec, updatedAt: new Date() })
          .where(eq(bands.id, bandId));
      }
      const row = { bandId, poolId: a.source === "pool" ? pool!.id : null, ...split, state: "reserved" as const, updatedAt: new Date() };
      if (existing) {
        // refunded였던 세션의 재분석 — 같은 행을 다시 reserved로
        await tx.update(analysisCharges).set(row).where(eq(analysisCharges.sessionId, sessionId));
      } else {
        await tx.insert(analysisCharges).values({ sessionId, ...row });
      }
      return { ok: true, alreadyCharged: false };
    });
  }

  async commit(sessionId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [c] = await tx.select().from(analysisCharges).where(eq(analysisCharges.sessionId, sessionId)).for("update");
      if (!c || c.state !== "reserved") return;
      if (c.poolId && c.monthlySec > 0) {
        await tx
          .update(billingPools)
          .set({ usedSec: sql`${billingPools.usedSec} + ${c.monthlySec}`, updatedAt: new Date() })
          .where(eq(billingPools.id, c.poolId));
      }
      await tx.update(analysisCharges).set({ state: "charged", updatedAt: new Date() }).where(eq(analysisCharges.sessionId, sessionId));
    });
  }

  async refund(sessionId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [c] = await tx.select().from(analysisCharges).where(eq(analysisCharges.sessionId, sessionId)).for("update");
      if (!c || c.state !== "reserved") return;
      if (c.freeSec > 0 || c.extraSec > 0) {
        await tx
          .update(bands)
          .set({
            freeUsedSec: sql`greatest(0, ${bands.freeUsedSec} - ${c.freeSec})`,
            extraSec: sql`${bands.extraSec} + ${c.extraSec}`,
            updatedAt: new Date(),
          })
          .where(eq(bands.id, c.bandId));
      }
      await tx.update(analysisCharges).set({ state: "refunded", updatedAt: new Date() }).where(eq(analysisCharges.sessionId, sessionId));
    });
  }

  async allowanceOf(bandId: string, tx: Db | Tx = this.db): Promise<Allowance> {
    const [band] = await tx.select().from(bands).where(eq(bands.id, bandId));
    if (!band) throw new Error(`band ${bandId} not found`);
    const pool = band.poolId ? (await tx.select().from(billingPools).where(eq(billingPools.id, band.poolId)))[0] : undefined;
    const reservedSec = pool ? await this.reservedSum(tx, pool.id) : 0;
    return allowance({
      pool: pool ? { plan: pool.plan, status: pool.status, usedSec: pool.usedSec, reservedSec } : null,
      band: { freeUsedSec: band.freeUsedSec, extraSec: band.extraSec },
    });
  }

  private async lockAndCompute(tx: Tx, bandId: string) {
    const [band] = await tx.select().from(bands).where(eq(bands.id, bandId)).for("update");
    if (!band) throw new Error(`band ${bandId} not found`);
    const pool = band.poolId ? (await tx.select().from(billingPools).where(eq(billingPools.id, band.poolId)).for("update"))[0] : undefined;
    const reservedSec = pool ? await this.reservedSum(tx, pool.id) : 0;
    const a = allowance({
      pool: pool ? { plan: pool.plan, status: pool.status, usedSec: pool.usedSec, reservedSec } : null,
      band: { freeUsedSec: band.freeUsedSec, extraSec: band.extraSec },
    });
    return { band, pool, a };
  }

  async reservedSecOf(poolId: string): Promise<number> {
    return this.reservedSum(this.db, poolId);
  }

  private async reservedSum(tx: Db | Tx, poolId: string): Promise<number> {
    const [row] = await tx
      .select({ n: sql<number>`coalesce(sum(${analysisCharges.monthlySec}), 0)::int` })
      .from(analysisCharges)
      .where(and(eq(analysisCharges.poolId, poolId), eq(analysisCharges.state, "reserved")));
    return row?.n ?? 0;
  }
}

export const billingChargeServiceProvider: Provider = {
  provide: BillingChargeService,
  useFactory: (db: Db) => new BillingChargeService(db),
  inject: [DB],
};
```

`apps/api/src/billing/billing.module.ts` (지금은 charge만, Task 5·6에서 늘린다):

```ts
import { Module } from "@nestjs/common";
import { DbModule } from "../db/db.module.js";
import { billingChargeServiceProvider } from "./billing-charge.service.js";

@Module({
  imports: [DbModule],
  providers: [billingChargeServiceProvider],
  exports: [billingChargeServiceProvider],
})
export class BillingModule {}
```

- [ ] **Step 4: 통과 확인**

```bash
pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/billing-charge.e2e-spec.ts
```

Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/billing apps/api/test/billing-charge.e2e-spec.ts
git commit -m "feat(api): BillingChargeService — reserve, commit, refund analysis time"
```

---

### Task 4: 워커 게이트 — ffprobe 뒤 예약, 성공 시 확정, 실패 시 환불

**Files:**
- Modify: `apps/api/src/worker/session-analysis.service.ts`
- Modify: `apps/api/src/worker/worker.module.ts`
- Modify: `apps/api/src/sessions/sessions.service.ts` (`retry`)
- Modify: `apps/api/src/sessions/sessions.module.ts`
- Test: `apps/api/src/worker/session-analysis.service.spec.ts`
- Test: `apps/api/test/sessions.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 3 `BillingChargeService.reserve/commit/refund`.
- Produces: `SessionAnalysisService` 생성자에 `charges: BillingChargeService` 인자 추가 (ffmpeg 뒤, tmpRoot 앞). 세션 상태 `waiting_for_time`.

- [ ] **Step 1: 워커 단위 테스트 추가**

`session-analysis.service.spec.ts`의 기존 `fakeDb`에 `guardedWhereCalls` 옆으로 상태를 추가하지 않는다 — 게이트는 별도 fake로 주입한다. 파일 상단에 추가:

```ts
import type { BillingChargeService, ReserveResult } from "../billing/billing-charge.service.js";

function fakeCharges(result: ReserveResult = { ok: true, alreadyCharged: false }) {
  const calls = { reserve: [] as Array<{ sessionId: string; bandId: string; needSec: number }>, commit: [] as string[], refund: [] as string[] };
  const charges = {
    reserve: async (sessionId: string, bandId: string, needSec: number) => { calls.reserve.push({ sessionId, bandId, needSec }); return result; },
    commit: async (sessionId: string) => { calls.commit.push(sessionId); },
    refund: async (sessionId: string) => { calls.refund.push(sessionId); },
  } as unknown as BillingChargeService;
  return { charges, calls };
}
```

기존 테스트들이 `new SessionAnalysisService(db, storage, gemini, ffmpeg, tmp, 0)`처럼 만들고 있으면, 모두 `new SessionAnalysisService(db, storage, gemini, ffmpeg, fakeCharges().charges, tmp, 0)`로 바꾼다 (인자 위치는 ffmpeg 다음).

`describe("SessionAnalysisService.run")` 안에 추가:

```ts
  it("ffprobe 길이를 초 단위로 올림해 예약하고, 성공하면 commit", async () => {
    const { db, state } = fakeDb({ id: "s", bandId: "b", status: "analyzing" });
    const { storage } = fakeStorage();
    const { ffmpeg } = fakeFfmpeg(90 * MIN + 500);
    const { charges, calls } = fakeCharges();
    const gemini = { analyzeFile: async () => [] } as unknown as GeminiService;
    await new SessionAnalysisService(db, storage, gemini, ffmpeg, charges, tmp, 0).run("s");
    expect(calls.reserve).toEqual([{ sessionId: "s", bandId: "b", needSec: 90 * 60 + 1 }]);
    expect(calls.commit).toEqual(["s"]);
    expect(calls.refund).toEqual([]);
    expect(state.updates.at(-1)).toMatchObject({ status: "ready" });
  });

  it("시간이 부족하면 waiting_for_time으로 바꾸고 Gemini를 부르지 않는다", async () => {
    const { db, state } = fakeDb({ id: "s", bandId: "b", status: "analyzing" });
    const { storage } = fakeStorage();
    const { ffmpeg, cuts } = fakeFfmpeg(60 * MIN);
    const { charges, calls } = fakeCharges({ ok: false, availableSec: 600 });
    let geminiCalls = 0;
    const gemini = { analyzeFile: async () => { geminiCalls += 1; return []; } } as unknown as GeminiService;
    await new SessionAnalysisService(db, storage, gemini, ffmpeg, charges, tmp, 0).run("s");
    expect(geminiCalls).toBe(0);
    expect(cuts).toEqual([]);
    expect(calls.commit).toEqual([]);
    expect(state.updates.at(-1)).toMatchObject({ status: "waiting_for_time", analysisError: null });
  });

  it("Gemini가 실패하면 refund하고 failed", async () => {
    const { db, state } = fakeDb({ id: "s", bandId: "b", status: "analyzing" });
    const { storage } = fakeStorage();
    const { ffmpeg } = fakeFfmpeg(10 * MIN);
    const { charges, calls } = fakeCharges();
    const gemini = { analyzeFile: async () => { throw new Error("boom"); } } as unknown as GeminiService;
    await new SessionAnalysisService(db, storage, gemini, ffmpeg, charges, tmp, 0).run("s");
    expect(calls.refund).toEqual(["s"]);
    expect(calls.commit).toEqual([]);
    expect(state.updates.at(-1)).toMatchObject({ status: "failed" });
  });

  it("예약 자체가 실패(동시 중복 전달 등)하면 refund 없이 failed로 기록한다", async () => {
    const { db, state } = fakeDb({ id: "s", bandId: "b", status: "analyzing" });
    const { storage } = fakeStorage();
    const { ffmpeg } = fakeFfmpeg(10 * MIN);
    const { charges, calls } = fakeCharges();
    (charges as unknown as { reserve: () => Promise<never> }).reserve = async () => { throw new Error("duplicate key"); };
    const gemini = { analyzeFile: async () => [] } as unknown as GeminiService;
    await new SessionAnalysisService(db, storage, gemini, ffmpeg, charges, tmp, 0).run("s");
    expect(calls.refund).toEqual([]);
    expect(state.updates.at(-1)).toMatchObject({ status: "failed" });
  });
```

- [ ] **Step 2: 실패 확인**

```bash
pnpm --filter @bandapp/api exec vitest run src/worker/session-analysis.service.spec.ts
```

Expected: FAIL — 생성자 인자 불일치 / reserve 호출 없음.

- [ ] **Step 3: 워커 구현**

`session-analysis.service.ts`:

- import 추가: `import { BillingChargeService } from "../billing/billing-charge.service.js";`
- 생성자:

```ts
  constructor(
    private readonly db: Db,
    private readonly storage: StorageService,
    private readonly gemini: GeminiService,
    private readonly ffmpeg: FfmpegRunner,
    private readonly charges: BillingChargeService,
    private readonly tmpRoot: string = tmpdir(),
    private readonly retryDelayMs: number = 2000,
  ) {}
```

- `run()`에서 `durationMs` 업데이트 바로 다음, `planChunks` 앞에:

```ts
      // 결제 게이트 (2026-10-03 스펙): 길이를 확정한 뒤, Gemini를 부르기 전에 시간을 예약한다.
      // 부족하면 waiting_for_time — 녹음·재생은 되고 분석만 기다린다. 시간을 산 뒤 /retry가 다시 큐에 넣는다.
      const needSec = Math.ceil(durationMs / 1000);
      const reserved = await this.charges.reserve(sessionId, session.bandId, needSec);
      if (!reserved.ok) {
        await this.db
          .update(sessions)
          .set({ status: "waiting_for_time", analysisError: null, updatedAt: new Date() })
          .where(and(eq(sessions.id, sessionId), eq(sessions.status, "analyzing")));
        this.logger.log(`session ${sessionId}: waiting for time (need ${needSec}s, available ${reserved.availableSec}s)`);
        return;
      }
      reservedForRefund = true;
```

- `run()`의 `try` 앞에 `let reservedForRefund = false;`를 두고, 마무리 트랜잭션 성공 직후(`this.logger.log(...takes from...)` 앞)에 `await this.charges.commit(sessionId);`를 넣는다. commit은 ready 트랜잭션 **밖**이다 — ready가 됐는데 commit이 실패하면 예약이 남아 월 시간이 계속 묶이지만, 이중 차감보다 낫고 다음 retry가 `alreadyCharged`가 아닌 `reserved` 재사용으로 들어와 다시 commit된다.
- `catch`에서 `StaleSessionError`가 아닌 경우, `fail()` 호출 **앞에**:

```ts
        if (reservedForRefund) await this.charges.refund(sessionId).catch((e) => this.logger.error(`session ${sessionId} refund failed: ${String(e)}`));
```

- `fail()`은 그대로 (analyzing일 때만 failed).
- provider:

```ts
export const sessionAnalysisServiceProvider: Provider = {
  provide: SessionAnalysisService,
  useFactory: (db: Db, storage: StorageService, gemini: GeminiService, charges: BillingChargeService) =>
    new SessionAnalysisService(db, storage, gemini, new ExecFfmpegRunner(), charges),
  inject: [DB, StorageService, GeminiService, BillingChargeService],
};
```

`worker.module.ts`의 providers에 `billingChargeServiceProvider` 추가 (`import { billingChargeServiceProvider } from "../billing/billing-charge.service.js";`). 워커는 AuthModule이 필요 없으니 BillingModule 전체를 import하지 않는다.

- [ ] **Step 4: 단위 테스트 통과 확인**

```bash
pnpm --filter @bandapp/api exec vitest run src/worker/session-analysis.service.spec.ts
```

Expected: PASS (기존 + 4).

- [ ] **Step 5: `/retry`가 `waiting_for_time`을 받게 하는 e2e 테스트**

`apps/api/test/sessions.e2e-spec.ts`의 기존 retry 테스트 근처에 추가:

```ts
  it("waiting_for_time 세션은 retry로 다시 analyzing이 되고 큐에 들어간다", async () => {
    const { session } = await createSession();
    await db.update(sessions).set({ status: "waiting_for_time" }).where(eq(sessions.id, session.id));
    const res = await request(app.getHttpServer()).post(`/sessions/${session.id}/retry`).set(auth(owner.accessToken)).expect(200);
    expect(res.body.status).toBe("analyzing");
    expect(producer.enqueued).toContain(session.id);
  });
```

- [ ] **Step 6: retry 구현**

`sessions.service.ts`의 `retry`:

```ts
    const retryable = session.status === "failed" || session.status === "waiting_for_time";
    if (!retryable && !stale) throw new ConflictException("실패했거나 시간을 기다리는 세션만 다시 시도할 수 있어요.");
```

- [ ] **Step 7: e2e 통과 확인**

```bash
pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/sessions.e2e-spec.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/worker apps/api/src/sessions apps/api/test/sessions.e2e-spec.ts
git commit -m "feat(api): gate analysis on billing time — reserve, commit, refund, waiting_for_time"
```

---

### Task 5: 결제 조회·풀 연결 API와 오너 양도 연결 해제

**Files:**
- Modify: `packages/types/src/band.ts` (`BandErrorCode`에 `billing_*` 추가)
- Create: `packages/types/src/billing.ts`
- Modify: `packages/types/src/index.ts`
- Create: `apps/api/src/billing/billing.service.ts`
- Create: `apps/api/src/billing/billing.controller.ts`
- Modify: `apps/api/src/billing/billing.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/bands/band-errors.ts`
- Modify: `apps/api/src/bands/bands.service.ts` (`transferOwnership`)
- Test: `apps/api/test/billing.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 3 `BillingChargeService.allowanceOf`.
- Produces:
  ```ts
  // @bandapp/types billing.ts
  export type PoolPlan = "band" | "plus";
  export type BandBillingState = "free" | "linked" | "expired";
  export interface BandBilling {
    state: BandBillingState;
    plan: PoolPlan | null;
    periodEnd: string | null; // ISO
    willRenew: boolean;
    store: "app_store" | "play_store" | null;
    availableSec: number; monthlyTotalSec: number; monthlyLeftSec: number; monthlyUsedSec: number; extraSec: number; freeLeftSec: number;
    owner: { id: string; displayName: string };
    isOwner: boolean;
    linkedBandCount: number;
    canBuyExtra: boolean;
    myPool: { plan: PoolPlan | null; status: "active" | "grace" | "expired"; monthlyLeftSec: number; bands: Array<{ id: string; name: string; memberCount: number; linked: boolean }> } | null;
  }
  export type BillingErrorCode = "billing_owner_only" | "billing_no_active_pool" | "billing_band_linked_elsewhere";
  // API
  GET  /bands/:bandId/billing           → BandBilling   (멤버)
  POST /bands/:bandId/billing/link      → BandBilling   (오너, 내 풀 활성이어야 함)
  POST /bands/:bandId/billing/unlink    → BandBilling   (오너)
  // BillingService
  class BillingService { bandBilling(bandId, userId): Promise<BandBilling>; link(bandId, userId): Promise<BandBilling>; unlink(bandId, userId): Promise<BandBilling>; }
  ```

- [ ] **Step 1: 타입 추가**

`packages/types/src/billing.ts`를 위 Interfaces의 `BandBilling`·`PoolPlan`·`BandBillingState`·`BillingErrorCode` 그대로 만든다 (주석: "`GET /bands/:id/billing` 응답. 디자인 B01의 state 분기: free/linked/expired"). `index.ts`에 `export * from "./billing";`. `band.ts`의 `BandErrorCode` union 끝에:

```ts
  | "billing_owner_only" // 403 구독·연결은 오너만
  | "billing_no_active_pool" // 409 활성 구독이 없어 연결할 수 없음
  | "billing_band_linked_elsewhere"; // 409 다른 사람의 풀에 연결된 밴드
```

`band-errors.ts`의 `MESSAGES`에:

```ts
  billing_owner_only: "플랜은 밴드 관리자만 바꿀 수 있어요.",
  billing_no_active_pool: "활성 구독이 없어요.",
  billing_band_linked_elsewhere: "다른 사람의 플랜에 연결된 밴드예요.",
```

`pnpm --filter @bandapp/types build`.

- [ ] **Step 2: e2e 테스트 작성**

`apps/api/test/billing.e2e-spec.ts`:

```ts
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bandMembers, bands, billingPools } from "../src/db/schema.js";
import { createTestApp, loginAs, providerUser } from "./app-util.js";
import { createTestDb, truncateAll } from "./db-util.js";

const H = 3600;

describe("billing API", () => {
  const db = createTestDb();
  let app: INestApplication;
  let owner: { accessToken: string; userId: string };
  let bandId: string;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function createBand(token: string, name = "B"): Promise<string> {
    const res = await request(app.getHttpServer()).post("/bands").set(auth(token)).send({ name }).expect(201);
    return res.body.id;
  }
  async function otherUser(subject: string) {
    const other = await createTestApp({ google: providerUser(subject, "Minsoo") });
    const login = await loginAs(other);
    await other.close();
    return login;
  }
  async function activePool(userId: string, plan: "band" | "plus" = "band", usedSec = 0): Promise<string> {
    const [p] = await db
      .insert(billingPools)
      .values({ ownerUserId: userId, plan, status: "active", usedSec, periodEnd: new Date("2026-11-03T00:00:00Z"), willRenew: true, store: "app_store" })
      .returning({ id: billingPools.id });
    return p!.id;
  }

  beforeEach(async () => {
    await truncateAll(db);
    app = await createTestApp({ google: providerUser("owner-1") });
    owner = await loginAs(app);
    bandId = await createBand(owner.accessToken);
  });
  afterEach(() => app.close());

  it("무료 밴드: state free, 무료 잔여 3h, 오너", async () => {
    const res = await request(app.getHttpServer()).get(`/bands/${bandId}/billing`).set(auth(owner.accessToken)).expect(200);
    expect(res.body).toMatchObject({
      state: "free", plan: null, availableSec: 3 * H, freeLeftSec: 3 * H, monthlyTotalSec: 0, extraSec: 0,
      isOwner: true, linkedBandCount: 0, canBuyExtra: false, myPool: null,
      owner: { id: owner.userId, displayName: "Dongjin" },
    });
  });

  it("비멤버는 403", async () => {
    const s = await otherUser("stranger-1");
    await request(app.getHttpServer()).get(`/bands/${bandId}/billing`).set(auth(s.accessToken)).expect(403);
  });

  it("오너가 풀을 가지면 myPool에 내가 오너인 밴드 전부가 linked 여부와 함께 온다 (삭제된 밴드 제외)", async () => {
    await activePool(owner.userId, "band", 5 * H);
    const second = await createBand(owner.accessToken, "Second");
    const deleted = await createBand(owner.accessToken, "Gone");
    await request(app.getHttpServer()).delete(`/bands/${deleted}`).set(auth(owner.accessToken)).expect(204);
    const res = await request(app.getHttpServer()).get(`/bands/${bandId}/billing`).set(auth(owner.accessToken)).expect(200);
    expect(res.body.state).toBe("free");
    expect(res.body.myPool).toMatchObject({ plan: "band", status: "active", monthlyLeftSec: 15 * H });
    expect(res.body.myPool.bands).toEqual([
      { id: bandId, name: "B", memberCount: 1, linked: false },
      { id: second, name: "Second", memberCount: 1, linked: false },
    ]);
  });

  it("link: 오너가 활성 풀에 연결하면 state linked, 월 시간이 보인다", async () => {
    await activePool(owner.userId, "plus", 2 * H);
    const res = await request(app.getHttpServer()).post(`/bands/${bandId}/billing/link`).set(auth(owner.accessToken)).expect(201);
    expect(res.body).toMatchObject({
      state: "linked", plan: "plus", monthlyTotalSec: 40 * H, monthlyLeftSec: 38 * H, monthlyUsedSec: 2 * H, availableSec: 38 * H,
      periodEnd: "2026-11-03T00:00:00.000Z", willRenew: true, store: "app_store", linkedBandCount: 1, canBuyExtra: true,
    });
    expect(res.body.myPool.bands[0].linked).toBe(true);
  });

  it("link: 활성 풀이 없으면 409 billing_no_active_pool", async () => {
    const res = await request(app.getHttpServer()).post(`/bands/${bandId}/billing/link`).set(auth(owner.accessToken)).expect(409);
    expect(res.body.code).toBe("billing_no_active_pool");
  });

  it("link/unlink: 멤버는 403 billing_owner_only", async () => {
    const m = await otherUser("member-1");
    await db.insert(bandMembers).values({ bandId, userId: m.userId, role: "member" });
    await activePool(m.userId);
    const res = await request(app.getHttpServer()).post(`/bands/${bandId}/billing/link`).set(auth(m.accessToken)).expect(403);
    expect(res.body.code).toBe("billing_owner_only");
    await request(app.getHttpServer()).post(`/bands/${bandId}/billing/unlink`).set(auth(m.accessToken)).expect(403);
  });

  it("멤버 시점: linked 밴드는 isOwner false, canBuyExtra true, myPool null, owner 이름", async () => {
    const poolId = await activePool(owner.userId);
    await db.update(bands).set({ poolId }).where(eq(bands.id, bandId));
    const m = await otherUser("member-2");
    await db.insert(bandMembers).values({ bandId, userId: m.userId, role: "member" });
    const res = await request(app.getHttpServer()).get(`/bands/${bandId}/billing`).set(auth(m.accessToken)).expect(200);
    expect(res.body).toMatchObject({ state: "linked", isOwner: false, canBuyExtra: true, myPool: null, owner: { displayName: "Dongjin" } });
  });

  it("만료 풀에 연결된 밴드: state expired, 무료 잔여 + 추가 시간, canBuyExtra false", async () => {
    const poolId = await activePool(owner.userId);
    await db.update(billingPools).set({ status: "expired", willRenew: false }).where(eq(billingPools.id, poolId));
    await db.update(bands).set({ poolId, freeUsedSec: 3 * H, extraSec: H }).where(eq(bands.id, bandId));
    const res = await request(app.getHttpServer()).get(`/bands/${bandId}/billing`).set(auth(owner.accessToken)).expect(200);
    expect(res.body).toMatchObject({ state: "expired", plan: "band", availableSec: H, freeLeftSec: 0, extraSec: H, canBuyExtra: false });
  });

  it("unlink: 밴드는 무료로 돌아가고 추가 시간은 남는다", async () => {
    const poolId = await activePool(owner.userId);
    await db.update(bands).set({ poolId, extraSec: H }).where(eq(bands.id, bandId));
    const res = await request(app.getHttpServer()).post(`/bands/${bandId}/billing/unlink`).set(auth(owner.accessToken)).expect(201);
    expect(res.body).toMatchObject({ state: "free", availableSec: 4 * H, extraSec: H, linkedBandCount: 0 });
  });

  it("오너를 양도하면 연결이 풀린다", async () => {
    const poolId = await activePool(owner.userId);
    await db.update(bands).set({ poolId }).where(eq(bands.id, bandId));
    const m = await otherUser("member-3");
    await db.insert(bandMembers).values({ bandId, userId: m.userId, role: "member" });
    await request(app.getHttpServer()).post(`/bands/${bandId}/transfer`).set(auth(owner.accessToken)).send({ userId: m.userId }).expect(204);
    const [band] = await db.select().from(bands).where(eq(bands.id, bandId));
    expect(band!.poolId).toBeNull();
  });

  it("linkedBandCount는 같은 풀에 연결된 밴드 수", async () => {
    const poolId = await activePool(owner.userId);
    const second = await createBand(owner.accessToken, "Second");
    await db.update(bands).set({ poolId }).where(eq(bands.id, bandId));
    await db.update(bands).set({ poolId }).where(eq(bands.id, second));
    const res = await request(app.getHttpServer()).get(`/bands/${bandId}/billing`).set(auth(owner.accessToken)).expect(200);
    expect(res.body.linkedBandCount).toBe(2);
  });
});
```

- [ ] **Step 3: 실패 확인**

```bash
pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/billing.e2e-spec.ts
```

Expected: 404 등으로 FAIL.

- [ ] **Step 4: `BillingService` 구현**

`apps/api/src/billing/billing.service.ts`:

```ts
import { ConflictException, ForbiddenException } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { BandBilling } from "@bandapp/types";
import { bandError } from "../bands/band-errors.js";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { bandMembers, bands, billingPools, users } from "../db/schema.js";
import { MembershipsService } from "../memberships/memberships.service.js";
import { BillingChargeService } from "./billing-charge.service.js";
import { PLANS } from "./plans.js";

type PoolRow = typeof billingPools.$inferSelect;

/** 밴드 결제 조회·풀 연결 (스펙 "API"). 풀 상태 자체는 BillingSyncService가 RevenueCat에서 받아 쓴다. */
export class BillingService {
  constructor(
    private readonly db: Db,
    private readonly memberships: MembershipsService,
    private readonly charges: BillingChargeService,
  ) {}

  async bandBilling(bandId: string, userId: string): Promise<BandBilling> {
    const role = await this.memberships.assertMember(bandId, userId);
    return this.build(bandId, userId, role === "owner");
  }

  async link(bandId: string, userId: string): Promise<BandBilling> {
    await this.assertOwner(bandId, userId);
    const pool = await this.poolOf(userId);
    if (!pool || pool.status === "expired" || !pool.plan) throw new ConflictException(bandError("billing_no_active_pool"));
    const [band] = await this.db.select({ poolId: bands.poolId }).from(bands).where(eq(bands.id, bandId));
    if (band?.poolId && band.poolId !== pool.id) throw new ConflictException(bandError("billing_band_linked_elsewhere"));
    await this.db.update(bands).set({ poolId: pool.id, updatedAt: new Date() }).where(eq(bands.id, bandId));
    return this.build(bandId, userId, true);
  }

  async unlink(bandId: string, userId: string): Promise<BandBilling> {
    await this.assertOwner(bandId, userId);
    await this.db.update(bands).set({ poolId: null, updatedAt: new Date() }).where(eq(bands.id, bandId));
    return this.build(bandId, userId, true);
  }

  private async assertOwner(bandId: string, userId: string): Promise<void> {
    if ((await this.memberships.assertMember(bandId, userId)) !== "owner") {
      throw new ForbiddenException(bandError("billing_owner_only"));
    }
  }

  async poolOf(userId: string): Promise<PoolRow | undefined> {
    const [pool] = await this.db.select().from(billingPools).where(eq(billingPools.ownerUserId, userId));
    return pool;
  }

  private async build(bandId: string, userId: string, isOwner: boolean): Promise<BandBilling> {
    const [band] = await this.db.select().from(bands).where(eq(bands.id, bandId));
    if (!band) throw new ForbiddenException(bandError("band_forbidden"));
    const linkedPool = band.poolId ? (await this.db.select().from(billingPools).where(eq(billingPools.id, band.poolId)))[0] : undefined;
    const a = await this.charges.allowanceOf(bandId);
    const state: BandBilling["state"] = !linkedPool ? "free" : a.source === "pool" ? "linked" : "expired";
    const [ownerRow] = await this.db
      .select({ id: users.id, displayName: users.displayName })
      .from(bandMembers)
      .innerJoin(users, eq(users.id, bandMembers.userId))
      .where(and(eq(bandMembers.bandId, bandId), eq(bandMembers.role, "owner")));
    const linkedBandCount = linkedPool ? await this.countLinked(linkedPool.id) : 0;
    const myPool = isOwner ? await this.myPool(userId) : null;
    const monthlyTotalSec = state === "linked" && linkedPool?.plan ? PLANS[linkedPool.plan].monthlySec : 0;
    return {
      state,
      plan: linkedPool?.plan ?? null,
      periodEnd: linkedPool?.periodEnd?.toISOString() ?? null,
      willRenew: linkedPool?.willRenew ?? false,
      store: linkedPool?.store ?? null,
      availableSec: a.availableSec,
      monthlyTotalSec,
      monthlyLeftSec: a.monthlyLeftSec,
      monthlyUsedSec: state === "linked" ? Math.max(0, monthlyTotalSec - a.monthlyLeftSec) : 0,
      extraSec: a.extraSec,
      freeLeftSec: a.freeLeftSec,
      owner: { id: ownerRow?.id ?? "", displayName: ownerRow?.displayName ?? "" },
      isOwner,
      linkedBandCount,
      canBuyExtra: state === "linked",
      myPool,
    };
  }

  private async myPool(userId: string): Promise<BandBilling["myPool"]> {
    const pool = await this.poolOf(userId);
    if (!pool) return null;
    const rows = await this.db
      .select({
        id: bands.id,
        name: bands.name,
        poolId: bands.poolId,
        memberCount: sql<number>`(select count(*)::int from band_members bm where bm.band_id = ${bands.id})`,
      })
      .from(bandMembers)
      .innerJoin(bands, eq(bands.id, bandMembers.bandId))
      .where(and(eq(bandMembers.userId, userId), eq(bandMembers.role, "owner"), isNull(bands.deletedAt)))
      .orderBy(bandMembers.joinedAt);
    const reservedSec = await this.charges.reservedSecOf(pool.id); // 월 남은 시간은 연결된 밴드 전체 공통
    const monthlyLeftSec = pool.plan && pool.status !== "expired" ? Math.max(0, PLANS[pool.plan].monthlySec - pool.usedSec - reservedSec) : 0;
    return {
      plan: pool.plan,
      status: pool.status,
      monthlyLeftSec,
      bands: rows.map((r) => ({ id: r.id, name: r.name, memberCount: r.memberCount, linked: r.poolId === pool.id })),
    };
  }

  private async countLinked(poolId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(bands)
      .where(and(eq(bands.poolId, poolId), isNull(bands.deletedAt)));
    return row?.n ?? 0;
  }
}

export const billingServiceProvider: Provider = {
  provide: BillingService,
  useFactory: (db: Db, memberships: MembershipsService, charges: BillingChargeService) => new BillingService(db, memberships, charges),
  inject: [DB, MembershipsService, BillingChargeService],
};
```



- [ ] **Step 5: 컨트롤러·모듈**

`apps/api/src/billing/billing.controller.ts`:

```ts
import { Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import type { BandBilling } from "@bandapp/types";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUserId } from "../auth/current-user-id.decorator.js";
import { requireUuidParam } from "../common/validation.js";
import { BillingService } from "./billing.service.js";

@Controller("bands")
@UseGuards(AuthGuard)
export class BandBillingController {
  constructor(private readonly billing: BillingService) {}

  @Get(":bandId/billing")
  get(@CurrentUserId() userId: string, @Param("bandId") bandId: string): Promise<BandBilling> {
    requireUuidParam(bandId, "bandId");
    return this.billing.bandBilling(bandId, userId);
  }

  @Post(":bandId/billing/link")
  link(@CurrentUserId() userId: string, @Param("bandId") bandId: string): Promise<BandBilling> {
    requireUuidParam(bandId, "bandId");
    return this.billing.link(bandId, userId);
  }

  @Post(":bandId/billing/unlink")
  unlink(@CurrentUserId() userId: string, @Param("bandId") bandId: string): Promise<BandBilling> {
    requireUuidParam(bandId, "bandId");
    return this.billing.unlink(bandId, userId);
  }
}
```

`billing.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { DbModule } from "../db/db.module.js";
import { MembershipsModule } from "../memberships/memberships.module.js";
import { billingChargeServiceProvider } from "./billing-charge.service.js";
import { BandBillingController } from "./billing.controller.js";
import { billingServiceProvider } from "./billing.service.js";

@Module({
  imports: [DbModule, AuthModule, MembershipsModule],
  controllers: [BandBillingController],
  providers: [billingChargeServiceProvider, billingServiceProvider],
  exports: [billingChargeServiceProvider, billingServiceProvider],
})
export class BillingModule {}
```

`app.module.ts` imports에 `BillingModule` 추가.

- [ ] **Step 6: 오너 양도 시 연결 해제**

`bands.service.ts` `transferOwnership`의 트랜잭션 안, 두 `update(bandMembers)` 뒤에:

```ts
      // 풀 주인 = 연결된 모든 밴드의 오너라는 규칙을 지킨다 — 양도하면 밴드는 무료로 돌아간다 (2026-10-03 스펙)
      await tx.update(bands).set({ poolId: null, updatedAt: new Date() }).where(eq(bands.id, bandId));
```

- [ ] **Step 7: 통과 확인**

```bash
pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/billing.e2e-spec.ts test/bands.e2e-spec.ts
pnpm --filter @bandapp/api build
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/types/src apps/api/src
git add apps/api/test/billing.e2e-spec.ts
git commit -m "feat(api): band billing endpoint, pool link/unlink, unlink on ownership transfer"
```

---

### Task 6: RevenueCat 동기화 — `/billing/sync`와 웹훅

**Files:**
- Create: `apps/api/src/billing/revenuecat.client.ts`
- Create: `apps/api/src/billing/billing-sync.service.ts`
- Create: `apps/api/src/billing/revenuecat-webhook.controller.ts`
- Modify: `apps/api/src/billing/billing.controller.ts` (`POST /billing/sync`)
- Modify: `apps/api/src/billing/billing.module.ts`
- Modify: `apps/api/test/app-util.ts` (`FakeRevenueCat`)
- Test: `apps/api/src/billing/billing-sync.spec.ts` (순수 매핑)
- Test: `apps/api/test/billing-sync.e2e-spec.ts`

**Interfaces:**
- Produces:
  ```ts
  // revenuecat.client.ts — REST v1 GET /subscribers/{app_user_id} 의 필요한 부분만
  export interface RcSubscriber {
    subscriptions: Record<string, { expires_date: string | null; purchase_date: string; store: string; unsubscribe_detected_at: string | null; billing_issues_detected_at: string | null; period_type: string }>;
    non_subscriptions: Record<string, Array<{ id: string; purchase_date: string; store: string }>>;
    subscriber_attributes?: Record<string, { value: string }>;
  }
  export class RevenueCatClient { getSubscriber(appUserId: string): Promise<RcSubscriber>; }
  // billing-sync.service.ts
  export interface PoolSnapshot { plan: PoolPlan | null; status: "active"|"grace"|"expired"; store: "app_store"|"play_store"|null; periodStart: Date|null; periodEnd: Date|null; willRenew: boolean }
  export function toPoolSnapshot(sub: RcSubscriber, now: Date): PoolSnapshot;   // 순수
  export function extraTransactions(sub: RcSubscriber): Array<{ id: string; store: string }>; // 순수
  export class BillingSyncService {
    /** 사용자 풀을 RevenueCat 상태로 맞추고, 소모성 거래를 반영한다. bandId가 있으면 자동 연결·추가 시간 배정 */
    syncUser(userId: string, opts?: { bandId?: string; attributeBandId?: string }): Promise<void>;
  }
  // API
  POST /billing/sync { bandId?: string } → BandBilling | null  (bandId 있으면 그 밴드 billing, 없으면 null)
  POST /webhooks/revenuecat  (Authorization: Bearer <REVENUECAT_WEBHOOK_SECRET>) → 200 {}
  ```

- [ ] **Step 1: 매핑 순수 함수 테스트**

`apps/api/src/billing/billing-sync.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { RcSubscriber } from "./revenuecat.client.js";
import { extraTransactions, toPoolSnapshot } from "./billing-sync.service.js";

const now = new Date("2026-10-10T00:00:00Z");
const sub = (over: Partial<RcSubscriber> = {}): RcSubscriber => ({ subscriptions: {}, non_subscriptions: {}, ...over });
const active = { purchase_date: "2026-10-03T00:00:00Z", expires_date: "2026-11-03T00:00:00Z", store: "app_store", unsubscribe_detected_at: null, billing_issues_detected_at: null, period_type: "normal" };

describe("toPoolSnapshot", () => {
  it("구독 없음 → expired, plan null", () => {
    expect(toPoolSnapshot(sub(), now)).toEqual({ plan: null, status: "expired", store: null, periodStart: null, periodEnd: null, willRenew: false });
  });

  it("활성 band 구독", () => {
    expect(toPoolSnapshot(sub({ subscriptions: { "rehearsal.band.monthly": active } }), now)).toEqual({
      plan: "band", status: "active", store: "app_store",
      periodStart: new Date("2026-10-03T00:00:00Z"), periodEnd: new Date("2026-11-03T00:00:00Z"), willRenew: true,
    });
  });

  it("해지 예정이면 willRenew false지만 만료 전까지 active", () => {
    const s = toPoolSnapshot(sub({ subscriptions: { "rehearsal.plus.monthly": { ...active, unsubscribe_detected_at: "2026-10-05T00:00:00Z" } } }), now);
    expect(s).toMatchObject({ plan: "plus", status: "active", willRenew: false });
  });

  it("만료일이 지났고 결제 문제가 있으면 grace, 없으면 expired", () => {
    const past = { ...active, expires_date: "2026-10-09T00:00:00Z" };
    expect(toPoolSnapshot(sub({ subscriptions: { "rehearsal.band.monthly": { ...past, billing_issues_detected_at: "2026-10-09T00:00:00Z" } } }), now).status).toBe("grace");
    expect(toPoolSnapshot(sub({ subscriptions: { "rehearsal.band.monthly": past } }), now).status).toBe("expired");
  });

  it("활성 구독이 둘이면(전환 중) 만료가 더 늦은 쪽", () => {
    const s = toPoolSnapshot(sub({ subscriptions: {
      "rehearsal.band.monthly": { ...active, expires_date: "2026-10-20T00:00:00Z" },
      "rehearsal.plus.monthly": { ...active, store: "play_store" },
    } }), now);
    expect(s).toMatchObject({ plan: "plus", store: "play_store" });
  });

  it("모르는 상품 ID는 무시한다", () => {
    expect(toPoolSnapshot(sub({ subscriptions: { "other.app.thing": active } }), now).plan).toBeNull();
  });
});

describe("extraTransactions", () => {
  it("추가 시간 상품의 거래만 id와 store로 돌려준다", () => {
    const s = sub({ non_subscriptions: {
      "rehearsal.extra.3h": [{ id: "t1", purchase_date: "2026-10-04T00:00:00Z", store: "play_store" }, { id: "t2", purchase_date: "2026-10-05T00:00:00Z", store: "play_store" }],
      "other": [{ id: "x", purchase_date: "2026-10-04T00:00:00Z", store: "app_store" }],
    } });
    expect(extraTransactions(s)).toEqual([{ id: "t1", store: "play_store" }, { id: "t2", store: "play_store" }]);
  });
});
```

- [ ] **Step 2: 실패 확인**

```bash
pnpm --filter @bandapp/api exec vitest run src/billing/billing-sync.spec.ts
```

Expected: FAIL — 모듈 없음.

- [ ] **Step 3: RevenueCat 클라이언트와 순수 매핑 구현**

`apps/api/src/billing/revenuecat.client.ts`:

```ts
import type { Provider } from "@nestjs/common";

/** RevenueCat REST v1 `GET /v1/subscribers/{app_user_id}` 응답 중 쓰는 부분만 */
export interface RcSubscriber {
  subscriptions: Record<
    string,
    {
      expires_date: string | null;
      purchase_date: string;
      store: string;
      unsubscribe_detected_at: string | null;
      billing_issues_detected_at: string | null;
      period_type: string;
    }
  >;
  non_subscriptions: Record<string, Array<{ id: string; purchase_date: string; store: string }>>;
  subscriber_attributes?: Record<string, { value: string }>;
}

export class RevenueCatClient {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async getSubscriber(appUserId: string): Promise<RcSubscriber> {
    // 키는 호출 시점에 읽는다 — 없으면 결제 기능만 죽고 서버는 뜬다 (기존 env 패턴)
    const key = process.env.REVENUECAT_API_KEY;
    if (!key) throw new Error("REVENUECAT_API_KEY is not set");
    const res = await this.fetchFn(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(appUserId)}`, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`revenuecat ${res.status}`);
    const body = (await res.json()) as { subscriber: RcSubscriber };
    return body.subscriber;
  }
}

export const revenueCatClientProvider: Provider = { provide: RevenueCatClient, useFactory: () => new RevenueCatClient() };
```

`apps/api/src/billing/billing-sync.service.ts` (순수 함수 부분 먼저):

```ts
import { Logger } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { bandMembers, bands, billingPools, extraPurchases } from "../db/schema.js";
import { EXTRA_PRODUCT_IDS, EXTRA_SEC, SUBSCRIPTION_PRODUCTS, type PoolPlan } from "./plans.js";
import { RevenueCatClient, type RcSubscriber } from "./revenuecat.client.js";

export interface PoolSnapshot {
  plan: PoolPlan | null;
  status: "active" | "grace" | "expired";
  store: "app_store" | "play_store" | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  willRenew: boolean;
}

function storeOf(s: string): PoolSnapshot["store"] {
  return s === "app_store" ? "app_store" : s === "play_store" ? "play_store" : null;
}

/** 구독 목록에서 풀 상태를 뽑는다. 활성이 둘이면(플랜 전환 중) 만료가 늦은 쪽을 쓴다 */
export function toPoolSnapshot(sub: RcSubscriber, now: Date): PoolSnapshot {
  let best: PoolSnapshot | null = null;
  for (const [productId, s] of Object.entries(sub.subscriptions)) {
    const plan = SUBSCRIPTION_PRODUCTS[productId];
    if (!plan) continue;
    const periodEnd = s.expires_date ? new Date(s.expires_date) : null;
    const expired = periodEnd !== null && periodEnd.getTime() <= now.getTime();
    const status: PoolSnapshot["status"] = !expired ? "active" : s.billing_issues_detected_at ? "grace" : "expired";
    const snap: PoolSnapshot = {
      plan,
      status,
      store: storeOf(s.store),
      periodStart: new Date(s.purchase_date),
      periodEnd,
      willRenew: !s.unsubscribe_detected_at && status !== "expired",
    };
    const rank = (x: PoolSnapshot) => (x.status === "expired" ? 0 : 1) * 1e13 + (x.periodEnd?.getTime() ?? 0);
    if (!best || rank(snap) > rank(best)) best = snap;
  }
  if (!best || best.status === "expired") {
    // 만료된 구독은 플랜만 남기고(디자인: "{Plan} plan ended") 나머지는 비활성으로
    return { plan: best?.plan ?? null, status: "expired", store: best?.store ?? null, periodStart: best?.periodStart ?? null, periodEnd: best?.periodEnd ?? null, willRenew: false };
  }
  return best;
}

export function extraTransactions(sub: RcSubscriber): Array<{ id: string; store: string }> {
  return EXTRA_PRODUCT_IDS.flatMap((pid) => (sub.non_subscriptions[pid] ?? []).map((t) => ({ id: t.id, store: t.store })));
}
```

주의: 테스트 "구독 없음"은 `plan: null, store: null, periodStart: null, periodEnd: null`을 기대한다 — 위 분기가 `best`가 null일 때 그 값을 준다.

- [ ] **Step 4: 순수 함수 테스트 통과 확인**

```bash
pnpm --filter @bandapp/api exec vitest run src/billing/billing-sync.spec.ts
```

Expected: PASS (7 tests).

- [ ] **Step 5: 동기화 e2e 테스트**

`apps/api/test/app-util.ts`에 추가:

```ts
import { RevenueCatClient, type RcSubscriber } from "../src/billing/revenuecat.client.js";

export class FakeRevenueCat extends RevenueCatClient {
  subscribers = new Map<string, RcSubscriber>();
  async getSubscriber(appUserId: string): Promise<RcSubscriber> {
    return this.subscribers.get(appUserId) ?? { subscriptions: {}, non_subscriptions: {} };
  }
}
```

`createTestApp`의 overrides에 `revenueCat?: FakeRevenueCat`를 추가하고 `.overrideProvider(RevenueCatClient).useValue(overrides?.revenueCat ?? new FakeRevenueCat())`를 체인에 넣는다.

`apps/api/test/billing-sync.e2e-spec.ts`:

```ts
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bandMembers, bands, billingEvents, billingPools, extraPurchases } from "../src/db/schema.js";
import { FakeRevenueCat, createTestApp, loginAs, providerUser } from "./app-util.js";
import { createTestDb, truncateAll } from "./db-util.js";

const H = 3600;
const SECRET = "whsec-test";
const activeBand = (expires = "2099-01-01T00:00:00Z", purchase = "2026-10-03T00:00:00Z") => ({
  "rehearsal.band.monthly": { purchase_date: purchase, expires_date: expires, store: "app_store", unsubscribe_detected_at: null, billing_issues_detected_at: null, period_type: "normal" },
});

describe("billing sync + webhook", () => {
  const db = createTestDb();
  let app: INestApplication;
  let rc: FakeRevenueCat;
  let owner: { accessToken: string; userId: string };
  let bandId: string;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeEach(async () => {
    process.env.REVENUECAT_WEBHOOK_SECRET = SECRET;
    await truncateAll(db);
    rc = new FakeRevenueCat();
    app = await createTestApp({ google: providerUser("owner-1"), revenueCat: rc });
    owner = await loginAs(app);
    const res = await request(app.getHttpServer()).post("/bands").set(auth(owner.accessToken)).send({ name: "B" }).expect(201);
    bandId = res.body.id;
  });
  afterEach(() => app.close());

  async function webhook(event: Record<string, unknown>, secret = SECRET) {
    return request(app.getHttpServer()).post("/webhooks/revenuecat").set({ authorization: `Bearer ${secret}` }).send({ api_version: "1.0", event });
  }

  it("sync(bandId): 구독을 풀에 반영하고 그 밴드를 자동 연결한다", async () => {
    rc.subscribers.set(owner.userId, { subscriptions: activeBand(), non_subscriptions: {} });
    const res = await request(app.getHttpServer()).post("/billing/sync").set(auth(owner.accessToken)).send({ bandId }).expect(201);
    expect(res.body).toMatchObject({ state: "linked", plan: "band", monthlyLeftSec: 20 * H, periodEnd: "2099-01-01T00:00:00.000Z" });
    const [pool] = await db.select().from(billingPools).where(eq(billingPools.ownerUserId, owner.userId));
    expect(pool).toMatchObject({ plan: "band", status: "active", willRenew: true, store: "app_store" });
  });

  it("sync 없이 bandId만 멤버가 아닌 밴드면 403", async () => {
    const other = await createTestApp({ google: providerUser("x-1", "X"), revenueCat: rc });
    const x = await loginAs(other);
    await other.close();
    await request(app.getHttpServer()).post("/billing/sync").set(auth(x.accessToken)).send({ bandId }).expect(403);
  });

  it("갱신(period_start 변경)이면 used_sec이 0이 된다", async () => {
    rc.subscribers.set(owner.userId, { subscriptions: activeBand("2026-11-03T00:00:00Z", "2026-10-03T00:00:00Z"), non_subscriptions: {} });
    await request(app.getHttpServer()).post("/billing/sync").set(auth(owner.accessToken)).send({}).expect(201);
    await db.update(billingPools).set({ usedSec: 7 * H }).where(eq(billingPools.ownerUserId, owner.userId));
    rc.subscribers.set(owner.userId, { subscriptions: activeBand("2026-12-03T00:00:00Z", "2026-11-03T00:00:00Z"), non_subscriptions: {} });
    await request(app.getHttpServer()).post("/billing/sync").set(auth(owner.accessToken)).send({}).expect(201);
    const [pool] = await db.select().from(billingPools).where(eq(billingPools.ownerUserId, owner.userId));
    expect(pool!.usedSec).toBe(0);
  });

  it("같은 기간의 재동기화는 used_sec을 유지한다", async () => {
    rc.subscribers.set(owner.userId, { subscriptions: activeBand(), non_subscriptions: {} });
    await request(app.getHttpServer()).post("/billing/sync").set(auth(owner.accessToken)).send({}).expect(201);
    await db.update(billingPools).set({ usedSec: 7 * H }).where(eq(billingPools.ownerUserId, owner.userId));
    await request(app.getHttpServer()).post("/billing/sync").set(auth(owner.accessToken)).send({}).expect(201);
    const [pool] = await db.select().from(billingPools).where(eq(billingPools.ownerUserId, owner.userId));
    expect(pool!.usedSec).toBe(7 * H);
  });

  it("추가 시간: 멤버가 sync(bandId)하면 밴드 extra_sec에 3h, 두 번째 sync는 중복 반영 안 함", async () => {
    const other = await createTestApp({ google: providerUser("member-1", "M"), revenueCat: rc });
    const m = await loginAs(other);
    await other.close();
    await db.insert(bandMembers).values({ bandId, userId: m.userId, role: "member" });
    rc.subscribers.set(m.userId, { subscriptions: {}, non_subscriptions: { "rehearsal.extra.3h": [{ id: "tx-1", purchase_date: "2026-10-04T00:00:00Z", store: "play_store" }] } });
    await request(app.getHttpServer()).post("/billing/sync").set(auth(m.accessToken)).send({ bandId }).expect(201);
    await request(app.getHttpServer()).post("/billing/sync").set(auth(m.accessToken)).send({ bandId }).expect(201);
    const [band] = await db.select().from(bands).where(eq(bands.id, bandId));
    expect(band!.extraSec).toBe(3 * H);
    const [p] = await db.select().from(extraPurchases).where(eq(extraPurchases.transactionId, "tx-1"));
    expect(p).toMatchObject({ userId: m.userId, bandId, sec: 3 * H });
    expect(p!.appliedAt).not.toBeNull();
  });

  it("웹훅: 시크릿이 틀리면 401, 맞으면 동기화되고 같은 event id는 한 번만 저장", async () => {
    rc.subscribers.set(owner.userId, { subscriptions: activeBand(), non_subscriptions: {} });
    await webhook({ id: "ev-1", type: "INITIAL_PURCHASE", app_user_id: owner.userId }, "wrong").expect(401);
    await webhook({ id: "ev-1", type: "INITIAL_PURCHASE", app_user_id: owner.userId }).expect(200);
    await webhook({ id: "ev-1", type: "INITIAL_PURCHASE", app_user_id: owner.userId }).expect(200);
    expect(await db.select().from(billingEvents)).toHaveLength(1);
    const [pool] = await db.select().from(billingPools).where(eq(billingPools.ownerUserId, owner.userId));
    expect(pool).toMatchObject({ plan: "band", status: "active" });
  });

  it("웹훅의 소모성 거래는 subscriber_attributes.band_id로 배정하고, 없으면 미배정으로 남긴다", async () => {
    rc.subscribers.set(owner.userId, {
      subscriptions: activeBand(),
      non_subscriptions: { "rehearsal.extra.3h": [{ id: "tx-a", purchase_date: "2026-10-04T00:00:00Z", store: "app_store" }] },
      subscriber_attributes: { band_id: { value: bandId } },
    });
    await webhook({ id: "ev-a", type: "NON_RENEWING_PURCHASE", app_user_id: owner.userId }).expect(200);
    let [band] = await db.select().from(bands).where(eq(bands.id, bandId));
    expect(band!.extraSec).toBe(3 * H);

    rc.subscribers.set(owner.userId, {
      subscriptions: activeBand(),
      non_subscriptions: { "rehearsal.extra.3h": [{ id: "tx-a", purchase_date: "2026-10-04T00:00:00Z", store: "app_store" }, { id: "tx-b", purchase_date: "2026-10-05T00:00:00Z", store: "app_store" }] },
    });
    await webhook({ id: "ev-b", type: "NON_RENEWING_PURCHASE", app_user_id: owner.userId }).expect(200);
    const [pending] = await db.select().from(extraPurchases).where(eq(extraPurchases.transactionId, "tx-b"));
    expect(pending!.bandId).toBeNull();
    expect(pending!.appliedAt).toBeNull();

    // 나중에 앱이 bandId로 sync하면 배정된다
    await request(app.getHttpServer()).post("/billing/sync").set(auth(owner.accessToken)).send({ bandId }).expect(201);
    [band] = await db.select().from(bands).where(eq(bands.id, bandId));
    expect(band!.extraSec).toBe(6 * H);
  });

  it("웹훅: 모르는 사용자 id는 200으로 무시한다", async () => {
    await webhook({ id: "ev-z", type: "RENEWAL", app_user_id: "00000000-0000-0000-0000-000000000000" }).expect(200);
    await webhook({ id: "ev-y", type: "RENEWAL", app_user_id: "$RCAnonymousID:abc" }).expect(200);
  });
});
```

- [ ] **Step 6: `BillingSyncService` 구현**

`billing-sync.service.ts`에 이어서:

```ts
/**
 * RevenueCat → 우리 DB. 웹훅과 /billing/sync가 같은 함수를 쓰므로 이벤트 순서에 의존하지 않는다 —
 * 어떤 이벤트가 오든 REST로 현재 상태를 다시 읽어 그대로 쓴다 (스펙 "API").
 */
export class BillingSyncService {
  private readonly logger = new Logger(BillingSyncService.name);

  constructor(
    private readonly db: Db,
    private readonly rc: RevenueCatClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async syncUser(userId: string, opts: { bandId?: string; attributeBandId?: string } = {}): Promise<void> {
    const sub = await this.rc.getSubscriber(userId);
    const snap = toPoolSnapshot(sub, this.now());
    const attrBand = opts.attributeBandId ?? sub.subscriber_attributes?.band_id?.value;

    await this.db.transaction(async (tx) => {
      const [existing] = await tx.select().from(billingPools).where(eq(billingPools.ownerUserId, userId)).for("update");
      // 갱신 판단: 기간 시작이 바뀌면 월 사용량을 0으로 (스펙 "웹훅")
      const renewed = existing?.periodStart?.getTime() !== snap.periodStart?.getTime();
      const values = { ...snap, usedSec: renewed ? 0 : (existing?.usedSec ?? 0), updatedAt: new Date() };
      let poolId: string;
      if (existing) {
        await tx.update(billingPools).set(values).where(eq(billingPools.id, existing.id));
        poolId = existing.id;
      } else {
        const [row] = await tx.insert(billingPools).values({ ownerUserId: userId, ...values }).returning({ id: billingPools.id });
        poolId = row!.id;
      }

      // 결제 화면에서 들어온 밴드는 자동 연결 — 요청자가 오너이고 풀이 활성일 때만
      if (opts.bandId && snap.status !== "expired" && (await this.isOwner(tx, opts.bandId, userId))) {
        await tx.update(bands).set({ poolId, updatedAt: new Date() }).where(and(eq(bands.id, opts.bandId), isNull(bands.poolId)));
      }

      // 소모성 거래: 원장에 upsert하고, 밴드가 정해지면 한 번만 반영
      for (const t of extraTransactions(sub)) {
        await tx
          .insert(extraPurchases)
          .values({ transactionId: t.id, userId, sec: EXTRA_SEC })
          .onConflictDoNothing();
        const target = opts.bandId ?? attrBand;
        if (!target || !(await this.isMember(tx, target, userId))) continue;
        const [applied] = await tx
          .update(extraPurchases)
          .set({ bandId: target, appliedAt: new Date() })
          .where(and(eq(extraPurchases.transactionId, t.id), isNull(extraPurchases.appliedAt)))
          .returning({ sec: extraPurchases.sec });
        if (applied) {
          await tx.update(bands).set({ extraSec: sql`${bands.extraSec} + ${applied.sec}`, updatedAt: new Date() }).where(eq(bands.id, target));
        }
      }
    });
    this.logger.log(`billing sync user ${userId}: ${snap.plan ?? "none"} ${snap.status}`);
  }

  private async isOwner(tx: Pick<Db, "select">, bandId: string, userId: string): Promise<boolean> {
    const [row] = await tx.select({ role: bandMembers.role }).from(bandMembers).where(and(eq(bandMembers.bandId, bandId), eq(bandMembers.userId, userId)));
    return row?.role === "owner";
  }

  private async isMember(tx: Pick<Db, "select">, bandId: string, userId: string): Promise<boolean> {
    const [row] = await tx.select({ role: bandMembers.role }).from(bandMembers).where(and(eq(bandMembers.bandId, bandId), eq(bandMembers.userId, userId)));
    return row !== undefined;
  }
}

export const billingSyncServiceProvider: Provider = {
  provide: BillingSyncService,
  useFactory: (db: Db, rc: RevenueCatClient) => new BillingSyncService(db, rc),
  inject: [DB, RevenueCatClient],
};
```

`tx`의 타입은 Task 3처럼 `type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];`로 두고 `Pick<Db, "select">` 대신 `Db | Tx`를 쓴다 (drizzle 타입이 `Pick`과 안 맞을 수 있다).

- [ ] **Step 7: 컨트롤러 추가**

`billing.controller.ts`에 두 번째 컨트롤러:

```ts
@Controller("billing")
@UseGuards(AuthGuard)
export class BillingSyncController {
  constructor(
    private readonly sync: BillingSyncService,
    private readonly billing: BillingService,
    private readonly memberships: MembershipsService,
  ) {}

  /** 구매 직후·"Check status"에서 부른다. bandId가 있으면 그 밴드의 멤버여야 하고, 응답으로 그 밴드 billing을 준다 */
  @Post("sync")
  async syncMe(@CurrentUserId() userId: string, @Body() body: unknown): Promise<BandBilling | null> {
    const bandId = optionalUuid(body, "bandId");
    if (bandId) await this.memberships.assertMember(bandId, userId);
    await this.sync.syncUser(userId, { bandId });
    return bandId ? this.billing.bandBilling(bandId, userId) : null;
  }
}
```

`apps/api/src/billing/revenuecat-webhook.controller.ts`:

```ts
import { Body, Controller, Headers, HttpCode, Inject, Post, UnauthorizedException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { billingEvents, users } from "../db/schema.js";
import { BillingSyncService } from "./billing-sync.service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RcWebhookBody {
  event?: { id?: string; type?: string; app_user_id?: string; subscriber_attributes?: Record<string, { value: string }> };
}

/**
 * RevenueCat 웹훅. AuthGuard 없이 공유 시크릿만 본다. 이벤트 본문은 중복 판별과 기록용이고,
 * 실제 상태는 REST로 다시 읽는다 — 순서가 뒤바뀐 이벤트에도 결과가 같다 (스펙 "웹훅").
 */
@Controller("webhooks")
export class RevenueCatWebhookController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(BillingSyncService) private readonly sync: BillingSyncService,
  ) {}

  @Post("revenuecat")
  @HttpCode(200)
  async handle(@Headers("authorization") authorization: string | undefined, @Body() body: RcWebhookBody): Promise<Record<string, never>> {
    const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
    if (!secret || authorization !== `Bearer ${secret}`) throw new UnauthorizedException();
    const ev = body.event;
    if (!ev?.id || !ev.type || !ev.app_user_id) return {};
    const inserted = await this.db
      .insert(billingEvents)
      .values({ id: ev.id, type: ev.type, appUserId: ev.app_user_id, payload: ev })
      .onConflictDoNothing()
      .returning({ id: billingEvents.id });
    if (inserted.length === 0) return {}; // 중복 전달
    // 익명 ID($RCAnonymousID:...)나 우리 users에 없는 id는 무시 — 로그인 전 구매는 logIn 뒤 sync로 들어온다
    if (!UUID_RE.test(ev.app_user_id)) return {};
    const [user] = await this.db.select({ id: users.id }).from(users).where(eq(users.id, ev.app_user_id));
    if (!user) return {};
    await this.sync.syncUser(ev.app_user_id, { attributeBandId: ev.subscriber_attributes?.band_id?.value });
    return {};
  }
}
```

`billing.module.ts`에 `revenueCatClientProvider`, `billingSyncServiceProvider`를 providers에, `BillingSyncController`, `RevenueCatWebhookController`를 controllers에 추가한다. `BillingSyncController`가 `MembershipsService`를 쓰므로 모듈은 이미 `MembershipsModule`을 import하고 있다.

- [ ] **Step 8: 통과 확인**

```bash
pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/billing-sync.e2e-spec.ts
pnpm --filter @bandapp/api build
pnpm --filter @bandapp/api lint
```

Expected: PASS (8 tests), 빌드·린트 통과.

- [ ] **Step 9: `.env.example`에 변수 추가**

루트 `.env.example`에:

```
# RevenueCat (결제). 서버용 secret API key와 웹훅 Authorization 값
REVENUECAT_API_KEY=
REVENUECAT_WEBHOOK_SECRET=
```

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/billing apps/api/test .env.example
git commit -m "feat(api): RevenueCat sync service, /billing/sync, webhook"
```

---

### Task 7: api-client — `bands.billing/linkPool/unlinkPool`, `billing.sync`, Mock 결제 상태

**Files:**
- Modify: `packages/api-client/src/client.ts`
- Modify: `packages/api-client/src/http/HttpApiClient.ts`
- Modify: `packages/api-client/src/mock/seed.ts`
- Modify: `packages/api-client/src/mock/MockApiClient.ts`
- Test: `packages/api-client/src/http/HttpApiClient.spec.ts`
- Test: `packages/api-client/src/mock/MockApiClient.test.ts`

**Interfaces:**
- Consumes: `@bandapp/types` `BandBilling`.
- Produces (`RehearsalApiClient`):
  ```ts
  bands: { ...; billing(bandId): Promise<BandBilling>; linkPool(bandId): Promise<BandBilling>; unlinkPool(bandId): Promise<BandBilling> };
  billing: { sync(bandId?: string): Promise<BandBilling | null> };
  ```
  Mock 전용(테스트·프리뷰용, 인터페이스 밖): `MockApiClient.mockPurchase(product: "band" | "plus" | "extra", bandId: string): void` — 스토어 구매를 흉내 내 상태를 바꾼다.

- [ ] **Step 1: Http 테스트 추가**

`HttpApiClient.spec.ts`의 기존 패턴(`fetchFn` mock, `client.bands.setMyPart` 테스트 참고)으로:

```ts
  it("bands.billing은 GET /bands/:id/billing", async () => {
    const { client, fetchFn } = makeClient({ state: "free" });
    await client.bands.billing("b1");
    expect(fetchFn).toHaveBeenCalledWith("https://api.test/bands/b1/billing", expect.objectContaining({ method: "GET" }));
  });

  it("bands.linkPool/unlinkPool은 POST이고 emit한다", async () => {
    const { client, fetchFn } = makeClient({ state: "linked" });
    const listener = vi.fn();
    client.subscribe(listener);
    await client.bands.linkPool("b1");
    await client.bands.unlinkPool("b1");
    expect(fetchFn).toHaveBeenCalledWith("https://api.test/bands/b1/billing/link", expect.objectContaining({ method: "POST" }));
    expect(fetchFn).toHaveBeenCalledWith("https://api.test/bands/b1/billing/unlink", expect.objectContaining({ method: "POST" }));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("billing.sync는 POST /billing/sync에 bandId를 보내고 emit한다", async () => {
    const { client, fetchFn } = makeClient({ state: "linked" });
    const listener = vi.fn();
    client.subscribe(listener);
    await client.billing.sync("b1");
    expect(fetchFn).toHaveBeenCalledWith("https://api.test/billing/sync", expect.objectContaining({ method: "POST", body: JSON.stringify({ bandId: "b1" }) }));
    expect(listener).toHaveBeenCalledTimes(1);
  });
```

`makeClient`가 그 파일에 없으면 기존 테스트가 쓰는 헬퍼 이름으로 바꾼다 (파일 상단을 읽고 맞춘다). 응답 본문 인자는 그 헬퍼의 시그니처에 맞춘다.

- [ ] **Step 2: 인터페이스·Http 구현**

`client.ts` import에 `BandBilling` 추가, `bands`에:

```ts
    /** 밴드 결제 상태. 멤버 누구나. 디자인 B01의 재료 */
    billing(bandId: string): Promise<BandBilling>;
    /** Owner 전용. 내 활성 풀에 연결. 409 billing_no_active_pool */
    linkPool(bandId: string): Promise<BandBilling>;
    /** Owner 전용. 연결 해제 — 밴드는 무료로 돌아가고 추가 시간은 남는다 */
    unlinkPool(bandId: string): Promise<BandBilling>;
```

`invites` 앞에:

```ts
  billing: {
    /** 구매 직후·"Check status"에서. 서버가 RevenueCat 상태를 다시 읽는다. bandId가 있으면 그 밴드 billing을 돌려준다 */
    sync(bandId?: string): Promise<BandBilling | null>;
  };
```

`HttpApiClient.ts` `bands`에:

```ts
    billing: (bandId: string): Promise<BandBilling> => this.request<BandBilling>("GET", `/bands/${bandId}/billing`),
    linkPool: async (bandId: string): Promise<BandBilling> => {
      const b = await this.request<BandBilling>("POST", `/bands/${bandId}/billing/link`);
      this.emit();
      return b;
    },
    unlinkPool: async (bandId: string): Promise<BandBilling> => {
      const b = await this.request<BandBilling>("POST", `/bands/${bandId}/billing/unlink`);
      this.emit();
      return b;
    },
```

그리고:

```ts
  billing = {
    sync: async (bandId?: string): Promise<BandBilling | null> => {
      const b = await this.request<BandBilling | null>("POST", "/billing/sync", bandId ? { bandId } : {});
      this.emit();
      return b;
    },
  };
```

- [ ] **Step 3: Mock 상태와 구현**

`seed.ts` `MockState`에:

```ts
  /** 결제 — 디자인 프로토타입의 bill()과 같은 역할. 풀은 MOCK_USER 것 하나 */
  billing: {
    pool: { plan: "band" | "plus" | null; status: "active" | "grace" | "expired"; usedSec: number; periodEnd: string; willRenew: boolean };
    /** bandId → 밴드별 상태 */
    bands: Record<string, { linked: boolean; freeUsedSec: number; extraSec: number }>;
  };
```

시드 기본값(seed 함수가 state를 만드는 곳): `pool: { plan: null, status: "expired", usedSec: 0, periodEnd: "2026-11-03T00:00:00.000Z", willRenew: false }`, `bands: { b1: { linked: false, freeUsedSec: 1800, extraSec: 0 } }`. 디자인 기본 시나리오(무료, 30분 사용)와 같다.

`MockApiClient.ts` import에 `BandBilling`(`@bandapp/types`)을 추가하고, private 헬퍼와 메서드:

```ts
  private bandBilling(bandId: string): BandBilling {
    const members = this.state.members[bandId] ?? [];
    const me = members.find((m) => m.id === MOCK_USER.id);
    if (!me) throw new ApiError(403, "이 밴드에 접근할 수 없어요.", "band_forbidden");
    const pool = this.state.billing.pool;
    const bb = (this.state.billing.bands[bandId] ??= { linked: false, freeUsedSec: 0, extraSec: 0 });
    const H = 3600;
    const poolActive = pool.plan !== null && pool.status !== "expired";
    const monthlyTotalSec = poolActive ? (pool.plan === "plus" ? 40 : 20) * H : 0;
    const state: BandBilling["state"] = !bb.linked ? "free" : poolActive ? "linked" : "expired";
    const monthlyLeftSec = state === "linked" ? Math.max(0, monthlyTotalSec - pool.usedSec) : 0;
    const freeLeftSec = Math.max(0, 3 * H - bb.freeUsedSec);
    const owner = members.find((m) => m.role === "owner") ?? me;
    const isOwner = me.role === "owner";
    const linkedBandCount = Object.values(this.state.billing.bands).filter((b) => b.linked).length;
    return {
      state,
      plan: bb.linked ? pool.plan : null,
      periodEnd: bb.linked ? pool.periodEnd : null,
      willRenew: bb.linked && pool.willRenew,
      store: bb.linked ? "app_store" : null,
      availableSec: (state === "linked" ? monthlyLeftSec : freeLeftSec) + bb.extraSec,
      monthlyTotalSec: state === "linked" ? monthlyTotalSec : 0,
      monthlyLeftSec,
      monthlyUsedSec: state === "linked" ? pool.usedSec : 0,
      extraSec: bb.extraSec,
      freeLeftSec,
      owner: { id: owner.id, displayName: owner.name },
      isOwner,
      linkedBandCount: bb.linked ? linkedBandCount : 0,
      canBuyExtra: state === "linked",
      myPool: isOwner && pool.plan
        ? {
            plan: pool.plan,
            status: pool.status,
            monthlyLeftSec: poolActive ? Math.max(0, monthlyTotalSec - pool.usedSec) : 0,
            bands: this.state.bands
              .filter((b) => (this.state.members[b.id] ?? []).some((m) => m.id === MOCK_USER.id && m.role === "owner"))
              .map((b) => ({ id: b.id, name: b.name, memberCount: b.memberCount, linked: this.state.billing.bands[b.id]?.linked ?? false })),
          }
        : null,
    };
  }

  /** 테스트·프리뷰용: 스토어 구매를 흉내 낸다. 인터페이스 밖 */
  mockPurchase(product: "band" | "plus" | "extra", bandId: string): void {
    const bb = (this.state.billing.bands[bandId] ??= { linked: false, freeUsedSec: 0, extraSec: 0 });
    if (product === "extra") bb.extraSec += 3 * 3600;
    else {
      const pool = this.state.billing.pool;
      const fresh = pool.plan === null || pool.status === "expired";
      Object.assign(pool, { plan: product, status: "active", willRenew: true, usedSec: fresh ? 0 : pool.usedSec });
      bb.linked = true;
    }
    this.emit();
  }
```

`bands`에 `billing`, `linkPool`, `unlinkPool`:

```ts
    billing: async (bandId: string): Promise<BandBilling> => this.bandBilling(bandId),
    linkPool: async (bandId: string): Promise<BandBilling> => {
      this.assertOwner(bandId);
      const pool = this.state.billing.pool;
      if (!pool.plan || pool.status === "expired") throw new ApiError(409, "활성 구독이 없어요.", "billing_no_active_pool");
      (this.state.billing.bands[bandId] ??= { linked: false, freeUsedSec: 0, extraSec: 0 }).linked = true;
      this.emit();
      return this.bandBilling(bandId);
    },
    unlinkPool: async (bandId: string): Promise<BandBilling> => {
      this.assertOwner(bandId);
      (this.state.billing.bands[bandId] ??= { linked: false, freeUsedSec: 0, extraSec: 0 }).linked = false;
      this.emit();
      return this.bandBilling(bandId);
    },
```

`billing`:

```ts
  billing = {
    // Mock은 mockPurchase가 이미 상태를 바꿨으므로 sync는 조회만
    sync: async (bandId?: string): Promise<BandBilling | null> => (bandId ? this.bandBilling(bandId) : null),
  };
```

`transferOwnership` mock 끝에 `const bb = this.state.billing.bands[bandId]; if (bb) bb.linked = false;` 추가 (서버와 같은 규칙).

Mock 분석 흐름(기존 `completeUpload`/`upload`에서 `analyzing` → `ready`로 바꾸는 타이머)에 게이트를 넣는다: 세션을 `ready`로 바꾸기 전에 `this.bandBilling(s.bandId).availableSec < s.durationSec`이면 `s.status = "waiting_for_time"`으로 두고 끝낸다. 충분하면 사용량을 깎는다 — linked면 `pool.usedSec += ...`, 아니면 `bb.freeUsedSec += ...`, 남는 건 `bb.extraSec`에서. `retryAnalysis`는 `waiting_for_time`도 받아 같은 흐름을 다시 탄다.

- [ ] **Step 4: Mock 테스트**

`MockApiClient.test.ts`에:

```ts
  it("무료 밴드는 3h 중 30분 사용 상태로 시작한다", async () => {
    const api = new MockApiClient();
    const b = await api.bands.billing("b1");
    expect(b).toMatchObject({ state: "free", freeLeftSec: 2.5 * 3600, availableSec: 2.5 * 3600, isOwner: true, canBuyExtra: false });
  });

  it("mockPurchase('band')로 linked가 되고, unlinkPool로 free로 돌아간다", async () => {
    const api = new MockApiClient();
    api.mockPurchase("band", "b1");
    expect((await api.bands.billing("b1")).state).toBe("linked");
    expect((await api.bands.billing("b1")).monthlyLeftSec).toBe(20 * 3600);
    await api.bands.unlinkPool("b1");
    expect((await api.bands.billing("b1")).state).toBe("free");
  });

  it("활성 풀 없이 linkPool하면 409 billing_no_active_pool", async () => {
    const api = new MockApiClient();
    await expect(api.bands.linkPool("b1")).rejects.toMatchObject({ code: "billing_no_active_pool" });
  });

  it("남은 시간보다 긴 녹음은 waiting_for_time이 되고, 시간을 사면 retry로 분석된다", async () => {
    vi.useFakeTimers();
    const api = new MockApiClient();
    const s = await api.sessions.upload("b1", { startedAt: "2026-10-03T19:00:00+09:00", durationMs: 4 * 3600 * 1000, sizeBytes: 1, contentType: "audio/mp4", source: "recording" }, { sizeBytes: 1, readPart: async () => new Uint8Array(1) });
    await vi.runAllTimersAsync();
    expect((await api.sessions.get(s.id)).status).toBe("waiting_for_time");
    api.mockPurchase("band", "b1");
    await api.sessions.retryAnalysis(s.id);
    await vi.runAllTimersAsync();
    expect((await api.sessions.get(s.id)).status).toBe("ready");
    vi.useRealTimers();
  });
```

`upload`의 두 번째 인자 형태는 기존 `MockApiClient` 테스트에서 쓰는 `CreateSessionInput`·`UploadSource`에 맞춘다.

- [ ] **Step 5: 테스트·빌드**

```bash
pnpm --filter @bandapp/api-client test
pnpm --filter @bandapp/api-client build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/api-client
git commit -m "feat(api-client): billing endpoints and mock purchase flow"
```

---

### Task 8: 모바일 — `react-native-purchases` 설치와 `purchases` 서비스

**Files:**
- Modify: `apps/mobile/package.json` (의존성)
- Modify: `apps/mobile/.env.example`
- Create: `apps/mobile/src/services/purchases.ts`
- Create: `apps/mobile/src/services/purchases.mock.ts`
- Modify: `apps/mobile/src/features/auth/AuthProvider.tsx` (logIn/logOut)
- Modify: `apps/mobile/app/_layout.tsx` (configure)

**Interfaces:**
- Produces:
  ```ts
  // services/purchases.ts — 앱이 쓰는 유일한 결제 SDK 표면. 실/Mock 둘 다 이 모양
  export type ProductKey = "band" | "plus" | "extra";
  export interface StorePrice { key: ProductKey; priceString: string } // 스토어 현지 통화 문자열
  export type PurchaseOutcome = "success" | "cancelled" | "pending" | "failed";
  export interface PurchasesApi {
    configure(): void;                       // 앱 시작 1회
    logIn(userId: string): Promise<void>;
    logOut(): Promise<void>;
    prices(): Promise<StorePrice[]>;         // getOfferings
    purchase(key: ProductKey, opts: { bandId: string; currentPlan: "band" | "plus" | null }): Promise<PurchaseOutcome>;
    manageSubscriptions(): Promise<void>;    // 스토어 구독 관리 화면
    storeName(): "App Store" | "Google Play";
  }
  export const purchases: PurchasesApi;      // EXPO_PUBLIC_API_URL 비면 mock
  export const PRODUCT_IDS: Record<ProductKey, string>; // 서버 plans.ts와 같은 값
  ```

- [ ] **Step 1: 설치**

```bash
pnpm --filter mobile add react-native-purchases
```

네이티브 모듈이라 dev client를 다시 빌드해야 한다 (`pnpm --filter mobile android` — Windows는 [windows-android-build](../../..) 메모 참고). 웹 Mock 프리뷰는 mock 구현만 쓰므로 영향 없다.

`apps/mobile/.env.example`에:

```
# RevenueCat public SDK keys (플랫폼별). 비어 있으면 결제 화면이 "가격을 불러올 수 없음"으로 끝난다
EXPO_PUBLIC_RC_IOS_KEY=
EXPO_PUBLIC_RC_ANDROID_KEY=
```

- [ ] **Step 2: 실 구현**

`apps/mobile/src/services/purchases.ts`:

```ts
import { Platform } from "react-native";
import Purchases, { LOG_LEVEL, PURCHASES_ERROR_CODE, type PurchasesPackage } from "react-native-purchases";
import { purchasesMock } from "./purchases.mock";

export type ProductKey = "band" | "plus" | "extra";
export interface StorePrice {
  key: ProductKey;
  priceString: string;
}
export type PurchaseOutcome = "success" | "cancelled" | "pending" | "failed";

export interface PurchasesApi {
  configure(): void;
  logIn(userId: string): Promise<void>;
  logOut(): Promise<void>;
  prices(): Promise<StorePrice[]>;
  purchase(key: ProductKey, opts: { bandId: string; currentPlan: "band" | "plus" | null }): Promise<PurchaseOutcome>;
  manageSubscriptions(): Promise<void>;
  storeName(): "App Store" | "Google Play";
}

/** 서버 billing/plans.ts와 같은 값. 바꾸면 양쪽을 같이 바꾼다 */
export const PRODUCT_IDS: Record<ProductKey, string> = {
  band: "rehearsal.band.monthly",
  plus: "rehearsal.plus.monthly",
  extra: "rehearsal.extra.3h",
};

function keyOf(productId: string): ProductKey | null {
  return (Object.keys(PRODUCT_IDS) as ProductKey[]).find((k) => PRODUCT_IDS[k] === productId) ?? null;
}

const real: PurchasesApi = {
  configure() {
    const apiKey = Platform.OS === "ios" ? process.env.EXPO_PUBLIC_RC_IOS_KEY : process.env.EXPO_PUBLIC_RC_ANDROID_KEY;
    if (!apiKey) {
      console.warn("[purchases] RevenueCat key가 없어 결제가 동작하지 않는다 (.env.example 참고)");
      return;
    }
    Purchases.setLogLevel(__DEV__ ? LOG_LEVEL.DEBUG : LOG_LEVEL.ERROR);
    Purchases.configure({ apiKey });
  },
  async logIn(userId) {
    // 우리 users.id가 RevenueCat app_user_id — 서버 웹훅이 이 값으로 사용자를 찾는다
    await Purchases.logIn(userId);
  },
  async logOut() {
    if (!(await Purchases.isAnonymous())) await Purchases.logOut();
  },
  async prices() {
    const offerings = await Purchases.getOfferings();
    const packages = offerings.current?.availablePackages ?? [];
    return packages
      .map((p) => ({ key: keyOf(p.product.identifier), priceString: p.product.priceString }))
      .filter((x): x is StorePrice => x.key !== null);
  },
  async purchase(key, { bandId, currentPlan }) {
    const offerings = await Purchases.getOfferings();
    const pkg = offerings.current?.availablePackages.find((p) => p.product.identifier === PRODUCT_IDS[key]);
    if (!pkg) return "failed";
    // 소모성은 어느 밴드 것인지 웹훅이 알 수 있게 속성으로 남긴다 (앱이 sync를 못 부르고 죽는 경우 대비)
    await Purchases.setAttributes({ band_id: bandId });
    try {
      await Purchases.purchasePackage(pkg, upgradeInfo(key, currentPlan));
      return "success";
    } catch (e) {
      const err = e as { code?: string; userCancelled?: boolean };
      if (err.userCancelled || err.code === PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR) return "cancelled";
      if (err.code === PURCHASES_ERROR_CODE.PAYMENT_PENDING_ERROR) return "pending";
      return "failed";
    }
  },
  async manageSubscriptions() {
    await Purchases.showManageSubscriptions();
  },
  storeName() {
    return Platform.OS === "ios" ? "App Store" : "Google Play";
  },
};

/** Android는 기존 구독을 교체해야 업·다운그레이드가 된다. iOS는 같은 구독 그룹이라 스토어가 처리 */
function upgradeInfo(key: ProductKey, currentPlan: "band" | "plus" | null) {
  if (Platform.OS !== "android" || key === "extra" || !currentPlan || currentPlan === key) return undefined;
  return { oldProductIdentifier: PRODUCT_IDS[currentPlan] } as unknown as Parameters<typeof Purchases.purchasePackage>[1];
}

export const purchases: PurchasesApi = process.env.EXPO_PUBLIC_API_URL ? real : purchasesMock;
```

`purchasePackage`의 두 번째 인자 타입은 설치된 react-native-purchases 버전의 d.ts를 열어 확인한다 (`node_modules/react-native-purchases/dist/purchases.d.ts`에서 `purchasePackage(`를 찾는다). `{ oldProductIdentifier }`가 `GoogleProductChangeInfo`로 받아들여지면 cast를 지우고 그 타입을 import한다.

- [ ] **Step 3: Mock 구현**

`apps/mobile/src/services/purchases.mock.ts`:

```ts
import type { PurchasesApi } from "./purchases";

/**
 * 웹 프리뷰·Expo Go용. 가격은 디자인 프로토타입 값, 구매는 0.8초 뒤 성공.
 * 실제 상태 변화는 화면이 MockApiClient.mockPurchase로 만든다 (purchase 성공 뒤 sync 전에).
 */
export const purchasesMock: PurchasesApi = {
  configure() {},
  async logIn() {},
  async logOut() {},
  async prices() {
    await new Promise((r) => setTimeout(r, 800));
    return [
      { key: "band", priceString: "$15" },
      { key: "plus", priceString: "$25" },
      { key: "extra", priceString: "$3" },
    ];
  },
  async purchase() {
    await new Promise((r) => setTimeout(r, 800));
    return "success";
  },
  async manageSubscriptions() {},
  storeName() {
    return "App Store";
  },
};
```

- [ ] **Step 4: 앱에 연결**

`app/_layout.tsx` `RootLayout`의 `useEffect` 안(`pendingUploads.sweepOrphans()` 옆)에 `purchases.configure();` 추가 (`import { purchases } from "@/services/purchases";`).

`AuthProvider.tsx`: 로그인 성공 경로 세 곳(복원 `settle({status:"authenticated"})` 직후, `signInWithGoogle`, `signInWithApple`)에서 `void purchases.logIn(res.user.id)` (복원 쪽은 `user.id`). `signOut`과 `deleteAccount`에서 `await purchases.logOut().catch(() => {})`. 실패해도 로그인은 막지 않는다 — 결제 화면에서 sync가 다시 맞춘다.

- [ ] **Step 5: 타입 확인**

```bash
pnpm --filter mobile typecheck
```

Expected: 통과.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/package.json pnpm-lock.yaml apps/mobile/.env.example apps/mobile/src/services apps/mobile/app/_layout.tsx apps/mobile/src/features/auth/AuthProvider.tsx
git commit -m "feat(mobile): react-native-purchases service with mock"
```

---

### Task 9: 모바일 — 결제 표시용 순수 로직과 i18n 키

**Files:**
- Create: `apps/mobile/src/features/billing/billingView.ts`
- Test: `apps/mobile/src/features/billing/billingView.test.ts`
- Modify: `apps/mobile/src/i18n/en.ts`, `apps/mobile/src/i18n/ko.ts`

**Interfaces:**
- Produces:
  ```ts
  export function fmtH(sec: number): string;                 // "2h 30m" / "45m" / "0h" (디자인 fmtH)
  export function monthDay(iso: string | null): string;      // "Nov 3"
  export type PurchasePhase = "checking" | "success" | "failed" | "pending" | "delayed" | "canceled" | "resumed";
  export function phaseAfterSync(outcome: "success"|"pending"|"failed", before: BandBilling, after: BandBilling | null, product: ProductKey): PurchasePhase;
  export function noTimeActions(b: BandBilling, needSec: number): Array<"viewPlans" | "resubscribe" | "addToPlan" | "buyExtra" | "viewPlus" | "notNow">; // 디자인 ntActions
  ```

- [ ] **Step 1: 테스트**

`billingView.test.ts` (상대 import, `@/` 금지):

```ts
import type { BandBilling } from "@bandapp/types";
import { describe, expect, it } from "vitest";
import { fmtH, monthDay, noTimeActions, phaseAfterSync } from "./billingView";

const H = 3600;
const base: BandBilling = {
  state: "free", plan: null, periodEnd: null, willRenew: false, store: null,
  availableSec: 3 * H, monthlyTotalSec: 0, monthlyLeftSec: 0, monthlyUsedSec: 0, extraSec: 0, freeLeftSec: 3 * H,
  owner: { id: "u1", displayName: "Minsu" }, isOwner: true, linkedBandCount: 0, canBuyExtra: false, myPool: null,
};
const linked: BandBilling = { ...base, state: "linked", plan: "band", monthlyTotalSec: 20 * H, monthlyLeftSec: 5 * H, availableSec: 5 * H, canBuyExtra: true, linkedBandCount: 1 };

describe("fmtH", () => {
  it.each([[0, "0h"], [45 * 60, "45m"], [2 * H, "2h"], [2 * H + 30 * 60, "2h 30m"], [-5, "0h"]])("%s → %s", (sec, out) => {
    expect(fmtH(sec)).toBe(out);
  });
});

describe("monthDay", () => {
  it("ISO를 'Nov 3'로", () => expect(monthDay("2026-11-03T00:00:00.000Z")).toBe("Nov 3"));
  it("null은 빈 문자열", () => expect(monthDay(null)).toBe(""));
});

describe("phaseAfterSync", () => {
  it("구독이 linked로 반영되면 success", () => expect(phaseAfterSync("success", base, linked, "band")).toBe("success"));
  it("구독했는데 아직 free면 delayed", () => expect(phaseAfterSync("success", base, base, "band")).toBe("delayed"));
  it("추가 시간이 늘었으면 success, 아니면 delayed", () => {
    expect(phaseAfterSync("success", linked, { ...linked, extraSec: 3 * H }, "extra")).toBe("success");
    expect(phaseAfterSync("success", linked, linked, "extra")).toBe("delayed");
  });
  it("pending/failed는 그대로", () => {
    expect(phaseAfterSync("pending", base, null, "band")).toBe("pending");
    expect(phaseAfterSync("failed", base, null, "band")).toBe("failed");
  });
});

describe("noTimeActions", () => {
  it("오너 + 무료 → View plans", () => expect(noTimeActions(base, 4 * H)).toEqual(["viewPlans", "notNow"]));
  it("멤버 + 무료 → Not now만", () => expect(noTimeActions({ ...base, isOwner: false }, 4 * H)).toEqual(["notNow"]));
  it("오너 + 풀 있음 + 미연결 → Add to my plan", () => {
    const b: BandBilling = { ...base, myPool: { plan: "band", status: "active", monthlyLeftSec: 10 * H, bands: [] } };
    expect(noTimeActions(b, 4 * H)).toEqual(["addToPlan", "notNow"]);
  });
  it("오너 + 만료 → Resubscribe", () => expect(noTimeActions({ ...base, state: "expired", plan: "band" }, 4 * H)).toEqual(["resubscribe", "notNow"]));
  it("linked band 플랜 → Buy 3h + View Plus", () => expect(noTimeActions(linked, 6 * H)).toEqual(["buyExtra", "viewPlus", "notNow"]));
  it("linked plus 플랜 → Buy 3h만", () => expect(noTimeActions({ ...linked, plan: "plus" }, 6 * H)).toEqual(["buyExtra", "notNow"]));
  it("linked 멤버 → Buy 3h만", () => expect(noTimeActions({ ...linked, isOwner: false }, 6 * H)).toEqual(["buyExtra", "notNow"]));
});
```

- [ ] **Step 2: 실패 확인**

```bash
pnpm --filter mobile exec vitest run src/features/billing
```

- [ ] **Step 3: 구현**

`billingView.ts`:

```ts
import type { BandBilling } from "@bandapp/types";
import type { ProductKey } from "../../services/purchases";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 디자인 프로토타입 fmtH: 분 단위 반올림, "2h 30m" / "45m" / "0h" */
export function fmtH(sec: number): string {
  const m = Math.round(Math.max(0, sec) / 60);
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!m) return "0h";
  if (h && r) return `${h}h ${r}m`;
  return h ? `${h}h` : `${r}m`;
}

export function monthDay(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export type PurchasePhase = "checking" | "success" | "failed" | "pending" | "delayed" | "canceled" | "resumed";

/** 구매 결과 + sync 뒤 상태 → B06 화면 (디자인 P 테이블). 스토어는 됐는데 서버가 아직이면 delayed */
export function phaseAfterSync(
  outcome: "success" | "pending" | "failed",
  before: BandBilling,
  after: BandBilling | null,
  product: ProductKey,
): PurchasePhase {
  if (outcome !== "success") return outcome;
  if (!after) return "delayed";
  if (product === "extra") return after.extraSec > before.extraSec ? "success" : "delayed";
  return after.state === "linked" && after.plan === product ? "success" : "delayed";
}

export type NoTimeAction = "viewPlans" | "resubscribe" | "addToPlan" | "buyExtra" | "viewPlus" | "notNow";

/** B03 시트 버튼 (디자인 ntActions) */
export function noTimeActions(b: BandBilling, _needSec: number): NoTimeAction[] {
  if (!b.isOwner) return b.state === "linked" ? ["buyExtra", "notNow"] : ["notNow"];
  if (b.state === "linked") return b.plan === "band" ? ["buyExtra", "viewPlus", "notNow"] : ["buyExtra", "notNow"];
  if (b.state === "expired") return ["resubscribe", "notNow"];
  if (b.myPool && b.myPool.status !== "expired" && b.myPool.plan) return ["addToPlan", "notNow"];
  return ["viewPlans", "notNow"];
}
```

- [ ] **Step 4: i18n 키**

`en.ts`에 `billing` 섹션 (디자인 문구 그대로). `ko.ts`에 같은 키의 한국어. 보간은 `{{band}}`, `{{owner}}`, `{{n}}`, `{{time}}`, `{{date}}`, `{{price}}`, `{{plan}}`, `{{store}}`.

```ts
  billing: {
    card: { planUsage: "Plan & usage", unavailable: "Plan details unavailable", summary: "{{plan}} · {{time}} available" },
    planName: { free: "Free", band: "Band", plus: "Plus" },
    b01: {
      title: "Plan & usage", back: "Band", membersMeta: "{{band}} · {{n}} MEMBERS",
      loading: "Checking your plan…", failTitle: "Couldn’t load your plan",
      failBody: "Your plan and analysis time will show once we can confirm them. Recordings and takes are still available.", retry: "Retry",
      planSuffix: "{{plan}} plan", metaRenews: "{{price}} / month · Renews {{date}}", metaCanceled: "Renewal canceled · Active until {{date}}",
      metaOwnersPlan: "{{owner}}’s plan", metaEnded: "{{plan}} plan ended {{date}}", metaFree: "3h once per band",
      shareOwner: "Sharing time across {{n}} bands", shareMember: "Shared by {{owner}} across {{n}} bands", manage: "Manage",
      availableNow: "AVAILABLE NOW", subMonthly: "Monthly time", subMonthlyExtra: "{{time}} monthly + {{extra}} extra",
      subFree: "Free time", subFreeExtra: "{{time}} free + {{extra}} extra",
      addTitle: "Add this band to my plan", addBody: "Your {{plan}} plan has {{time}} left this month.", addCta: "Add to my plan",
      monthly: "Monthly time", leftOf: "{{time}} left of {{total}}", used: "Used", left: "Left",
      resetNote: "Shared across {{n}} bands. Resets on {{date}} and doesn’t carry over.",
      freeTime: "Free time", freeLeftOf: "{{time}} left of 3h", freeNote: "Each band gets 3h once. It doesn’t reset.",
      extra: "Extra time", extraNoteLinked: "Bought separately. Used after monthly time and kept when your month renews.",
      extraNoteFree: "Bought separately. Used after free time.", extraNoteExpired: "Bought while the plan was active. Still yours to use.",
      buyExtra: "Buy extra time", viewPlans: "View plans", resubscribe: "Resubscribe", changePlan: "Change plan",
      noteOnlyOwner: "Only {{owner}} can change the plan.", noteEnded: "{{owner}}’s plan ended. Extra time stays available.",
      noteAsk: "Ask {{owner}} to add {{band}} to their plan.",
    },
    b01a: {
      title: "Bands on your plan", back: "Plan & usage", sub: "{{plan}} plan · {{time}} / month, shared",
      onPlan: "ON YOUR PLAN · {{n}}", none: "No bands on your plan yet.", thisBand: "THIS BAND", members: "{{n}} members", thisBandMeta: "{{n}} members · this band",
      remove: "Remove", others: "OTHER BANDS YOU OWN", add: "Add",
      footer: "Bands on your plan share its monthly time. A removed band goes back to Free — its recordings, takes, and extra time stay.",
      removeTitle: "Remove {{band}} from your plan?", removeBody: "{{band}} goes back to Free. Its recordings, takes, and extra time stay.", removePrimary: "Remove from plan",
      addedToast: "{{band}} added to your plan",
    },
    b02: {
      back: "Back", title: "More time for your band", sub: "Your plan covers {{band}} and any other band you own.",
      current: "CURRENT PLAN", perMonth: "of analysis / month", price: "{{price}} / month",
      note: "Share recordings and edit takes for free. Use AI when you need it.",
      cancel: "Cancel subscription", cancelSub: "Managed in the {{store}}. {{plan}} stays active until {{date}}.",
      resumeNote: "Renewal canceled. {{plan}} stays active until {{date}}.", resume: "Resume subscription",
      cta: "Continue with {{plan}}", fine: "Billed monthly through the {{store}}. Renews automatically until you cancel in {{store}} settings.",
      loadingPrices: "Loading prices from the {{store}}…", terms: "Terms", privacy: "Privacy", keepFree: "Keep using Free",
    },
    b04: {
      back: "Plans", titleNew: "Review subscription", titleChange: "Change to {{plan}}", label: "{{plan}} PLAN", perMonth: "/ month",
      forBand: "For {{band}}", sharedBy: "Shared by all {{n}} members · add other bands you own anytime",
      rowCurrent: "Current plan", rowNew: "New plan", rowBilledThrough: "Billed through", rowTime: "Analysis time", rowBilling: "Billing", rowRenewal: "Next renewal",
      vMonthly: "{{price}} / month", vTime: "{{time}} / month", vBilling: "Monthly · renews automatically",
      ctxOk: "{{session}} ({{time}}) can be analyzed once the plan is active.", ctxShort: "Still {{time}} short for {{session}} after this change.",
      noteChange: "The {{store}} will show the amount and when the change applies before you confirm. Your current time stays available until then.",
      noteNew: "You’ll confirm in the {{store}}. Cancel anytime in {{store}} settings — your recordings and takes stay available.",
      ctaChange: "Change to {{plan}}", ctaNew: "Subscribe · {{price}}/month", help: "Billing help",
    },
    b05: {
      back: "Back", title: "Add analysis time", forBand: "For {{band}}", hours: "3 hours", oneTime: "{{price}} · One-time purchase",
      rowNow: "Available now", rowExtra: "Extra time now", rowAfter: "After purchase",
      ctxOk: "After analyzing this recording, {{time}} left.", ctxShort: "Still {{time}} short for this recording after buying 3h.",
      note: "Monthly time is used first. Extra time stays when your month renews.",
      ctaAnalyze: "Buy 3h and analyze", cta: "Buy 3h · {{price}}", ctaSubAnalyze: "{{price}} one-time · then uses {{time}} to analyze {{session}}", ctaSub: "One-time purchase · doesn’t renew",
    },
    b06: {
      checkingSub: "Checking subscription status…", checking: "Checking your purchase…", checkingBody: "{{product}} for {{band}}. This usually takes a few seconds.",
      productExtra: "3 hours of analysis", productPlan: "{{plan}} plan",
      successExtra: "3h added", successPlan: "{{plan}} activated", successExtraBody: "Extra time is ready for everyone in {{band}}.", successPlanBody: "Everyone in {{band}} can use the plan now.",
      rowPurchase: "Purchase", vOneTime: "One-time · {{price}}", rowAvailable: "Available now", rowTime: "Analysis time", rowRenews: "Renews", vRenews: "{{date}} · {{price}}",
      continueAnalysis: "Continue analysis", done: "Done",
      failed: "Purchase couldn’t be completed", failedBody: "The {{store}} didn’t finish the purchase. Nothing changed for {{band}}.", tryAgain: "Try again", back: "Back",
      pending: "Purchase pending", pendingBody: "We’ll update your plan when the purchase is confirmed. You don’t need to buy again.", rowProduct: "Product", rowBand: "Band",
      delayed: "Your purchase is confirmed", delayedBody: "We’re updating your band’s access. This can take a moment.", checkStatus: "Check status",
      canceled: "Renewal canceled", canceledBody: "{{plan}} stays active for {{band}} until {{date}}. Your recordings and takes stay available.", rowActiveUntil: "Active until", rowAfter: "After that", vAfter: "Free · 3h once per band",
      resumed: "Subscription resumed", resumedBody: "{{plan}} will renew on {{date}}.",
    },
    b03: {
      title: "You need {{time}} more", session: "{{session}} · {{time}} recording", avail: "{{time}} available in {{band}}",
      resetMonthly: "Monthly time resets on {{date}}.", resetFree: "Free time is 3h once per band and doesn’t reset.",
      hintOnlyOwner: "Only {{owner}} can change the plan.", hintAsk: "Ask {{owner}} to add {{band}} to their plan.",
      short: "Buying 3h still leaves {{time}} short.",
      viewPlans: "View plans", resubscribe: "Resubscribe", addToPlan: "Add to my plan · {{time}} left", buyExtra: "Buy 3h for {{price}}", viewPlus: "View Plus", notNow: "Not now",
      footer: "You can still listen, comment, and add takes manually.", savedToast: "Saved. Analyze it anytime from Sessions.",
    },
    sessionRow: { waiting: "Waiting for analysis time — tap for options" },
    transferNote: " {{band}} will be removed from your plan.",
  },
```

`errors`에 `billing_owner_only`, `billing_no_active_pool`, `billing_band_linked_elsewhere` 추가 (en: "Only the band owner can change the plan." / "There’s no active subscription." / "This band is on someone else’s plan."). `ko.ts`도 같은 키 전부.

- [ ] **Step 5: 테스트 통과**

```bash
pnpm --filter mobile test
pnpm --filter mobile typecheck
```

Expected: PASS (`resources.test.ts` 포함).

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/features/billing apps/mobile/src/i18n
git commit -m "feat(mobile): billing view helpers and i18n strings"
```

---

### Task 10: 모바일 — 결제 데이터 훅, 구매 흐름 훅, 라우트 뼈대

**Files:**
- Create: `apps/mobile/src/features/billing/useBandBilling.ts`
- Create: `apps/mobile/src/features/billing/usePurchaseFlow.ts`
- Create: `apps/mobile/src/features/billing/billingContext.ts`
- Create: `apps/mobile/app/billing/_layout.tsx`, `apps/mobile/app/billing/plan.tsx`, `linked.tsx`, `plans.tsx`, `review.tsx`, `extra.tsx`, `status.tsx`
- Create: `apps/mobile/src/features/billing/PlanScreen.tsx` 등 6개 (이 Task에서는 제목만 있는 빈 화면, Task 11~14가 채운다)

**Interfaces:**
- Produces:
  ```ts
  // useBandBilling.ts
  export function useBandBilling(bandId: string | undefined): { data: BandBilling | undefined; failed: boolean; reload(): void };
  // billingContext.ts — 결제 화면 사이에 넘기는 진입 맥락 (디자인 billCtx). 라우트 params로 전달
  export type BillingCtx = { from: "band" } | { from: "analysis"; sessionId: string; title: string; durationSec: number };
  export function ctxToParams(ctx: BillingCtx): Record<string, string>;
  export function paramsToCtx(p: Record<string, string | string[] | undefined>): BillingCtx;
  // usePurchaseFlow.ts
  export function usePurchaseFlow(bandId: string): {
    busy: boolean;
    buy(product: ProductKey, before: BandBilling, ctx: BillingCtx, ret: "/billing/plans" | "/billing/extra"): Promise<void>; // 성공/실패 모두 /billing/status로 간다(ret = 실패 시 Try again이 돌아갈 곳), cancelled는 머문다
    manage(kind: "cancel" | "resume", before: BandBilling, ctx: BillingCtx): Promise<void>; // 스토어 관리 화면 → 돌아오면 sync → status
  };
  ```
  라우트: `/billing/plan`, `/billing/linked`, `/billing/plans`, `/billing/review`, `/billing/extra`, `/billing/status` — 모두 `bandId` 쿼리 + `ctxToParams` 쿼리. `/billing/status`는 `phase`, `product`, `ret`(실패 시 돌아갈 라우트)도 받는다.

- [ ] **Step 1: 데이터 훅**

`useBandBilling.ts`:

```ts
import type { BandBilling } from "@bandapp/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "@/api";

/** useApiData와 같은 구독 갱신 패턴이지만 실패를 노출한다 — B01의 "Couldn't load your plan" + Retry 때문 */
export function useBandBilling(bandId: string | undefined) {
  const api = useApi();
  const [data, setData] = useState<BandBilling | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const reqRef = useRef(0);
  const reload = useCallback(() => {
    if (!bandId) return;
    const id = ++reqRef.current;
    setFailed(false);
    api.bands
      .billing(bandId)
      .then((b) => { if (reqRef.current === id) setData(b); })
      .catch(() => { if (reqRef.current === id) setFailed(true); });
  }, [api, bandId]);
  useEffect(() => {
    reload();
    const off = api.subscribe(reload);
    return () => { reqRef.current++; off(); };
  }, [api, reload]);
  return { data, failed, reload };
}
```

- [ ] **Step 2: 맥락 직렬화**

`billingContext.ts`:

```ts
/** 결제 화면이 어디서 열렸는지 — 분석 대기 세션에서 왔으면 성공 뒤 "Continue analysis"를 보여준다 (디자인 billCtx) */
export type BillingCtx = { from: "band" } | { from: "analysis"; sessionId: string; title: string; durationSec: number };

export function ctxToParams(ctx: BillingCtx): Record<string, string> {
  return ctx.from === "band"
    ? { from: "band" }
    : { from: "analysis", sessionId: ctx.sessionId, title: ctx.title, durationSec: String(ctx.durationSec) };
}

export function paramsToCtx(p: Record<string, string | string[] | undefined>): BillingCtx {
  const s = (k: string) => (Array.isArray(p[k]) ? p[k]![0] : p[k]) ?? "";
  if (s("from") === "analysis" && s("sessionId")) {
    return { from: "analysis", sessionId: s("sessionId"), title: s("title"), durationSec: Number(s("durationSec")) || 0 };
  }
  return { from: "band" };
}
```

- [ ] **Step 3: 구매 흐름 훅**

`usePurchaseFlow.ts`:

```ts
import { MockApiClient } from "@bandapp/api-client";
import type { BandBilling } from "@bandapp/types";
import { useRouter } from "expo-router";
import { useState } from "react";
import { useApi } from "@/api";
import { purchases, type ProductKey } from "@/services/purchases";
import { ctxToParams, type BillingCtx } from "./billingContext";
import { phaseAfterSync, type PurchasePhase } from "./billingView";

/**
 * 스토어 구매 → 서버 sync → B06. 사용자가 취소하면 현재 화면에 머문다.
 * Mock 모드에서는 purchases.purchase가 성공을 흉내 내고, 상태 변화는 MockApiClient.mockPurchase가 만든다.
 */
export function usePurchaseFlow(bandId: string) {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const toStatus = (phase: PurchasePhase, product: ProductKey, ctx: BillingCtx, ret: string) =>
    router.replace({ pathname: "/billing/status", params: { bandId, phase, product, ret, ...ctxToParams(ctx) } });

  return {
    busy,
    async buy(product: ProductKey, before: BandBilling, ctx: BillingCtx, ret: "/billing/plans" | "/billing/extra") {
      if (busy) return;
      setBusy(true);
      try {
        const outcome = await purchases.purchase(product, { bandId, currentPlan: before.state === "linked" ? before.plan : null });
        if (outcome === "cancelled") return;
        if (api instanceof MockApiClient && outcome === "success") api.mockPurchase(product, bandId);
        // 스토어가 끝났으니 서버에 알린다. sync가 죽어도 구매는 유효 — delayed로 보내 "Check status"가 다시 부른다
        const after = outcome === "success" ? await api.billing.sync(bandId).catch(() => null) : null;
        toStatus(phaseAfterSync(outcome, before, after, product), product, ctx, ret);
      } finally {
        setBusy(false);
      }
    },
    async manage(kind: "cancel" | "resume", before: BandBilling, ctx: BillingCtx) {
      if (busy) return;
      setBusy(true);
      try {
        await purchases.manageSubscriptions();
        // 스토어 화면에서 돌아온 뒤 — 실제로 바꿨는지는 sync 결과의 willRenew로 안다
        const after = await api.billing.sync(bandId).catch(() => null);
        const product = (before.plan ?? "band") as ProductKey;
        const changed = after ? after.willRenew !== before.willRenew : false;
        toStatus(changed ? (kind === "cancel" ? "canceled" : "resumed") : "delayed", product, ctx, "/billing/plans");
      } finally {
        setBusy(false);
      }
    },
  };
}
```

- [ ] **Step 4: 라우트와 빈 화면**

`app/billing/_layout.tsx`:

```tsx
import { Stack } from "expo-router";
import { color } from "@/theme";

export default function BillingLayout() {
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg } }} />;
}
```

6개 라우트 파일은 각각 한 줄 re-export: `export { PlanScreen as default } from "@/features/billing/PlanScreen";` (`LinkedBandsScreen`, `PlansScreen`, `ReviewScreen`, `ExtraScreen`, `PurchaseStatusScreen`).

6개 화면 파일은 이 Task에서는 `Screen` + `AppText variant="title"`로 제목만 그린다. 공통 헤더는 `features/billing/BillingHeader.tsx`:

```tsx
import { View } from "react-native";
import { useRouter } from "expo-router";
import { space, useTheme } from "@/theme";
import { AppText, PressableOpacity } from "@/ui";

/** 디자인 B01~B05 상단 "‹ Back" 줄 */
export function BillingHeader({ back, onBack }: { back: string; onBack?: () => void }) {
  const router = useRouter();
  const { colors } = useTheme();
  return (
    <View style={{ paddingHorizontal: space.screenX - 8, paddingBottom: 4 }}>
      <PressableOpacity onPress={onBack ?? (() => router.back())} style={{ flexDirection: "row", alignItems: "center", gap: 6, padding: 8, alignSelf: "flex-start" }}>
        <AppText style={{ fontSize: 18, lineHeight: 18, color: colors.textMuted }}>‹</AppText>
        <AppText style={{ fontSize: 14, color: colors.textMuted }}>{back}</AppText>
      </PressableOpacity>
    </View>
  );
}
```

- [ ] **Step 5: 타입 확인·프리뷰에서 라우트 열림 확인**

```bash
pnpm --filter mobile typecheck
```

`preview_start({name:"mobile-web-mock"})` 후 `/billing/plan?bandId=b1&from=band`로 이동해 제목이 보이는지 `read_page`로 확인.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/app/billing apps/mobile/src/features/billing
git commit -m "feat(mobile): billing routes, data hook, purchase flow hook"
```

---

### Task 11: B01 Plan & usage + B01a Bands on your plan

**Files:**
- Modify: `apps/mobile/src/features/billing/PlanScreen.tsx`
- Modify: `apps/mobile/src/features/billing/LinkedBandsScreen.tsx`
- Create: `apps/mobile/src/features/billing/UsageBar.tsx`
- Create: `apps/mobile/src/features/billing/KeyValueRows.tsx`

**Interfaces:**
- Consumes: Task 9 `fmtH/monthDay`, Task 10 `useBandBilling`, `paramsToCtx`, `BillingHeader`, Task 8 `purchases.prices()` (B01 메타의 가격).
- Produces: `KeyValueRows({ rows: Array<{ k: string; v: string }> })` — B04·B05·B06이 재사용. `UsageBar({ usedPct, leftPct })`.

- [ ] **Step 1: 공통 조각**

`KeyValueRows.tsx`: `rows.map`으로 `flexDirection:"row", justifyContent:"space-between", paddingVertical:10, borderBottomWidth:1(마지막 제외), borderBottomColor: colors.border`, 왼쪽 `caption`, 오른쪽 `fontSize:14, color: colors.text`.

`UsageBar.tsx`: 높이 8, `borderRadius:4`, 배경 `colors.borderStrong`, 안에 `usedPct`% 폭의 `colors.borderHover` 블록과 `leftPct`% 폭의 `colors.accent` 블록을 가로로.

- [ ] **Step 2: B01**

`PlanScreen.tsx` — 디자인 분기(`renderVals`의 `bp*`)를 그대로 옮긴다:

```tsx
import type { BandBilling } from "@bandapp/types";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, View } from "react-native";
import { useApi } from "@/api";
import { useCurrentBand } from "@/features/band/useCurrentBand";
import { apiErrorMessage } from "@/i18n/apiErrorMessage";
import { purchases, type StorePrice } from "@/services/purchases";
import { radius, space, useTheme } from "@/theme";
import { AppText, MonoLabel, PressableOpacity, Screen, useToast } from "@/ui";
import { BillingHeader } from "./BillingHeader";
import { ctxToParams, paramsToCtx } from "./billingContext";
import { fmtH, monthDay } from "./billingView";
import { KeyValueRows } from "./KeyValueRows";
import { UsageBar } from "./UsageBar";
import { useBandBilling } from "./useBandBilling";

export function PlanScreen() {
  const params = useLocalSearchParams<Record<string, string>>();
  const bandId = params.bandId;
  const ctx = paramsToCtx(params);
  const { bands } = useCurrentBand();
  const band = bands.find((b) => b.id === bandId) ?? null;
  const { data: b, failed, reload } = useBandBilling(bandId);
  const [prices, setPrices] = useState<StorePrice[]>([]);
  useEffect(() => { purchases.prices().then(setPrices).catch(() => setPrices([])); }, []);
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();
  const api = useApi();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const go = (path: string, extra: Record<string, string> = {}) => router.push({ pathname: path, params: { bandId, ...ctxToParams(ctx), ...extra } });
  const price = (plan: "band" | "plus" | null) => prices.find((p) => p.key === plan)?.priceString ?? "";
  const planName = (p: "band" | "plus" | null) => (p ? t(`billing.planName.${p}`) : t("billing.planName.free"));

  const addThisBand = async () => {
    if (!bandId || busy) return;
    setBusy(true);
    try {
      await api.bands.linkPool(bandId);
      toast.show(t("billing.b01a.addedToast", { band: band?.name ?? "" }));
    } catch (err) {
      toast.show(apiErrorMessage(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <BillingHeader back={t("billing.b01.back")} onBack={() => router.back()} />
      <View style={{ paddingHorizontal: space.screenX, gap: 6, paddingBottom: 14 }}>
        <AppText variant="title">{t("billing.b01.title")}</AppText>
        <MonoLabel>{t("billing.b01.membersMeta", { band: band?.name ?? "", n: band?.memberCount ?? 0 })}</MonoLabel>
      </View>
      {!b && !failed ? (
        <AppText variant="caption" style={{ paddingHorizontal: space.screenX }}>{t("billing.b01.loading")}</AppText>
      ) : failed || !b ? (
        <View style={{ paddingHorizontal: space.screenX, gap: 10 }}>
          <AppText variant="sheetTitle">{t("billing.b01.failTitle")}</AppText>
          <AppText variant="body">{t("billing.b01.failBody")}</AppText>
          <PressableOpacity onPress={reload} style={outline(colors)}><AppText>{t("billing.b01.retry")}</AppText></PressableOpacity>
        </View>
      ) : (
        <PlanBody b={b} bandName={band?.name ?? ""} price={price} planName={planName} go={go} addThisBand={addThisBand} />
      )}
    </Screen>
  );
}

function PlanBody({ b, bandName, price, planName, go, addThisBand }: {
  b: BandBilling; bandName: string; price: (p: "band" | "plus" | null) => string; planName: (p: "band" | "plus" | null) => string;
  go: (path: string, extra?: Record<string, string>) => void; addThisBand: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const onPlan = b.state === "linked";
  const owner = b.isOwner;
  const ownerName = b.owner.displayName;
  const date = monthDay(b.periodEnd);
  const meta = onPlan
    ? owner
      ? b.willRenew ? t("billing.b01.metaRenews", { price: price(b.plan), date }) : t("billing.b01.metaCanceled", { date })
      : t("billing.b01.metaOwnersPlan", { owner: ownerName })
    : b.state === "expired" ? t("billing.b01.metaEnded", { plan: planName(b.plan), date }) : t("billing.b01.metaFree");
  const availSub = onPlan
    ? b.extraSec ? t("billing.b01.subMonthlyExtra", { time: fmtH(b.monthlyLeftSec), extra: fmtH(b.extraSec) }) : t("billing.b01.subMonthly")
    : b.extraSec ? t("billing.b01.subFreeExtra", { time: fmtH(b.freeLeftSec), extra: fmtH(b.extraSec) }) : t("billing.b01.subFree");
  const pct = (x: number) => (b.monthlyTotalSec ? Math.min(100, (x / b.monthlyTotalSec) * 100) : 0);
  const showAdd = owner && !onPlan && b.myPool !== null && b.myPool.status !== "expired" && b.myPool.plan !== null;
  const hasPrimary = owner ? b.state === "free" || b.state === "expired" || onPlan : onPlan;
  const primaryLabel = onPlan ? t("billing.b01.buyExtra") : b.state === "expired" ? t("billing.b01.resubscribe") : t("billing.b01.viewPlans");
  const primaryGo = () => (onPlan ? go("/billing/extra") : go("/billing/plans", { sel: b.state === "free" ? "band" : (b.plan ?? "band") }));
  const note = onPlan ? t("billing.b01.noteOnlyOwner", { owner: ownerName }) : b.state === "expired" ? t("billing.b01.noteEnded", { owner: ownerName }) : t("billing.b01.noteAsk", { owner: ownerName, band: bandName });

  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: space.screenX, paddingBottom: 40, gap: 12 }}>
      <View style={card(colors)}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <AppText variant="sheetTitle">{onPlan ? t("billing.b01.planSuffix", { plan: planName(b.plan) }) : t("billing.planName.free")}</AppText>
          <AppText variant="caption" style={{ textAlign: "right", flexShrink: 1 }}>{meta}</AppText>
        </View>
        {onPlan ? (
          <PressableOpacity disabled={!owner} onPress={() => go("/billing/linked")} style={{ flexDirection: "row", justifyContent: "space-between", paddingTop: 10 }}>
            <AppText variant="caption">{owner ? t("billing.b01.shareOwner", { n: b.linkedBandCount }) : t("billing.b01.shareMember", { owner: ownerName, n: b.linkedBandCount })}</AppText>
            {owner ? <AppText variant="caption" color={colors.accent}>{t("billing.b01.manage")} ›</AppText> : null}
          </PressableOpacity>
        ) : null}
        <View style={{ paddingTop: 14, gap: 4 }}>
          <MonoLabel>{t("billing.b01.availableNow")}</MonoLabel>
          <AppText style={{ fontSize: 34, fontWeight: "700", letterSpacing: -0.5, color: colors.text }}>{fmtH(b.availableSec)}</AppText>
          <AppText variant="caption">{availSub}</AppText>
        </View>
      </View>

      {showAdd ? (
        <View style={card(colors)}>
          <AppText variant="rowTitle">{t("billing.b01.addTitle")}</AppText>
          <AppText variant="caption" style={{ paddingTop: 4 }}>{t("billing.b01.addBody", { plan: planName(b.myPool!.plan), time: fmtH(b.myPool!.monthlyLeftSec) })}</AppText>
          <PressableOpacity onPress={addThisBand} style={[primaryBtn(colors), { marginTop: 12 }]}><AppText style={{ color: colors.bg, fontWeight: "600" }}>{t("billing.b01.addCta")}</AppText></PressableOpacity>
        </View>
      ) : null}

      {onPlan ? (
        <View style={card(colors)}>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <AppText variant="rowTitle">{t("billing.b01.monthly")}</AppText>
            <AppText variant="caption">{t("billing.b01.leftOf", { time: fmtH(b.monthlyLeftSec), total: fmtH(b.monthlyTotalSec) })}</AppText>
          </View>
          <View style={{ paddingVertical: 12 }}><UsageBar usedPct={pct(b.monthlyUsedSec)} leftPct={pct(b.monthlyLeftSec)} /></View>
          <KeyValueRows rows={[{ k: t("billing.b01.used"), v: fmtH(b.monthlyUsedSec) }, { k: t("billing.b01.left"), v: fmtH(b.monthlyLeftSec) }]} />
          <AppText variant="small" style={{ paddingTop: 10 }}>{t("billing.b01.resetNote", { n: b.linkedBandCount, date })}</AppText>
        </View>
      ) : (
        <View style={card(colors)}>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <AppText variant="rowTitle">{t("billing.b01.freeTime")}</AppText>
            <AppText variant="caption">{t("billing.b01.freeLeftOf", { time: fmtH(b.freeLeftSec) })}</AppText>
          </View>
          <AppText variant="small" style={{ paddingTop: 10 }}>{t("billing.b01.freeNote")}</AppText>
        </View>
      )}

      {onPlan || b.extraSec > 0 ? (
        <View style={card(colors)}>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <AppText variant="rowTitle">{t("billing.b01.extra")}</AppText>
            <AppText variant="caption">{fmtH(b.extraSec)}</AppText>
          </View>
          <AppText variant="small" style={{ paddingTop: 10 }}>
            {b.state === "expired" ? t("billing.b01.extraNoteExpired") : onPlan ? t("billing.b01.extraNoteLinked") : t("billing.b01.extraNoteFree")}
          </AppText>
        </View>
      ) : null}

      <View style={{ gap: 10, paddingTop: 4 }}>
        {hasPrimary ? <PressableOpacity onPress={primaryGo} style={primaryBtn(colors)}><AppText style={{ color: colors.bg, fontWeight: "600", fontSize: 15 }}>{primaryLabel}</AppText></PressableOpacity> : null}
        {owner && onPlan ? <PressableOpacity onPress={() => go("/billing/plans", { sel: b.plan === "band" ? "plus" : "band" })} style={outline(colors)}><AppText style={{ fontSize: 15 }}>{t("billing.b01.changePlan")}</AppText></PressableOpacity> : null}
        {!owner ? <AppText variant="caption" style={{ textAlign: "center" }}>{note}</AppText> : null}
      </View>
    </ScrollView>
  );
}

export const card = (c: ReturnType<typeof useTheme>["colors"]) => ({ backgroundColor: c.surface, borderWidth: 1, borderColor: c.borderStrong, borderRadius: radius.input, padding: 16 });
export const primaryBtn = (c: ReturnType<typeof useTheme>["colors"]) => ({ backgroundColor: c.accent, borderRadius: radius.input, padding: 14, alignItems: "center" as const });
export const outline = (c: ReturnType<typeof useTheme>["colors"]) => ({ borderWidth: 1, borderColor: c.borderStrong, borderRadius: radius.input, padding: 13, alignItems: "center" as const });
```

`radius.input`·`space.screenX`·`colors.accent` 등은 테마에 있다. `card/primaryBtn/outline`은 다른 결제 화면도 import해 쓴다.

- [ ] **Step 3: B01a**

`LinkedBandsScreen.tsx`: `useBandBilling(bandId)`의 `myPool`을 쓴다. 상단 `BillingHeader back=t("billing.b01a.back")`, 제목, `lkSub`. "ON YOUR PLAN · n" 아래 `myPool.bands.filter(linked)` 행(이니셜 원 + 이름 + `THIS BAND` 칩(id === bandId) + 멤버 수, 오른쪽 `Remove` 텍스트 버튼 → `ConfirmDialog`(title `removeTitle`, body `removeBody`, primary danger `removePrimary`) → `api.bands.unlinkPool(id)`; 비어 있으면 `none`). "OTHER BANDS YOU OWN" 아래 `filter(!linked)` 행, 오른쪽 `Add` → `api.bands.linkPool(id)` + 토스트 `addedToast`. 맨 아래 `footer` caption. 오류는 `apiErrorMessage` 토스트. `busy` 동안 버튼 비활성.

- [ ] **Step 4: 프리뷰 검증**

`preview_start({name:"mobile-web-mock"})`, `/billing/plan?bandId=b1&from=band` 열어 `read_page`로 "Free", "2h 30m", "View plans", "Each band gets 3h once" 확인. 브라우저 콘솔에서 상태를 바꿀 수 없으니, `MockApiClient` 시드에서 `billing.pool.plan = "band"`로 잠깐 바꿔 linked 화면(월 시간 바, "Sharing time across 1 band", "Manage")도 확인한 뒤 되돌린다. `/billing/linked?bandId=b1`에서 Remove→확인→Free로 바뀌는지, Add로 돌아오는지 확인. 콘솔 오류 없음.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/features/billing
git commit -m "feat(mobile): Plan & usage and Bands on your plan screens"
```

---

### Task 12: B02 Plans + B04 Subscription review

**Files:**
- Modify: `apps/mobile/src/features/billing/PlansScreen.tsx`
- Modify: `apps/mobile/src/features/billing/ReviewScreen.tsx`

**Interfaces:**
- Consumes: Task 10 `usePurchaseFlow.buy/manage`, Task 11 `card/primaryBtn/outline/KeyValueRows`.
- 라우트 params: `/billing/plans?sel=band|plus`, `/billing/review?sel=band|plus`.

- [ ] **Step 1: B02**

`PlansScreen.tsx`:
- `useBandBilling(bandId)`, `purchases.prices()`(로딩 중 `pricesLoading` → 카드 가격 자리에 회색 블록, 하단 fine print `loadingPrices`).
- `const paid = b.state === "linked"`. 카드 2개(`band`, `plus`): 이름, `CURRENT PLAN` 칩(paid && b.plan === k), 선택 체크(✓), `fmtH(20h|40h)` + `perMonth`, 가격. 탭하면 `sel` state 변경(current는 선택 불가). 선택 카드는 `borderColor: colors.accent`.
- `note` caption. paid && b.willRenew → `Cancel subscription` 행(`cancelSub` 보조문구) → `flow.manage("cancel", b, ctx)`. paid && !b.willRenew → `resumeNote` + `Resume subscription` → `flow.manage("resume", b, ctx)`.
- 하단: CTA `cta` (`plCanGo = pricesReady && !(paid && sel === b.plan)`; 아니면 흐리게 비활성) → `router.push("/billing/review", { bandId, sel, ...ctx })`. fine print, Terms/Privacy 링크(`Linking.openURL`로 `EXPO_PUBLIC_TERMS_URL`/`EXPO_PUBLIC_PRIVACY_URL`, 없으면 토스트 "Coming soon"), `!paid`면 `keepFree` → `router.back()`.
- 멤버(`!b.isOwner`)가 이 화면에 오면 안 되지만 딥링크 대비 CTA 대신 `billing.b01.noteOnlyOwner`를 보여준다.

- [ ] **Step 2: B04**

`ReviewScreen.tsx`:
- `sel`, `change = b.state === "linked"`. 제목 `titleChange|titleNew`. 카드: `label`(대문자), 가격 큰 글씨 + `perMonth`, 밴드 이니셜 원 + `forBand` + `sharedBy({n: memberCount})`, `KeyValueRows`:
  - change: `[rowCurrent: planName(b.plan) · vMonthly(price(b.plan))]`, `[rowNew: planName(sel) · vTime(fmtH(sel.monthlySec))]`, `[rowBilledThrough: store]`
  - new: `[rowTime: vTime]`, `[rowBilling: vBilling]`, `[rowRenewal: monthDay(+1개월)]` — `+1개월`은 `new Date()`에 `setMonth(+1)`.
- `ctx.from === "analysis"`면 `after = (change ? max(0, selSec − b.monthlyUsedSec) : selSec) + b.extraSec`로 `ctxOk|ctxShort` (short면 `colors.danger`).
- `noteChange|noteNew` caption. CTA `ctaChange|ctaNew` → `flow.buy(sel, b, ctx, "/billing/plans")`. 하단 Terms/Privacy/Billing help 링크.
- 플랜 시간 상수는 앱에도 필요하다: `billingView.ts`에 `export const PLAN_SEC = { band: 20 * 3600, plus: 40 * 3600 } as const;`를 추가한다 (서버 `PLANS`와 같은 값, 표시용).

- [ ] **Step 3: 프리뷰 검증**

`/billing/plans?bandId=b1&from=band&sel=band` → 가격 로딩 뒤 "$15 / month", CTA 활성 → Review → "Subscribe · $15/month" → 누르면 Mock 구매 후 `/billing/status`(아직 빈 화면)로 이동하는지 URL로 확인. `/billing/plan`으로 돌아가면 Band 플랜·20h가 보인다(Mock 상태가 바뀌었으므로).

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/features/billing
git commit -m "feat(mobile): Plans and Subscription review screens"
```

---

### Task 13: B05 Extra time + B06 Purchase status

**Files:**
- Modify: `apps/mobile/src/features/billing/ExtraScreen.tsx`
- Modify: `apps/mobile/src/features/billing/PurchaseStatusScreen.tsx`

- [ ] **Step 1: B05**

`ExtraScreen.tsx`:
- `b.canBuyExtra`가 아니면(딥링크) `router.back()`.
- 제목 `title`, `forBand`. 카드: `hours` 큰 글씨 + `oneTime({price: extraPrice})`. `KeyValueRows`: `rowNow: fmtH(avail)`, `rowExtra: fmtH(b.extraSec)`, `rowAfter: fmtH(avail + 3h)`.
- `ctx.from === "analysis"`: `exAfter = avail + 3h − durationSec`; 제목줄 `"{title} · {fmtH(durationSec)}"` + `ctxOk|ctxShort`.
- `note`. CTA: analysis && ok → `ctaAnalyze` / 아니면 `cta({price})`; 보조문구 `ctaSubAnalyze|ctaSub`. → `flow.buy("extra", b, ctx, "/billing/extra")`.

- [ ] **Step 2: B06**

`PurchaseStatusScreen.tsx` — params `phase`, `product`, `ret`, `bandId`, ctx. `useBandBilling(bandId)`로 최신 `b`. 디자인 `P` 테이블을 그대로:

| phase | 제목/본문 | rows | primary | secondary |
|---|---|---|---|---|
| checking | `checking` / `checkingBody` | — | — | — |
| success | extra: `successExtra`/`successExtraBody`; plan: `successPlan`/`successPlanBody` | extra: `[rowPurchase, vOneTime][rowAvailable, fmtH(avail)]`; plan: `[rowTime, vTime][rowRenews, vRenews][rowAvailable]` | analysis && avail ≥ durationSec → `continueAnalysis`(→ `api.sessions.retryAnalysis(sessionId)` 후 `router.replace("/")`), 아니면 `done` | — |
| failed | `failed` / `failedBody` | — | `tryAgain` → `router.replace(ret)` | `back` → `router.replace("/billing/plan")` |
| pending | `pending` / `pendingBody` | `[rowProduct][rowBand]` | `done` | — |
| delayed | `delayed` / `delayedBody` | `[rowProduct][rowBand]` | `checkStatus` → phase를 `checking`으로 바꾸고 `api.billing.sync(bandId)` → `phaseAfterSync("success", before, after, product)`로 다시 결정 | `help` → Terms와 같은 링크 처리 |
| canceled | `canceled` / `canceledBody` | `[rowActiveUntil, date][rowAfter, vAfter]` | `done` | — |
| resumed | `resumed` / `resumedBody` | `[rowRenews, "{date} · {price}"]` | `done` | — |

`done`은 `ctx.from === "analysis"`면 `router.replace("/")`, 아니면 `router.replace({ pathname: "/billing/plan", params: { bandId, from: "band" } })`. 아이콘: 성공·재개 `✓`(accent 원), 실패 `!`(danger 원), 취소·보류 `…`/`✓`(muted). `checking`은 `ActivityIndicator`. `before`는 "Check status" 비교용으로 화면 진입 시 `b`를 ref에 담아 둔다.

- [ ] **Step 3: 프리뷰 검증**

`/billing/plan` → "Buy extra time" → B05 "$3 · One-time purchase", "After purchase 23h" → 구매 → B06 "3h added", "Extra time is ready for everyone in …", Done → B01에 Extra time 3h. 분석 맥락: `/billing/extra?bandId=b1&from=analysis&sessionId=s1&title=Test&durationSec=7200` → "Buy 3h and analyze" → B06 "Continue analysis" 버튼.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/features/billing
git commit -m "feat(mobile): Extra time and Purchase status screens"
```

---

### Task 14: B03 Not enough time 시트 + 세션 목록의 `waiting_for_time`

**Files:**
- Create: `apps/mobile/src/features/billing/NoTimeSheet.tsx`
- Modify: `apps/mobile/src/features/sessions/SessionsScreen.tsx`
- Modify: `apps/mobile/src/features/sessions/SessionRow.tsx`

**Interfaces:**
- Consumes: Task 9 `noTimeActions`, Task 10 `useBandBilling`, `ctxToParams`, Task 8 `purchases.prices()`.
- Produces: `NoTimeSheet({ session: Session | null; onClose(): void })` — `session`이 null이면 닫힘.

- [ ] **Step 1: SessionRow**

`SessionRow.tsx`의 상태 분기에 `waiting_for_time` 추가: `s.status === "waiting_for_time"`이면 `StatusDot color={colors.textMuted}` + caption `colors.textMuted`로 `t("billing.sessionRow.waiting")`. (`useTranslation` import 추가.)

- [ ] **Step 2: 시트**

`NoTimeSheet.tsx` — `BottomSheet`를 쓰고 디자인 B03 그대로:

```tsx
import type { Session } from "@bandapp/types";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { useApi } from "@/api";
import { apiErrorMessage } from "@/i18n/apiErrorMessage";
import { purchases } from "@/services/purchases";
import { useTheme } from "@/theme";
import { AppText, BottomSheet, PressableOpacity, useToast } from "@/ui";
import { ctxToParams, type BillingCtx } from "./billingContext";
import { fmtH, monthDay, noTimeActions, type NoTimeAction } from "./billingView";
import { primaryBtn, outline } from "./PlanScreen";
import { useBandBilling } from "./useBandBilling";

export function NoTimeSheet({ session, bandName, onClose }: { session: Session | null; bandName: string; onClose: () => void }) {
  const { data: b } = useBandBilling(session?.bandId);
  const [extraPrice, setExtraPrice] = useState("");
  useEffect(() => { purchases.prices().then((p) => setExtraPrice(p.find((x) => x.key === "extra")?.priceString ?? "")).catch(() => {}); }, []);
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();
  const api = useApi();
  const toast = useToast();
  if (!session || !b) return <BottomSheet visible={false} onClose={onClose}><View /></BottomSheet>;

  const need = Math.max(0, session.durationSec - b.availableSec);
  const ctx: BillingCtx = { from: "analysis", sessionId: session.id, title: session.name ?? session.title, durationSec: session.durationSec };
  const go = (path: string, extra: Record<string, string> = {}) => { onClose(); router.push({ pathname: path, params: { bandId: session.bandId, ...ctxToParams(ctx), ...extra } }); };
  const notNow = () => { onClose(); toast.show(t("billing.b03.savedToast")); };
  const addToPlan = async () => {
    try {
      await api.bands.linkPool(session.bandId);
      await api.sessions.retryAnalysis(session.id);
      onClose();
    } catch (err) {
      toast.show(apiErrorMessage(err, t));
    }
  };
  const onAction = (a: NoTimeAction) => {
    switch (a) {
      case "viewPlans": return go("/billing/plans", { sel: "band" });
      case "resubscribe": return go("/billing/plans", { sel: b.plan ?? "band" });
      case "viewPlus": return go("/billing/plans", { sel: "plus" });
      case "buyExtra": return go("/billing/extra");
      case "addToPlan": return void addToPlan();
      case "notNow": return notNow();
    }
  };
  const label = (a: NoTimeAction) => ({
    viewPlans: t("billing.b03.viewPlans"), resubscribe: t("billing.b03.resubscribe"), viewPlus: t("billing.b03.viewPlus"),
    buyExtra: t("billing.b03.buyExtra", { price: extraPrice }), addToPlan: t("billing.b03.addToPlan", { time: fmtH(b.myPool?.monthlyLeftSec ?? 0) }), notNow: t("billing.b03.notNow"),
  })[a];
  const actions = noTimeActions(b, need);
  const onPlan = b.state === "linked";

  return (
    <BottomSheet visible onClose={notNow} title={t("billing.b03.title", { time: fmtH(need) })}>
      <View style={{ gap: 4 }}>
        <AppText variant="body">{t("billing.b03.session", { session: ctx.title, time: fmtH(session.durationSec) })}</AppText>
        <AppText variant="caption">{t("billing.b03.avail", { time: fmtH(b.availableSec), band: bandName })}</AppText>
        <AppText variant="caption">{onPlan ? t("billing.b03.resetMonthly", { date: monthDay(b.periodEnd) }) : t("billing.b03.resetFree")}</AppText>
        {!b.isOwner ? <AppText variant="caption">{onPlan ? t("billing.b03.hintOnlyOwner", { owner: b.owner.displayName }) : t("billing.b03.hintAsk", { owner: b.owner.displayName, band: bandName })}</AppText> : null}
      </View>
      {onPlan && need > 3 * 3600 ? <AppText variant="caption" color={colors.danger} style={{ paddingTop: 8 }}>{t("billing.b03.short", { time: fmtH(need - 3 * 3600) })}</AppText> : null}
      <View style={{ gap: 10, paddingTop: 16 }}>
        {actions.map((a, i) => (
          <PressableOpacity key={a} onPress={() => onAction(a)} style={a === "notNow" ? { padding: 12, alignItems: "center" } : i === 0 ? primaryBtn(colors) : outline(colors)}>
            <AppText style={{ fontSize: 15, color: a === "notNow" ? colors.textMuted : i === 0 ? colors.bg : colors.text, fontWeight: i === 0 && a !== "notNow" ? "600" : "400" }}>{label(a)}</AppText>
          </PressableOpacity>
        ))}
      </View>
      <AppText variant="small" style={{ paddingTop: 14, textAlign: "center" }}>{t("billing.b03.footer")}</AppText>
    </BottomSheet>
  );
}
```

- [ ] **Step 3: SessionsScreen 연결**

`SessionsScreen.tsx`: `const [noTime, setNoTime] = useState<Session | null>(null);` `onRowPress`에 `else if (s.status === "waiting_for_time") setNoTime(s);`를 `failed` 분기 앞에 추가. 렌더 끝에 `<NoTimeSheet session={noTime} bandName={band?.name ?? ""} onClose={() => setNoTime(null)} />`.

- [ ] **Step 4: 프리뷰 검증**

Mock 시드에 `waiting_for_time` 세션 하나를 추가한다 (`seed.ts`의 세션 목록에 `session("s9", "2026-10-02T19:00:00+09:00", 4 * 3600, 0, "waiting_for_time")`). 세션 탭에서 행 caption "Waiting for analysis time", 탭 → 시트 "You need 1h 30m more", "View plans"/"Not now". "View plans" → B02 → 구독 → B06 "Continue analysis" → 세션 탭으로 돌아오고 그 세션이 analyzing→ready로 바뀌는지 확인.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/features/billing/NoTimeSheet.tsx apps/mobile/src/features/sessions packages/api-client/src/mock/seed.ts
git commit -m "feat(mobile): Not enough time sheet and waiting_for_time session row"
```

---

### Task 15: Band 화면 진입 카드 + 오너 양도 문구

**Files:**
- Modify: `apps/mobile/src/features/band/BandScreen.tsx`
- Modify: `apps/mobile/src/features/band/useBandActions.ts` (없음 — 양도 자체는 그대로)

- [ ] **Step 1: 플랜 카드**

`BandScreen.tsx`에 `useBandBilling(band?.id)`를 추가하고, 멤버 FlatList의 `ListHeaderComponent`로 디자인 Band 화면의 카드(`openPlan`):

```tsx
<PressableOpacity
  onPress={() => band && router.push({ pathname: "/billing/plan", params: { bandId: band.id, from: "band" } })}
  style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.input, paddingVertical: 14, paddingHorizontal: 16, marginTop: 4, marginBottom: 10 }}
>
  <AppText variant="rowTitle">
    {billingFailed ? t("billing.card.unavailable") : billing ? t("billing.card.summary", { plan: billing.state === "linked" ? t(`billing.planName.${billing.plan!}`) : t("billing.planName.free"), time: fmtH(billing.availableSec) }) : t("billing.b01.loading")}
  </AppText>
  <AppText variant="caption">{t("billing.card.planUsage")} <AppText style={{ color: colors.borderHover, fontSize: 18 }}>›</AppText></AppText>
</PressableOpacity>
```

(`const { data: billing, failed: billingFailed } = useBandBilling(band?.id);`, `fmtH` import.)

- [ ] **Step 2: 양도 확인 문구**

`confirmProps`의 `case "transfer"` body: `t("band.confirm.transfer.body") + (billing?.state === "linked" && billing.isOwner ? t("billing.transferNote", { band: bandName }) : "")`.

- [ ] **Step 3: 프리뷰 검증**

Band 탭에 "Free · 2h 30m available  Plan & usage ›" 카드가 멤버 목록 위에 보이고, 탭하면 B01. Mock에서 구독한 뒤 양도 다이얼로그를 열면 "… will be removed from your plan." 문장이 붙는다.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/features/band/BandScreen.tsx
git commit -m "feat(mobile): plan card on band screen, transfer note when linked"
```

---

### Task 16: 전체 검증과 README

**Files:**
- Modify: `README.md` (결제 설정 절)

- [ ] **Step 1: 전체 테스트**

```bash
pnpm --filter @bandapp/types build
pnpm --filter @bandapp/api-client build
pnpm --filter @bandapp/api-client test
pnpm --filter @bandapp/api lint
pnpm --filter @bandapp/api build
pnpm --filter @bandapp/api test
pnpm --filter mobile typecheck
pnpm --filter mobile test
```

Expected: 전부 통과. 실패하면 고치고 다시.

- [ ] **Step 2: README에 결제 설정 절**

"결제 (RevenueCat)" 절: 환경변수 4개, 상품 ID 3개(`rehearsal.band.monthly`, `rehearsal.plus.monthly` — 같은 구독 그룹 `analysis`; `rehearsal.extra.3h` — 소모성), RevenueCat에서 entitlement `band`·`plus`와 offering `default`에 3개 패키지 등록, 웹훅 URL `POST /webhooks/revenuecat` + Authorization 값 = `REVENUECAT_WEBHOOK_SECRET`, 로컬에서는 웹훅이 못 들어오므로 앱의 "Check status"(= `/billing/sync`)로 확인한다는 안내.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: RevenueCat setup for billing"
```

---

### Task 17: 실기기 구매 체크리스트 (코드 밖 — 스토어 설정이 끝난 뒤)

사전 조건: 사업자·판매자 설정(스펙 "범위 밖"), 스토어 콘솔에 상품 3개, RevenueCat 프로젝트·키·웹훅, dev client 재빌드(`react-native-purchases` 포함), `.env` 키 4개.

- [ ] iOS Sandbox 계정 / Android 라이선스 테스터로 로그인 → Band 탭 카드가 "Free · 3h available".
- [ ] B02에서 가격이 스토어 통화로 보인다 (Loading prices… → 가격).
- [ ] Band 구독 → 스토어 시트 → B06 "Band activated" → B01 "Band plan · … Renews …", 월 시간 20h. 서버 `billing_pools`에 행, `bands.pool_id` 채워짐 (웹훅 로그 또는 sync).
- [ ] 다른 밴드를 만들고 B01 "Add this band to my plan" → B01a에 2개 → "Sharing time across 2 bands".
- [ ] Remove → Free로 돌아가고 추가 시간 유지.
- [ ] Buy extra time(일반 멤버 계정으로도) → "3h added" → `bands.extra_sec` 10800.
- [ ] Change plan → Plus: Android는 교체 다이얼로그, iOS는 업그레이드 즉시 적용 → B01 40h, `used_sec` 유지.
- [ ] Cancel subscription → 스토어 관리 화면 → 돌아오면 B06 "Renewal canceled" → B01 "Renewal canceled · Active until …". Resume도 같은 길.
- [ ] 4시간 녹음 업로드(무료 밴드) → 세션 행 "Waiting for analysis time" → 시트 → 구독 → "Continue analysis" → 분석 완료.
- [ ] 샌드박스 구독 만료(iOS 5분) 뒤 웹훅 EXPIRATION → B01 "Band plan ended …", Resubscribe.
- [ ] 오너 양도 → 새 오너의 B01이 Free, 전 오너의 B01a에서 그 밴드가 "OTHER BANDS"로 가지 않고 사라진다(오너가 아니므로).
