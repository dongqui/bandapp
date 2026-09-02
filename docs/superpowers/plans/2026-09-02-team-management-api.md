# 팀 관리 API 갭 메우기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 팀원 파트, Owner의 팀원 내보내기, 초대 실패 사유 구분, 안정적인 초대 링크를 서버와 공용 클라이언트에 구현한다.

**Architecture:** 기존 NestJS 모듈 구조를 그대로 쓴다. `BandsService`/`InvitesService`에 메서드를 더하고 컨트롤러에 라우트를 붙인다. 권한은 언제나 `MembershipsService.assertMember`/`assertOwner`가 서버에서 검증한다. 스키마 변경은 drizzle 마이그레이션 하나(`0002`)로 묶는다.

**Tech Stack:** NestJS 12 (ESM), drizzle-orm + PostgreSQL, vitest + supertest, pnpm workspace + turbo.

**선행 문서:** [2026-09-02-team-management-api-design.md](../specs/2026-09-02-team-management-api-design.md) — "스펙 결정 N"은 그 문서의 번호를 가리킨다.

## Global Constraints

- Node >= 22, pnpm 10. 모든 명령은 리포 루트에서 실행한다.
- **Postgres가 떠 있어야 한다.** `docker compose up -d`. e2e의 기본 `DATABASE_URL`은 `postgresql://band:band@localhost:5432/band`이고, `test/global-setup.ts`가 테스트 시작 시 `drizzle/`의 마이그레이션을 자동 적용한다.
- **`apps/api`는 ESM이다.** 모든 상대 경로 import는 `.js`로 끝난다 (`../db/schema.js`). 확장자를 빠뜨리면 런타임에 모듈을 못 찾는다.
- **`packages/types`를 고치면 소비자보다 먼저 빌드해야 한다.** 단일 패키지만 돌릴 때는 `pnpm --filter @bandapp/types build`를 먼저 실행한다. `pnpm test`(turbo)는 `^build` 의존이 걸려 있어 자동으로 처리된다.
- **사용자에게 보이는 문구는 한국어**, 코드 주석도 한국어가 리포 관례다. 커밋 메시지는 영어.
- e2e 실행: `pnpm --filter @bandapp/api test:e2e`
- api 전체(단위 + e2e): `pnpm --filter @bandapp/api test`
- api-client 단위: `pnpm --filter @bandapp/api-client test`
- 린트: `pnpm --filter @bandapp/api lint` (oxlint)
- e2e spec 파일들은 실제 Postgres 하나를 공유하고 `beforeEach`에서 truncate하므로 `fileParallelism: false`다. 새 테스트도 이 전제를 지킨다.

---

### Task 1: 스키마 변경과 평문 토큰 전환

초대 재사용의 전제다. `band_invites.token_hash`를 평문 `token`으로 바꾸고, 같은 마이그레이션에서 `band_members.part`와 `band_part` enum을 추가한다 (스펙 결정 2·6).

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/drizzle/0002_*.sql` (drizzle-kit이 이름을 정한다)
- Modify: `apps/api/src/invites/invites.service.ts`
- Test: `apps/api/test/invites.e2e-spec.ts:60-66` (기존 "원문 토큰은 DB에 저장되지 않는다" 단언을 뒤집는다)

**Interfaces:**
- Consumes: 없음 (첫 태스크)
- Produces: `bandPart` pgEnum (`"vocal" | "guitar" | "bass" | "drums" | "keyboard" | "other"`), `bandMembers.part` 컬럼(nullable), `bandInvites.token` 컬럼(text, not null, unique). `InvitesService`에서 `private hash()`가 사라진다.

- [ ] **Step 1: 실패 테스트를 쓴다**

`apps/api/test/invites.e2e-spec.ts`의 첫 `it` 안에서 마지막 두 줄을 교체한다.

```ts
  it("owner는 초대를 만들고 URL은 INVITE_LINK_BASE_URL/invite/<token>", async () => {
    const invite = await createInvite();
    expect(invite.url).toMatch(/^https:\/\/invite\.test\/invite\/[A-Za-z0-9_-]{20,}$/);
    // 재사용을 위해 토큰을 평문으로 저장한다 (스펙 결정 6)
    const rows = await db.query.bandInvites.findMany({ where: eq(bandInvites.bandId, bandId) });
    expect(rows[0]!.token).toBe(invite.token);
  });
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter @bandapp/api test:e2e -- invites`
Expected: FAIL — `Property 'token' does not exist on type` (타입 에러) 또는 `rows[0].token`이 `undefined`

- [ ] **Step 3: 스키마를 고친다**

`apps/api/src/db/schema.ts`에서 `bandRole` 선언 바로 아래에 enum을 추가한다.

```ts
// @bandapp/types의 MemberRole("owner" | "member")과 값을 일치시킨다 (스펙 결정 5)
export const bandRole = pgEnum("band_role", ["owner", "member"]);
// @bandapp/types의 BandPart와 값을 일치시킨다. 표시 문자열은 클라이언트 책임이다 (스펙 결정 2)
export const bandPart = pgEnum("band_part", [
  "vocal",
  "guitar",
  "bass",
  "drums",
  "keyboard",
  "other",
]);
```

`bandMembers`에 컬럼을 더한다.

```ts
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
    // null = 미설정. 초대 과정에서 파트를 묻지 않으므로 갓 참여한 멤버는 항상 null이다 (스펙 결정 4)
    part: bandPart("part"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.bandId, t.userId] })],
);
```

`bandInvites`의 `tokenHash` 줄을 교체한다.

```ts
  // 평문 저장 — 활성 초대를 재사용하려면 URL을 복원할 수 있어야 한다 (스펙 결정 6)
  token: text("token").notNull().unique(),
