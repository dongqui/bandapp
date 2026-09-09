# 코멘트 수정·삭제와 원본 녹음 코멘트 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 작성자가 자기 코멘트·답글의 본문을 고치거나 지울 수 있고, 원본 녹음에도 take와 같은 방식으로 코멘트를 남길 수 있게 한다.

**Architecture:** `comments` 테이블에 `session_id`(NOT NULL)·`updated_at`을 더하고 `take_id`를 nullable로 바꿔 원본 코멘트를 같은 행·같은 타입으로 다룬다. `CommentsService`는 대상을 `CommentScope`(sessionId, takeId|null, lengthMs)로 받아 목록·생성 로직을 한 벌로 두고, `PATCH/DELETE /comments/:id`는 코멘트 → 세션 멤버십 → 작성자 순으로 검증한다. api-client는 `CommentTarget = { takeId } | { sessionId }`로 경로를 고르고, 모바일 `TakePlayerScreen`은 원본일 때 `{ sessionId }` target으로 같은 UI를 켠다. 수정·삭제 UI는 디자인의 `···` 시트 → 편집 배너 / `ConfirmDialog` 흐름이다.

**Tech Stack:** NestJS 11 + drizzle-orm(Postgres), vitest(e2e는 실 Postgres), pnpm workspace(`@bandapp/types`·`@bandapp/api-client`는 `dist`로 소비 → 변경 후 build 필요), Expo/React Native.

스펙: [docs/superpowers/specs/2026-09-09-comment-edit-delete-original-design.md](../specs/2026-09-09-comment-edit-delete-original-design.md)

## Global Constraints

- 수정·삭제는 `author_id === userId`인 작성자만. 아니면 403.
- 수정은 본문(`text`)만. `updated_at`은 수정 시에만 채운다.
- 부모 삭제 시 답글은 기존 `parent_id ON DELETE CASCADE`로 사라진다.
- `comments.session_id`는 모든 행에 NOT NULL. 원본 코멘트는 `take_id IS NULL`.
- 세션 `commentCount`는 `session_id` 기준 최상위 코멘트 수(원본 포함). take `commentCount`는 그대로.
- text는 trim 후 1~500자.
- 모바일 새 문구는 이 화면의 기존 방식대로 영어 하드코딩 (i18n 리소스에 넣지 않는다).
- `TakeComment` 타입 이름은 유지한다.
- e2e 테스트는 `localhost:5432`의 Postgres가 필요하다: 리포 루트에서 `docker compose up -d postgres`.
- 커밋 메시지 끝에 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## 파일 구조

| 파일 | 역할 |
|---|---|
| `packages/types/src/take.ts` | `TakeComment`에 `sessionId`·`takeId: string \| null`·`updatedAt`, `CommentTarget`, `UpdateCommentInput` |
| `apps/api/src/db/schema.ts` | `comments`에 `sessionId`·`updatedAt`, `takeId` nullable, `(session_id, at_ms)` 인덱스 |
| `apps/api/drizzle/0006_*.sql` | 마이그레이션 (backfill 문장 손으로 삽입) |
| `apps/api/src/comments/comments.service.ts` | `CommentScope`, `scopeForTake/scopeForSession`, `list/create/update/remove` |
| `apps/api/src/comments/comments.controller.ts` | `takes/:id/comments`, `sessions/:id/comments`, `comments/:id` |
| `apps/api/src/comments/comments.module.ts` | `SessionsModule` import |
| `apps/api/src/sessions/session-mapper.ts` | `commentCount` 서브쿼리를 `session_id` 기준으로 |
| `apps/api/test/comments.e2e-spec.ts` | 수정·삭제·원본 코멘트 e2e |
| `packages/api-client/src/client.ts` | `comments` 인터페이스 |
| `packages/api-client/src/http/HttpApiClient.ts` (+`.spec.ts`) | target별 경로, PATCH/DELETE |
| `packages/api-client/src/mock/seed.ts`, `MockApiClient.ts` (+`.test.ts`) | 키 `take:`/`session:`, update/remove, 원본 시드 |
| `apps/mobile/src/ui/SheetRow.tsx` | `features/band/SheetRow.tsx`를 옮김 |
| `apps/mobile/src/features/takes/useComments.ts` | `CommentTarget` 받음 |
| `apps/mobile/src/features/takes/CommentThread.tsx` | `···` 링크, `· edited` |
| `apps/mobile/src/features/takes/CommentActionSheet.tsx` | 새 파일 — 인용문 + Edit/Delete 행 |
| `apps/mobile/src/features/takes/CommentInput.tsx` | `editing` 배너 |
| `apps/mobile/src/features/takes/TakePlayerScreen.tsx` | target 전환, 편집·삭제 상태, `ConfirmDialog` |
| `README.md`, `docs/backlog.md` | 문서 |

---

### Task 1: 공유 타입

**Files:**
- Modify: `packages/types/src/take.ts`

**Interfaces:**
- Produces: `TakeComment { sessionId: string; takeId: string | null; updatedAt: string | null; … }`, `CommentTarget`, `UpdateCommentInput` — 이후 모든 태스크가 쓴다.

- [ ] **Step 1: 타입을 바꾼다**

`packages/types/src/take.ts`의 `TakeComment` 이하를 다음으로 교체한다:

```ts
export interface TakeComment {
  id: string;
  sessionId: string;
  /** 원본 녹음 코멘트면 null (2026-09-09 스펙 결정 4) */
  takeId: string | null;
  authorId: string;
  authorName: string;
  /** 답글이면 부모(최상위 코멘트) id. 스레드는 1단계만 허용한다 */
  parentId: string | null;
  /** 답글은 부모의 시점을 물려받는다 */
  atSec: number;
  text: string;
  createdAt: string;
  /** 본문을 수정한 적 있으면 채워진다 → 클라이언트가 "edited"를 그린다 */
  updatedAt: string | null;
}

/** 코멘트가 붙는 대상 — take 또는 원본 녹음(세션) */
export type CommentTarget = { takeId: string } | { sessionId: string };

export interface CreateCommentInput {
  text: string;
  /** parentId가 없을 때 필수 */
  atSec?: number;
  /** 있으면 답글. atSec은 무시되고 부모의 시점을 쓴다 */
  parentId?: string;
}

export interface UpdateCommentInput {
  /** 본문만 고친다. 시점은 지우고 다시 남긴다 */
  text: string;
}
```

- [ ] **Step 2: 빌드해서 타입이 통과하는지 본다**

Run: `pnpm --filter @bandapp/types build`
Expected: 에러 없이 종료. (이 시점에 api·api-client는 아직 안 고쳐서 그쪽 빌드는 깨진다 — 정상.)

- [ ] **Step 3: 커밋**

