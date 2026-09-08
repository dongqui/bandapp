# 팀 관리 서버 갭 (파트 자유 입력 · 이름 변경 · 소유권 이전 · soft delete · 오류 code) 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 팀 관리 화면이 필요로 하는 서버 계약을 채운다 — 파트를 자유 문자열로, 밴드 이름 변경·소유권 이전·soft delete API, 밴드 오류에 `code`, 그리고 api-client HTTP·Mock 양쪽.

**Architecture:** `band_members.part`를 text로 바꾸고 `bands.deleted_at`을 더한다. 삭제된 밴드는 `MembershipsService.roleOf` 한 곳에서 "멤버 아님"으로 판정해 모든 밴드 스코프 라우트를 닫는다. 밴드 오류는 초대 오류와 같은 `{ message, code }` 본문으로 내려가고, `ApiError.code`로 클라이언트에 도달한다. Mock 클라이언트는 같은 code를 `ApiError`로 던져 화면 분기가 Mock에서도 동작한다.

**Tech Stack:** NestJS 12, drizzle-orm + drizzle-kit, Postgres, vitest + supertest e2e, `@bandapp/types`, `@bandapp/api-client`.

**스펙:** [docs/superpowers/specs/2026-09-08-team-management-screen-design.md](../specs/2026-09-08-team-management-screen-design.md)

## Global Constraints

- 파트 문자열은 서버가 **trim 후 1~20자**만 검증한다. 프리셋 키 목록은 참조하지 않는다 (스펙 결정 2).
- 밴드 이름은 **trim 후 1~50자** (`create`와 같은 규칙).
- 밴드 삭제는 **soft delete** — `bands.deleted_at`만 채운다. 행·R2 객체는 지우지 않는다 (스펙 결정 3).
- 삭제된 밴드 차단은 **`MembershipsService.roleOf` 한 곳**에서 한다. 라우트마다 별도 존재 확인을 넣지 않는다 (스펙 결정 4).
- 오류 code는 `BandErrorCode` 유니온의 7개만 쓴다: `band_forbidden`, `band_owner_only`, `band_owner_must_transfer`, `band_member_not_found`, `band_cannot_remove_self`, `band_cannot_remove_owner`, `band_transfer_self`.
- 권한 검증 순서: **owner 확인이 먼저**, 그다음 대상 존재 확인. 권한 없는 사람이 404/409로 멤버십 존재 여부를 알아내면 안 된다.
- e2e는 실 Postgres를 쓴다. 실행 전 `docker compose up -d postgres` (이 머신은 `API_PORT=3001`, DB는 `localhost:5432`).
- `@bandapp/types`를 바꾸면 소비자가 `dist`를 읽으므로 **`pnpm --filter @bandapp/types build`** 를 먼저 돌린다. `@bandapp/api-client`도 마찬가지로 모바일이 `dist`를 읽는다.
- 커밋 메시지는 영어 conventional commit, 본문 끝에 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## 파일 구조

```
packages/types/src/band.ts                        BandPart 삭제, BAND_PART_PRESETS·BandErrorCode 추가, part: string | null
apps/api/src/common/validation.ts                 requireBandPartOrNull → requirePartOrNull (문자열 길이 검증)
apps/api/src/common/validation.spec.ts            requirePartOrNull 단위 테스트
apps/api/src/db/schema.ts                         band_part enum 삭제, part text, bands.deleted_at
apps/api/drizzle/0005_*.sql                       마이그레이션 (손질 포함)
apps/api/src/bands/band-errors.ts                 bandError(code) — invite-errors.ts와 같은 모양
apps/api/src/memberships/memberships.service.ts   roleOf가 bands 조인 + deleted_at 필터, 오류에 code
apps/api/src/bands/bands.service.ts               rename · transferOwnership · softDelete · leave soft delete · code
apps/api/src/bands/bands.controller.ts            PATCH /bands/:id, POST /bands/:id/transfer, DELETE /bands/:id
apps/api/src/invites/invites.service.ts           preview/join이 삭제된 밴드를 invite_not_found로
apps/api/test/bands.e2e-spec.ts                   신규 API·code·soft delete 테스트
apps/api/test/invites.e2e-spec.ts                 삭제된 밴드 초대 테스트
packages/api-client/src/errors.ts                 ApiError를 여기로 이동 (Mock도 던질 수 있게)
packages/api-client/src/client.ts                 bands.rename · transferOwnership · delete, setMyPart(string | null)
packages/api-client/src/http/HttpApiClient.ts     HTTP 구현
packages/api-client/src/mock/MockApiClient.ts     Mock 구현 + ApiError code
packages/api-client/src/mock/seed.ts              owner 밴드 + member 밴드 시드
packages/api-client/src/mock/MockApiClient.spec.ts Mock 밴드 관리 테스트
```

---

### Task 1: 공유 타입과 파트 검증

**Files:**
- Modify: `packages/types/src/band.ts`
- Modify: `apps/api/src/common/validation.ts`
- Modify: `apps/api/src/common/validation.spec.ts`
- Modify: `apps/api/src/bands/bands.controller.ts:60-68` (`requireBandPartOrNull` 호출부)
- Modify: `apps/api/src/bands/bands.service.ts` (`BandPart` import·`setPart` 시그니처)
- Modify: `packages/api-client/src/client.ts:64`, `packages/api-client/src/http/HttpApiClient.ts:200`, `packages/api-client/src/mock/MockApiClient.ts:6,103`

**Interfaces:**
- Produces: `BAND_PART_PRESETS: readonly ["vocal","guitar","bass","drums","keyboard"]`, `BandPartPreset`, `BandErrorCode`, `BandMember.part: string | null`, `requirePartOrNull(body, field): string | null`.
- `BandPart` 타입은 이 태스크에서 사라진다. 참조하던 곳을 전부 `string`으로 바꾼다.

- [ ] **Step 1: 타입 변경**

`packages/types/src/band.ts` 전체를 아래로 교체:

```ts
export type MemberRole = "owner" | "member";

/**
 * 파트 프리셋 키. 클라이언트가 이 키를 각 언어로 번역해 보여준다.
 * 서버는 이 목록을 참조하지 않는다 — 파트는 자유 문자열이고 프리셋은 그중 특별 취급되는 값일 뿐이다 (스펙 결정 1·2).
 */
export const BAND_PART_PRESETS = ["vocal", "guitar", "bass", "drums", "keyboard"] as const;
export type BandPartPreset = (typeof BAND_PART_PRESETS)[number];

export interface Band {
  id: string;
  name: string;
  memberCount: number;
}

export interface BandMember {
  id: string;
  name: string;
  role: MemberRole;
  /** null = 미설정. 프리셋 키(BAND_PART_PRESETS)거나 사용자가 직접 친 문자열(trim 후 1~20자). */
  part: string | null;
}

/** 밴드 관리 실패 사유. 서버가 오류 본문의 code로 내려준다. */
export type BandErrorCode =
  | "band_forbidden" // 403 멤버 아님 (삭제된 밴드 포함)
  | "band_owner_only" // 403 owner 전용
  | "band_owner_must_transfer" // 409 owner가 leave
  | "band_member_not_found" // 404 대상 userId가 멤버 아님
  | "band_cannot_remove_self" // 409 removeMember 대상이 본인
  | "band_cannot_remove_owner" // 409 removeMember 대상이 owner
  | "band_transfer_self"; // 409 transfer 대상이 본인
```