```

- [ ] **Step 4: 마이그레이션을 생성한다**

Run: `pnpm --filter @bandapp/api db:generate`

**drizzle-kit이 `token_hash` → `token`을 "rename"으로 볼지 물어본다. 반드시 rename이 아니라 "create + drop"을 고른다.** rename을 고르면 해시 값이 그대로 새 컬럼에 남아 모든 초대가 조회되지 않는다. 프롬프트에서 `+ token` / `- token_hash` 쪽 항목을 선택한다.

- [ ] **Step 5: 생성된 SQL 맨 위에 DELETE를 넣는다**

`apps/api/drizzle/0002_*.sql`을 열어 첫 줄에 아래를 추가한다. `not null` 컬럼을 기본값 없이 추가할 수 없고 해시에서 평문을 복원할 수도 없으므로 기존 초대를 버린다. 출시 전이라 살아있는 초대는 개발용뿐이고, 무효화돼도 초대 화면을 다시 열면 새로 발급된다.

```sql
--> 손으로 추가: 해시에서 평문 토큰을 복원할 수 없어 기존 초대를 버린다 (스펙 결정 6, 출시 전이라 안전)
DELETE FROM "band_invites";
```

- [ ] **Step 6: `InvitesService`가 평문 토큰을 쓰게 한다**

`apps/api/src/invites/invites.service.ts`에서:

import 줄을 바꾼다.

```ts
import { randomBytes } from "node:crypto";
```

`create()`의 insert를 바꾼다.

```ts
    const [row] = await this.db
      .insert(bandInvites)
      .values({ bandId, token, createdBy: userId, expiresAt })
      .returning();
```

`findValid()`의 조회 조건을 바꾼다.

```ts
    const invite = await this.db.query.bandInvites.findFirst({
      where: eq(bandInvites.token, token),
    });
```

`private hash()` 메서드 전체를 삭제한다.

```ts
  private hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }
```

- [ ] **Step 7: 테스트가 통과하는지 확인한다**

Run: `pnpm --filter @bandapp/api test:e2e`
Expected: PASS — invites·bands·auth 전체 통과. `global-setup`이 `0002`를 자동 적용한다.

- [ ] **Step 8: 커밋**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle apps/api/src/invites/invites.service.ts apps/api/test/invites.e2e-spec.ts
git commit -m "feat(api): store invite tokens in plaintext and add band_part"
```

---

### Task 2: `BandMember.part` 노출

멤버 조회가 파트를 함께 준다. 타입에 필수 nullable 필드를 더하므로 mock 픽스처까지 같이 맞춘다 (스펙 결정 1).

**Files:**
- Modify: `packages/types/src/band.ts`
- Modify: `apps/api/src/bands/bands.service.ts`
- Modify: `packages/api-client/src/mock/seed.ts:112-118`
- Modify: `packages/api-client/src/mock/MockApiClient.ts` (`bands.create`, `invites.join`)
- Test: `apps/api/test/bands.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 1의 `bandMembers.part` 컬럼
- Produces: `BandPart = "vocal" | "guitar" | "bass" | "drums" | "keyboard" | "other"`, `BandMember.part: BandPart | null` (optional 아님 — "아직 안 불러왔다"와 "설정 안 했다"가 섞이면 안 된다), `apps/api/src/bands/bands.service.ts`의 모듈 레벨 `memberColumns` 상수

- [ ] **Step 1: 실패 테스트를 쓴다**

`apps/api/test/bands.e2e-spec.ts`의 첫 `it`에서 단언을 고치고, 새 `it`을 그 아래에 추가한다.

```ts
    expect(members.body).toEqual([
      { id: owner.userId, name: "Dongjin", role: "owner", part: null },
    ]);
  });

  it("멤버 목록은 파트를 함께 준다", async () => {
    const bandId = await createBand(owner.accessToken);
    await db
      .update(bandMembers)
      .set({ part: "guitar" })
      .where(and(eq(bandMembers.bandId, bandId), eq(bandMembers.userId, owner.userId)));
    const res = await request(app.getHttpServer())
      .get(`/bands/${bandId}/members`)
      .set(auth(owner.accessToken))
      .expect(200);
    expect(res.body[0]).toMatchObject({ role: "owner", part: "guitar" });
  });
```

같은 파일 상단 import에 drizzle 연산자를 추가한다.

```ts
import { and, eq } from "drizzle-orm";
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter @bandapp/api test:e2e -- bands`
Expected: FAIL — 첫 테스트는 `part` 키가 응답에 없어 `toEqual` 불일치, 새 테스트는 `part: "guitar"` 없음

- [ ] **Step 3: 타입을 넓힌다**

`packages/types/src/band.ts` 전체를 아래로 바꾼다.

```ts
export type MemberRole = "owner" | "member";

/** DB의 band_part enum과 값을 일치시킨다. 표시 문자열(VOCAL, Vocal)은 클라이언트 책임. */
export type BandPart = "vocal" | "guitar" | "bass" | "drums" | "keyboard" | "other";

export interface Band {
  id: string;
  name: string;
  memberCount: number;
}

export interface BandMember {
  id: string;
  name: string;
  role: MemberRole;
  /** null = 미설정. optional이 아니라 필수 nullable — "안 불러왔다"와 "설정 안 했다"를 구분한다. */
  part: BandPart | null;
}
```

- [ ] **Step 4: 서버 조회에 파트를 넣는다**

`apps/api/src/bands/bands.service.ts`에서 import에 타입을 더한다.

```ts
import type { Band, BandMember, BandPart, MemberRole } from "@bandapp/types";
```

`BandsService` 클래스 선언 바로 위에 공용 컬럼 상수와 매퍼를 둔다. `members()`와 뒤 태스크의 `setPart()`가 같은 모양을 반환해야 하므로 한 곳에 모은다.

```ts
const memberColumns = {
  id: users.id,
  name: users.displayName,
  role: bandMembers.role,
  part: bandMembers.part,
};