```bash
git add packages/types/src/take.ts
git commit -m "feat(types): add sessionId, nullable takeId, updatedAt to TakeComment; CommentTarget, UpdateCommentInput

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: 스키마와 마이그레이션 0006

**Files:**
- Modify: `apps/api/src/db/schema.ts:172-189` (`comments` 테이블)
- Create: `apps/api/drizzle/0006_<generated>.sql` (+ `meta/0006_snapshot.json`, `meta/_journal.json`은 drizzle-kit이 만든다)

**Interfaces:**
- Produces: `comments.sessionId`(NOT NULL), `comments.takeId`(nullable), `comments.updatedAt`(nullable) 컬럼.

- [ ] **Step 1: 스키마를 바꾼다**

`apps/api/src/db/schema.ts`의 `comments` 정의를 다음으로 교체한다:

```ts
export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // 모든 코멘트가 세션에 속한다 — 원본 녹음 코멘트는 take_id가 NULL (2026-09-09 스펙 결정 4)
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    takeId: uuid("take_id").references(() => takes.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    // 답글이면 부모(최상위 코멘트). 스레드는 1단계만 허용한다 — 서비스에서 검증
    parentId: uuid("parent_id").references((): AnyPgColumn => comments.id, { onDelete: "cascade" }),
    atMs: integer("at_ms").notNull(),
    text: text("text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // 본문을 수정할 때만 채운다 → "edited" (2026-09-09 스펙 결정 2)
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => [index("comments_take_at_idx").on(t.takeId, t.atMs), index("comments_session_at_idx").on(t.sessionId, t.atMs)],
);
```

- [ ] **Step 2: 마이그레이션을 생성한다**

Run: `pnpm --filter @bandapp/api db:generate`
Expected: `apps/api/drizzle/0006_<이름>.sql`과 `meta/0006_snapshot.json`이 생기고 `_journal.json`에 idx 6이 붙는다. DB 연결은 필요 없다.

- [ ] **Step 3: 생성된 SQL을 backfill이 들어가게 손으로 고친다**

생성된 `0006_*.sql` 내용을 통째로 다음으로 바꾼다 (`ADD COLUMN "session_id" uuid NOT NULL`은 기존 행 때문에 실패한다):

```sql
ALTER TABLE "comments" ADD COLUMN "session_id" uuid;--> statement-breakpoint
-- 손으로 넣음: 기존 코멘트는 전부 take 코멘트 — take의 세션으로 채운다 (2026-09-09 스펙 결정 4)
UPDATE "comments" SET "session_id" = t."session_id" FROM "takes" t WHERE t."id" = "comments"."take_id";--> statement-breakpoint
ALTER TABLE "comments" ALTER COLUMN "session_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "comments" ALTER COLUMN "take_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_session_at_idx" ON "comments" USING btree ("session_id","at_ms");
```

생성된 파일의 FK 제약 이름이 위와 다르면 생성된 이름을 쓴다(스냅샷과 맞아야 한다).

- [ ] **Step 4: 실 DB에 적용해 본다**

Run: `docker compose up -d postgres` 후 `pnpm --filter @bandapp/api db:migrate`
Expected: 에러 없이 끝난다. 기존 로컬 코멘트가 있었다면 `session_id`가 채워진다.

- [ ] **Step 5: 기존 e2e가 아직 도는지 본다 (서비스는 insert에 sessionId를 안 넣으므로 comments e2e는 깨져야 정상)**

Run: `pnpm --filter @bandapp/api test:e2e -- test/db.e2e-spec.ts`
Expected: PASS.

- [ ] **Step 6: 커밋**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle
git commit -m "feat(api): comments.session_id, nullable take_id, updated_at (migration 0006)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: CommentsService — scope, 원본 코멘트, 수정·삭제 (e2e 먼저)

**Files:**
- Modify: `apps/api/src/comments/comments.service.ts`
- Modify: `apps/api/src/sessions/session-mapper.ts:57`
- Test: `apps/api/test/comments.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 1 타입, Task 2 컬럼. `TakesService.loadForMember(takeId, userId): Promise<TakeRow>`(`sessionId`, `startMs`, `endMs`), `SessionsService.loadForMember(id, userId): Promise<SessionRow>`(`durationMs: number | null`).
- Produces:
  ```ts
  interface CommentScope { sessionId: string; takeId: string | null; lengthMs: number | null }
  class CommentsService {
    scopeForTake(takeId, userId): Promise<CommentScope>
    scopeForSession(sessionId, userId): Promise<CommentScope>
    list(scope): Promise<TakeComment[]>
    create(scope, userId, input: CreateCommentInput): Promise<TakeComment>
    update(id, userId, input: UpdateCommentInput): Promise<TakeComment>
    remove(id, userId): Promise<void>
  }
  ```
  Task 4의 컨트롤러가 그대로 쓴다.

- [ ] **Step 1: 기존 e2e의 응답 shape 기대값을 새 필드로 바꾼다**

`apps/api/test/comments.e2e-spec.ts`의 첫 테스트("코멘트를 남기면 …")에서 `expect(later.body).toEqual({...})`를 다음으로 바꾼다:

```ts
    expect(later.body).toEqual({
      id: expect.any(String),
      sessionId,
      takeId,
      authorId: owner.userId,
      authorName: "Dongjin",
      parentId: null,
      atSec: 120.7,
      text: "Rushing here",
      createdAt: expect.any(String),
      updatedAt: null,
    });
```

- [ ] **Step 2: 새 e2e 테스트를 파일 끝(`describe` 닫기 전)에 추가한다**

```ts
  describe("수정·삭제", () => {
    async function memberOf(id: string, name: string) {
      const other = await createTestApp({ google: providerUser(id, name), storage: new FakeStorage() });
      const login = await loginAs(other);
      await other.close();
      await db.insert(bandMembers).values({ bandId, userId: login.userId, role: "member" });
      return login;
    }

    it("PATCH는 본문만 바꾸고 updatedAt을 채우며 목록에 반영된다", async () => {
      const c = await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ atSec: 10, text: "typo" }).expect(201);
      const res = await request(app.getHttpServer()).patch(`/comments/${c.body.id}`).set(auth(owner.accessToken)).send({ text: "  fixed  " }).expect(200);
      expect(res.body).toMatchObject({ id: c.body.id, text: "fixed", atSec: 10, updatedAt: expect.any(String) });
      const list = await request(app.getHttpServer()).get(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).expect(200);
      expect(list.body[0]).toMatchObject({ text: "fixed", updatedAt: res.body.updatedAt });
    });

    it.each([
      ["빈 텍스트", { text: "   " }],
      ["500자 초과", { text: "a".repeat(501) }],
      ["text 없음", {}],
    ])("PATCH 잘못된 입력은 400: %s", async (_label, body) => {
      const c = await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ atSec: 10, text: "x" }).expect(201);
      await request(app.getHttpServer()).patch(`/comments/${c.body.id}`).set(auth(owner.accessToken)).send(body).expect(400);
    });

    it("타인 코멘트는 수정·삭제 403, 비멤버는 403, 없는 id는 404", async () => {
      const minsoo = await memberOf("member-1", "Minsoo");
      const c = await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ atSec: 10, text: "mine" }).expect(201);
      await request(app.getHttpServer()).patch(`/comments/${c.body.id}`).set(auth(minsoo.accessToken)).send({ text: "hijack" }).expect(403);
      await request(app.getHttpServer()).delete(`/comments/${c.body.id}`).set(auth(minsoo.accessToken)).expect(403);
      const strangerApp = await createTestApp({ google: providerUser("stranger-1", "S"), storage: new FakeStorage() });
      const stranger = await loginAs(strangerApp);
      await strangerApp.close();
      await request(app.getHttpServer()).patch(`/comments/${c.body.id}`).set(auth(stranger.accessToken)).send({ text: "x" }).expect(403);
      await request(app.getHttpServer()).delete(`/comments/${c.body.id}`).set(auth(stranger.accessToken)).expect(403);
      await request(app.getHttpServer()).patch(`/comments/00000000-0000-0000-0000-000000000000`).set(auth(owner.accessToken)).send({ text: "x" }).expect(404);
      await request(app.getHttpServer()).delete(`/comments/00000000-0000-0000-0000-000000000000`).set(auth(owner.accessToken)).expect(404);
      await request(app.getHttpServer()).delete(`/comments/nope`).set(auth(owner.accessToken)).expect(400);
      // 아무것도 안 바뀌었다
      const list = await request(app.getHttpServer()).get(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0]).toMatchObject({ text: "mine", updatedAt: null });
    });

    it("부모를 지우면 답글도 사라지고 take·세션 commentCount가 준다", async () => {
      const minsoo = await memberOf("member-1", "Minsoo");
      const parent = await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ atSec: 10, text: "p" }).expect(201);
      await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(minsoo.accessToken)).send({ parentId: parent.body.id, text: "r" }).expect(201);
      await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ atSec: 20, text: "other" }).expect(201);
      await request(app.getHttpServer()).delete(`/comments/${parent.body.id}`).set(auth(owner.accessToken)).expect(204);
      const list = await request(app.getHttpServer()).get(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).expect(200);
      expect(list.body.map((c: { text: string }) => c.text)).toEqual(["other"]);
      const takesRes = await request(app.getHttpServer()).get(`/sessions/${sessionId}/takes`).set(auth(owner.accessToken)).expect(200);
      expect(takesRes.body[0].commentCount).toBe(1);
      const sessionRes = await request(app.getHttpServer()).get(`/sessions/${sessionId}`).set(auth(owner.accessToken)).expect(200);
      expect(sessionRes.body.commentCount).toBe(1);
    });

    it("답글은 작성자가 따로 지울 수 있고 부모는 남는다", async () => {
      const minsoo = await memberOf("member-1", "Minsoo");
      const parent = await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ atSec: 10, text: "p" }).expect(201);
      const reply = await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(minsoo.accessToken)).send({ parentId: parent.body.id, text: "r" }).expect(201);
      await request(app.getHttpServer()).delete(`/comments/${reply.body.id}`).set(auth(minsoo.accessToken)).expect(204);
      const list = await request(app.getHttpServer()).get(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).expect(200);
      expect(list.body.map((c: { text: string }) => c.text)).toEqual(["p"]);
    });
  });

  describe("원본 녹음 코멘트", () => {
    it("세션에 코멘트를 남기면 takeId가 null이고 take 목록에는 섞이지 않으며 세션 commentCount에 든다", async () => {
      const c = await request(app.getHttpServer()).post(`/sessions/${sessionId}/comments`).set(auth(owner.accessToken)).send({ atSec: 412.5, text: "Soundcheck ends here" }).expect(201);
      expect(c.body).toMatchObject({ sessionId, takeId: null, parentId: null, atSec: 412.5, text: "Soundcheck ends here", updatedAt: null });
      await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ atSec: 1, text: "on take" }).expect(201);
      const orig = await request(app.getHttpServer()).get(`/sessions/${sessionId}/comments`).set(auth(owner.accessToken)).expect(200);
      expect(orig.body.map((x: { text: string }) => x.text)).toEqual(["Soundcheck ends here"]);
      const takeList = await request(app.getHttpServer()).get(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).expect(200);
      expect(takeList.body.map((x: { text: string }) => x.text)).toEqual(["on take"]);
      const sessionRes = await request(app.getHttpServer()).get(`/sessions/${sessionId}`).set(auth(owner.accessToken)).expect(200);
      expect(sessionRes.body.commentCount).toBe(2);
      const takesRes = await request(app.getHttpServer()).get(`/sessions/${sessionId}/takes`).set(auth(owner.accessToken)).expect(200);
      expect(takesRes.body[0].commentCount).toBe(1);
    });

    it("원본 코멘트의 답글은 부모 시점을 물려받고, take 코멘트와 원본 코멘트는 서로 부모가 될 수 없다", async () => {
      const orig = await request(app.getHttpServer()).post(`/sessions/${sessionId}/comments`).set(auth(owner.accessToken)).send({ atSec: 100, text: "o" }).expect(201);
      const onTake = await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ atSec: 5, text: "t" }).expect(201);
      const reply = await request(app.getHttpServer()).post(`/sessions/${sessionId}/comments`).set(auth(owner.accessToken)).send({ parentId: orig.body.id, text: "r" }).expect(201);
      expect(reply.body).toMatchObject({ parentId: orig.body.id, atSec: 100, takeId: null });
      await request(app.getHttpServer()).post(`/sessions/${sessionId}/comments`).set(auth(owner.accessToken)).send({ parentId: onTake.body.id, text: "x" }).expect(400);
      await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ parentId: orig.body.id, text: "x" }).expect(400);
    });

    it("세션 길이를 넘는 시점은 400, 비멤버는 403, 없는 세션은 404", async () => {
      await request(app.getHttpServer()).post(`/sessions/${sessionId}/comments`).set(auth(owner.accessToken)).send({ atSec: 601, text: "x" }).expect(400);
      const strangerApp = await createTestApp({ google: providerUser("stranger-1", "S"), storage: new FakeStorage() });
      const stranger = await loginAs(strangerApp);
      await strangerApp.close();
      await request(app.getHttpServer()).get(`/sessions/${sessionId}/comments`).set(auth(stranger.accessToken)).expect(403);
      await request(app.getHttpServer()).get(`/sessions/00000000-0000-0000-0000-000000000000/comments`).set(auth(owner.accessToken)).expect(404);
    });

    it("원본 코멘트도 작성자가 수정·삭제할 수 있다", async () => {
      const c = await request(app.getHttpServer()).post(`/sessions/${sessionId}/comments`).set(auth(owner.accessToken)).send({ atSec: 1, text: "a" }).expect(201);
      await request(app.getHttpServer()).patch(`/comments/${c.body.id}`).set(auth(owner.accessToken)).send({ text: "b" }).expect(200);
      await request(app.getHttpServer()).delete(`/comments/${c.body.id}`).set(auth(owner.accessToken)).expect(204);
      const orig = await request(app.getHttpServer()).get(`/sessions/${sessionId}/comments`).set(auth(owner.accessToken)).expect(200);
      expect(orig.body).toEqual([]);
    });
  });
```

- [ ] **Step 3: 실패를 확인한다**

Run: `pnpm --filter @bandapp/api test:e2e -- test/comments.e2e-spec.ts`
Expected: 기존 테스트도 insert에 `session_id`가 없어 500으로 실패하고, 새 테스트는 404(라우트 없음)로 실패한다.

- [ ] **Step 4: 세션 commentCount 서브쿼리를 바꾼다**

`apps/api/src/sessions/session-mapper.ts`에서 `commentCount:` 줄과 그 위 주석 두 줄을 다음으로 바꾼다:

```ts
  // 상관 서브쿼리이므로 테이블명을 직접 명시해 모호성을 없앤다.
  // 답글은 세지 않는다 (스레드 스펙 결정 5). 원본 녹음 코멘트도 session_id로 함께 센다 (2026-09-09 스펙 결정 6).
  commentCount: sql<number>`(select count(*)::int from comments c where c.session_id = "sessions"."id" and c.parent_id is null)`,
```

- [ ] **Step 5: 서비스를 다시 쓴다**

`apps/api/src/comments/comments.service.ts` 전체를 다음으로 교체한다:

```ts
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { and, asc, eq, isNull, type SQL } from "drizzle-orm";
import type { CreateCommentInput, TakeComment, UpdateCommentInput } from "@bandapp/types";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { comments, users } from "../db/schema.js";
import { SessionsService } from "../sessions/sessions.service.js";
import { TakesService } from "../takes/takes.service.js";

/** 코멘트가 붙는 대상. take 코멘트와 원본 녹음(세션) 코멘트를 한 코드 경로로 다룬다 (2026-09-09 스펙 결정 4, 5) */
export interface CommentScope {
  sessionId: string;
  /** 원본 녹음이면 null */
  takeId: string | null;
  /** 시점 상한(ms). null이면 검사하지 않는다 — 가져오기 세션은 워커가 재기 전까지 길이를 모른다 */
  lengthMs: number | null;
}

const COMMENT_COLUMNS = {
  id: comments.id,
  sessionId: comments.sessionId,
  takeId: comments.takeId,
  authorId: comments.authorId,
  authorName: users.displayName,
  parentId: comments.parentId,
  atMs: comments.atMs,
  text: comments.text,
  createdAt: comments.createdAt,
  updatedAt: comments.updatedAt,
};

type CommentRow = {
  id: string;
  sessionId: string;
  takeId: string | null;
  authorId: string;
  authorName: string | null;
  parentId: string | null;
  atMs: number;
  text: string;
  createdAt: Date;
  updatedAt: Date | null;
};

function toComment(row: CommentRow): TakeComment {
  return {
    id: row.id,
    sessionId: row.sessionId,
    takeId: row.takeId,
    authorId: row.authorId,
    authorName: row.authorName ?? "탈퇴한 멤버",
    parentId: row.parentId,
    atSec: row.atMs / 1000,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

function normalizeText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 500) throw new BadRequestException("text must be 1-500 characters");
  return trimmed;
}

/** scope 안의 코멘트만 고르는 where — take 코멘트는 take_id로, 원본 코멘트는 session_id + take_id IS NULL로 */
function inScope(scope: CommentScope): SQL {
  return scope.takeId ? eq(comments.takeId, scope.takeId) : and(eq(comments.sessionId, scope.sessionId), isNull(comments.takeId))!;
}

export class CommentsService {
  constructor(
    private readonly db: Db,
    private readonly takes: TakesService,
    private readonly sessions: SessionsService,
  ) {}

  /** 없으면 404, 멤버가 아니면 403 (takes.loadForMember) */
  async scopeForTake(takeId: string, userId: string): Promise<CommentScope> {
    const take = await this.takes.loadForMember(takeId, userId);
    return { sessionId: take.sessionId, takeId, lengthMs: take.endMs - take.startMs };
  }

  /** 없으면 404, 멤버가 아니면 403 (sessions.loadForMember) */
  async scopeForSession(sessionId: string, userId: string): Promise<CommentScope> {
    const session = await this.sessions.loadForMember(sessionId, userId);
    return { sessionId, takeId: null, lengthMs: session.durationMs };
  }

  async list(scope: CommentScope): Promise<TakeComment[]> {
    const rows = await this.db
      .select(COMMENT_COLUMNS)
      .from(comments)
      .innerJoin(users, eq(users.id, comments.authorId))
      .where(inScope(scope))
      .orderBy(asc(comments.atMs), asc(comments.createdAt));
    return rows.map(toComment);
  }

  async create(scope: CommentScope, userId: string, input: CreateCommentInput): Promise<TakeComment> {
    const text = normalizeText(input.text);
    const parentId = input.parentId ?? null;
    let atMs: number;
    if (parentId) {
      // 스레드는 1단계 — 부모는 같은 대상의 최상위 코멘트여야 한다 (스레드 스펙 결정 1, 3; 2026-09-09 스펙 결정 5)
      const [parent] = await this.db
        .select({ atMs: comments.atMs, parentId: comments.parentId })
        .from(comments)
        .where(and(eq(comments.id, parentId), inScope(scope)));
      if (!parent || parent.parentId !== null) throw new BadRequestException("parentId must be a top-level comment on this target");
      atMs = parent.atMs;
    } else {
      if (input.atSec === undefined) throw new BadRequestException("atSec is required");
      atMs = Math.round(input.atSec * 1000);
      if (scope.lengthMs !== null && atMs > scope.lengthMs) throw new BadRequestException("atSec is beyond the recording length");
    }
    const [inserted] = await this.db
      .insert(comments)
      .values({ sessionId: scope.sessionId, takeId: scope.takeId, authorId: userId, parentId, atMs, text })
      .returning({ id: comments.id });
    if (!inserted) throw new Error("failed to insert comment");
    return this.getOne(inserted.id);
  }

  async update(id: string, userId: string, input: UpdateCommentInput): Promise<TakeComment> {
    const text = normalizeText(input.text);
    await this.loadOwn(id, userId);
    await this.db.update(comments).set({ text, updatedAt: new Date() }).where(eq(comments.id, id));
    return this.getOne(id);
  }

  /** 답글은 parent_id의 ON DELETE CASCADE로 함께 지워진다 (2026-09-09 스펙 결정 3) */
  async remove(id: string, userId: string): Promise<void> {
    await this.loadOwn(id, userId);
    await this.db.delete(comments).where(eq(comments.id, id));
  }

  /** 없으면 404 → 비멤버 403 → 작성자 아님 403 (2026-09-09 스펙 결정 7) */
  private async loadOwn(id: string, userId: string): Promise<void> {
    const [row] = await this.db.select({ sessionId: comments.sessionId, authorId: comments.authorId }).from(comments).where(eq(comments.id, id));
    if (!row) throw new NotFoundException("코멘트를 찾을 수 없어요.");
    await this.sessions.loadForMember(row.sessionId, userId);
    if (row.authorId !== userId) throw new ForbiddenException("내 코멘트만 고치거나 지울 수 있어요.");
  }

  private async getOne(id: string): Promise<TakeComment> {
    const [row] = await this.db.select(COMMENT_COLUMNS).from(comments).innerJoin(users, eq(users.id, comments.authorId)).where(eq(comments.id, id));
    if (!row) throw new Error("comment vanished");
    return toComment(row);
  }
}

export const commentsServiceProvider: Provider = {
  provide: CommentsService,
  useFactory: (db: Db, takes: TakesService, sessions: SessionsService) => new CommentsService(db, takes, sessions),
  inject: [DB, TakesService, SessionsService],
};
```

- [ ] **Step 6: 모듈이 SessionsService를 주입할 수 있게 한다**

`apps/api/src/comments/comments.module.ts`를 다음으로 교체한다:

```ts
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { DbModule } from "../db/db.module.js";
import { SessionsModule } from "../sessions/sessions.module.js";
import { TakesModule } from "../takes/takes.module.js";
import { CommentsController } from "./comments.controller.js";
import { commentsServiceProvider } from "./comments.service.js";

@Module({
  imports: [DbModule, AuthModule, TakesModule, SessionsModule],
  controllers: [CommentsController],
  providers: [commentsServiceProvider],
})
export class CommentsModule {}
```

- [ ] **Step 7: 컨트롤러를 임시로 새 서비스 시그니처에 맞춘다 (라우트 추가는 Task 4)**

`apps/api/src/comments/comments.controller.ts`의 두 핸들러 본문을 바꾼다:

```ts
  @Get(":id/comments")
  async list(@CurrentUserId() userId: string, @Param("id") id: string): Promise<TakeComment[]> {
    requireUuidParam(id, "id");
    return this.comments.list(await this.comments.scopeForTake(id, userId));
  }

  @Post(":id/comments")
  async create(@CurrentUserId() userId: string, @Param("id") id: string, @Body() body: unknown): Promise<TakeComment> {
    requireUuidParam(id, "id");
    const scope = await this.comments.scopeForTake(id, userId);
    const text = requireString(body, "text");
    const parentId = optionalUuid(body, "parentId");
    // 답글은 부모의 시점을 물려받으므로 atSec을 받지 않는다 (스펙 결정 2)
    if (parentId) return this.comments.create(scope, userId, { parentId, text });
    return this.comments.create(scope, userId, { atSec: requireNumber(body, "atSec", { min: 0 }), text });
  }
```

- [ ] **Step 8: 기존 테스트가 다시 통과하는지 본다**

Run: `pnpm --filter @bandapp/api build && pnpm --filter @bandapp/api test:e2e -- test/comments.e2e-spec.ts`
Expected: 기존 6개 테스트 PASS. 새 `수정·삭제`·`원본 녹음 코멘트` 테스트는 404로 FAIL (라우트가 아직 없다). `sessions.e2e-spec.ts`·`takes.e2e-spec.ts`도 돌려 PASS를 확인한다: `pnpm --filter @bandapp/api test:e2e -- test/sessions.e2e-spec.ts test/takes.e2e-spec.ts`.

- [ ] **Step 9: 커밋**

```bash
git add apps/api/src/comments apps/api/src/sessions/session-mapper.ts apps/api/test/comments.e2e-spec.ts
git commit -m "feat(api): comment scope for take/original, update/remove in service; session commentCount by session_id

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: 컨트롤러 라우트

**Files:**
- Modify: `apps/api/src/comments/comments.controller.ts`
- Test: `apps/api/test/comments.e2e-spec.ts` (Task 3에서 추가한 테스트)

**Interfaces:**
- Consumes: Task 3의 `CommentsService`.
- Produces: `GET/POST /takes/:id/comments`, `GET/POST /sessions/:id/comments`, `PATCH /comments/:id`, `DELETE /comments/:id`(204).

- [ ] **Step 1: 컨트롤러 전체를 교체한다**

```ts
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from "@nestjs/common";
import type { CreateCommentInput, TakeComment } from "@bandapp/types";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUserId } from "../auth/current-user-id.decorator.js";
import { optionalUuid, requireNumber, requireString, requireUuidParam } from "../common/validation.js";
import { CommentsService } from "./comments.service.js";