- [ ] **Step 2: 타입 빌드**

Run: `pnpm --filter @bandapp/types build`
Expected: 성공. 이후 api·api-client 타입체크에서 `BandPart` 참조 오류가 나는 것이 정상 — 다음 단계에서 고친다.

- [ ] **Step 3: 실패하는 검증 테스트 작성**

`apps/api/src/common/validation.spec.ts` 끝에 추가 (파일 상단의 import에 `requirePartOrNull`을 더한다):

```ts
describe("requirePartOrNull", () => {
  it("프리셋 키든 자유 문자열이든 trim해서 돌려준다", () => {
    expect(requirePartOrNull({ part: "guitar" }, "part")).toBe("guitar");
    expect(requirePartOrNull({ part: "  Synth  " }, "part")).toBe("Synth");
  });

  it("null은 해제", () => {
    expect(requirePartOrNull({ part: null }, "part")).toBeNull();
  });

  it("필드 없음·빈 문자열·공백만·21자·문자열 아님은 400", () => {
    expect(() => requirePartOrNull({}, "part")).toThrow(BadRequestException);
    expect(() => requirePartOrNull({ part: "" }, "part")).toThrow(BadRequestException);
    expect(() => requirePartOrNull({ part: "   " }, "part")).toThrow(BadRequestException);
    expect(() => requirePartOrNull({ part: "a".repeat(21) }, "part")).toThrow(BadRequestException);
    expect(() => requirePartOrNull({ part: 3 }, "part")).toThrow(BadRequestException);
  });

  it("20자는 통과", () => {
    expect(requirePartOrNull({ part: "a".repeat(20) }, "part")).toBe("a".repeat(20));
  });
});
```

기존 spec 파일에 `BadRequestException` import가 없으면 `import { BadRequestException } from "@nestjs/common";`를 추가한다.

- [ ] **Step 4: 실패 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/common/validation.spec.ts`
Expected: FAIL — `requirePartOrNull is not a function` (또는 export 없음).

- [ ] **Step 5: 검증 함수 교체**

`apps/api/src/common/validation.ts`에서 `import type { BandPart } from "@bandapp/types";` 줄과 `BAND_PARTS` 상수, `requireBandPartOrNull` 함수를 지우고 그 자리에:

```ts
const PART_MAX_LENGTH = 20;

/**
 * 파트는 자유 문자열이다 — 프리셋 키(vocal 등)든 "Synth"든 서버는 구분하지 않는다 (스펙 결정 2).
 * null을 허용한다 — 파트 미설정이 정상 상태이고, 해제 전용 엔드포인트 대신 같은 PATCH로 받는다.
 * 필드가 아예 없으면 400 — 의도한 해제와 실수를 구분한다.
 */
export function requirePartOrNull(body: unknown, name: string): string | null {
  const value = field(body, name);
  if (value === null) return null;
  if (typeof value !== "string") throw new BadRequestException(`${name} must be a string or null`);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > PART_MAX_LENGTH) {
    throw new BadRequestException(`${name} must be 1-${PART_MAX_LENGTH} characters or null`);
  }
  return trimmed;
}
```

`field()`는 파일 아래쪽에 이미 정의돼 있다(함수 선언이라 호이스팅된다).

- [ ] **Step 6: 호출부 갱신**

`apps/api/src/bands/bands.controller.ts`: import에서 `requireBandPartOrNull`을 `requirePartOrNull`로 바꾸고 `setMyPart`의 본문을 `this.bandsService.setPart(bandId, userId, requirePartOrNull(body, "part"))`로.

`apps/api/src/bands/bands.service.ts`: `import type { Band, BandMember, BandPart, MemberRole }`에서 `BandPart`를 지우고, `toBandMember`의 매개변수 타입 `part: BandPart | null`과 `setPart(bandId, userId, part: BandPart | null)`을 `string | null`로.

`packages/api-client/src/client.ts:64`: `setMyPart(bandId: string, part: string | null): Promise<BandMember>;` 그리고 파일 상단 import에서 `BandPart`를 지운다.

`packages/api-client/src/http/HttpApiClient.ts:200`: `setMyPart: async (bandId: string, part: string | null)` — import에서 `BandPart` 제거.

`packages/api-client/src/mock/MockApiClient.ts:6,103`: import 목록에서 `BandPart` 제거, `setMyPart: async (bandId: string, part: string | null)`.

- [ ] **Step 7: 테스트·타입체크**

Run: `pnpm --filter @bandapp/api exec vitest run src/common/validation.spec.ts`
Expected: PASS (새 4개 포함).

Run: `pnpm --filter @bandapp/api exec tsc --noEmit -p tsconfig.json && pnpm --filter @bandapp/api-client build`
Expected: 둘 다 오류 없음. (`schema.ts`의 `bandPart` enum은 아직 남아 있어도 `part` 컬럼 타입이 enum 리터럴이라 `string`에 대입 가능하므로 통과한다. Task 2에서 정리.)

- [ ] **Step 8: 커밋**

```bash
git add packages/types/src/band.ts apps/api/src/common/validation.ts apps/api/src/common/validation.spec.ts apps/api/src/bands packages/api-client/src
git commit -m "feat(types): make band part a free string with preset keys and add band error codes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: 스키마와 마이그레이션

**Files:**
- Modify: `apps/api/src/db/schema.ts:25-34,82-103`
- Create: `apps/api/drizzle/0005_<generated>.sql` (+ `meta/` 자동 갱신)
- Test: `apps/api/test/bands.e2e-spec.ts` (기존 "본인 파트를 설정하고 해제한다"에 자유 문자열 케이스 추가)

**Interfaces:**
- Produces: `bands.deletedAt: timestamp | null`, `bandMembers.part: text | null`. `bandPart` enum export는 사라진다.

- [ ] **Step 1: 실패하는 e2e 작성**

`apps/api/test/bands.e2e-spec.ts`의 "본인 파트를 설정하고 해제한다" 테스트 안, `cleared` 검증 뒤에 추가:

```ts
    const custom = await request(app.getHttpServer())
      .patch(`/bands/${bandId}/members/me`)
      .set(auth(owner.accessToken))
      .send({ part: "  Synth " })
      .expect(200);
    expect(custom.body.part).toBe("Synth");
```

그리고 "정의되지 않은 파트는 400, 비멤버는 403" 테스트에서 `.send({ part: "trumpet" }).expect(400)`을 `.send({ part: "a".repeat(21) }).expect(400)`으로 바꾼다 (이제 "trumpet"은 유효하다). 테스트 이름도 `"21자 이상·필드 없음은 400, 비멤버는 403"`으로.