function toBandMember(row: {
  id: string;
  name: string | null;
  role: MemberRole;
  part: BandPart | null;
}): BandMember {
  return { id: row.id, name: row.name ?? "탈퇴한 멤버", role: row.role, part: row.part };
}
```

`members()`를 바꾼다.

```ts
  async members(bandId: string): Promise<BandMember[]> {
    const rows = await this.db
      .select(memberColumns)
      .from(bandMembers)
      .innerJoin(users, eq(users.id, bandMembers.userId))
      .where(eq(bandMembers.bandId, bandId))
      .orderBy(bandMembers.joinedAt);
    return rows.map(toBandMember);
  }
```

- [ ] **Step 5: mock 픽스처를 맞춘다**

`packages/api-client/src/mock/seed.ts`의 멤버 배열을 바꾼다.

```ts
        { id: "m1", name: "Dongjin Kim", role: "owner", part: "guitar" },
        { id: "m2", name: "Minsu", role: "member", part: "vocal" },
        { id: "m3", name: "Jihoon", role: "member", part: "bass" },
        { id: "m4", name: "Suhyun", role: "member", part: null },
```

`packages/api-client/src/mock/MockApiClient.ts`의 두 곳에 `part: null`을 더한다. 갓 만들어진 멤버는 파트가 없는 것이 정상이다.

```ts
      this.state.members[band.id] = [
        { id: MOCK_USER.id, name: MOCK_USER.displayName ?? "나", role: "owner", part: null },
      ];
```

```ts
      members.push({ id: MOCK_USER.id, name: MOCK_USER.displayName ?? "나", role: "member", part: null });
```

- [ ] **Step 6: 테스트가 통과하는지 확인한다**

Run: `pnpm --filter @bandapp/types build && pnpm --filter @bandapp/api test:e2e && pnpm --filter @bandapp/api-client test`
Expected: PASS — 전부 통과

- [ ] **Step 7: 커밋**

```bash
git add packages/types/src/band.ts apps/api/src/bands/bands.service.ts packages/api-client/src/mock apps/api/test/bands.e2e-spec.ts
git commit -m "feat(api): expose member part in the band member list"
```

---

### Task 3: `PATCH /bands/:bandId/members/me` — 본인 파트 설정

본인만 자기 파트를 쓴다. 타인의 파트를 쓰는 경로는 만들지 않는다 (스펙 결정 3).

**Files:**
- Modify: `apps/api/src/common/validation.ts`
- Modify: `apps/api/src/bands/bands.service.ts`
- Modify: `apps/api/src/bands/bands.controller.ts`
- Test: `apps/api/test/bands.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 2의 `memberColumns`, `toBandMember`, `BandPart`
- Produces: `requireBandPartOrNull(body: unknown, field: string): BandPart | null` (`apps/api/src/common/validation.ts`), `BandsService.setPart(bandId: string, userId: string, part: BandPart | null): Promise<BandMember>`

- [ ] **Step 1: 실패 테스트를 쓴다**

`apps/api/test/bands.e2e-spec.ts`에 추가한다.

```ts
  it("본인 파트를 설정하고 해제한다", async () => {
    const bandId = await createBand(owner.accessToken);
    const set = await request(app.getHttpServer())
      .patch(`/bands/${bandId}/members/me`)
      .set(auth(owner.accessToken))
      .send({ part: "guitar" })
      .expect(200);
    expect(set.body).toMatchObject({ id: owner.userId, role: "owner", part: "guitar" });

    const cleared = await request(app.getHttpServer())
      .patch(`/bands/${bandId}/members/me`)
      .set(auth(owner.accessToken))
      .send({ part: null })
      .expect(200);
    expect(cleared.body.part).toBeNull();
  });

  it("정의되지 않은 파트는 400, 비멤버는 403", async () => {
    const bandId = await createBand(owner.accessToken);
    await request(app.getHttpServer())
      .patch(`/bands/${bandId}/members/me`)
      .set(auth(owner.accessToken))
      .send({ part: "trumpet" })
      .expect(400);
    await request(app.getHttpServer())
      .patch(`/bands/${bandId}/members/me`)
      .set(auth(owner.accessToken))
      .send({})
      .expect(400);
    const stranger = await secondUser("stranger-part");
    await request(app.getHttpServer())
      .patch(`/bands/${bandId}/members/me`)
      .set(auth(stranger.accessToken))
      .send({ part: "bass" })
      .expect(403);
  });
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter @bandapp/api test:e2e -- bands`
Expected: FAIL — 404 (라우트가 없다)

- [ ] **Step 3: 검증 헬퍼를 추가한다**

`apps/api/src/common/validation.ts` 맨 아래에 붙인다.

```ts
const BAND_PARTS = ["vocal", "guitar", "bass", "drums", "keyboard", "other"] as const;

/**
 * null을 허용한다 — 파트 미설정이 정상 상태이고, 해제 전용 엔드포인트 대신 같은 PATCH로 받는다
 * (스펙 결정 4). 필드가 아예 없으면 400 — 의도한 해제와 실수를 구분한다.
 */
export function requireBandPartOrNull(body: unknown, field: string): BandPart | null {
  const value = (body as Record<string, unknown> | null | undefined)?.[field];
  if (value === null) return null;
  if (typeof value !== "string" || !(BAND_PARTS as readonly string[]).includes(value)) {
    throw new BadRequestException(`${field} must be one of ${BAND_PARTS.join(", ")} or null`);
  }
  return value as BandPart;
}
```

같은 파일 첫 줄 아래에 타입 import를 더한다.

```ts
import { BadRequestException } from "@nestjs/common";
import type { BandPart } from "@bandapp/types";
```

- [ ] **Step 4: 서비스에 `setPart`를 추가한다**

`apps/api/src/bands/bands.service.ts`의 `members()` 아래에 붙인다.