/** 답글은 부모의 시점을 물려받으므로 atSec을 받지 않는다 (스레드 스펙 결정 2) */
function parseCreate(body: unknown): CreateCommentInput {
  const text = requireString(body, "text");
  const parentId = optionalUuid(body, "parentId");
  if (parentId) return { parentId, text };
  return { atSec: requireNumber(body, "atSec", { min: 0 }), text };
}

@Controller()
@UseGuards(AuthGuard)
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get("takes/:id/comments")
  async listForTake(@CurrentUserId() userId: string, @Param("id") id: string): Promise<TakeComment[]> {
    requireUuidParam(id, "id");
    return this.comments.list(await this.comments.scopeForTake(id, userId));
  }

  @Post("takes/:id/comments")
  async createForTake(@CurrentUserId() userId: string, @Param("id") id: string, @Body() body: unknown): Promise<TakeComment> {
    requireUuidParam(id, "id");
    const scope = await this.comments.scopeForTake(id, userId);
    return this.comments.create(scope, userId, parseCreate(body));
  }

  /** 원본 녹음 코멘트 (2026-09-09 스펙) */
  @Get("sessions/:id/comments")
  async listForSession(@CurrentUserId() userId: string, @Param("id") id: string): Promise<TakeComment[]> {
    requireUuidParam(id, "id");
    return this.comments.list(await this.comments.scopeForSession(id, userId));
  }

  @Post("sessions/:id/comments")
  async createForSession(@CurrentUserId() userId: string, @Param("id") id: string, @Body() body: unknown): Promise<TakeComment> {
    requireUuidParam(id, "id");
    const scope = await this.comments.scopeForSession(id, userId);
    return this.comments.create(scope, userId, parseCreate(body));
  }

  @Patch("comments/:id")
  update(@CurrentUserId() userId: string, @Param("id") id: string, @Body() body: unknown): Promise<TakeComment> {
    requireUuidParam(id, "id");
    return this.comments.update(id, userId, { text: requireString(body, "text") });
  }

  @Delete("comments/:id")
  @HttpCode(204)
  async remove(@CurrentUserId() userId: string, @Param("id") id: string): Promise<void> {
    requireUuidParam(id, "id");
    await this.comments.remove(id, userId);
  }
}
```

- [ ] **Step 2: 전체 e2e와 lint를 돌린다**

Run: `pnpm --filter @bandapp/api build && pnpm --filter @bandapp/api lint && pnpm --filter @bandapp/api test`
Expected: 단위·e2e 모두 PASS. `comments.e2e-spec.ts`의 새 테스트 9개 포함.

- [ ] **Step 3: 커밋**

```bash
git add apps/api/src/comments/comments.controller.ts
git commit -m "feat(api): session comments and PATCH/DELETE /comments/:id

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: api-client 계약과 HTTP 구현