- [ ] **Step 2: 실패 확인**

Run: `docker compose up -d postgres` 후 `pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/bands.e2e-spec.ts`
Expected: FAIL — `"Synth"` 저장 시 Postgres enum 오류(`invalid input value for enum band_part`)로 500.

- [ ] **Step 3: 스키마 변경**

`apps/api/src/db/schema.ts`:

`bandPart` pgEnum 선언(25~34행의 `// @bandapp/types의 BandPart와…` 주석 포함)을 삭제한다.

`bands` 테이블에 `deletedAt` 추가:

```ts
export const bands = pgTable("bands", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  ...timestamps,
  // soft delete — 행·R2 객체는 남긴다. 영구 삭제는 배치가 맡는다 (2026-09-08 스펙 결정 3)
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});
```

`bandMembers`의 `part` 줄을:

```ts
    // null = 미설정. 프리셋 키(vocal 등)든 자유 문자열이든 서버는 구분하지 않는다 (2026-09-08 스펙 결정 1·2)
    part: text("part"),
```

- [ ] **Step 4: 마이그레이션 생성**

Run: `pnpm --filter @bandapp/api db:generate`
Expected: `apps/api/drizzle/0005_<이름>.sql` 생성. 내용에 `ALTER TABLE "band_members" ALTER COLUMN "part" SET DATA TYPE text;`, `DROP TYPE "public"."band_part";`, `ALTER TABLE "bands" ADD COLUMN "deleted_at" timestamp with time zone;`가 있어야 한다.

- [ ] **Step 5: 마이그레이션 손질**

생성된 SQL에서 `ALTER COLUMN "part" SET DATA TYPE text;` 줄 **바로 뒤**, `DROP TYPE` **앞**에 삽입:

```sql
--> statement-breakpoint
-- 손으로 넣음: 'other'는 자유 입력이 생겨 의미가 없다 — NULL(미설정)로 (2026-09-08 스펙 결정 1)
UPDATE "band_members" SET "part" = NULL WHERE "part" = 'other';
```

`--> statement-breakpoint` 구분자는 생성기의 기존 줄들과 같은 형식으로 앞뒤에 하나씩 있어야 한다. 최종 파일이 `ALTER … text;--> statement-breakpoint` / `UPDATE …;--> statement-breakpoint` / `DROP TYPE …;--> statement-breakpoint` / `ALTER TABLE "bands" ADD COLUMN …;` 순서인지 눈으로 확인한다.

- [ ] **Step 6: e2e 통과 확인**

Run: `pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/bands.e2e-spec.ts`
Expected: PASS. (global-setup이 새 마이그레이션을 적용한다. 컨테이너 DB의 기존 데이터가 걸리면 `docker compose down -v && docker compose up -d postgres`.)

- [ ] **Step 7: 커밋**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle apps/api/test/bands.e2e-spec.ts
git commit -m "feat(api): store band part as text and add bands.deleted_at

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: 밴드 오류 code와 삭제된 밴드 차단

**Files:**
- Create: `apps/api/src/bands/band-errors.ts`
- Modify: `apps/api/src/memberships/memberships.service.ts`
- Test: `apps/api/test/bands.e2e-spec.ts`

**Interfaces:**
- Produces: `bandError(code: BandErrorCode): { message: string; code: BandErrorCode }`.
- `roleOf(bandId, userId)`는 밴드가 삭제됐으면 `null`.
- `assertMember` 403 본문 `{ message, code: "band_forbidden" }`, `assertOwner` 403 `{ …, code: "band_owner_only" }`.

- [ ] **Step 1: 실패하는 e2e 작성**

`apps/api/test/bands.e2e-spec.ts`에 추가. 파일 상단 import에 `bands`를 더한다: `import { bandInvites, bandMembers, bands } from "../src/db/schema.js";`

```ts
  it("403 본문에 code가 실린다", async () => {
    const bandId = await createBand(owner.accessToken);
    const member = await secondUser("coded-member");
    await db.insert(bandMembers).values({ bandId, userId: member.userId, role: "member" });
    const stranger = await secondUser("coded-stranger");
    const forbidden = await request(app.getHttpServer())
      .get(`/bands/${bandId}/members`)
      .set(auth(stranger.accessToken))
      .expect(403);
    expect(forbidden.body.code).toBe("band_forbidden");
    const ownerOnly = await request(app.getHttpServer())
      .post(`/bands/${bandId}/invites`)
      .set(auth(member.accessToken))
      .expect(403);
    expect(ownerOnly.body.code).toBe("band_owner_only");
  });

  it("삭제된 밴드는 목록에서 빠지고 모든 밴드 스코프 라우트가 403 band_forbidden", async () => {
    const bandId = await createBand(owner.accessToken);
    await db.update(bands).set({ deletedAt: new Date() }).where(eq(bands.id, bandId));

    const mine = await request(app.getHttpServer()).get("/bands").set(auth(owner.accessToken)).expect(200);
    expect(mine.body).toHaveLength(0);

    const members = await request(app.getHttpServer())
      .get(`/bands/${bandId}/members`)
      .set(auth(owner.accessToken))
      .expect(403);
    expect(members.body.code).toBe("band_forbidden");
    await request(app.getHttpServer())
      .get(`/bands/${bandId}/sessions`)
      .set(auth(owner.accessToken))
      .expect(403);
  });
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/bands.e2e-spec.ts`
Expected: 두 테스트 FAIL — `code`가 `undefined`, 삭제된 밴드가 목록에 남고 멤버 목록이 200.

- [ ] **Step 3: band-errors.ts 작성**

`apps/api/src/bands/band-errors.ts`:

```ts
import type { BandErrorCode } from "@bandapp/types";

const MESSAGES: Record<BandErrorCode, string> = {
  band_forbidden: "이 밴드에 접근할 수 없어요.",
  band_owner_only: "밴드 관리자만 할 수 있어요.",
  band_owner_must_transfer: "관리자는 먼저 소유권을 넘기거나 팀을 삭제해야 해요.",
  band_member_not_found: "팀원을 찾을 수 없어요.",
  band_cannot_remove_self: "자기 자신은 내보낼 수 없어요. 팀 나가기를 사용해 주세요.",
  band_cannot_remove_owner: "팀장은 내보낼 수 없어요.",
  band_transfer_self: "이미 소유자예요.",
};

/**
 * HttpException에 객체를 넘기면 그 객체가 그대로 응답 본문이 된다. 클라이언트는 code로 번역하고,
 * code를 모르는 옛 클라이언트는 message를 그대로 보여준다 (2026-09-08 스펙 결정 8).
 */
export function bandError(code: BandErrorCode): { message: string; code: BandErrorCode } {
  return { message: MESSAGES[code], code };
}
```

- [ ] **Step 4: MembershipsService 수정**

`apps/api/src/memberships/memberships.service.ts` 전체를 아래로 교체:

```ts
import { ForbiddenException } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import type { MemberRole } from "@bandapp/types";
import { bandError } from "../bands/band-errors.js";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { bandMembers, bands } from "../db/schema.js";

export class MembershipsService {
  constructor(private readonly db: Db) {}

  /**
   * 삭제된 밴드(bands.deleted_at)는 여기서 "멤버 아님"으로 판정한다. 밴드 스코프 라우트가 전부
   * assertMember/assertOwner를 지나므로 이 한 곳으로 닫힌다 (2026-09-08 스펙 결정 4).
   */
  async roleOf(bandId: string, userId: string): Promise<MemberRole | null> {
    const [row] = await this.db
      .select({ role: bandMembers.role })
      .from(bandMembers)
      .innerJoin(bands, eq(bands.id, bandMembers.bandId))
      .where(
        and(eq(bandMembers.bandId, bandId), eq(bandMembers.userId, userId), isNull(bands.deletedAt)),
      )
      .limit(1);
    return row?.role ?? null;
  }

  /** Band 권한은 항상 서버에서 검증한다 (기획서 9장). 멤버가 아니면 403. */
  async assertMember(bandId: string, userId: string): Promise<MemberRole> {
    const role = await this.roleOf(bandId, userId);
    if (!role) throw new ForbiddenException(bandError("band_forbidden"));
    return role;
  }

  async assertOwner(bandId: string, userId: string): Promise<void> {
    if ((await this.assertMember(bandId, userId)) !== "owner") {
      throw new ForbiddenException(bandError("band_owner_only"));
    }
  }
}

export const membershipsServiceProvider: Provider = {
  provide: MembershipsService,
  useFactory: (db: Db) => new MembershipsService(db),
  inject: [DB],
};
```

- [ ] **Step 5: listForUser 필터**

`apps/api/src/bands/bands.service.ts`의 `listForUser`에서 `.where(eq(bandMembers.userId, userId))`를 `.where(and(eq(bandMembers.userId, userId), isNull(bands.deletedAt)))`로. (`and`, `isNull`은 이미 import돼 있다.)

- [ ] **Step 6: e2e 통과 확인**

Run: `pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/bands.e2e-spec.ts`
Expected: PASS.

Run: `pnpm --filter @bandapp/api test:e2e`
Expected: 전체 PASS — 다른 스펙(sessions·takes·comments·invites)이 403 본문 모양에 의존하지 않는지 확인한다. 실패하면 그 테스트가 `message` 문자열을 비교하는 것인지 보고, 문자열이 같으므로 코드 문제다.

- [ ] **Step 7: 커밋**

```bash
git add apps/api/src/bands/band-errors.ts apps/api/src/memberships/memberships.service.ts apps/api/src/bands/bands.service.ts apps/api/test/bands.e2e-spec.ts
git commit -m "feat(api): add band error codes and hide soft-deleted bands from memberships

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: 이름 변경 · 소유권 이전 · 삭제 · leave soft delete

**Files:**
- Modify: `apps/api/src/bands/bands.service.ts`
- Modify: `apps/api/src/bands/bands.controller.ts`
- Test: `apps/api/test/bands.e2e-spec.ts`

**Interfaces:**
- Produces:
  - `BandsService.rename(bandId, actorId, name): Promise<Band>`
  - `BandsService.transferOwnership(bandId, actorId, targetUserId): Promise<void>`
  - `BandsService.softDelete(bandId, actorId): Promise<void>`
  - 라우트 `PATCH /bands/:bandId { name }` → 200 Band, `POST /bands/:bandId/transfer { userId }` → 204, `DELETE /bands/:bandId` → 204.

- [ ] **Step 1: 실패하는 e2e 작성**

`apps/api/test/bands.e2e-spec.ts`에 추가:

```ts
  describe("이름 변경", () => {
    it("owner는 이름을 바꾼다 (trim, 1~50자)", async () => {
      const bandId = await createBand(owner.accessToken);
      const res = await request(app.getHttpServer())
        .patch(`/bands/${bandId}`)
        .set(auth(owner.accessToken))
        .send({ name: "  Saturday Night  " })
        .expect(200);
      expect(res.body).toMatchObject({ id: bandId, name: "Saturday Night", memberCount: 1 });
      await request(app.getHttpServer())
        .patch(`/bands/${bandId}`)
        .set(auth(owner.accessToken))
        .send({ name: "   " })
        .expect(400);
      await request(app.getHttpServer())
        .patch(`/bands/${bandId}`)
        .set(auth(owner.accessToken))
        .send({ name: "a".repeat(51) })
        .expect(400);
    });

    it("member는 403 band_owner_only", async () => {
      const bandId = await createBand(owner.accessToken);
      const member = await secondUser("renamer");
      await db.insert(bandMembers).values({ bandId, userId: member.userId, role: "member" });
      const res = await request(app.getHttpServer())
        .patch(`/bands/${bandId}`)
        .set(auth(member.accessToken))
        .send({ name: "Nope" })
        .expect(403);
      expect(res.body.code).toBe("band_owner_only");
    });
  });

  describe("소유권 이전", () => {
    it("owner가 member에게 넘기면 역할이 교체된다", async () => {
      const bandId = await createBand(owner.accessToken);
      const member = await secondUser("heir");
      await db.insert(bandMembers).values({ bandId, userId: member.userId, role: "member" });
      await request(app.getHttpServer())
        .post(`/bands/${bandId}/transfer`)
        .set(auth(owner.accessToken))
        .send({ userId: member.userId })
        .expect(204);
      const members = await request(app.getHttpServer())
        .get(`/bands/${bandId}/members`)
        .set(auth(owner.accessToken))
        .expect(200);
      const roles = Object.fromEntries(members.body.map((m: { id: string; role: string }) => [m.id, m.role]));
      expect(roles[owner.userId]).toBe("member");
      expect(roles[member.userId]).toBe("owner");
      // 이전 owner는 이제 owner 전용 작업을 못 한다
      await request(app.getHttpServer())
        .patch(`/bands/${bandId}`)
        .set(auth(owner.accessToken))
        .send({ name: "X" })
        .expect(403);
    });

    it("대상 검증: 본인 409, 비멤버 404, member 호출 403, UUID 아님 400", async () => {
      const bandId = await createBand(owner.accessToken);
      const member = await secondUser("plain-2");
      await db.insert(bandMembers).values({ bandId, userId: member.userId, role: "member" });
      const stranger = await secondUser("outsider");

      const self = await request(app.getHttpServer())
        .post(`/bands/${bandId}/transfer`)
        .set(auth(owner.accessToken))
        .send({ userId: owner.userId })
        .expect(409);
      expect(self.body.code).toBe("band_transfer_self");

      const notFound = await request(app.getHttpServer())
        .post(`/bands/${bandId}/transfer`)
        .set(auth(owner.accessToken))
        .send({ userId: stranger.userId })
        .expect(404);
      expect(notFound.body.code).toBe("band_member_not_found");

      await request(app.getHttpServer())
        .post(`/bands/${bandId}/transfer`)
        .set(auth(member.accessToken))
        .send({ userId: owner.userId })
        .expect(403);

      await request(app.getHttpServer())
        .post(`/bands/${bandId}/transfer`)
        .set(auth(owner.accessToken))
        .send({ userId: "not-a-uuid" })
        .expect(400);
    });
  });

  describe("밴드 삭제 (soft)", () => {
    it("owner가 지우면 행은 남고 목록·라우트에서 사라진다", async () => {
      const bandId = await createBand(owner.accessToken);
      await request(app.getHttpServer())
        .delete(`/bands/${bandId}`)
        .set(auth(owner.accessToken))
        .expect(204);
      const row = await db.query.bands.findFirst({ where: eq(bands.id, bandId) });
      expect(row?.deletedAt).not.toBeNull();
      const mine = await request(app.getHttpServer()).get("/bands").set(auth(owner.accessToken)).expect(200);
      expect(mine.body).toHaveLength(0);
      const again = await request(app.getHttpServer())
        .delete(`/bands/${bandId}`)
        .set(auth(owner.accessToken))
        .expect(403);
      expect(again.body.code).toBe("band_forbidden");
    });

    it("member는 403 band_owner_only", async () => {
      const bandId = await createBand(owner.accessToken);
      const member = await secondUser("deleter");
      await db.insert(bandMembers).values({ bandId, userId: member.userId, role: "member" });
      const res = await request(app.getHttpServer())
        .delete(`/bands/${bandId}`)
        .set(auth(member.accessToken))
        .expect(403);
      expect(res.body.code).toBe("band_owner_only");
    });
  });