```ts
  /** 본인 파트만 쓴다 — 타인의 파트를 쓰는 경로는 없다 (스펙 결정 3). */
  async setPart(bandId: string, userId: string, part: BandPart | null): Promise<BandMember> {
    await this.memberships.assertMember(bandId, userId);
    await this.db
      .update(bandMembers)
      .set({ part })
      .where(and(eq(bandMembers.bandId, bandId), eq(bandMembers.userId, userId)));
    const [row] = await this.db
      .select(memberColumns)
      .from(bandMembers)
      .innerJoin(users, eq(users.id, bandMembers.userId))
      .where(and(eq(bandMembers.bandId, bandId), eq(bandMembers.userId, userId)));
    if (!row) throw new Error("member vanished between update and read");
    return toBandMember(row);
  }
```

`and`는 이미 import돼 있다(`import { and, eq, sql } from "drizzle-orm";`).

- [ ] **Step 5: 컨트롤러에 라우트를 붙인다**

`apps/api/src/bands/bands.controller.ts`의 import에 `Patch`와 헬퍼를 더한다.

```ts
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
```

```ts
import { requireBandPartOrNull, requireString, requireUuidParam } from "../common/validation.js";
```

`members()` 핸들러 아래에 추가한다.

```ts
  @Patch(":bandId/members/me")
  setMyPart(
    @CurrentUserId() userId: string,
    @Param("bandId") bandId: string,
    @Body() body: unknown,
  ): Promise<BandMember> {
    requireUuidParam(bandId, "bandId");
    return this.bandsService.setPart(bandId, userId, requireBandPartOrNull(body, "part"));
  }
```

- [ ] **Step 6: 테스트가 통과하는지 확인한다**

Run: `pnpm --filter @bandapp/api test:e2e -- bands`
Expected: PASS

- [ ] **Step 7: 커밋**

```bash
git add apps/api/src/common/validation.ts apps/api/src/bands apps/api/test/bands.e2e-spec.ts
git commit -m "feat(api): let a member set their own part"
```

---

### Task 4: `DELETE /bands/:bandId/members/:userId` — 팀원 내보내기

Owner 전용. 성공하면 같은 트랜잭션에서 그 밴드의 활성 초대를 전부 무효화한다 (스펙 결정 5).

**Files:**
- Modify: `apps/api/src/bands/bands.service.ts`
- Modify: `apps/api/src/bands/bands.controller.ts`
- Test: `apps/api/test/bands.e2e-spec.ts`

**Interfaces:**
- Consumes: `MembershipsService.assertOwner`, `MembershipsService.roleOf`
- Produces: `BandsService.removeMember(bandId: string, actorId: string, targetUserId: string): Promise<void>`

**중요 — 라우트 순서:** `@Delete(":bandId/members/me")`가 `@Delete(":bandId/members/:userId")`보다 **먼저** 선언돼 있어야 한다. Nest는 선언 순서로 매칭하므로 순서가 뒤집히면 `me`가 `:userId`로 잡혀 `requireUuidParam`이 400을 던진다. 기존 `leave()` 아래에 새 핸들러를 붙이면 순서가 맞는다.

- [ ] **Step 1: 실패 테스트를 쓴다**

`apps/api/test/bands.e2e-spec.ts`에 추가한다. 초대 revoke 확인을 위해 파일 상단 import에 `bandInvites`를 더한다 (`import { bandInvites, bandMembers } from "../src/db/schema.js";`).