**Files:**
- Modify: `packages/api-client/src/client.ts:102-105`
- Modify: `packages/api-client/src/http/HttpApiClient.ts:272-279`
- Test: `packages/api-client/src/http/HttpApiClient.spec.ts:211-225`

**Interfaces:**
- Consumes: Task 1의 `CommentTarget`, `UpdateCommentInput`.
- Produces:
  ```ts
  comments: {
    list(target: CommentTarget): Promise<TakeComment[]>;
    create(target: CommentTarget, input: CreateCommentInput): Promise<TakeComment>;
    update(id: string, input: UpdateCommentInput): Promise<TakeComment>;
    remove(id: string): Promise<void>;
  }
  ```
  Task 6(Mock)·Task 8(모바일)이 쓴다. (`delete`는 예약어 느낌이라 `remove`.)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`HttpApiClient.spec.ts`의 기존 두 comments 테스트(`comments.create는 takes 경로로 POST한다`, `답글은 parentId만 싣고 …`)를 다음 다섯으로 교체한다:

```ts
  it("comments.list/create는 target에 따라 takes 또는 sessions 경로를 쓴다", async () => {
    const tokens = memoryTokens({ accessToken: "a1" });
    const fetchFn = vi.fn(async () => json(200, []));
    const client = new HttpApiClient({ baseUrl: "https://api.test", tokens, fetchFn });
    await client.comments.list({ takeId: "t1" });
    expect(fetchFn).toHaveBeenLastCalledWith("https://api.test/takes/t1/comments", expect.objectContaining({ method: "GET" }));
    await client.comments.list({ sessionId: "s1" });
    expect(fetchFn).toHaveBeenLastCalledWith("https://api.test/sessions/s1/comments", expect.objectContaining({ method: "GET" }));
  });

  it("comments.create는 takes 경로로 POST한다", async () => {
    const tokens = memoryTokens({ accessToken: "a1" });
    const fetchFn = vi.fn(async () => json(201, { id: "c1" }));
    const client = new HttpApiClient({ baseUrl: "https://api.test", tokens, fetchFn });
    await client.comments.create({ takeId: "t1" }, { atSec: 3, text: "x" });
    expect(fetchFn).toHaveBeenCalledWith("https://api.test/takes/t1/comments", expect.objectContaining({ method: "POST", body: JSON.stringify({ atSec: 3, text: "x" }) }));
  });

  it("원본 녹음 코멘트는 sessions 경로로 POST하고, 답글은 parentId만 싣는다", async () => {
    const tokens = memoryTokens({ accessToken: "a1" });
    const fetchFn = vi.fn(async () => json(201, { id: "c2" }));
    const client = new HttpApiClient({ baseUrl: "https://api.test", tokens, fetchFn });
    await client.comments.create({ sessionId: "s1" }, { parentId: "c1", text: "y" });
    expect(fetchFn).toHaveBeenCalledWith("https://api.test/sessions/s1/comments", expect.objectContaining({ method: "POST", body: JSON.stringify({ parentId: "c1", text: "y" }) }));
  });

  it("comments.update는 PATCH /comments/:id 후 구독자에게 알린다", async () => {
    const tokens = memoryTokens({ accessToken: "a1" });
    const fetchFn = vi.fn(async () => json(200, { id: "c1", text: "fixed" }));
    const client = new HttpApiClient({ baseUrl: "https://api.test", tokens, fetchFn });
    const listener = vi.fn();
    client.subscribe(listener);
    const res = await client.comments.update("c1", { text: "fixed" });
    expect(res).toMatchObject({ text: "fixed" });
    expect(fetchFn).toHaveBeenCalledWith("https://api.test/comments/c1", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ text: "fixed" }) }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("comments.remove는 DELETE /comments/:id (204) 후 구독자에게 알린다", async () => {
    const tokens = memoryTokens({ accessToken: "a1" });
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));
    const client = new HttpApiClient({ baseUrl: "https://api.test", tokens, fetchFn });
    const listener = vi.fn();
    client.subscribe(listener);
    await expect(client.comments.remove("c1")).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledWith("https://api.test/comments/c1", expect.objectContaining({ method: "DELETE" }));
    expect(listener).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter @bandapp/api-client exec vitest run src/http`
Expected: 타입 에러 또는 5개 FAIL.

- [ ] **Step 3: 인터페이스를 바꾼다**

`packages/api-client/src/client.ts`:
- 상단 `import type { … } from "@bandapp/types"`에 `CommentTarget`, `UpdateCommentInput`을 더한다.
- `export type { CreateCommentInput, CreateSessionInput } from "@bandapp/types";`를 `export type { CommentTarget, CreateCommentInput, CreateSessionInput, UpdateCommentInput } from "@bandapp/types";`로.
- `comments:` 블록을 다음으로 교체:

```ts
  comments: {
    /** target이 { takeId }면 take 코멘트, { sessionId }면 원본 녹음 코멘트 */
    list(target: CommentTarget): Promise<TakeComment[]>;
    create(target: CommentTarget, input: CreateCommentInput): Promise<TakeComment>;
    /** 작성자만. 본문만 바꾸고 updatedAt이 채워진다 */
    update(id: string, input: UpdateCommentInput): Promise<TakeComment>;
    /** 작성자만. 최상위 코멘트를 지우면 답글도 함께 사라진다 */
    remove(id: string): Promise<void>;
  };
```

- [ ] **Step 4: HTTP 구현을 바꾼다**

`HttpApiClient.ts`의 `import type { … } from "@bandapp/types"`에 `CommentTarget`, `UpdateCommentInput`을 더하고 `comments =` 블록을 교체:

```ts
  comments = {
    list: (target: CommentTarget): Promise<TakeComment[]> => this.request<TakeComment[]>("GET", commentsPath(target)),
    create: async (target: CommentTarget, input: CreateCommentInput): Promise<TakeComment> => {
      const comment = await this.request<TakeComment>("POST", commentsPath(target), input);
      this.emit();
      return comment;
    },
    update: async (id: string, input: UpdateCommentInput): Promise<TakeComment> => {
      const comment = await this.request<TakeComment>("PATCH", `/comments/${id}`, input);
      this.emit();
      return comment;
    },
    remove: async (id: string): Promise<void> => {
      await this.request<void>("DELETE", `/comments/${id}`);
      this.emit();
    },
  };
```

그리고 클래스 바깥(파일 상단 import 아래)에 헬퍼를 둔다:

```ts
/** take 코멘트와 원본 녹음(세션) 코멘트는 경로만 다르다 (2026-09-09 스펙 결정 8) */
function commentsPath(target: CommentTarget): string {
  return "takeId" in target ? `/takes/${target.takeId}/comments` : `/sessions/${target.sessionId}/comments`;
}
```

- [ ] **Step 5: 통과를 확인한다**

Run: `pnpm --filter @bandapp/api-client exec vitest run src/http`
Expected: PASS. (Mock은 Task 6에서 고치므로 `pnpm --filter @bandapp/api-client build`는 아직 깨진다.)

- [ ] **Step 6: 커밋**

```bash
git add packages/api-client/src/client.ts packages/api-client/src/http
git commit -m "feat(api-client): comment target, update and remove

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Mock — 키 재구성, 원본 시드, update/remove

**Files:**
- Modify: `packages/api-client/src/mock/seed.ts`
- Modify: `packages/api-client/src/mock/MockApiClient.ts:285-325`
- Test: `packages/api-client/src/mock/MockApiClient.test.ts`

**Interfaces:**
- Consumes: Task 5 인터페이스.
- Produces: `MockState.comments`의 키가 `take:<takeId>` / `session:<sessionId>`. `commentKey(target)` export (seed.ts). 시드: `session:s1`에 원본 코멘트 2개(Dongjin 412s, Suhyun 3125s), `take:s1-t0`의 Dongjin 158s 코멘트는 `updatedAt` 있음.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`MockApiClient.test.ts`에서 `api.comments.list("s1-t0")` 같은 문자열 인자를 모두 `{ takeId: "…" }`로 바꾼다(`list`·`create` 호출 전부 — `"s1-t0"`, `"s1-t1"`, `"s1-t2"`). 그리고 파일 끝(`describe` 닫기 전)에 추가:

```ts
  it("comments.list({ sessionId }) returns seeded original-recording comments, and one seeded comment is edited", async () => {
    const api = new MockApiClient();
    const orig = await api.comments.list({ sessionId: "s1" });
    expect(orig.map((c) => [c.takeId, c.sessionId, c.parentId])).toEqual([
      [null, "s1", null],
      [null, "s1", null],
    ]);
    expect(orig[0]!.atSec).toBeLessThan(orig[1]!.atSec);
    const take = await api.comments.list({ takeId: "s1-t0" });
    expect(take.filter((c) => c.updatedAt !== null)).toHaveLength(1);
    expect(take.every((c) => c.takeId === "s1-t0" && c.sessionId === "s1")).toBe(true);
  });

  it("session commentCount includes original-recording comments", async () => {
    const api = new MockApiClient();
    const sessions = await api.sessions.list(BAND);
    const s1 = sessions.find((s) => s.id === "s1")!;
    const takes = await api.takes.list("s1");
    const fromTakes = takes.reduce((a, t) => a + t.commentCount, 0);
    expect(s1.commentCount).toBe(fromTakes + 2);
  });

  it("comments.create on a session attaches an original comment and bumps only the session count", async () => {
    const api = new MockApiClient();
    const before = (await api.sessions.get("s1")).commentCount;
    const c = await api.comments.create({ sessionId: "s1" }, { atSec: 30, text: "orig" });
    expect(c).toMatchObject({ takeId: null, sessionId: "s1", parentId: null, atSec: 30, updatedAt: null });
    expect((await api.sessions.get("s1")).commentCount).toBe(before + 1);
    const takes = await api.takes.list("s1");
    expect(takes[0]!.commentCount).toBe(5);
  });

  it("comments.update changes text only, stamps updatedAt, notifies, and rejects others' comments", async () => {
    const api = new MockApiClient();
    const listener = vi.fn();
    api.subscribe(listener);
    const mine = await api.comments.create({ takeId: "s1-t2" }, { atSec: 42, text: "typo" });
    const updated = await api.comments.update(mine.id, { text: "fixed" });
    expect(updated).toMatchObject({ id: mine.id, text: "fixed", atSec: 42, updatedAt: expect.any(String) });
    expect(listener).toHaveBeenCalledTimes(2);
    const [theirs] = await api.comments.list({ takeId: "s1-t0" });
    await expect(api.comments.update(theirs!.id, { text: "hijack" })).rejects.toThrow();
    await expect(api.comments.update("nope", { text: "x" })).rejects.toThrow();
  });

  it("comments.remove deletes the comment and its replies and decrements counts", async () => {
    const api = new MockApiClient();
    const parent = await api.comments.create({ takeId: "s1-t2" }, { atSec: 10, text: "p" });
    await api.comments.create({ takeId: "s1-t2" }, { parentId: parent.id, text: "r" });
    const takeBefore = (await api.takes.list("s1"))[2]!.commentCount;
    const sessionBefore = (await api.sessions.get("s1")).commentCount;
    await api.comments.remove(parent.id);
    expect(await api.comments.list({ takeId: "s1-t2" })).toEqual([]);
    expect((await api.takes.list("s1"))[2]!.commentCount).toBe(takeBefore - 1);
    expect((await api.sessions.get("s1")).commentCount).toBe(sessionBefore - 1);
  });

  it("comments.remove on a reply leaves the parent and counts alone", async () => {
    const api = new MockApiClient();
    const parent = await api.comments.create({ takeId: "s1-t2" }, { atSec: 10, text: "p" });
    const reply = await api.comments.create({ takeId: "s1-t2" }, { parentId: parent.id, text: "r" });
    const takeBefore = (await api.takes.list("s1"))[2]!.commentCount;
    await api.comments.remove(reply.id);
    expect((await api.comments.list({ takeId: "s1-t2" })).map((c) => c.id)).toEqual([parent.id]);
    expect((await api.takes.list("s1"))[2]!.commentCount).toBe(takeBefore);
  });
```

파일 상단 import에 `vi`를 더한다: `import { describe, expect, it, vi } from "vitest";`

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter @bandapp/api-client exec vitest run src/mock`
Expected: 타입 에러/FAIL.

- [ ] **Step 3: 시드를 고친다**

`seed.ts`:

(a) 상단 import를 `import type { Band, BandMember, CommentTarget, Session, Take, TakeComment } from "@bandapp/types";`로.

(b) `MockState.comments` 주석을 바꾸고 헬퍼를 export:

```ts
  comments: Record<string, TakeComment[]>; // commentKey(target) -> comments
```

`generateTakes` 위에:

```ts
/** state.comments의 키 — take 코멘트와 원본 녹음 코멘트를 한 맵에 둔다 */
export function commentKey(target: CommentTarget): string {
  return "takeId" in target ? `take:${target.takeId}` : `session:${target.sessionId}`;
}

/** 시드 take id는 `${sessionId}-t${index}` — 세션 id를 되돌린다 */
function sessionOfTake(takeId: string): string {
  return takeId.slice(0, takeId.lastIndexOf("-t"));
}
```

(c) `SeedComment`에 `edited?: boolean`을 더한다:

```ts
interface SeedComment {
  who: string;
  t: number;
  text: string;
  replies?: SeedReply[];
  /** 본문을 고친 적 있는 것으로 시드 — "edited" 표기를 웹 프리뷰에서 본다 */
  edited?: boolean;
}
```

(d) `SEED_COMMENTS`의 키를 `commentKey` 형식으로 바꾸고 원본 코멘트를 더한다. `"s1-t0"` → `"take:s1-t0"`, `"s1-t1"` → `"take:s1-t1"`, `"s1-t3"` → `"take:s1-t3"`, `"s1-t5"` → `"take:s1-t5"`, `"s2-t1"` → `"take:s2-t1"`, `"s2-t4"` → `"take:s2-t4"`. `take:s1-t0`의 `{ who: "Dongjin", t: 158, text: "Second chorus vocals sitting better here" }`에 `edited: true`를 더한다. 맵 끝에 추가:

```ts
  // 원본 녹음 코멘트 — take 밖 구간에 남긴다 (2026-09-09 스펙)
  "session:s1": [
    { who: "Dongjin", t: 412, text: "Soundcheck ends here — takes start after this" },
    { who: "Suhyun", t: 3125, text: "Break chatter, skip this bit" },
  ],
```

(e) `createSeedState`의 코멘트 루프를 다음으로 교체:

```ts
  const comments: MockState["comments"] = {};
  let cid = 0;
  // 답글은 부모 뒤에 1분 간격으로 쓴 것으로 둔다 — createdAt 순 정렬이 시드 순서를 유지하게
  const base = new Date("2026-08-27T19:03:00").getTime();
  for (const [key, rows] of Object.entries(SEED_COMMENTS)) {
    const [kind, id] = key.split(":") as ["take" | "session", string];
    const takeId = kind === "take" ? id : null;
    const sessionId = kind === "take" ? sessionOfTake(id) : id;
    const list: TakeComment[] = [];
    for (const r of rows) {
      const parentId = `c${cid++}`;
      list.push({
        id: parentId,
        sessionId,
        takeId,
        authorId: AUTHOR_IDS[r.who] ?? "m2",
        authorName: r.who,
        parentId: null,
        atSec: r.t,
        text: r.text,
        createdAt: new Date(base).toISOString(),
        updatedAt: r.edited ? new Date(base + 5 * 60_000).toISOString() : null,
      });
      (r.replies ?? []).forEach((rep, i) => {
        list.push({
          id: `c${cid++}`,
          sessionId,
          takeId,
          authorId: AUTHOR_IDS[rep.who] ?? "m2",
          authorName: rep.who,
          parentId,
          atSec: r.t,
          text: rep.text,
          createdAt: new Date(base + (i + 1) * 60_000).toISOString(),
          updatedAt: null,
        });
      });
    }
    comments[key] = list;
  }
  // commentCount 반영 — 답글은 세지 않는다. 세션은 take 코멘트 + 원본 코멘트 (2026-09-09 스펙 결정 6)
  const topLevel = (key: string) => (comments[key] ?? []).filter((c) => c.parentId === null).length;
  for (const list of Object.values(takes)) {
    for (const t of list) t.commentCount = topLevel(commentKey({ takeId: t.id }));
  }
  for (const s of sessions) {
    s.commentCount = (takes[s.id] ?? []).reduce((a, t) => a + t.commentCount, 0) + topLevel(commentKey({ sessionId: s.id }));
  }
```

- [ ] **Step 4: MockApiClient를 고친다**

(a) import: `@bandapp/types`에서 `CommentTarget`, `UpdateCommentInput`을 더하고, `./seed`에서 `commentKey`를 더한다: `import { commentKey, createSeedState, generateTakes, type MockState } from "./seed";`

(b) `comments =` 블록을 교체:

```ts
  comments = {
    list: async (target: CommentTarget): Promise<TakeComment[]> =>
      (this.state.comments[commentKey(target)] ?? []).slice().sort((a, b) => a.atSec - b.atSec),
    create: async (target: CommentTarget, input: CreateCommentInput): Promise<TakeComment> => {
      const key = commentKey(target);
      const list = (this.state.comments[key] ??= []);
      const takeId = "takeId" in target ? target.takeId : null;
      const take = takeId ? this.findTake(takeId) : undefined;
      if (takeId && !take) throw new ApiError(404, "Take를 찾을 수 없어요.");
      const sessionId = take ? take.sessionId : (target as { sessionId: string }).sessionId;
      let atSec: number;
      if (input.parentId) {
        // 스레드는 1단계 — 부모는 같은 대상의 최상위 코멘트여야 한다
        const parent = list.find((c) => c.id === input.parentId);
        if (!parent || parent.parentId !== null) throw new ApiError(400, "parentId must be a top-level comment on this target");
        atSec = parent.atSec;
      } else {
        if (input.atSec === undefined) throw new ApiError(400, "atSec is required");
        atSec = Math.floor(input.atSec);
      }
      const c: TakeComment = {
        id: `u${this.nextId++}`,
        sessionId,
        takeId,
        authorId: MOCK_USER.id,
        authorName: "You",
        parentId: input.parentId ?? null,
        atSec,
        text: input.text,
        createdAt: new Date().toISOString(),
        updatedAt: null,
      };
      list.push(c);
      // 답글은 commentCount에 세지 않는다
      if (!input.parentId) this.bumpCounts(take, sessionId, +1);
      this.emit();
      return { ...c };
    },
    update: async (id: string, input: UpdateCommentInput): Promise<TakeComment> => {
      const { comment } = this.findOwnComment(id);
      comment.text = input.text;
      comment.updatedAt = new Date().toISOString();
      this.emit();
      return { ...comment };
    },
    remove: async (id: string): Promise<void> => {
      const { key, comment } = this.findOwnComment(id);
      const list = this.state.comments[key] ?? [];
      // 최상위를 지우면 답글도 함께 (서버의 ON DELETE CASCADE와 같게)
      this.state.comments[key] = list.filter((c) => c.id !== id && c.parentId !== id);
      if (comment.parentId === null) this.bumpCounts(comment.takeId ? this.findTake(comment.takeId) : undefined, comment.sessionId, -1);
      this.emit();
    },
  };

  private findTake(takeId: string): Take | undefined {
    for (const takes of Object.values(this.state.takes)) {
      const take = takes.find((t) => t.id === takeId);
      if (take) return take;
    }
    return undefined;
  }

  /** 없으면 404, 내 것이 아니면 403 — 서버와 같은 순서 */
  private findOwnComment(id: string): { key: string; comment: TakeComment } {
    for (const [key, list] of Object.entries(this.state.comments)) {
      const comment = list.find((c) => c.id === id);
      if (comment) {
        if (comment.authorId !== MOCK_USER.id) throw new ApiError(403, "내 코멘트만 고치거나 지울 수 있어요.");
        return { key, comment };
      }
    }
    throw new ApiError(404, "코멘트를 찾을 수 없어요.");
  }

  private bumpCounts(take: Take | undefined, sessionId: string, delta: number): void {
    if (take) take.commentCount += delta;
    const s = this.state.sessions.find((x) => x.id === sessionId);
    if (s) s.commentCount += delta;
  }
```

`ApiError` 생성자 시그니처는 `new ApiError(status, message, code?)`이다(`../errors`).

- [ ] **Step 5: 통과를 확인하고 빌드한다**

Run: `pnpm --filter @bandapp/api-client test && pnpm --filter @bandapp/api-client build`
Expected: 전부 PASS, 빌드 성공.

- [ ] **Step 6: 커밋**

```bash
git add packages/api-client/src/mock
git commit -m "feat(api-client): mock comment update/remove, original-recording seed, keyed comment store

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `SheetRow`를 공용 UI로 옮긴다

**Files:**
- Create: `apps/mobile/src/ui/SheetRow.tsx` (내용은 `features/band/SheetRow.tsx` 그대로, import 경로만)
- Delete: `apps/mobile/src/features/band/SheetRow.tsx`
- Modify: `apps/mobile/src/ui/index.ts`, `apps/mobile/src/features/band/MemberSheet.tsx:5`, `PartSheet.tsx:6-8`, `SelfMemberSheet.tsx:3-7`

**Interfaces:**
- Produces: `import { SheetRow } from "@/ui"` — `SheetRow({ title, subtitle?, trailing?, danger?, onPress })`. Task 8의 `CommentActionSheet`가 쓴다.

- [ ] **Step 1: 파일을 옮긴다**

`apps/mobile/src/ui/SheetRow.tsx`를 만든다:

```tsx
import type { ReactNode } from "react";
import { View } from "react-native";
import { radius, useTheme } from "@/theme";
import { AppText } from "./AppText";
import { PressableOpacity } from "./PressableOpacity";

/** 디자인의 시트 행: 좌측 제목(+부제), 우측 값. danger는 빨간 제목. */
export function SheetRow({
  title,
  subtitle,
  trailing,
  danger = false,
  onPress,
}: {
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
  danger?: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <PressableOpacity
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingVertical: 14,
        paddingHorizontal: 12,
        borderRadius: radius.row,
      }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <AppText style={{ fontSize: 15, color: danger ? colors.danger : colors.text }}>{title}</AppText>
        {subtitle ? <AppText variant="caption">{subtitle}</AppText> : null}
      </View>
      {trailing ?? null}
    </PressableOpacity>
  );
}
```

`apps/mobile/src/ui/index.ts`의 `export * from "./SheetActionRow";` 다음 줄에 `export * from "./SheetRow";`를 더한다. `apps/mobile/src/features/band/SheetRow.tsx`를 지운다.

- [ ] **Step 2: band의 import를 고친다**

- `MemberSheet.tsx`: `import { SheetRow } from "./SheetRow";` → `import { SheetRow } from "@/ui";`
- `PartSheet.tsx`: `import { AppText, PressableOpacity } from "@/ui";` → `import { AppText, PressableOpacity, SheetRow } from "@/ui";`, `import { SheetRow } from "./SheetRow";` 줄 삭제.
- `SelfMemberSheet.tsx`: `import { AppText } from "@/ui";` → `import { AppText, SheetRow } from "@/ui";`, `import { SheetRow } from "./SheetRow";` 줄 삭제.

- [ ] **Step 3: 타입체크**

Run: `pnpm --filter mobile typecheck`
Expected: `SheetRow` 관련 에러 없음. (`comments.list(string)` 호출 때문에 `useComments.ts`·`TakePlayerScreen.tsx`에 에러가 남는 건 Task 8에서 푼다.)

- [ ] **Step 4: 커밋**

```bash
git add apps/mobile/src/ui apps/mobile/src/features/band
git commit -m "refactor(mobile): move SheetRow to shared ui

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: 모바일 — target 전환, `···` 시트, 편집, 삭제 확인, edited

**Files:**
- Modify: `apps/mobile/src/features/takes/useComments.ts`
- Modify: `apps/mobile/src/features/takes/CommentThread.tsx`
- Create: `apps/mobile/src/features/takes/CommentActionSheet.tsx`
- Modify: `apps/mobile/src/features/takes/CommentInput.tsx`
- Modify: `apps/mobile/src/features/takes/TakePlayerScreen.tsx`

**Interfaces:**
- Consumes: Task 5·6의 `api.comments.{list,create,update,remove}`, Task 7의 `SheetRow`, 기존 `BottomSheet`, `ConfirmDialog({ visible, title, body, primary: { label, onPress, danger? }, cancelLabel, onCancel, busy? })`, `useAuth().state`(`status === "authenticated"`면 `user.id`), `useToast().show(text)`.
- Produces: 화면 동작. 테스트는 없다(스펙 테스트 절 — 상태 전환이 순수 함수로 뺄 만큼 크지 않다). 검증은 Step 7의 웹 프리뷰.