```

그리고 기존 테스트 둘을 수정:

- "혼자 남은 owner가 탈퇴하면 밴드가 삭제된다": `mine` 검증 뒤에 soft delete 확인을 추가한다.
  ```ts
      const row = await db.query.bands.findFirst({ where: eq(bands.id, bandId) });
      expect(row).toBeDefined();
      expect(row?.deletedAt).not.toBeNull();
  ```
- "다른 멤버가 있는 밴드의 owner 탈퇴는 409": `.expect(409)`의 결과를 변수로 받아 `expect(res.body.code).toBe("band_owner_must_transfer")`.
- "내보내기 권한과 대상 검증": 409·404 응답을 변수로 받아 각각 `expect(res.body.code).toBe("band_cannot_remove_self")`, `expect(res.body.code).toBe("band_member_not_found")`를 추가한다. 그리고 테스트 끝에 "이전 후 새 owner가 이전 owner를 내보낼 수 있다"를 붙인다:
  ```ts
      await request(app.getHttpServer())
        .post(`/bands/${bandId}/transfer`)
        .set(auth(owner.accessToken))
        .send({ userId: member.userId })
        .expect(204);
      await request(app.getHttpServer())
        .delete(`/bands/${bandId}/members/${owner.userId}`)
        .set(auth(member.accessToken))
        .expect(204);
  ```
  `band_cannot_remove_owner`는 실제로 도달 불가능하다 — owner는 항상 1명이고, owner가 자기 자신을 대상으로 하면 `band_cannot_remove_self`가 먼저, owner가 아닌 호출자는 `assertOwner`에서 403이 먼저다. `removeMember`에 방어 코드로 남기고 테스트하지 않는다.

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/bands.e2e-spec.ts`
Expected: 새 테스트들 FAIL (404 라우트 없음), 수정한 기존 테스트도 FAIL (`code` undefined, 행이 hard delete됨).

- [ ] **Step 3: BandsService 구현**

`apps/api/src/bands/bands.service.ts`:

import를 갱신한다:

```ts
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Band, BandMember, MemberRole } from "@bandapp/types";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { bandInvites, bandMembers, bands, users } from "../db/schema.js";
import { MembershipsService } from "../memberships/memberships.service.js";
import { bandError } from "./band-errors.js";
```

`leave`를 교체:

```ts
  async leave(bandId: string, userId: string): Promise<void> {
    const role = await this.memberships.assertMember(bandId, userId);
    const total = await this.countMembers(bandId);
    if (total === 1) {
      // 마지막 멤버가 나가면 밴드를 soft delete — 행은 남고 목록·라우트에서 사라진다 (2026-09-08 스펙 결정 5)
      await this.markDeleted(bandId);
      return;
    }
    if (role === "owner") throw new ConflictException(bandError("band_owner_must_transfer"));
    await this.db
      .delete(bandMembers)
      .where(and(eq(bandMembers.bandId, bandId), eq(bandMembers.userId, userId)));
  }
```

`removeMember`의 세 예외를 code 버전으로:

```ts
    if (!targetRole) throw new NotFoundException(bandError("band_member_not_found"));
    if (targetUserId === actorId) throw new ConflictException(bandError("band_cannot_remove_self"));
    if (targetRole === "owner") throw new ConflictException(bandError("band_cannot_remove_owner"));
```

`setPart`의 `ForbiddenException("이 밴드에 접근할 수 없어요.")`를 `ForbiddenException(bandError("band_forbidden"))`로.

`countMembers` 앞에 세 메서드 추가:

```ts
  async rename(bandId: string, actorId: string, name: string): Promise<Band> {
    await this.memberships.assertOwner(bandId, actorId);
    const [row] = await this.db
      .update(bands)
      .set({ name, updatedAt: new Date() })
      .where(eq(bands.id, bandId))
      .returning({ id: bands.id, name: bands.name });
    if (!row) throw new ForbiddenException(bandError("band_forbidden"));
    return { id: row.id, name: row.name, memberCount: await this.countMembers(bandId) };
  }

  /**
   * owner↔member 교체 한 번. 밴드당 owner는 항상 정확히 1명이다 (2026-09-08 스펙 결정 7).
   * 검증 순서: owner 확인 → 본인 여부 → 대상 존재. 권한 없는 호출자에게 멤버십 존재를 알려주지 않는다.
   */
  async transferOwnership(bandId: string, actorId: string, targetUserId: string): Promise<void> {
    await this.memberships.assertOwner(bandId, actorId);
    if (targetUserId === actorId) throw new ConflictException(bandError("band_transfer_self"));
    const targetRole = await this.memberships.roleOf(bandId, targetUserId);
    if (!targetRole) throw new NotFoundException(bandError("band_member_not_found"));
    await this.db.transaction(async (tx) => {
      await tx
        .update(bandMembers)
        .set({ role: "owner" })
        .where(and(eq(bandMembers.bandId, bandId), eq(bandMembers.userId, targetUserId)));
      await tx
        .update(bandMembers)
        .set({ role: "member" })
        .where(and(eq(bandMembers.bandId, bandId), eq(bandMembers.userId, actorId)));
    });
  }

  /** soft delete — 행·세션·R2 객체는 남긴다 (2026-09-08 스펙 결정 3). 이미 삭제된 밴드는 assertOwner가 403. */
  async softDelete(bandId: string, actorId: string): Promise<void> {
    await this.memberships.assertOwner(bandId, actorId);
    await this.markDeleted(bandId);
  }

  private async markDeleted(bandId: string): Promise<void> {
    await this.db.update(bands).set({ deletedAt: new Date() }).where(eq(bands.id, bandId));
  }
```