```ts
  it("owner는 팀원을 내보내고, 그 밴드의 활성 초대가 함께 무효화된다", async () => {
    const bandId = await createBand(owner.accessToken);
    const member = await secondUser("kick-target");
    await db.insert(bandMembers).values({ bandId, userId: member.userId, role: "member" });
    const invite = await request(app.getHttpServer())
      .post(`/bands/${bandId}/invites`)
      .set(auth(owner.accessToken))
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/bands/${bandId}/members/${member.userId}`)
      .set(auth(owner.accessToken))
      .expect(204);

    const members = await request(app.getHttpServer())
      .get(`/bands/${bandId}/members`)
      .set(auth(owner.accessToken))
      .expect(200);
    expect(members.body).toHaveLength(1);

    const rows = await db.query.bandInvites.findMany({ where: eq(bandInvites.bandId, bandId) });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(invite.body.id);
    expect(rows[0]!.revokedAt).not.toBeNull();
  });

  it("다른 밴드의 초대는 내보내기에 영향받지 않는다", async () => {
    const bandA = await createBand(owner.accessToken, "BAND A");
    const bandB = await createBand(owner.accessToken, "BAND B");
    const member = await secondUser("kick-target-2");
    await db.insert(bandMembers).values({ bandId: bandA, userId: member.userId, role: "member" });
    const inviteB = await request(app.getHttpServer())
      .post(`/bands/${bandB}/invites`)
      .set(auth(owner.accessToken))
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/bands/${bandA}/members/${member.userId}`)
      .set(auth(owner.accessToken))
      .expect(204);

    const rows = await db.query.bandInvites.findMany({ where: eq(bandInvites.bandId, bandB) });
    expect(rows[0]!.revokedAt).toBeNull();
    expect(inviteB.body.id).toBe(rows[0]!.id);
  });

  it("내보내기 권한과 대상 검증", async () => {
    const bandId = await createBand(owner.accessToken);
    const member = await secondUser("plain-member");
    await db.insert(bandMembers).values({ bandId, userId: member.userId, role: "member" });
    const other = await secondUser("another-member");
    await db.insert(bandMembers).values({ bandId, userId: other.userId, role: "member" });

    // member는 다른 member를 내보낼 수 없다
    await request(app.getHttpServer())
      .delete(`/bands/${bandId}/members/${other.userId}`)
      .set(auth(member.accessToken))
      .expect(403);
    // owner가 자기 자신을 내보내려 하면 409 — 팀 나가기를 써야 한다
    await request(app.getHttpServer())
      .delete(`/bands/${bandId}/members/${owner.userId}`)
      .set(auth(owner.accessToken))
      .expect(409);
    // 멤버가 아닌 사용자는 404
    const stranger = await secondUser("not-a-member");
    await request(app.getHttpServer())
      .delete(`/bands/${bandId}/members/${stranger.userId}`)
      .set(auth(owner.accessToken))
      .expect(404);
    // UUID가 아니면 400
    await request(app.getHttpServer())
      .delete(`/bands/${bandId}/members/not-a-uuid`)
      .set(auth(owner.accessToken))
      .expect(400);
  });

  it("DELETE .../members/me는 여전히 탈퇴로 동작한다 (라우트 순서)", async () => {
    const bandId = await createBand(owner.accessToken);
    const member = await secondUser("leaver");
    await db.insert(bandMembers).values({ bandId, userId: member.userId, role: "member" });
    await request(app.getHttpServer())
      .delete(`/bands/${bandId}/members/me`)
      .set(auth(member.accessToken))
      .expect(204);
  });
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter @bandapp/api test:e2e -- bands`
Expected: FAIL — 새 라우트가 없어 `members/:userId` 요청이 404

- [ ] **Step 3: 서비스에 `removeMember`를 추가한다**

`apps/api/src/bands/bands.service.ts`의 import를 넓힌다.

```ts
import { ConflictException, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { bandInvites, bandMembers, bands, users } from "../db/schema.js";
```

`leave()` 아래에 붙인다.

```ts
  /**
   * 검증 순서가 중요하다 — owner 확인이 먼저다. 권한 없는 사람이 404/409로
   * 멤버십 존재 여부를 물어볼 수 있으면 안 된다.
   */
  async removeMember(bandId: string, actorId: string, targetUserId: string): Promise<void> {
    await this.memberships.assertOwner(bandId, actorId);
    const targetRole = await this.memberships.roleOf(bandId, targetUserId);
    if (!targetRole) throw new NotFoundException("팀원을 찾을 수 없어요.");
    if (targetUserId === actorId) {
      throw new ConflictException("자기 자신은 내보낼 수 없어요. 팀 나가기를 사용해 주세요.");
    }
    if (targetRole === "owner") throw new ConflictException("팀장은 내보낼 수 없어요.");
    await this.db.transaction(async (tx) => {
      await tx
        .delete(bandMembers)
        .where(and(eq(bandMembers.bandId, bandId), eq(bandMembers.userId, targetUserId)));
      // 내보낸 사람이 폰에 남은 링크로 곧장 돌아오지 못하게 활성 초대를 전부 무효화한다 (스펙 결정 5)
      await tx
        .update(bandInvites)
        .set({ revokedAt: new Date() })
        .where(and(eq(bandInvites.bandId, bandId), isNull(bandInvites.revokedAt)));
    });
  }
```

- [ ] **Step 4: 컨트롤러에 라우트를 붙인다**

`apps/api/src/bands/bands.controller.ts`의 `leave()` **아래에** 추가한다. 순서가 바뀌면 `members/me`가 깨진다.

```ts
  @Delete(":bandId/members/:userId")
  @HttpCode(204)
  async removeMember(
    @CurrentUserId() actorId: string,
    @Param("bandId") bandId: string,
    @Param("userId") userId: string,
  ): Promise<void> {
    requireUuidParam(bandId, "bandId");
    requireUuidParam(userId, "userId");
    await this.bandsService.removeMember(bandId, actorId, userId);
  }
```

- [ ] **Step 5: 테스트가 통과하는지 확인한다**

Run: `pnpm --filter @bandapp/api test:e2e -- bands`
Expected: PASS

무효화 확인을 HTTP 응답이 아니라 DB의 `revokedAt`으로 하는 이유: 취소된 초대가 410을 내는 것은 Task 5의 책임이라, 여기서 상태 코드를 단언하면 두 태스크가 서로를 붙잡는다.

- [ ] **Step 6: 커밋**

```bash
git add apps/api/src/bands apps/api/test/bands.e2e-spec.ts
git commit -m "feat(api): let an owner remove a member and revoke live invites"
```

---

### Task 5: 초대 실패 사유 구분

찾은 토큰에 한해 사유를 밝힌다 (스펙 결정 7·8).

**Files:**
- Modify: `packages/types/src/invite.ts`
- Create: `apps/api/src/invites/invite-errors.ts`
- Modify: `apps/api/src/invites/invites.service.ts`
- Modify: `apps/api/src/invites/invites.controller.ts`
- Test: `apps/api/test/invites.e2e-spec.ts`, `apps/api/test/bands.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 1의 `bandInvites.token`
- Produces: `InviteErrorCode` (`@bandapp/types`), `inviteError(code: InviteErrorCode): { message: string; code: InviteErrorCode }` (`apps/api/src/invites/invite-errors.ts`)

- [ ] **Step 1: 실패 테스트를 쓴다**

`apps/api/test/invites.e2e-spec.ts`의 `it("만료/취소/미존재 초대는 404", ...)` 전체를 아래 셋으로 교체한다.

```ts
  it("없는 토큰은 404 invite_not_found", async () => {
    const res = await request(app.getHttpServer()).get("/invites/does-not-exist-token-x").expect(404);
    expect(res.body.code).toBe("invite_not_found");
  });

  it("만료된 초대는 410 invite_expired", async () => {
    const invite = await createInvite();
    await db
      .update(bandInvites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(bandInvites.id, invite.id));
    const res = await request(app.getHttpServer()).get(`/invites/${invite.token}`).expect(410);
    expect(res.body.code).toBe("invite_expired");
    const join = await request(app.getHttpServer())
      .post(`/invites/${invite.token}/join`)
      .set(auth(owner.accessToken))
      .expect(410);
    expect(join.body.code).toBe("invite_expired");
  });

  it("취소된 초대는 410 invite_revoked이고, 만료까지 겹치면 revoked가 이긴다", async () => {
    const invite = await createInvite();
    await request(app.getHttpServer())
      .delete(`/bands/${bandId}/invites/${invite.id}`)
      .set(auth(owner.accessToken))
      .expect(204);
    const res = await request(app.getHttpServer()).get(`/invites/${invite.token}`).expect(410);
    expect(res.body.code).toBe("invite_revoked");

    await db
      .update(bandInvites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(bandInvites.id, invite.id));
    const both = await request(app.getHttpServer()).get(`/invites/${invite.token}`).expect(410);
    expect(both.body.code).toBe("invite_revoked");
  });
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter @bandapp/api test:e2e -- invites`
Expected: FAIL — 만료·취소가 전부 404로 오고 `body.code`가 `undefined`

- [ ] **Step 3: 타입에 코드를 추가한다**

`packages/types/src/invite.ts` 맨 아래에 붙인다.

```ts
/** 초대 조회·참여 실패 사유. 서버가 오류 본문의 code로 내려준다 (스펙 결정 7). */
export type InviteErrorCode =
  | "invite_not_found"
  | "invite_revoked"
  | "invite_expired"
  | "invite_exhausted";
```

- [ ] **Step 4: 오류 헬퍼 파일을 만든다**

Create `apps/api/src/invites/invite-errors.ts`:

```ts
import type { InviteErrorCode } from "@bandapp/types";

const MESSAGES: Record<InviteErrorCode, string> = {
  invite_not_found: "유효하지 않은 초대예요.",
  invite_revoked: "더 이상 사용할 수 없는 초대예요.",
  invite_expired: "초대가 만료되었어요.",
  invite_exhausted: "초대 사용 횟수가 모두 찼어요.",
};

/**
 * HttpException에 객체를 넘기면 그 객체가 그대로 응답 본문이 된다.
 * 기존 클라이언트가 body.message를 읽고 있어 하위 호환된다 (스펙 결정 9).
 */
export function inviteError(code: InviteErrorCode): { message: string; code: InviteErrorCode } {
  return { message: MESSAGES[code], code };
}
```

- [ ] **Step 5: `findValid`를 분기시킨다**

`apps/api/src/invites/invites.service.ts`의 import를 넓힌다.

```ts
import { GoneException, NotFoundException } from "@nestjs/common";
import { inviteError } from "./invite-errors.js";
```

`findValid()` 전체를 교체한다.

```ts
  /**
   * 찾지 못한 토큰은 사유를 밝히지 않는다. 찾은 토큰은 이미 그 문자열을 쥔 사람에게만
   * 응답하는 것이라 사유를 알려도 새로 새는 정보가 없다 (스펙 결정 7).
   * 취소가 만료보다 먼저다 — 둘 다 해당해도 "취소됨"이 더 정확한 설명이다.
   */
  private async findValid(token: string): Promise<typeof bandInvites.$inferSelect> {
    const invite = await this.db.query.bandInvites.findFirst({
      where: eq(bandInvites.token, token),
    });
    if (!invite) throw new NotFoundException(inviteError("invite_not_found"));
    if (invite.revokedAt) throw new GoneException(inviteError("invite_revoked"));
    if (invite.expiresAt <= new Date()) throw new GoneException(inviteError("invite_expired"));
    if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) {
      throw new GoneException(inviteError("invite_exhausted"));
    }
    return invite;
  }
```

같은 파일의 `preview()`와 `revoke()`에 남은 문자열 예외도 코드를 싣게 바꾼다.

```ts
    if (!band) throw new NotFoundException(inviteError("invite_not_found"));
```

```ts
    if (!row) throw new NotFoundException(inviteError("invite_not_found"));
```

- [ ] **Step 6: 컨트롤러의 형식 검사도 같은 코드를 내게 한다**

`apps/api/src/invites/invites.controller.ts`에서 import를 더하고 헬퍼를 바꾼다.

```ts
import { inviteError } from "./invite-errors.js";
```

```ts
function requireInviteToken(token: string): string {
  // 형식이 아예 다르면 조회 없이 404 (없는 토큰과 같은 응답)
  if (!INVITE_TOKEN_RE.test(token)) throw new NotFoundException(inviteError("invite_not_found"));
  return token;
}
```

- [ ] **Step 7: 테스트가 통과하는지 확인한다**

Run: `pnpm --filter @bandapp/types build && pnpm --filter @bandapp/api test:e2e`
Expected: PASS — invites·bands 전부 통과

- [ ] **Step 8: 커밋**

```bash
git add packages/types/src/invite.ts apps/api/src/invites apps/api/test
git commit -m "feat(api): name the reason an invite failed"
```

---

### Task 6: 활성 초대 재사용

화면 진입마다 새 링크가 생기지 않게 한다 (스펙 결정 6).

**Files:**
- Modify: `apps/api/src/invites/invites.service.ts`
- Test: `apps/api/test/invites.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 1의 `bandInvites.token`, Task 4의 `DELETE /bands/:bandId/members/:userId`와 Task 5의 410 응답 (마지막 테스트가 둘 다 쓴다)
- Produces: `InvitesService.create`의 동작 변경(계약은 그대로 `BandInvite`, 상태 코드도 201 유지), `private toBandInvite(row)`, `private findActive(bandId)`

- [ ] **Step 1: 실패 테스트를 쓴다**

`apps/api/test/invites.e2e-spec.ts`에 추가한다.

```ts
  it("활성 초대가 있으면 재발급하지 않고 같은 링크를 준다", async () => {
    const first = await createInvite();
    const second = await createInvite();
    expect(second.url).toBe(first.url);
    expect(second.id).toBe(first.id);
    const rows = await db.query.bandInvites.findMany({ where: eq(bandInvites.bandId, bandId) });
    expect(rows).toHaveLength(1);
    // 재사용된 링크가 실제로 조회된다 — 평문 저장 왕복 확인
    await request(app.getHttpServer()).get(`/invites/${second.token}`).expect(200);
  });

  it("취소된 뒤에는 새 링크가 발급된다", async () => {
    const first = await createInvite();
    await request(app.getHttpServer())
      .delete(`/bands/${bandId}/invites/${first.id}`)
      .set(auth(owner.accessToken))
      .expect(204);
    const second = await createInvite();
    expect(second.url).not.toBe(first.url);
    await request(app.getHttpServer()).get(`/invites/${second.token}`).expect(200);
  });

  it("만료된 초대만 있으면 새 링크가 발급된다", async () => {
    const first = await createInvite();
    await db
      .update(bandInvites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(bandInvites.id, first.id));
    const second = await createInvite();
    expect(second.id).not.toBe(first.id);
    await request(app.getHttpServer()).get(`/invites/${second.token}`).expect(200);
  });

  it("팀원을 내보낸 뒤 발급하면 이전과 다른 링크가 나온다", async () => {
    const before = await createInvite();
    const member = await memberLogin("kicked-then-reinvited");
    await request(app.getHttpServer())
      .post(`/invites/${before.token}/join`)
      .set(auth(member.accessToken))
      .expect(200);

    await request(app.getHttpServer())
      .delete(`/bands/${bandId}/members/${member.userId}`)
      .set(auth(owner.accessToken))
      .expect(204);

    // 내보내기가 활성 초대를 전부 무효화했으므로 재사용 대상이 없다 (스펙 결정 5·6)
    const after = await createInvite();
    expect(after.url).not.toBe(before.url);
    await request(app.getHttpServer()).get(`/invites/${before.token}`).expect(410);
    await request(app.getHttpServer()).get(`/invites/${after.token}`).expect(200);
  });
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter @bandapp/api test:e2e -- invites`
Expected: FAIL — 첫 테스트에서 `second.url`이 `first.url`과 다르고 행이 2개

- [ ] **Step 3: 재사용을 구현한다**

`apps/api/src/invites/invites.service.ts`의 drizzle import를 넓힌다.

```ts
import { and, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
```

`create()` 전체를 교체한다.

```ts
  async create(bandId: string, userId: string): Promise<BandInvite> {
    await this.memberships.assertOwner(bandId, userId);
    // 화면 진입마다 새 링크가 생기지 않도록 살아있는 초대를 재사용한다 (스펙 결정 6).
    // 동시 요청이 둘 다 "없음"으로 판정해 2개가 생길 수 있으나, revoke가 활성 초대를
    // 전부 무효화하므로 보장이 깨지지 않는다. 밴드 단위 락은 얻는 것에 비해 비싸다.
    const active = await this.findActive(bandId);
    if (active) return this.toBandInvite(active);
    const token = randomBytes(24).toString("base64url"); // 32자 — 충분히 긴 random token
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
    const [row] = await this.db
      .insert(bandInvites)
      .values({ bandId, token, createdBy: userId, expiresAt })
      .returning();
    if (!row) throw new Error("failed to insert invite");
    return this.toBandInvite(row);
  }

  /** "활성"의 정의는 findValid와 같다. 여럿이면 가장 최근 것. */
  private async findActive(bandId: string): Promise<typeof bandInvites.$inferSelect | null> {
    const [row] = await this.db
      .select()
      .from(bandInvites)
      .where(
        and(
          eq(bandInvites.bandId, bandId),
          isNull(bandInvites.revokedAt),
          gt(bandInvites.expiresAt, new Date()),
          or(isNull(bandInvites.maxUses), lt(bandInvites.usedCount, bandInvites.maxUses)),
        ),
      )
      .orderBy(desc(bandInvites.createdAt))
      .limit(1);
    return row ?? null;
  }

  private toBandInvite(row: typeof bandInvites.$inferSelect): BandInvite {
    return { id: row.id, url: this.inviteUrl(row.token), expiresAt: row.expiresAt.toISOString() };
  }
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm --filter @bandapp/api test:e2e && pnpm --filter @bandapp/api lint`
Expected: PASS — 특히 Task 4의 "다른 밴드의 초대는 내보내기에 영향받지 않는다"가 계속 통과해야 한다

- [ ] **Step 5: 커밋**

```bash
git add apps/api/src/invites/invites.service.ts apps/api/test/invites.e2e-spec.ts
git commit -m "feat(api): reuse a band's live invite instead of minting a new one"
```

---

### Task 7: 공용 클라이언트 배선

`ApiError`가 `code`를 나르고, 새 엔드포인트 세 개가 클라이언트 인터페이스에 오른다 (스펙 결정 9).

`revokeInvite`는 서버에 이미 있으나 클라이언트 메서드가 없던 것이다. 초대 화면의 "이전 초대 링크 비활성화"가 이걸 쓴다.

**Files:**
- Modify: `packages/api-client/src/client.ts`
- Modify: `packages/api-client/src/http/HttpApiClient.ts`
- Modify: `packages/api-client/src/mock/MockApiClient.ts`
- Test: `packages/api-client/src/http/HttpApiClient.spec.ts`

**Interfaces:**
- Consumes: Task 2의 `BandPart`·`BandMember.part`, Task 5의 `InviteErrorCode`
- Produces: `ApiError.code?: string`, `RehearsalApiClient["bands"]`에 `setMyPart(bandId, part)`, `removeMember(bandId, userId)`, `revokeInvite(bandId, inviteId)`

- [ ] **Step 1: 실패 테스트를 쓴다**

`packages/api-client/src/http/HttpApiClient.spec.ts`의 마지막 `it` 아래에 추가한다.

```ts
  it("오류 본문의 code를 ApiError.code로 전달한다", async () => {
    const tokens = memoryTokens({ accessToken: "a1", refreshToken: "r1" });
    const fetchFn = vi.fn(async () =>
      json(410, { message: "초대가 만료되었어요.", code: "invite_expired" }),
    );
    const client = new HttpApiClient({ baseUrl: "https://api.test", tokens, fetchFn });
    await expect(client.invites.preview("tok123")).rejects.toMatchObject({
      status: 410,
      code: "invite_expired",
      message: "초대가 만료되었어요.",
    });
  });

  it("code 없는 오류는 ApiError.code가 undefined다", async () => {
    const tokens = memoryTokens({ accessToken: "a1", refreshToken: "r1" });
    const fetchFn = vi.fn(async () => json(400, { message: "name must be 1-50 characters" }));
    const client = new HttpApiClient({ baseUrl: "https://api.test", tokens, fetchFn });
    const err = await client.bands.create("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBeUndefined();
  });

  it("본인 파트 설정은 PATCH .../members/me로 나간다", async () => {
    const tokens = memoryTokens({ accessToken: "a1", refreshToken: "r1" });
    const fetchFn = vi.fn(async () =>
      json(200, { id: "u1", name: "Dongjin", role: "owner", part: "guitar" }),
    );
    const client = new HttpApiClient({ baseUrl: "https://api.test", tokens, fetchFn });
    const member = await client.bands.setMyPart("b1", "guitar");
    expect(member.part).toBe("guitar");
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.test/bands/b1/members/me",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ part: "guitar" }) }),
    );
  });

  it("팀원 내보내기는 DELETE .../members/<userId>로 나간다", async () => {
    const tokens = memoryTokens({ accessToken: "a1", refreshToken: "r1" });
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));
    const client = new HttpApiClient({ baseUrl: "https://api.test", tokens, fetchFn });
    await client.bands.removeMember("b1", "u2");
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.test/bands/b1/members/u2",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter @bandapp/api-client test`
Expected: FAIL — `Property 'setMyPart' does not exist`, `code` 단언 불일치

- [ ] **Step 3: 인터페이스를 넓힌다**

`packages/api-client/src/client.ts`의 타입 import에 `BandPart`를 더하고 `bands` 블록을 교체한다.

```ts
  bands: {
    list(): Promise<Band[]>;
    create(name: string): Promise<Band>;
    members(bandId: string): Promise<BandMember[]>;
    /** 본인 파트만 설정한다. null이면 해제. */
    setMyPart(bandId: string, part: BandPart | null): Promise<BandMember>;
    /** Owner 전용. 성공하면 서버가 그 밴드의 활성 초대를 함께 무효화한다. */
    removeMember(bandId: string, userId: string): Promise<void>;
    leave(bandId: string): Promise<void>;
    createInvite(bandId: string): Promise<BandInvite>;
    revokeInvite(bandId: string, inviteId: string): Promise<void>;
  };
```

- [ ] **Step 4: `ApiError`에 code를 싣는다**

`packages/api-client/src/http/HttpApiClient.ts`에서 `ApiError`를 바꾼다.

```ts
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
```

`request()`의 실패 처리를 바꾼다.

```ts
    if (!res.ok) {
      const { message, code } = await this.errorFrom(res);
      throw new ApiError(res.status, message, code);
    }
```

`errorMessage()`를 `errorFrom()`으로 교체한다.

```ts
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
```

- [ ] **Step 5: HTTP 구현에 메서드를 더한다**

`packages/api-client/src/http/HttpApiClient.ts`의 타입 import에 `BandPart`를 더하고, `bands` 블록의 `members` 아래에 붙인다.

```ts
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
```

`createInvite` 아래에 붙인다.

```ts
    revokeInvite: async (bandId: string, inviteId: string): Promise<void> => {
      await this.request<void>("DELETE", `/bands/${bandId}/invites/${inviteId}`);
    },
```

- [ ] **Step 6: Mock 구현을 맞춘다**

`packages/api-client/src/mock/MockApiClient.ts`의 타입 import에 `BandPart`를 더하고 `bands` 블록에 붙인다.

```ts
    setMyPart: async (bandId: string, part: BandPart | null): Promise<BandMember> => {
      const me = (this.state.members[bandId] ?? []).find((m) => m.id === MOCK_USER.id);
      if (!me) throw new Error("이 밴드의 멤버가 아니에요.");
      me.part = part;
      this.emit();
      return { ...me };
    },
    removeMember: async (bandId: string, userId: string): Promise<void> => {
      const members = this.state.members[bandId];
      if (!members) return;
      this.state.members[bandId] = members.filter((m) => m.id !== userId);
      const band = this.state.bands.find((b) => b.id === bandId);
      if (band) band.memberCount = this.state.members[bandId]!.length;
      this.emit();
    },
    // mock 토큰은 bandId에서 결정적으로 만들어지므로 무효화할 상태가 없다 — no-op.
    revokeInvite: async (): Promise<void> => undefined,
```

- [ ] **Step 7: 테스트가 통과하는지 확인한다**

Run: `pnpm build && pnpm test`
Expected: PASS — types 빌드, api 단위·e2e, api-client 단위, mobile 단위 전부 통과

- [ ] **Step 8: 커밋**

```bash
git add packages/api-client/src
git commit -m "feat(api-client): carry error codes and expose the new band endpoints"
```

---

## 완료 확인

전부 끝나면 리포 루트에서 한 번에 돌린다.

```bash
docker compose up -d
pnpm build && pnpm lint && pnpm test
```

`pnpm --filter mobile typecheck`도 통과해야 한다 — `BandMember.part`가 필수 필드가 되면서 모바일이 멤버를 만드는 곳이 있으면 여기서 잡힌다.