- [ ] **Step 1: `useComments`가 target을 받게 한다**

```ts
import type { CommentTarget } from "@bandapp/types";
import { useApiData } from "@/api";

export function useComments(target: CommentTarget | undefined) {
  // 객체 identity 대신 id로 의존성을 잡아 렌더마다 다시 불러오지 않게
  const takeId = target && "takeId" in target ? target.takeId : undefined;
  const sessionId = target && "sessionId" in target ? target.sessionId : undefined;
  return useApiData(
    async (api) => {
      if (takeId) return api.comments.list({ takeId });
      if (sessionId) return api.comments.list({ sessionId });
      return [];
    },
    [takeId, sessionId],
  );
}
```

- [ ] **Step 2: `CommentThread`에 `···`와 edited를 더한다**

`CommentThread.tsx` 전체를 교체:

```tsx
import type { TakeComment } from "@bandapp/types";
import { View } from "react-native";
import { fmtClock } from "@/lib/time";
import { useTheme } from "@/theme";
import { AppText, Avatar, PressableOpacity } from "@/ui";
import type { CommentThread as Thread } from "./threads";

function ReplyLink({ onPress }: { onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <PressableOpacity onPress={onPress} style={{ paddingVertical: 2 }}>
      <AppText variant="small" color={colors.textFaint}>
        Reply
      </AppText>
    </PressableOpacity>
  );
}

/** 본인 코멘트에만 — 수정·삭제 시트를 연다 (디자인의 "···") */
function ActionsLink({ onPress }: { onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <PressableOpacity onPress={onPress} hitSlop={6} style={{ paddingVertical: 2, paddingHorizontal: 4 }}>
      <AppText variant="small" color={colors.textFaint} style={{ letterSpacing: 2 }}>
        ···
      </AppText>
    </PressableOpacity>
  );
}

/** "Reply" (+ 본인이면 "···") 한 줄 */
function ActionRow({ mine, onReply, onActions, marginTop }: { mine: boolean; onReply: () => void; onActions: () => void; marginTop: number }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 16, marginTop }}>
      <ReplyLink onPress={onReply} />
      {mine ? <ActionsLink onPress={onActions} /> : null}
    </View>
  );
}

/** updatedAt이 있으면 "· edited" (2026-09-09 스펙 결정 10) */
function EditedMark() {
  const { colors } = useTheme();
  return (
    <AppText variant="small" color={colors.textFaint}>
      · edited
    </AppText>
  );
}

/** "View replies (N)" / "View more replies (N)" — 짧은 선 뒤에 라벨 */
function RepliesLink({ label, onPress, marginTop }: { label: string; onPress: () => void; marginTop: number }) {
  const { colors } = useTheme();
  return (
    <PressableOpacity onPress={onPress} style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop }}>
      <View style={{ width: 24, height: 1, backgroundColor: colors.borderStronger }} />
      <AppText variant="small" color={colors.textMuted}>
        {label}
      </AppText>
    </PressableOpacity>
  );
}

function ReplyRow({ reply, mine, onReply, onActions }: { reply: TakeComment; mine: boolean; onReply: () => void; onActions: () => void }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: 10, marginTop: 12 }}>
      <Avatar label={reply.authorName.slice(0, 1)} size={24} fontSize={10} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
          <AppText variant="caption" color={colors.text} style={{ fontWeight: "600" }}>
            {reply.authorName}
          </AppText>
          {reply.updatedAt ? <EditedMark /> : null}
        </View>
        <AppText variant="body" style={{ marginTop: 3, lineHeight: 20 }}>
          {reply.text}
        </AppText>
        <ActionRow mine={mine} onReply={onReply} onActions={onActions} marginTop={4} />
      </View>
    </View>
  );
}

export function CommentThread({
  thread,
  shownReplies,
  meId,
  onSeek,
  onReply,
  onActions,
  onMoreReplies,
}: {
  thread: Thread;
  /** 보이는 답글 수. 0이면 접힌 상태 */
  shownReplies: number;
  /** 현재 사용자 id — 본인 코멘트에만 "···"가 보인다 */
  meId: string | undefined;
  onSeek: () => void;
  /** target은 답글 대상 — 최상위 코멘트 자신이거나 그 아래 답글 */
  onReply: (target: TakeComment) => void;
  /** 본인 코멘트·답글의 수정·삭제 시트 */
  onActions: (target: TakeComment) => void;
  onMoreReplies: () => void;
}) {
  const { colors } = useTheme();
  const { comment, replies } = thread;
  const visible = replies.slice(0, shownReplies);
  const hidden = replies.length - visible.length;
  const mine = (c: TakeComment) => meId !== undefined && c.authorId === meId;
  return (
    <View style={{ flexDirection: "row", gap: 12, paddingVertical: 14 }}>
      <Avatar label={comment.authorName.slice(0, 1)} size={30} fontSize={12} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <PressableOpacity onPress={onSeek} activeOpacity={0.8}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
            <AppText variant="caption" color={colors.text} style={{ fontWeight: "600" }}>
              {comment.authorName}
            </AppText>
            <AppText variant="monoMeta" color={colors.accent}>
              {fmtClock(comment.atSec)}
            </AppText>
            {comment.updatedAt ? <EditedMark /> : null}
          </View>
          <AppText variant="body" style={{ marginTop: 4, lineHeight: 20 }}>
            {comment.text}
          </AppText>
        </PressableOpacity>
        <ActionRow mine={mine(comment)} onReply={() => onReply(comment)} onActions={() => onActions(comment)} marginTop={6} />
        {replies.length > 0 && visible.length === 0 ? (
          <RepliesLink label={`View replies (${replies.length})`} onPress={onMoreReplies} marginTop={10} />
        ) : null}
        {visible.map((r) => (
          <ReplyRow key={r.id} reply={r} mine={mine(r)} onReply={() => onReply(r)} onActions={() => onActions(r)} />
        ))}
        {visible.length > 0 && hidden > 0 ? (
          <RepliesLink label={`View more replies (${hidden})`} onPress={onMoreReplies} marginTop={12} />
        ) : null}
      </View>
    </View>
  );
}
```

- [ ] **Step 3: `CommentActionSheet`를 만든다**

`apps/mobile/src/features/takes/CommentActionSheet.tsx`:

```tsx
import type { TakeComment } from "@bandapp/types";
import { View } from "react-native";
import { useTheme } from "@/theme";
import { AppText, BottomSheet, SheetRow } from "@/ui";

/**
 * 본인 코멘트의 "···" 시트 — 인용문 한 줄 아래 Edit / Delete (디자인 "Take Feedback").
 * comment가 null이면 닫힌 상태.
 */
export function CommentActionSheet({
  comment,
  onClose,
  onEdit,
  onDelete,
}: {
  comment: TakeComment | null;
  onClose: () => void;
  onEdit: (comment: TakeComment) => void;
  onDelete: (comment: TakeComment) => void;
}) {
  const { colors } = useTheme();
  const isReply = comment?.parentId !== null;
  const kind = isReply ? "reply" : "comment";
  return (
    <BottomSheet visible={comment !== null} onClose={onClose}>
      {comment ? (
        <>
          <View style={{ paddingHorizontal: 12, paddingBottom: 10, marginBottom: 8, borderBottomWidth: 1, borderBottomColor: colors.border }}>
            <AppText variant="caption" numberOfLines={1}>
              {`"${comment.text}"`}
            </AppText>
          </View>
          <SheetRow title={`Edit ${kind}`} onPress={() => onEdit(comment)} />
          <SheetRow title={`Delete ${kind}`} danger onPress={() => onDelete(comment)} />
        </>
      ) : null}
    </BottomSheet>
  );
}
```