- [ ] **Step 4: 컨트롤러 라우트**

`apps/api/src/bands/bands.controller.ts`에서 `create`의 이름 검증을 헬퍼로 뽑고 세 라우트를 추가한다. 파일 상단(클래스 밖)에:

```ts
function requireBandName(body: unknown): string {
  const name = requireString(body, "name").trim();
  if (name.length === 0 || name.length > 50) {
    throw new BadRequestException("name must be 1-50 characters");
  }
  return name;
}
```

`create`의 본문을 `return this.bandsService.create(userId, requireBandName(body));`로. `list` 다음, `members` 앞에 추가:

```ts
  @Patch(":bandId")
  rename(
    @CurrentUserId() userId: string,
    @Param("bandId") bandId: string,
    @Body() body: unknown,
  ): Promise<Band> {
    requireUuidParam(bandId, "bandId");
    return this.bandsService.rename(bandId, userId, requireBandName(body));
  }

  @Post(":bandId/transfer")
  @HttpCode(204)
  async transfer(
    @CurrentUserId() userId: string,
    @Param("bandId") bandId: string,
    @Body() body: unknown,
  ): Promise<void> {
    requireUuidParam(bandId, "bandId");
    const target = requireString(body, "userId");
    requireUuidParam(target, "userId");
    await this.bandsService.transferOwnership(bandId, userId, target);
  }

  @Delete(":bandId")
  @HttpCode(204)
  async remove(@CurrentUserId() userId: string, @Param("bandId") bandId: string): Promise<void> {
    requireUuidParam(bandId, "bandId");
    await this.bandsService.softDelete(bandId, userId);
  }
```

- [ ] **Step 5: e2e 통과 확인**

Run: `pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/bands.e2e-spec.ts`
Expected: PASS.

Run: `pnpm --filter @bandapp/api lint`
Expected: 오류 없음.

- [ ] **Step 6: 커밋**

```bash
git add apps/api/src/bands apps/api/test/bands.e2e-spec.ts
git commit -m "feat(api): rename, transfer ownership, and soft-delete bands

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: 삭제된 밴드의 초대

**Files:**
- Modify: `apps/api/src/invites/invites.service.ts:76-115`
- Test: `apps/api/test/invites.e2e-spec.ts`

**Interfaces:**
- `preview`·`join`이 삭제된 밴드의 초대에 404 `invite_not_found`.

- [ ] **Step 1: 실패하는 e2e 작성**

`apps/api/test/invites.e2e-spec.ts` import에 `bands`를 더하고(`import { bandInvites, bands } from "../src/db/schema.js";`) 테스트 추가:

```ts
  it("삭제된 밴드의 초대는 preview·join 모두 404 invite_not_found", async () => {
    const invite = await createInvite();
    await db.update(bands).set({ deletedAt: new Date() }).where(eq(bands.id, bandId));
    const preview = await request(app.getHttpServer()).get(`/invites/${invite.token}`).expect(404);
    expect(preview.body.code).toBe("invite_not_found");
    const member = await memberLogin("late-joiner");
    const join = await request(app.getHttpServer())
      .post(`/invites/${invite.token}/join`)
      .set(auth(member.accessToken))
      .expect(404);
    expect(join.body.code).toBe("invite_not_found");
  });
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/invites.e2e-spec.ts`
Expected: FAIL — preview 200 / join 201.

- [ ] **Step 3: 구현**

`apps/api/src/invites/invites.service.ts`에 private 헬퍼를 추가하고 `preview`·`join`이 쓰게 한다. `import { and, desc, eq, gt, isNull, lt, or, sql }`은 이미 `isNull`을 갖고 있다.

```ts
  /** 삭제된 밴드의 초대는 존재하지 않는 것으로 답한다 (2026-09-08 스펙 결정 4, 2026-09-02 결정 10). */
  private async liveBand(bandId: string): Promise<typeof bands.$inferSelect> {
    const band = await this.db.query.bands.findFirst({
      where: and(eq(bands.id, bandId), isNull(bands.deletedAt)),
    });
    if (!band) throw new NotFoundException(inviteError("invite_not_found"));
    return band;
  }
```

`preview`에서:

```ts
    const invite = await this.findValid(token);
    const band = await this.liveBand(invite.bandId);
```
로 바꾸고 바로 아래의 `if (!band) throw …` 줄은 지운다.

`join`에서 `const invite = await this.findValid(token);` 다음 줄에 `await this.liveBand(invite.bandId);`를 넣는다.

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/invites.e2e-spec.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add apps/api/src/invites/invites.service.ts apps/api/test/invites.e2e-spec.ts
git commit -m "fix(api): treat invites to soft-deleted bands as not found

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: api-client — HTTP·Mock 구현과 시드

**Files:**
- Create: `packages/api-client/src/errors.ts`
- Modify: `packages/api-client/src/http/HttpApiClient.ts:31-41,191-220`
- Modify: `packages/api-client/src/index.ts`
- Modify: `packages/api-client/src/client.ts:60-70`
- Modify: `packages/api-client/src/mock/seed.ts`, `packages/api-client/src/mock/MockApiClient.ts:91-137`
- Create: `packages/api-client/src/mock/MockApiClient.spec.ts`

**Interfaces:**
- Produces (`RehearsalApiClient.bands`):
  - `rename(bandId: string, name: string): Promise<Band>`
  - `transferOwnership(bandId: string, userId: string): Promise<void>`
  - `delete(bandId: string): Promise<void>`
- `ApiError`는 `packages/api-client/src/errors.ts`로 옮기되 `index.ts`와 `HttpApiClient.ts`에서 계속 export한다 (기존 import 경로 유지).
- Mock 시드: `b1`(MOCK_USER가 owner, 멤버 4명 — Dongjin/Minsu/Jihoon/Suhyun), `b2`(MOCK_USER가 member, owner는 Minsu). 멤버 id는 `m1`=MOCK_USER(`u-mock`)… 아래 참조.

- [ ] **Step 1: 실패하는 Mock 테스트 작성**

`packages/api-client/src/mock/MockApiClient.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ApiError } from "../errors";
import { MockApiClient } from "./MockApiClient";

const ME = "u-mock";