`colors.border`(#1D2025)는 디자인의 시트 인용문 아래 구분선 색과 같다. `AppText`는 `TextProps`를 스프레드하므로 `numberOfLines`가 그대로 `Text`에 간다.

- [ ] **Step 4: `CommentInput`에 편집 배너를 더한다**

`CommentInput.tsx`:

(a) `ReplyTarget` 아래에 추가:

```ts
export interface EditTarget {
  isReply: boolean;
  onCancel: () => void;
}
```

(b) props에 `editing?: EditTarget | null;`을 더한다(주석: `/** 편집 모드 — "Editing comment/reply" 배너. 답글 모드와 동시에 켜지지 않는다 */`).

(c) 포커스 effect를 `replyingTo`·`editing` 둘 다 보게:

```ts
  useEffect(() => {
    if (replyingTo || editing) inputRef.current?.focus();
  }, [replyingTo, editing]);
```

(d) 배너 렌더를 `replyingTo` 분기 뒤에 하나 더 둔다. 기존 `{replyingTo ? (…) : null}` 바로 다음:

```tsx
      {editing ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingVertical: 9,
            paddingHorizontal: 20,
            backgroundColor: colors.surfaceSunken,
          }}
        >
          <AppText variant="small" color={colors.textMuted}>
            {editing.isReply ? "Editing reply" : "Editing comment"}
          </AppText>
          <PressableOpacity onPress={editing.onCancel} hitSlop={8} style={{ paddingVertical: 2, paddingHorizontal: 6 }}>
            <AppText variant="small" color={colors.textFaint}>
              ✕
            </AppText>
          </PressableOpacity>
        </View>
      ) : null}
```

- [ ] **Step 5: `TakePlayerScreen`을 배선한다**

(a) import 변경:
- `import type { TakeComment } from "@bandapp/types";` → `import type { CommentTarget, TakeComment } from "@bandapp/types";`
- `import { AppText, MonoLabel, PlayerWaveform, PressableOpacity, Screen, useToast } from "@/ui";` → `import { AppText, ConfirmDialog, MonoLabel, PlayerWaveform, PressableOpacity, Screen, useToast } from "@/ui";`
- `import { CommentInput, type ReplyTarget } from "./CommentInput";` → `import { CommentInput, type EditTarget, type ReplyTarget } from "./CommentInput";`
- 추가: `import { useAuth } from "@/features/auth/AuthProvider";`, `import { CommentActionSheet } from "./CommentActionSheet";`

(b) 컴포넌트 본문 — `const { colors } = useTheme();` 아래에:

```ts
  const { state: authState } = useAuth();
  const meId = authState.status === "authenticated" ? authState.user.id : undefined;
```

(c) `useComments` 호출을 교체:

```ts
  // 원본 녹음도 같은 목록·입력을 쓴다 — 대상만 다르다 (2026-09-09 스펙 결정 4, 8)
  const target: CommentTarget | undefined = !session || !take ? undefined : isOriginal ? { sessionId: session.id } : { takeId: take.id };
  const { data: comments, reload } = useComments(target);
```

(d) 상태 추가 — `const [replyTo, setReplyTo] = useState<ReplyState | null>(null);` 아래:

```ts
  /** "···"로 연 코멘트 (시트) */
  const [actionTarget, setActionTarget] = useState<TakeComment | null>(null);
  /** 편집 중인 코멘트 — 입력창에 본문이 프리필된다 */
  const [editTarget, setEditTarget] = useState<TakeComment | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TakeComment | null>(null);
  const [deleting, setDeleting] = useState(false);

  const cancelEdit = () => {
    setEditTarget(null);
    setInput("");
  };
  // 편집을 시작하면 답글 모드는 끊는다 (디자인 caEdit)
  const startEdit = (c: TakeComment) => {
    setActionTarget(null);
    setReplyTo(null);
    setEditTarget(c);
    setInput(c.text);
  };
  const askDelete = (c: TakeComment) => {
    setActionTarget(null);
    setConfirmDelete(c);
  };
  const doDelete = () => {
    const c = confirmDelete;
    if (!c || deleting) return;
    setDeleting(true);
    void api.comments
      .remove(c.id)
      .then(() => {
        toast.show(c.parentId ? "Reply deleted" : "Comment deleted");
        if (editTarget?.id === c.id) cancelEdit();
        reload();
      })
      .catch(() => toast.show("Something went wrong"))
      .finally(() => {
        setDeleting(false);
        setConfirmDelete(null);
      });
  };
  const editing: EditTarget | null = editTarget ? { isReply: editTarget.parentId !== null, onCancel: cancelEdit } : null;
```

`startReply`도 편집 모드를 끊어야 한다 — 기존 `startReply` 안의 `setReplyTo(...)` 앞에 `setEditTarget(null);`을 더한다.

(e) `send`를 교체:

```ts
  const send = () => {
    const text = input.trim();
    if (!text || !target) return;
    if (editTarget) {
      const id = editTarget.id;
      setInput("");
      setEditTarget(null);
      void api.comments
        .update(id, { text })
        .then(() => reload())
        .catch(() => toast.show("Something went wrong"));
      return;
    }
    const parentId = replyTo?.parentId;
    setInput("");
    setReplyTo(null);
    // 새 코멘트가 화면 밖 페이지로 밀리지 않게 표시 범위를 넓혀 둔다
    if (parentId) setShownReplies((s) => ({ ...s, [parentId]: Number.POSITIVE_INFINITY }));
    else setShownThreads((n) => n + 1);
    const create = parentId
      ? api.comments.create(target, { parentId, text })
      : // 재생 위치가 실제 길이를 넘길 수 있다(디코딩된 길이가 메타데이터보다 길 때) — 타임라인 밖 코멘트를 막는다
        api.comments.create(target, { atSec: Math.min(playback.positionSec, take.durationSec), text });
    void create.then(() => reload()).catch(() => toast.show("Something went wrong"));
  };
```

(f) JSX:
- `ListEmptyComponent`의 문구를 원본 분기 없이 하나로:

```tsx
          ListEmptyComponent={
            <AppText variant="caption" color={colors.textFaint} style={{ paddingVertical: 18 }}>
              No feedback yet. Say something at the right moment — it lands on the timeline.
            </AppText>
          }
```

- `renderItem`의 `CommentThread`에 `meId={meId}`와 `onActions={setActionTarget}`을 더한다.
- `{!isOriginal && (<CommentInput … />)}`를 조건 없이 렌더하고 `editing={editing}`을 더한다:

```tsx
        <CommentInput
          value={input}
          onChangeText={setInput}
          replyingTo={replyTo}
          editing={editing}
          placeholder={replyTo ? "Add a reply…" : `Leave feedback at ${fmtClock(playback.positionSec)}…`}
          onSubmit={send}
        />
```

- `</KeyboardAvoidingView>` 뒤, `</Screen>` 앞에 시트와 다이얼로그:

```tsx
      <CommentActionSheet comment={actionTarget} onClose={() => setActionTarget(null)} onEdit={startEdit} onDelete={askDelete} />
      <ConfirmDialog
        visible={confirmDelete !== null}
        title={confirmDelete?.parentId ? "Delete reply?" : "Delete comment?"}
        body={`“${quote(confirmDelete?.text ?? "")}” will be removed for everyone in the band.`}
        primary={{ label: confirmDelete?.parentId ? "Delete reply" : "Delete comment", danger: true, onPress: doDelete }}
        cancelLabel="Cancel"
        onCancel={() => (deleting ? undefined : setConfirmDelete(null))}
        busy={deleting}
      />
```

파일 상단(상수들 옆)에:

```ts
/** 삭제 확인 본문 인용 — 디자인은 60자에서 자른다 */
function quote(text: string): string {
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}
```

- [ ] **Step 6: 타입체크·테스트**

Run: `pnpm --filter mobile typecheck && pnpm --filter mobile test`
Expected: 에러 없음, `threads.test.ts` 등 PASS.

- [ ] **Step 7: 웹 프리뷰(Mock)로 확인한다**

`EXPO_PUBLIC_API_URL`을 비운 채 `.claude/launch.json`의 mobile 설정으로 Browser pane에서 연다 (`preview_start`, 워크트리면 `worktree-dev-quirks` 메모 참고). 확인 항목:
1. 세션 s1 → Take 1: Dongjin(=나) 코멘트 158s에 `· edited`, "Reply ···"가 보이고 남의 코멘트엔 `···`가 없다.
2. `···` → 시트에 인용문·Edit comment·Delete comment. Edit → 배너 "Editing comment", 입력창에 본문. 본문을 바꿔 전송 → 목록 갱신, `· edited` 붙음.
3. 답글의 `···` → "Edit reply"/"Delete reply". Delete → "Delete reply?" 다이얼로그 → 삭제 → 토스트 "Reply deleted".
4. 최상위 코멘트 Delete → "Delete comment?" 본문에 인용 → 삭제 후 답글도 사라짐. 세션 목록의 코멘트 수가 줄어듦.
5. 세션 상세 → "Original recording" → 시드 원본 코멘트 2개가 보이고 입력창이 있다. 코멘트를 남기면 세션 목록 수가 1 오른다.
6. 답글 작성 중 Edit를 누르면 "Replying to" 배너가 사라지고 "Editing" 배너만 남는다.

스크린샷을 남긴다.

- [ ] **Step 8: 커밋**

```bash
git add apps/mobile/src/features/takes
git commit -m "feat(mobile): edit/delete own comments, original recording feedback, edited mark

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: 문서

**Files:**
- Modify: `README.md` (`### 녹음 업로드·분석 (모바일)` 절)
- Modify: `docs/backlog.md`

- [ ] **Step 1: README에 한 줄 더한다**

`### 녹음 업로드·분석 (모바일)` 절 마지막에:

```markdown
- 피드백은 take와 원본 녹음 둘 다에 남길 수 있고, 본인 코멘트는 `···`로 수정·삭제한다 (`PATCH/DELETE /comments/:id`, `GET/POST /sessions/:id/comments`). `0006` 마이그레이션이 `comments.session_id`를 더하고 `take_id`를 nullable로 바꾼다 — 기존 체크아웃은 `db:migrate`(컨테이너는 기동 시 자동).
```

- [ ] **Step 2: 백로그를 갱신한다**

`docs/backlog.md`의 `## 재생·피드백`에서 `**코멘트 수정·삭제.**`와 `**원본 녹음에 대한 코멘트.**` 항목을 지우고 다음을 더한다:

```markdown
- **코멘트 owner 중재.** 지금은 작성자만 수정·삭제한다 ([2026-09-09 스펙](superpowers/specs/2026-09-09-comment-edit-delete-original-design.md) 결정 1). 밴드 owner가 남의 코멘트를 지울 수 있게 하려면 서비스의 작성자 검사에 role 분기를 더한다.
- **코멘트 시점 수정.** 본문만 고칠 수 있다. 시점을 바꾸려면 답글의 `at_ms`도 같이 옮겨야 한다.
```

`## 팀·설정`의 `**기존 화면 문구의 i18n 이관.**` 항목 끝에 ` 코멘트 수정·삭제 문구(`···` 시트, 편집 배너, 삭제 확인)도 영어 하드코딩이다.`를 덧붙인다.

- [ ] **Step 3: 커밋**

```bash
git add README.md docs/backlog.md
git commit -m "docs: describe comment edit/delete and original recording feedback

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## 마지막 검증

- [ ] `pnpm build` (turbo) — types → api-client → api → mobile typecheck 순으로 깨진 곳이 없는지.
- [ ] `pnpm --filter @bandapp/api test` (Postgres 필요), `pnpm --filter @bandapp/api-client test`, `pnpm --filter mobile test`.
- [ ] `pnpm lint`.
- [ ] 서버 전 구간: `docker compose up --build -d` 후 README의 `upload-session` 스크립트로 세션을 만들고, `curl`로 `POST /sessions/:id/comments` → `PATCH` → `DELETE`가 201/200/204를 돌려주는지 (DEV_LOGIN 토큰 사용).