describe("MockApiClient bands 관리", () => {
  it("시드: b1은 내가 owner, b2는 내가 member", async () => {
    const api = new MockApiClient();
    const bands = await api.bands.list();
    expect(bands.map((b) => b.id)).toEqual(["b1", "b2"]);
    const b1 = await api.bands.members("b1");
    expect(b1.find((m) => m.id === ME)?.role).toBe("owner");
    expect(b1.find((m) => m.id === ME)?.part).toBe("guitar");
    const b2 = await api.bands.members("b2");
    expect(b2.find((m) => m.id === ME)?.role).toBe("member");
    expect(b2.find((m) => m.role === "owner")?.id).not.toBe(ME);
  });

  it("rename은 owner만, 이름을 trim해서 저장한다", async () => {
    const api = new MockApiClient();
    const band = await api.bands.rename("b1", "  Saturday  ");
    expect(band.name).toBe("Saturday");
    await expect(api.bands.rename("b2", "X")).rejects.toMatchObject({ status: 403, code: "band_owner_only" });
  });

  it("transferOwnership은 역할을 교체하고, 본인이면 409, 없으면 404", async () => {
    const api = new MockApiClient();
    await api.bands.transferOwnership("b1", "m2");
    const members = await api.bands.members("b1");
    expect(members.find((m) => m.id === ME)?.role).toBe("member");
    expect(members.find((m) => m.id === "m2")?.role).toBe("owner");
    // 이제 내가 member라 403
    await expect(api.bands.transferOwnership("b1", "m3")).rejects.toMatchObject({ status: 403, code: "band_owner_only" });
    const fresh = new MockApiClient();
    await expect(fresh.bands.transferOwnership("b1", ME)).rejects.toMatchObject({ status: 409, code: "band_transfer_self" });
    await expect(fresh.bands.transferOwnership("b1", "nobody")).rejects.toMatchObject({ status: 404, code: "band_member_not_found" });
  });

  it("delete는 owner만, 목록에서 사라진다", async () => {
    const api = new MockApiClient();
    await expect(api.bands.delete("b2")).rejects.toBeInstanceOf(ApiError);
    await api.bands.delete("b1");
    expect((await api.bands.list()).map((b) => b.id)).toEqual(["b2"]);
  });

  it("leave: owner이고 남이 있으면 409 band_owner_must_transfer, member면 빠진다", async () => {
    const api = new MockApiClient();
    await expect(api.bands.leave("b1")).rejects.toMatchObject({ status: 409, code: "band_owner_must_transfer" });
    await api.bands.leave("b2");
    expect((await api.bands.list()).map((b) => b.id)).toEqual(["b1"]);
  });

  it("setMyPart는 자유 문자열을 받는다", async () => {
    const api = new MockApiClient();
    const me = await api.bands.setMyPart("b1", "Synth");
    expect(me.part).toBe("Synth");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @bandapp/api-client exec vitest run src/mock/MockApiClient.spec.ts`
Expected: FAIL — `../errors` 없음.

- [ ] **Step 3: ApiError 이동**

`packages/api-client/src/errors.ts`:

```ts
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** 서버가 본문에 실어 보낸 기계 판독용 사유. 없을 수 있다. Mock도 같은 code를 던진다. */
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
```

`packages/api-client/src/http/HttpApiClient.ts`에서 `export class ApiError { … }` 블록(31~41행)을 지우고 상단에 `import { ApiError } from "../errors";`를 추가한 뒤, 기존 소비자를 위해 `export { ApiError };`를 한 줄 둔다.

`packages/api-client/src/index.ts`의 `export { ApiError, HttpApiClient } from "./http/HttpApiClient";`는 그대로 둬도 동작한다 (re-export). 명시적으로 `export { ApiError } from "./errors";`로 바꾸고 `HttpApiClient`만 http에서 export해도 된다 — 둘 중 하나만 남겨 중복 export를 만들지 않는다.

- [ ] **Step 4: 인터페이스와 HTTP 구현**

`packages/api-client/src/client.ts`의 `bands` 블록에 추가 (`leave` 다음):

```ts
    /** Owner 전용. trim 후 1~50자. */
    rename(bandId: string, name: string): Promise<Band>;
    /** Owner 전용. 대상이 owner가 되고 호출자는 member가 된다. */
    transferOwnership(bandId: string, userId: string): Promise<void>;
    /** Owner 전용. soft delete — 목록에서 사라진다. */
    delete(bandId: string): Promise<void>;
```

`packages/api-client/src/http/HttpApiClient.ts`의 `bands`에 추가 (`leave` 다음):

```ts
    rename: async (bandId: string, name: string): Promise<Band> => {
      const band = await this.request<Band>("PATCH", `/bands/${bandId}`, { name });
      this.emit();
      return band;
    },
    transferOwnership: async (bandId: string, userId: string): Promise<void> => {
      await this.request<void>("POST", `/bands/${bandId}/transfer`, { userId });
      this.emit();
    },
    delete: async (bandId: string): Promise<void> => {
      await this.request<void>("DELETE", `/bands/${bandId}`);
      this.emit();
    },
```

- [ ] **Step 5: Mock 시드**

현재 시드(`packages/api-client/src/mock/seed.ts:160-172`)는 본인을 `m1`으로 두는데 `MockApiClient`는 본인을 `MOCK_USER.id`(`"u-mock"`)로 찾는다 — 그래서 지금 Mock에서 `setMyPart`는 항상 "멤버가 아니에요"로 실패한다. 이번에 맞춘다.

`seed.ts:60`의 `AUTHOR_IDS`를 `{ Dongjin: "u-mock", Minsu: "m2", Jihoon: "m3", Suhyun: "m4" }`로 바꾼다 (코멘트 작성자와 멤버 id가 일치해야 "내 코멘트" 판정이 맞는다).

`createSeedState`의 `return` 블록에서 `bands`·`members`를 아래로 교체:

```ts
  return {
    // b1: 내가 owner. b2: 내가 member — 팀 관리 화면의 owner/member 두 상태를 웹 프리뷰에서 본다 (2026-09-08 스펙).
    bands: [
      { id: "b1", name: "FRIDAY NIGHT", memberCount: 4 },
      { id: "b2", name: "SIDE PROJECT", memberCount: 3 },
    ],
    members: {
      b1: [
        { id: "u-mock", name: "Dongjin", role: "owner", part: "guitar" },
        { id: "m2", name: "Minsu", role: "member", part: "vocal" },
        { id: "m3", name: "Jihoon", role: "member", part: "Synth" },
        { id: "m4", name: "Suhyun", role: "member", part: null },
      ],
      b2: [
        { id: "m2", name: "Minsu", role: "owner", part: "bass" },
        { id: "u-mock", name: "Dongjin", role: "member", part: null },
        { id: "m4", name: "Suhyun", role: "member", part: "drums" },
      ],
    },
    sessions,
    takes,
    comments,
  };
```

세션 시드는 전부 `bandId: "b1"`이라 b2의 세션 목록은 비어 있다 — 의도한 것이다(빈 상태 확인용).

- [ ] **Step 6: Mock 구현**

`packages/api-client/src/mock/MockApiClient.ts` 상단에 `import { ApiError } from "../errors";`를 추가하고, 클래스 안에 헬퍼 두 개를 넣는다 (`mustSession` 옆):

```ts
  private mustBand(bandId: string): Band {
    const band = this.state.bands.find((b) => b.id === bandId);
    if (!band) throw new ApiError(403, "이 밴드에 접근할 수 없어요.", "band_forbidden");
    return band;
  }

  /** 서버의 assertOwner와 같은 순서·code — 화면의 code 분기가 Mock에서도 동작하게 (2026-09-08 스펙). */
  private assertOwner(bandId: string): BandMember[] {
    const members = this.state.members[bandId];
    const me = members?.find((m) => m.id === MOCK_USER.id);
    if (!members || !me) throw new ApiError(403, "이 밴드에 접근할 수 없어요.", "band_forbidden");
    if (me.role !== "owner") throw new ApiError(403, "밴드 관리자만 할 수 있어요.", "band_owner_only");
    return members;
  }
```

`bands` 블록을 아래로 교체 (`createInvite`·`revokeInvite`는 기존 그대로 유지):

```ts
  bands = {
    list: async (): Promise<Band[]> => [...this.state.bands],
    members: async (bandId: string): Promise<BandMember[]> => [...(this.state.members[bandId] ?? [])],
    create: async (name: string): Promise<Band> => {
      const band: Band = { id: `b${this.nextId++}`, name, memberCount: 1 };
      this.state.bands.push(band);
      this.state.members[band.id] = [
        { id: MOCK_USER.id, name: MOCK_USER.displayName ?? "나", role: "owner", part: null },
      ];
      this.emit();
      return { ...band };
    },
    setMyPart: async (bandId: string, part: string | null): Promise<BandMember> => {
      const me = (this.state.members[bandId] ?? []).find((m) => m.id === MOCK_USER.id);
      if (!me) throw new ApiError(403, "이 밴드에 접근할 수 없어요.", "band_forbidden");
      me.part = part;
      this.emit();
      return { ...me };
    },
    removeMember: async (bandId: string, userId: string): Promise<void> => {
      const members = this.assertOwner(bandId);
      const target = members.find((m) => m.id === userId);
      if (!target) throw new ApiError(404, "팀원을 찾을 수 없어요.", "band_member_not_found");
      if (userId === MOCK_USER.id) {
        throw new ApiError(409, "자기 자신은 내보낼 수 없어요. 팀 나가기를 사용해 주세요.", "band_cannot_remove_self");
      }
      if (target.role === "owner") throw new ApiError(409, "팀장은 내보낼 수 없어요.", "band_cannot_remove_owner");
      this.state.members[bandId] = members.filter((m) => m.id !== userId);
      this.mustBand(bandId).memberCount = this.state.members[bandId]!.length;
      this.emit();
    },
    leave: async (bandId: string): Promise<void> => {
      const members = this.state.members[bandId] ?? [];
      const me = members.find((m) => m.id === MOCK_USER.id);
      if (!me) throw new ApiError(403, "이 밴드에 접근할 수 없어요.", "band_forbidden");
      if (me.role === "owner" && members.length > 1) {
        throw new ApiError(409, "관리자는 먼저 소유권을 넘기거나 팀을 삭제해야 해요.", "band_owner_must_transfer");
      }
      this.state.bands = this.state.bands.filter((b) => b.id !== bandId);
      delete this.state.members[bandId];
      this.emit();
    },
    rename: async (bandId: string, name: string): Promise<Band> => {
      this.assertOwner(bandId);
      const band = this.mustBand(bandId);
      band.name = name.trim();
      this.emit();
      return { ...band };
    },
    transferOwnership: async (bandId: string, userId: string): Promise<void> => {
      const members = this.assertOwner(bandId);
      if (userId === MOCK_USER.id) throw new ApiError(409, "이미 소유자예요.", "band_transfer_self");
      const target = members.find((m) => m.id === userId);
      if (!target) throw new ApiError(404, "팀원을 찾을 수 없어요.", "band_member_not_found");
      for (const m of members) m.role = m.id === userId ? "owner" : m.id === MOCK_USER.id ? "member" : m.role;
      this.emit();
    },
    delete: async (bandId: string): Promise<void> => {
      this.assertOwner(bandId);
      // Mock에는 deleted_at이 없다 — 목록에서 빠지는 것이 관찰 가능한 전부다
      this.state.bands = this.state.bands.filter((b) => b.id !== bandId);
      delete this.state.members[bandId];
      this.emit();
    },
    createInvite: /* 기존 그대로 */,
    revokeInvite: /* 기존 그대로 */,
  };
```

`createInvite`·`revokeInvite`는 기존 코드를 그대로 둔다 — 위 주석 자리에 실제로 옮겨 적는다.

- [ ] **Step 7: 테스트·빌드**

Run: `pnpm --filter @bandapp/api-client exec vitest run`
Expected: 전체 PASS (`upload.spec.ts` 포함).

Run: `pnpm --filter @bandapp/api-client build && pnpm --filter mobile typecheck`
Expected: 모두 통과. 모바일이 `setMyPart`·`BandPart`를 쓰는 곳이 없어 타입체크가 그대로 통과해야 한다. `MemberRow`가 `member.part`를 안 쓰므로 영향 없음.

- [ ] **Step 8: 커밋**

```bash
git add packages/api-client/src
git commit -m "feat(api-client): add band rename, ownership transfer, and delete with coded mock errors

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: 전체 검증과 README

**Files:**
- Modify: `README.md` (로컬 개발 환경 절)

- [ ] **Step 1: 전체 테스트**

Run: `pnpm --filter @bandapp/types build && pnpm --filter @bandapp/api-client build && pnpm --filter @bandapp/api test`
Expected: 단위·e2e 모두 PASS.

Run: `pnpm lint`
Expected: 오류 없음.

- [ ] **Step 2: README에 마이그레이션 메모**

`README.md`의 "### DB 마이그레이션" 절 끝에 한 줄 추가:

```
`0005` 마이그레이션이 `band_part` enum을 text로 바꾸고 `bands.deleted_at`을 더한다. 기존 `part = 'other'` 행은 NULL이 된다.
```

- [ ] **Step 3: 커밋**

```bash
git add README.md
git commit -m "docs: note the band part text migration

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## 자체 검토

- **스펙 커버리지:** 데이터 모델(Task 2), 타입(Task 1), API 4개와 code(Task 3·4), 삭제 파급 — 목록·라우트(Task 3)·초대(Task 5), api-client HTTP·Mock·시드(Task 6). 스펙의 "Mock 오류를 ApiError code로"는 Task 6.
- **도달 불가능한 code:** `band_cannot_remove_owner`는 owner가 1명뿐이라 `assertOwner` → 본인 409가 먼저 잡는다. 방어 코드로 남기고 테스트하지 않는다 (Task 4 Step 1에 기록).
- **타입 일관성:** `setMyPart(bandId, part: string | null)`(Task 1) ↔ Mock/HTTP(Task 1·6). `rename/transferOwnership/delete` 이름이 client.ts·HTTP·Mock·spec에서 동일. `bandError` 이름이 Task 3~4에서 동일.
