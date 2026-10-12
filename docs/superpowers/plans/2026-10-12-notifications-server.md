# Notifications (Server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Server side of notifications — comment read marks, per-band notification settings, per-recipient inbox rows created on comment/session-ready events, FCM push behind a pluggable `PushSender`, and device token registration.

**Architecture:** A new `NotificationsModule` (services, no controller) is imported by both `AppModule` and `WorkerModule`; `NotificationsHttpModule` adds the controllers for the API only. `CommentsService.create` and the worker's ready transaction call `NotificationsService`, which computes recipients with a pure `fanout()` function, bulk-inserts `notifications` rows, then sends push best-effort through `PushSender` (`FirebasePushSender` when `FIREBASE_SERVICE_ACCOUNT_JSON` is set, otherwise `LogPushSender`). Comment read state is one `comment_read_marks` row per (user, session, take) and is surfaced as `TakeComment.unread`, `Take.unreadCommentCount`, `Session.unreadCommentCount`.

**Tech Stack:** NestJS 12, drizzle-orm 0.45 + drizzle-kit, Postgres 17, firebase-admin, vitest (unit `*.spec.ts`, e2e `*.e2e-spec.ts` against a real Postgres via docker compose).

**Spec:** `docs/superpowers/specs/2026-10-12-notifications-design.md`

## Global Constraints

- Code comments and commit messages in English-or-Korean as the surrounding file already does (API code comments are Korean, commit messages are English Conventional Commits).
- Node ≥ 22, pnpm 10, `"type": "module"` — relative imports in `apps/api` end in `.js`.
- Postgres 17 (`docker-compose.yml`), so `UNIQUE ... NULLS NOT DISTINCT` is allowed.
- Every band-scoped endpoint goes through `MembershipsService.assertMember` (403 for non-members, deleted bands count as non-member).
- Response shapes come from `@bandapp/types`; after editing `packages/types/src/*` run `pnpm --filter @bandapp/types build` or the API will see stale `dist`.
- Settings row absent ⇒ defaults `{ sessionReady: true, comments: true, commentScope: "all" }`.
- Off settings ⇒ no `notifications` row is created (not just no push).
- Session-ready recipients include the uploader; comment recipients exclude the author.
- Notification creation and push failures are logged and never fail the originating request/worker run.
- Inbox retention 30 days, enforced by deleting the caller's older rows during `list`.
- Push text is rendered server-side from `push_tokens.locale` (`ko` → Korean, anything else → English).
- All e2e tests run with `pnpm --filter @bandapp/api test:e2e` and require `docker compose up -d postgres` (DB `postgresql://band:band@localhost:5432/band`). Unit tests: `pnpm --filter @bandapp/api exec vitest run <path>`.

## Review Focus

Inputs the spec implies but that are easy to get wrong; each has a test pinned in the owning task:

1. **A reply to my own top-level comment by me** must not notify me (author excluded before type resolution). → Task 3 `fanout.spec.ts`.
2. **Reply when the parent author has `commentScope: "mine"`** gets `reply`; a third member with `mine` gets nothing; a third member with `all` gets `comment`. → Task 3.
3. **Cursor paging at identical `created_at`** (bulk insert gives several rows the same timestamp) must not skip or repeat rows — the cursor compares `(created_at, id)`. → Task 6 e2e "같은 시각에 만들어진 알림도 커서가 건너뛰지 않는다".
4. **`unreadCommentCount` counts replies too, but never my own comments**, and a mark set before a new comment leaves that comment unread. → Task 2 e2e.
5. **A token that FCM reports unregistered is deleted** so the next send does not retry it forever. → Task 4 unit + Task 6 e2e with `FakePushSender` returning `invalidTokens`.

---

### Task 1: Schema, migration, shared types

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/drizzle/0013_notifications.sql` (generated)
- Create: `packages/types/src/notification.ts`
- Modify: `packages/types/src/index.ts`, `packages/types/src/take.ts`, `packages/types/src/session.ts`
- Modify: `apps/api/test/db-util.ts`
- Modify: `apps/api/src/sessions/session-mapper.spec.ts` (rows gain `unreadCommentCount`)

**Interfaces:**
- Produces drizzle tables `notificationSettings`, `notifications`, `pushTokens`, `commentReadMarks` and enums `notificationType`, `notificationCommentScope`, `pushPlatform`.
- Produces types `NotificationType`, `CommentScope`, `NotificationItem`, `NotificationPage`, `NotificationSettings`, `RegisterPushTokenInput`; adds `TakeComment.unread`, `Take.unreadCommentCount`, `Session.unreadCommentCount`.

- [ ] **Step 1: Add enums and tables to `schema.ts`** (append after `comments`; add `foreignKey` and `unique` to the drizzle-orm/pg-core import)

```ts
// 알림 (2026-10-12 스펙)
export const notificationType = pgEnum("notification_type", ["session_ready", "comment", "reply"]);
export const notificationCommentScope = pgEnum("notification_comment_scope", ["all", "mine"]);
export const pushPlatform = pgEnum("push_platform", ["ios", "android"]);

// 밴드별 알림 설정. 행이 없으면 기본값(전부 on, scope all). FK를 band_members에 걸어 밴드를 나가면 설정도 사라진다 (스펙 데이터 절)
export const notificationSettings = pgTable(
  "notification_settings",
  {
    userId: uuid("user_id").notNull(),
    bandId: uuid("band_id").notNull(),
    sessionReady: boolean("session_ready").notNull().default(true),
    comments: boolean("comments").notNull().default(true),
    commentScope: notificationCommentScope("comment_scope").notNull().default("all"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.bandId] }),
    foreignKey({ columns: [t.bandId, t.userId], foreignColumns: [bandMembers.bandId, bandMembers.userId], name: "notification_settings_member_fk" }).onDelete("cascade"),
  ],
);

// 인박스 — 수신자 1명당 1행 (스펙 결정 1). 제목·본문은 저장하지 않고 조회 때 join으로 만든다 (결정 8)
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bandId: uuid("band_id")
      .notNull()
      .references(() => bands.id, { onDelete: "cascade" }),
    type: notificationType("type").notNull(),
    // 업로더·코멘트 작성자. 탈퇴하면 null → "탈퇴한 멤버"
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    takeId: uuid("take_id").references(() => takes.id, { onDelete: "cascade" }),
    commentId: uuid("comment_id").references(() => comments.id, { onDelete: "cascade" }),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("notifications_user_band_created_idx").on(t.userId, t.bandId, t.createdAt.desc(), t.id.desc())],
);

// FCM 기기 토큰. 같은 토큰으로 다른 계정이 로그인하면 user_id가 덮어써진다
export const pushTokens = pgTable("push_tokens", {
  token: text("token").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  platform: pushPlatform("platform").notNull(),
  // 기기 언어 태그. 푸시 문구는 서버가 만들어야 해서 여기서 템플릿을 고른다 (스펙 결정 7)
  locale: text("locale").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

// 코멘트 읽음 — 대상(take 또는 원본 녹음)별 "여기까지 봤다" 시각 1행 (스펙 결정 13). take_id null = 원본 녹음
export const commentReadMarks = pgTable(
  "comment_read_marks",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    takeId: uuid("take_id").references(() => takes.id, { onDelete: "cascade" }),
    readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // take_id가 null일 수 있어 PK 대신 NULLS NOT DISTINCT 유니크 (PG 15+)
  (t) => [unique("comment_read_marks_target_uq").on(t.userId, t.sessionId, t.takeId).nullsNotDistinct()],
);
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm --filter @bandapp/api db:generate --name notifications`
Expected: `apps/api/drizzle/0013_notifications.sql` created and `drizzle/meta/_journal.json` gets `"tag": "0013_notifications"`.
Open the SQL and confirm it contains `CONSTRAINT "comment_read_marks_target_uq" UNIQUE NULLS NOT DISTINCT("user_id","session_id","take_id")` and the composite FK `FOREIGN KEY ("band_id","user_id") REFERENCES "public"."band_members"("band_id","user_id") ON DELETE cascade`. If drizzle-kit omitted `NULLS NOT DISTINCT`, edit the SQL by hand to add it (the snapshot in `meta/` is unaffected).

- [ ] **Step 3: Add shared types**

`packages/types/src/notification.ts`:

```ts
export type NotificationType = "session_ready" | "comment" | "reply";
export type CommentScope = "all" | "mine";

export interface NotificationItem {
  id: string;
  type: NotificationType;
  /** null = 탈퇴한 멤버. name이 null이면 이름 없는 계정 */
  actor: { id: string; name: string | null } | null;
  session: { id: string; title: string; name: string | null; startedAt: string; takeCount: number; durationSec: number };
  /** 원본 녹음 코멘트·session_ready면 null */
  take: { id: string; index: number; name: string } | null;
  /** session_ready면 null */
  comment: { id: string; atSec: number; text: string } | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPage {
  items: NotificationItem[];
  /** 더 없으면 null */
  nextCursor: string | null;
  /** 이 페이지 뒤에 남은 개수 — "Show older (n)" */
  remaining: number;
  /** 밴드 기준 미읽음 수 */
  unreadCount: number;
}

export interface NotificationSettings {
  bandId: string;
  sessionReady: boolean;
  comments: boolean;
  commentScope: CommentScope;
}

export type UpdateNotificationSettingsInput = Omit<NotificationSettings, "bandId">;

export const DEFAULT_NOTIFICATION_SETTINGS: UpdateNotificationSettingsInput = { sessionReady: true, comments: true, commentScope: "all" };

export interface RegisterPushTokenInput {
  token: string;
  platform: "ios" | "android";
  /** 기기 언어 태그 (예: "ko-KR", "en") */
  locale: string;
}

export const NOTIFICATIONS_PAGE_SIZE = 6;
export const NOTIFICATIONS_PAGE_MAX = 50;
```

Add `export * from "./notification";` to `packages/types/src/index.ts`.

In `packages/types/src/take.ts` add to `TakeComment` after `updatedAt`:
```ts
  /** 내 read mark 이후에 다른 사람이 쓴 코멘트 (2026-10-12 스펙 결정 13). 내 코멘트는 항상 false */
  unread: boolean;
```
and to `Take` after `commentCount`:
```ts
  /** 내가 안 읽은 코멘트 수 (답글 포함, 내 코멘트 제외) */
  unreadCommentCount: number;
```
In `packages/types/src/session.ts` add to `Session` after `commentCount`:
```ts
  /** 세션의 모든 take + 원본 녹음에서 내가 안 읽은 코멘트 수 */
  unreadCommentCount: number;
```

- [ ] **Step 4: Build types and fix compile fallout**

Run: `pnpm --filter @bandapp/types build && pnpm --filter @bandapp/api exec tsc --noEmit -p tsconfig.json`
Expected: errors in `apps/api/src/sessions/session-mapper.ts`, `sessions.service.ts`, `takes/takes.service.ts`, `comments/comments.service.ts` (missing `unread*`). Also `packages/api-client` mock will fail to typecheck — that is fixed in the mobile plan; for now run only the API typecheck. Do **not** fix the API errors here; Task 2 does. Just confirm the list is as expected.

- [ ] **Step 5: Add new tables to e2e truncation**

In `apps/api/test/db-util.ts` change the TRUNCATE list to start with the new tables:
```ts
    sql`TRUNCATE notifications, notification_settings, push_tokens, comment_read_marks, support_requests, analysis_charges, extra_purchases, billing_events, comments, takes, recordings, sessions, band_invites, band_members, bands, billing_pools, auth_sessions, user_identities, users CASCADE`,
```

- [ ] **Step 6: Apply the migration locally and run the DB e2e smoke**

Run: `docker compose up -d postgres && pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/db.e2e-spec.ts`
Expected: PASS (global setup migrates to 0013).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle packages/types/src apps/api/test/db-util.ts
git commit -m "feat(api): notifications schema, migration 0013 and shared types"
```

---

### Task 2: Comment read marks — `unread`, `unreadCommentCount`, read endpoints

**Files:**
- Create: `apps/api/src/comments/comment-unread.ts`
- Modify: `apps/api/src/sessions/session-mapper.ts`, `apps/api/src/sessions/sessions.service.ts`, `apps/api/src/sessions/session-mapper.spec.ts`
- Modify: `apps/api/src/takes/takes.service.ts`
- Modify: `apps/api/src/comments/comments.service.ts`, `apps/api/src/comments/comments.controller.ts`
- Test: `apps/api/test/comments.e2e-spec.ts`

**Interfaces:**
- Produces `unreadTakeCommentCount(userId): SQL<number>`, `unreadSessionCommentCount(userId): SQL<number>`.
- Produces `sessionColumns(userId)` (replaces constant `SESSION_WITH_COUNTS` at call sites), `takeColumns(userId)` (replaces `TAKE_WITH_COUNT`).
- Changes `CommentsService.list(scope, userId)`; adds `CommentsService.markRead(scope, userId): Promise<void>`.
- Routes `POST /takes/:id/comments/read`, `POST /sessions/:id/comments/read` → 204.

- [ ] **Step 1: Write the failing e2e tests** (append inside `describe("comments API")` in `test/comments.e2e-spec.ts`, after the existing `memberOf` helper is reachable — put a new `describe("읽음", ...)` block with its own `memberOf` copy)

```ts
  describe("읽음 (2026-10-12)", () => {
    async function memberOf(id: string, name: string) {
      const other = await createTestApp({ google: providerUser(id, name), storage: new FakeStorage() });
      const login = await loginAs(other);
      await other.close();
      await db.insert(bandMembers).values({ bandId, userId: login.userId, role: "member" });
      return login;
    }

    it("다른 사람 코멘트는 읽기 전엔 unread, 읽으면 false, 그 뒤 새 코멘트(답글 포함)는 다시 unread", async () => {
      const minsoo = await memberOf("member-1", "Minsoo");
      const first = await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(minsoo.accessToken)).send({ atSec: 10, text: "first" }).expect(201);
      let list = await request(app.getHttpServer()).get(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).expect(200);
      expect(list.body[0]).toMatchObject({ text: "first", unread: true });
      let takesRes = await request(app.getHttpServer()).get(`/sessions/${sessionId}/takes`).set(auth(owner.accessToken)).expect(200);
      expect(takesRes.body[0].unreadCommentCount).toBe(1);
      let sessionRes = await request(app.getHttpServer()).get(`/sessions/${sessionId}`).set(auth(owner.accessToken)).expect(200);
      expect(sessionRes.body.unreadCommentCount).toBe(1);

      await request(app.getHttpServer()).post(`/takes/${takeId}/comments/read`).set(auth(owner.accessToken)).expect(204);
      list = await request(app.getHttpServer()).get(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).expect(200);
      expect(list.body[0].unread).toBe(false);
      takesRes = await request(app.getHttpServer()).get(`/sessions/${sessionId}/takes`).set(auth(owner.accessToken)).expect(200);
      expect(takesRes.body[0].unreadCommentCount).toBe(0);

      // 읽은 뒤 답글 + 새 코멘트 → 둘 다 unread (답글도 센다)
      await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(minsoo.accessToken)).send({ parentId: first.body.id, text: "reply" }).expect(201);
      await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(minsoo.accessToken)).send({ atSec: 20, text: "second" }).expect(201);
      list = await request(app.getHttpServer()).get(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).expect(200);
      expect(list.body.map((c: { text: string; unread: boolean }) => [c.text, c.unread])).toEqual([["first", false], ["reply", true], ["second", true]]);
      sessionRes = await request(app.getHttpServer()).get(`/sessions/${sessionId}`).set(auth(owner.accessToken)).expect(200);
      expect(sessionRes.body.unreadCommentCount).toBe(2);
    });

    it("내 코멘트는 unread가 아니고, 작성자 쪽 unreadCommentCount에도 안 센다", async () => {
      await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ atSec: 1, text: "mine" }).expect(201);
      const list = await request(app.getHttpServer()).get(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).expect(200);
      expect(list.body[0].unread).toBe(false);
      const takesRes = await request(app.getHttpServer()).get(`/sessions/${sessionId}/takes`).set(auth(owner.accessToken)).expect(200);
      expect(takesRes.body[0].unreadCommentCount).toBe(0);
    });

    it("원본 녹음 코멘트는 세션 read로 읽고, take mark와 섞이지 않는다", async () => {
      const minsoo = await memberOf("member-2", "Minsoo");
      await request(app.getHttpServer()).post(`/sessions/${sessionId}/comments`).set(auth(minsoo.accessToken)).send({ atSec: 5, text: "orig" }).expect(201);
      await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(minsoo.accessToken)).send({ atSec: 5, text: "take" }).expect(201);
      // take만 읽음
      await request(app.getHttpServer()).post(`/takes/${takeId}/comments/read`).set(auth(owner.accessToken)).expect(204);
      let orig = await request(app.getHttpServer()).get(`/sessions/${sessionId}/comments`).set(auth(owner.accessToken)).expect(200);
      expect(orig.body[0].unread).toBe(true);
      await request(app.getHttpServer()).post(`/sessions/${sessionId}/comments/read`).set(auth(owner.accessToken)).expect(204);
      orig = await request(app.getHttpServer()).get(`/sessions/${sessionId}/comments`).set(auth(owner.accessToken)).expect(200);
      expect(orig.body[0].unread).toBe(false);
      // 두 번 읽어도 204 (upsert)
      await request(app.getHttpServer()).post(`/sessions/${sessionId}/comments/read`).set(auth(owner.accessToken)).expect(204);
    });

    it("비멤버의 read는 403, 없는 take는 404", async () => {
      const stranger = await createTestApp({ google: providerUser("stranger"), storage: new FakeStorage() });
      const s = await loginAs(stranger);
      await stranger.close();
      await request(app.getHttpServer()).post(`/takes/${takeId}/comments/read`).set(auth(s.accessToken)).expect(403);
      await request(app.getHttpServer()).post(`/takes/00000000-0000-0000-0000-000000000000/comments/read`).set(auth(owner.accessToken)).expect(404);
    });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/comments.e2e-spec.ts`
Expected: FAIL — TypeScript errors from Task 1 (`unread` missing) and 404 on `/comments/read`.

- [ ] **Step 3: Create the unread SQL builders** — `apps/api/src/comments/comment-unread.ts`

```ts
import { sql, type SQL } from "drizzle-orm";

/**
 * "내가 안 읽은 코멘트" 상관 서브쿼리 (2026-10-12 스펙 결정 13).
 * 대상별 read mark(comment_read_marks)가 없으면 전부, 있으면 read_at 이후 것만 센다. 내 코멘트는 제외, 답글은 포함.
 * 외부 쿼리의 테이블명("takes"/"sessions")을 직접 쓰는 이유는 TAKE_WITH_COUNT와 같다 — 단일 테이블 select에서
 * 컬럼이 접두어 없이 렌더돼 서브쿼리 안 컬럼과 충돌한다.
 */
export function unreadTakeCommentCount(userId: string): SQL<number> {
  return sql<number>`(select count(*)::int from comments c
    left join comment_read_marks m on m.user_id = ${userId}::uuid and m.session_id = c.session_id and m.take_id is not distinct from c.take_id
    where c.take_id = "takes"."id" and c.author_id <> ${userId}::uuid and (m.read_at is null or c.created_at > m.read_at))`;
}

export function unreadSessionCommentCount(userId: string): SQL<number> {
  return sql<number>`(select count(*)::int from comments c
    left join comment_read_marks m on m.user_id = ${userId}::uuid and m.session_id = c.session_id and m.take_id is not distinct from c.take_id
    where c.session_id = "sessions"."id" and c.author_id <> ${userId}::uuid and (m.read_at is null or c.created_at > m.read_at))`;
}
```

- [ ] **Step 4: Sessions — `sessionColumns(userId)` and `getRow(id, userId)`**

In `session-mapper.ts`: add `unreadCommentCount: number;` to `SessionRow` (after `commentCount`), add `unreadCommentCount: row.unreadCommentCount,` to `toSession` (after `commentCount`), import `unreadSessionCommentCount` from `../comments/comment-unread.js`, and replace the `SESSION_WITH_COUNTS` constant with:

```ts
/** 세션 목록·단건 조회가 공유하는 select 컬럼. commentCount는 session_id로 직접 집계한다 (take 코멘트·원본 녹음 코멘트 모두 포함). unreadCommentCount는 호출자 기준이라 함수다 */
export function sessionColumns(userId: string) {
  return {
    id: sessions.id,
    bandId: sessions.bandId,
    title: sessions.title,
    name: sessions.name,
    status: sessions.status,
    startedAt: sessions.startedAt,
    durationMs: sessions.durationMs,
    takeCount: sessions.takeCount,
    peaks: sessions.peaks,
    peaksKey: sessions.peaksKey,
    // retry()가 analyzing 정체 판단에 쓴다 — wire Session에는 노출하지 않는다 (toSession에서 사용 안 함).
    updatedAt: sessions.updatedAt,
    // 상관 서브쿼리이므로 "sessions"."id"를 테이블명까지 명시해 comments.id와의 모호성을 없앤다.
    // 답글은 세지 않는다 (스레드 스펙 결정 5). 원본 녹음 코멘트도 session_id로 함께 센다 (2026-09-09 스펙 결정 6).
    commentCount: sql<number>`(select count(*)::int from comments c where c.session_id = "sessions"."id" and c.parent_id is null)`,
    unreadCommentCount: unreadSessionCommentCount(userId),
  };
}
```

In `sessions.service.ts`: import `sessionColumns` instead of `SESSION_WITH_COUNTS`; change `private async getRow(id: string, userId: string)` to `.select(sessionColumns(userId))`; update every caller — `create` (`this.getRow(inserted.id, userId)`), `list` (`.select(sessionColumns(userId))`), `loadForMember` (`this.getRow(id, userId)`), `completeUpload` and `retry` (`toSession(await this.getRow(id, userId))`). All four already have `userId` in scope.

In `session-mapper.spec.ts` add `unreadCommentCount: 0` to every row literal passed to `toSession` and assert `unreadCommentCount: 0` where the test checks the full object.

- [ ] **Step 5: Takes — `takeColumns(userId)`**

In `takes.service.ts`: import `unreadTakeCommentCount` from `../comments/comment-unread.js`; add `unreadCommentCount: number;` to `TakeRow` and `unreadCommentCount: row.unreadCommentCount,` to `toTake` (after `commentCount`); replace the `TAKE_WITH_COUNT` constant with

```ts
export function takeColumns(userId: string) {
  return {
    id: takes.id,
    sessionId: takes.sessionId,
    index: takes.index,
    name: takes.name,
    startMs: takes.startMs,
    endMs: takes.endMs,
    type: takes.type,
    objectKey: takes.objectKey,
    peaks: takes.peaks,
    version: takes.version,
    audioStatus: takes.audioStatus,
    // ${takes.id}는 단일 테이블 select에서 테이블 접두어 없이 "id"로 렌더링돼 서브쿼리 안의
    // comments.id와 충돌한다 — 상관 서브쿼리이므로 테이블명을 직접 명시해 모호성을 없앤다.
    // 답글은 세지 않는다 — "N comments"는 스레드 수다 (스레드 스펙 결정 5).
    commentCount: sql<number>`(select count(*)::int from comments c where c.take_id = "takes"."id" and c.parent_id is null)`,
    unreadCommentCount: unreadTakeCommentCount(userId),
  };
}
```
and replace all six `.select(TAKE_WITH_COUNT)` with `.select(takeColumns(userId))` (in `list`, `create`, `loadForMember`, `update`, `rename`, `remove` — each has `userId`).

- [ ] **Step 6: CommentsService — `unread` and `markRead`**

In `comments.service.ts`:
- import `commentReadMarks` from schema and `sql` from drizzle-orm.
- `list(scope: CommentScope, userId: string)`:
```ts
  async list(scope: CommentScope, userId: string): Promise<TakeComment[]> {
    const [rows, readAt] = await Promise.all([
      this.db.select(COMMENT_COLUMNS).from(comments).innerJoin(users, eq(users.id, comments.authorId)).where(inScope(scope)).orderBy(asc(comments.atMs), asc(comments.createdAt)),
      this.readMarkOf(scope, userId),
    ]);
    return rows.map((row) => toComment(row, isUnread(row, userId, readAt)));
  }

  /** 대상(take 또는 원본 녹음)의 코멘트를 "지금까지 봤다"고 기록한다 (2026-10-12 스펙 결정 13). 두 번 불러도 read_at만 갱신 */
  async markRead(scope: CommentScope, userId: string): Promise<void> {
    await this.db
      .insert(commentReadMarks)
      .values({ userId, sessionId: scope.sessionId, takeId: scope.takeId })
      .onConflictDoUpdate({
        target: [commentReadMarks.userId, commentReadMarks.sessionId, commentReadMarks.takeId],
        set: { readAt: sql`now()` },
      });
  }

  private async readMarkOf(scope: CommentScope, userId: string): Promise<Date | null> {
    const [mark] = await this.db
      .select({ readAt: commentReadMarks.readAt })
      .from(commentReadMarks)
      .where(and(eq(commentReadMarks.userId, userId), eq(commentReadMarks.sessionId, scope.sessionId), scope.takeId ? eq(commentReadMarks.takeId, scope.takeId) : isNull(commentReadMarks.takeId)));
    return mark?.readAt ?? null;
  }
```
- module-level helper and `toComment(row, unread)`:
```ts
/** 내 코멘트는 항상 읽음. 마크가 없으면 남의 코멘트는 전부 안 읽음 */
function isUnread(row: Pick<CommentRow, "authorId" | "createdAt">, userId: string, readAt: Date | null): boolean {
  if (row.authorId === userId) return false;
  return readAt === null || row.createdAt > readAt;
}

function toComment(row: CommentRow, unread: boolean): TakeComment {
  return { /* existing fields */ ..., unread };
}
```
- `create`/`update` return `this.getOne(inserted.id)` — a comment you just wrote or edited is yours, so `getOne(id)` passes `unread: false`: `return toComment(row, false);`.

In `comments.controller.ts`: pass `userId` to `list` in both GET handlers and add

```ts
  /** 테이크 화면을 열 때 — 이 대상의 코멘트를 읽음 처리 (2026-10-12 스펙) */
  @Post("takes/:id/comments/read")
  @HttpCode(204)
  async readForTake(@CurrentUserId() userId: string, @Param("id") id: string): Promise<void> {
    requireUuidParam(id, "id");
    await this.comments.markRead(await this.comments.scopeForTake(id, userId), userId);
  }

  @Post("sessions/:id/comments/read")
  @HttpCode(204)
  async readForSession(@CurrentUserId() userId: string, @Param("id") id: string): Promise<void> {
    requireUuidParam(id, "id");
    await this.comments.markRead(await this.comments.scopeForSession(id, userId), userId);
  }
```

- [ ] **Step 7: Typecheck, run unit + e2e**

Run: `pnpm --filter @bandapp/api exec tsc --noEmit -p tsconfig.json && pnpm --filter @bandapp/api exec vitest run src/sessions && pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/comments.e2e-spec.ts test/takes.e2e-spec.ts test/sessions.e2e-spec.ts`
Expected: all PASS. If `takes.e2e-spec`/`sessions.e2e-spec` compare whole objects with `toEqual`, add `unreadCommentCount: 0` there.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat(api): comment read marks — unread flag, unreadCommentCount, read endpoints"
```

---

### Task 3: Pure fan-out and push text

**Files:**
- Create: `apps/api/src/notifications/fanout.ts`, `apps/api/src/notifications/fanout.spec.ts`
- Create: `apps/api/src/notifications/push-text.ts`, `apps/api/src/notifications/push-text.spec.ts`

**Interfaces:**
- Produces `NotificationEvent`, `fanout(event, memberIds, settingsByUser): Recipient[]`.
- Produces `PushTextInput`, `pushText(locale, input): { title: string; body: string }`.

- [ ] **Step 1: Write `fanout.spec.ts`**

```ts
import { describe, expect, it } from "vitest";
import { fanout, type NotificationEvent } from "./fanout.js";

const members = ["me", "a", "b", "c"];
const sessionReady: NotificationEvent = { kind: "session_ready", bandId: "band", sessionId: "s", actorId: "me" };
const topLevel: NotificationEvent = { kind: "comment", bandId: "band", sessionId: "s", actorId: "a", commentId: "c1", takeId: "t", parentAuthorId: null };
const replyToMe: NotificationEvent = { ...topLevel, commentId: "c2", parentAuthorId: "me" };

describe("fanout", () => {
  it("session_ready는 업로더 포함 전원에게 간다 (스펙 결정 3)", () => {
    expect(fanout(sessionReady, members, new Map())).toEqual(members.map((userId) => ({ userId, type: "session_ready" })));
  });

  it("sessionReady=false인 멤버는 빠진다", () => {
    const settings = new Map([["b", { sessionReady: false, comments: true, commentScope: "all" as const }]]);
    expect(fanout(sessionReady, members, settings).map((r) => r.userId)).toEqual(["me", "a", "c"]);
  });

  it("코멘트는 작성자를 빼고 모두 comment", () => {
    expect(fanout(topLevel, members, new Map())).toEqual([
      { userId: "me", type: "comment" },
      { userId: "b", type: "comment" },
      { userId: "c", type: "comment" },
    ]);
  });

  it("답글은 부모 작성자에게만 reply, 나머지는 comment", () => {
    expect(fanout(replyToMe, members, new Map())).toEqual([
      { userId: "me", type: "reply" },
      { userId: "b", type: "comment" },
      { userId: "c", type: "comment" },
    ]);
  });

  it("내 코멘트에 내가 단 답글은 나에게 안 온다 (작성자 제외가 먼저)", () => {
    const selfReply: NotificationEvent = { ...replyToMe, actorId: "me" };
    expect(fanout(selfReply, members, new Map()).map((r) => r.userId)).toEqual(["a", "b", "c"]);
  });

  it("commentScope=mine은 reply만 통과, comments=false는 전부 제외", () => {
    const settings = new Map([
      ["me", { sessionReady: true, comments: true, commentScope: "mine" as const }],
      ["b", { sessionReady: true, comments: true, commentScope: "mine" as const }],
      ["c", { sessionReady: true, comments: false, commentScope: "all" as const }],
    ]);
    expect(fanout(replyToMe, members, settings)).toEqual([{ userId: "me", type: "reply" }]);
    expect(fanout(topLevel, members, settings)).toEqual([]);
  });

  it("설정 행이 없으면 기본값(전부 on)", () => {
    expect(fanout(topLevel, ["me", "a"], new Map())).toEqual([{ userId: "me", type: "comment" }]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @bandapp/api exec vitest run src/notifications/fanout.spec.ts`
Expected: FAIL — cannot find module `./fanout.js`.

- [ ] **Step 3: Implement `fanout.ts`**

```ts
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationType, type UpdateNotificationSettingsInput } from "@bandapp/types";

/** 알림을 만들 사건. 서비스가 DB에서 채워 넘긴다 */
export type NotificationEvent =
  | { kind: "session_ready"; bandId: string; sessionId: string; actorId: string }
  | {
      kind: "comment";
      bandId: string;
      sessionId: string;
      actorId: string;
      commentId: string;
      takeId: string | null;
      /** 답글이면 부모(최상위) 코멘트 작성자 */
      parentAuthorId: string | null;
    };

export interface Recipient {
  userId: string;
  type: NotificationType;
}

/**
 * 수신자 계산 (스펙 서버 절). 순수 함수 — DB 없음.
 * session_ready: 밴드 전원(업로더 포함), sessionReady=false 제외.
 * comment: 작성자 제외. 부모 작성자에게는 reply, 나머지는 comment. comments=false 제외, scope=mine이면 reply만.
 */
export function fanout(event: NotificationEvent, memberIds: readonly string[], settingsByUser: ReadonlyMap<string, UpdateNotificationSettingsInput>): Recipient[] {
  const out: Recipient[] = [];
  for (const userId of memberIds) {
    const s = settingsByUser.get(userId) ?? DEFAULT_NOTIFICATION_SETTINGS;
    if (event.kind === "session_ready") {
      if (s.sessionReady) out.push({ userId, type: "session_ready" });
      continue;
    }
    if (userId === event.actorId || !s.comments) continue;
    const type: NotificationType = event.parentAuthorId === userId ? "reply" : "comment";
    if (s.commentScope === "mine" && type !== "reply") continue;
    out.push({ userId, type });
  }
  return out;
}
```

- [ ] **Step 4: Run fanout tests**

Run: `pnpm --filter @bandapp/api exec vitest run src/notifications/fanout.spec.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Write `push-text.spec.ts`**

```ts
import { describe, expect, it } from "vitest";
import { pushText, type PushTextInput } from "./push-text.js";

const base: PushTextInput = { type: "comment", actorName: "Minsu", isSelf: false, sessionLabel: "Full set run-through", takeCount: 7, takeName: "Take 1", commentText: "Rushing going into the chorus" };

describe("pushText", () => {
  it("en: 코멘트·답글·세션", () => {
    expect(pushText("en-US", base)).toEqual({ title: "Minsu commented on Take 1", body: "“Rushing going into the chorus”" });
    expect(pushText("en", { ...base, type: "reply" })).toEqual({ title: "Minsu replied to you on Take 1", body: "“Rushing going into the chorus”" });
    expect(pushText("en", { ...base, type: "session_ready", actorName: "Jihoon" })).toEqual({ title: "Jihoon's recording is ready", body: "Full set run-through · 7 takes found" });
    expect(pushText("en", { ...base, type: "session_ready", isSelf: true, takeCount: 1 })).toEqual({ title: "Your recording is ready", body: "Full set run-through · 1 take found" });
  });

  it("ko: 코멘트·답글·세션", () => {
    expect(pushText("ko-KR", base)).toEqual({ title: "Minsu님이 Take 1에 코멘트를 남겼어요", body: "“Rushing going into the chorus”" });
    expect(pushText("ko", { ...base, type: "reply" })).toEqual({ title: "Minsu님이 Take 1의 내 코멘트에 답글을 남겼어요", body: "“Rushing going into the chorus”" });
    expect(pushText("ko", { ...base, type: "session_ready", actorName: "Jihoon" })).toEqual({ title: "Jihoon님의 녹음이 준비됐어요", body: "Full set run-through · 테이크 7개" });
    expect(pushText("ko", { ...base, type: "session_ready", isSelf: true })).toEqual({ title: "내 녹음이 준비됐어요", body: "Full set run-through · 테이크 7개" });
  });

  it("원본 녹음 코멘트(takeName null)와 actor 없음·이름 없음", () => {
    expect(pushText("en", { ...base, takeName: null }).title).toBe("Minsu commented on the original recording");
    expect(pushText("ko", { ...base, takeName: null }).title).toBe("Minsu님이 원본 녹음에 코멘트를 남겼어요");
    expect(pushText("en", { ...base, actorName: null }).title).toBe("A former member commented on Take 1");
    expect(pushText("ko", { ...base, actorName: null }).title).toBe("탈퇴한 멤버님이 Take 1에 코멘트를 남겼어요");
    expect(pushText("en", { ...base, actorName: "" }).title).toBe("? commented on Take 1");
  });

  it("모르는 locale은 en, 본문은 200자에서 자른다", () => {
    expect(pushText("fr", base).title).toBe("Minsu commented on Take 1");
    const long = "a".repeat(300);
    expect(pushText("en", { ...base, commentText: long }).body).toBe(`“${"a".repeat(199)}…”`);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm --filter @bandapp/api exec vitest run src/notifications/push-text.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement `push-text.ts`**

```ts
import type { NotificationType } from "@bandapp/types";

export interface PushTextInput {
  type: NotificationType;
  /** null = 탈퇴한 멤버, "" = 이름 없는 계정 */
  actorName: string | null;
  /** session_ready를 업로더 본인이 받을 때 */
  isSelf: boolean;
  /** session.name ?? session.title */
  sessionLabel: string;
  takeCount: number;
  /** 원본 녹음 코멘트면 null */
  takeName: string | null;
  commentText: string | null;
}

const BODY_MAX = 200;

/** 푸시 문구 (스펙 서버 절 표). 인박스 문구는 모바일 i18n이 같은 규칙으로 만든다 */
export function pushText(locale: string, input: PushTextInput): { title: string; body: string } {
  const ko = locale.toLowerCase().startsWith("ko");
  const actor = input.actorName === null ? (ko ? "탈퇴한 멤버" : "A former member") : input.actorName.trim() || "?";
  const target = input.takeName ?? (ko ? "원본 녹음" : "the original recording");
  const quote = `“${truncate(input.commentText ?? "")}”`;
  switch (input.type) {
    case "session_ready": {
      const title = input.isSelf ? (ko ? "내 녹음이 준비됐어요" : "Your recording is ready") : ko ? `${actor}님의 녹음이 준비됐어요` : `${actor}'s recording is ready`;
      const takes = ko ? `테이크 ${input.takeCount}개` : `${input.takeCount} ${input.takeCount === 1 ? "take" : "takes"} found`;
      return { title, body: `${input.sessionLabel} · ${takes}` };
    }
    case "comment":
      return { title: ko ? `${actor}님이 ${target}에 코멘트를 남겼어요` : `${actor} commented on ${target}`, body: quote };
    case "reply":
      return { title: ko ? `${actor}님이 ${target}의 내 코멘트에 답글을 남겼어요` : `${actor} replied to you on ${target}`, body: quote };
  }
}

function truncate(text: string): string {
  return text.length > BODY_MAX ? `${text.slice(0, BODY_MAX - 1)}…` : text;
}
```

- [ ] **Step 8: Run tests, commit**

Run: `pnpm --filter @bandapp/api exec vitest run src/notifications`
Expected: PASS.

```bash
git add apps/api/src/notifications
git commit -m "feat(api): notification fan-out and push text as pure functions"
```

---

### Task 4: PushSender (Log + Firebase) and PushTokensService

**Files:**
- Create: `apps/api/src/notifications/push-sender.ts`, `apps/api/src/notifications/push-sender.spec.ts`
- Create: `apps/api/src/notifications/push-tokens.service.ts`
- Modify: `apps/api/package.json` (add `firebase-admin`)

**Interfaces:**
- Produces `PUSH_SENDER` symbol, `PushMessage`, `PushSender`, `LogPushSender`, `FirebasePushSender`, `pushSenderProvider`.
- Produces `PushTokensService { upsert(userId, input), remove(token), removeMany(tokens), forUsers(userIds) }`, `pushTokensServiceProvider`.

- [ ] **Step 1: Install firebase-admin**

Run: `pnpm --filter @bandapp/api add firebase-admin`
Expected: `apps/api/package.json` dependencies gain `"firebase-admin": "^13.x"` (whatever latest resolves). Confirm `node -e "import('firebase-admin/messaging').then(m=>console.log(Object.keys(m).includes('getMessaging')))"` prints `true` from `apps/api`.

- [ ] **Step 2: Write `push-sender.spec.ts`**

```ts
import { afterEach, describe, expect, it } from "vitest";
import { FirebasePushSender, LogPushSender, pushSenderProvider, type MessagingLike, type PushMessage } from "./push-sender.js";

const message: PushMessage = { title: "t", body: "b", data: { type: "comment" } };

function fakeMessaging(results: Array<{ success: boolean; code?: string }>) {
  const calls: unknown[] = [];
  const messaging = {
    sendEachForMulticast: async (msg: unknown) => {
      calls.push(msg);
      return { successCount: 0, failureCount: 0, responses: results.map((r) => ({ success: r.success, error: r.code ? { code: r.code, message: r.code } : undefined })) };
    },
  } as unknown as MessagingLike;
  return { messaging, calls };
}

describe("FirebasePushSender", () => {
  it("토큰 전체를 한 번에 보내고 unregistered·invalid 토큰만 돌려준다", async () => {
    const { messaging, calls } = fakeMessaging([
      { success: true },
      { success: false, code: "messaging/registration-token-not-registered" },
      { success: false, code: "messaging/internal-error" },
      { success: false, code: "messaging/invalid-argument" },
    ]);
    const res = await new FirebasePushSender(messaging).send(["ok", "gone", "flaky", "bad"], message);
    expect(res.invalidTokens).toEqual(["gone", "bad"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tokens: ["ok", "gone", "flaky", "bad"], notification: { title: "t", body: "b" }, data: { type: "comment" } });
  });

  it("토큰이 없으면 호출하지 않는다", async () => {
    const { messaging, calls } = fakeMessaging([]);
    expect(await new FirebasePushSender(messaging).send([], message)).toEqual({ invalidTokens: [] });
    expect(calls).toHaveLength(0);
  });
});

describe("pushSenderProvider", () => {
  const prev = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  afterEach(() => {
    if (prev === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    else process.env.FIREBASE_SERVICE_ACCOUNT_JSON = prev;
  });

  it("환경변수가 없으면 LogPushSender", async () => {
    delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const factory = (pushSenderProvider as { useFactory: () => unknown }).useFactory;
    expect(factory()).toBeInstanceOf(LogPushSender);
  });

  it("LogPushSender는 보내지 않고 성공으로 끝난다", async () => {
    expect(await new LogPushSender().send(["a", "b"], message)).toEqual({ invalidTokens: [] });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @bandapp/api exec vitest run src/notifications/push-sender.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `push-sender.ts`**

```ts
import { Logger } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { cert, initializeApp } from "firebase-admin/app";
import { getMessaging, type Messaging } from "firebase-admin/messaging";

export const PUSH_SENDER = Symbol("PUSH_SENDER");

export interface PushMessage {
  title: string;
  body: string;
  /** FCM data는 문자열만 허용. notificationId, bandId, sessionId, type, takeId?, atMs? */
  data: Record<string, string>;
}

/** 발송기. 수신자 1명의 토큰 묶음에 메시지 1개를 보낸다. 더 이상 유효하지 않은 토큰을 돌려주면 호출자가 지운다 */
export interface PushSender {
  send(tokens: string[], message: PushMessage): Promise<{ invalidTokens: string[] }>;
}

/** FIREBASE_SERVICE_ACCOUNT_JSON이 없을 때 — 보낼 내용을 로그로만 남긴다. 인박스·배지는 이것과 무관하게 동작한다 */
export class LogPushSender implements PushSender {
  private readonly logger = new Logger(LogPushSender.name);

  async send(tokens: string[], message: PushMessage): Promise<{ invalidTokens: string[] }> {
    this.logger.log(`push skipped (no FIREBASE_SERVICE_ACCOUNT_JSON) → ${tokens.length} device(s): ${message.title} — ${message.body}`);
    return { invalidTokens: [] };
  }
}

/** 테스트가 가짜를 꽂을 수 있게 messaging에서 쓰는 메서드만 적는다 */
export type MessagingLike = Pick<Messaging, "sendEachForMulticast">;

// 이 코드들을 돌려준 토큰은 다시 보내도 영원히 실패한다 — 행을 지운다
const INVALID_TOKEN_CODES = new Set(["messaging/registration-token-not-registered", "messaging/invalid-registration-token", "messaging/invalid-argument"]);

export class FirebasePushSender implements PushSender {
  private readonly logger = new Logger(FirebasePushSender.name);

  constructor(private readonly messaging: MessagingLike) {}

  /** 서비스 계정 JSON(한 줄) → admin app. Apple 키처럼 환경변수 하나로 끝낸다 */
  static fromServiceAccountJson(json: string): FirebasePushSender {
    const app = initializeApp({ credential: cert(JSON.parse(json)) });
    return new FirebasePushSender(getMessaging(app));
  }

  async send(tokens: string[], message: PushMessage): Promise<{ invalidTokens: string[] }> {
    if (tokens.length === 0) return { invalidTokens: [] };
    const res = await this.messaging.sendEachForMulticast({
      tokens,
      notification: { title: message.title, body: message.body },
      data: message.data,
      apns: { payload: { aps: { sound: "default" } } },
      android: { priority: "high" },
    });
    const invalidTokens: string[] = [];
    res.responses.forEach((r, i) => {
      if (r.success) return;
      const code = r.error?.code ?? "unknown";
      if (INVALID_TOKEN_CODES.has(code)) invalidTokens.push(tokens[i]!);
      else this.logger.warn(`push to token #${i} failed: ${code}`);
    });
    return { invalidTokens };
  }
}

export const pushSenderProvider: Provider = {
  provide: PUSH_SENDER,
  useFactory: (): PushSender => {
    const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    return json ? FirebasePushSender.fromServiceAccountJson(json) : new LogPushSender();
  },
};
```

- [ ] **Step 5: Run the spec**

Run: `pnpm --filter @bandapp/api exec vitest run src/notifications/push-sender.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Implement `push-tokens.service.ts`** (covered by e2e in Task 6)

```ts
import type { Provider } from "@nestjs/common";
import { eq, inArray } from "drizzle-orm";
import type { RegisterPushTokenInput } from "@bandapp/types";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { pushTokens } from "../db/schema.js";

export interface PushTokenRow {
  token: string;
  userId: string;
  locale: string;
}

export class PushTokensService {
  constructor(private readonly db: Db) {}

  /** 토큰 PK 충돌 = 같은 기기. 다른 계정이 쓰던 토큰이면 내 것으로 바뀐다 (스펙 API 절) */
  async upsert(userId: string, input: RegisterPushTokenInput): Promise<void> {
    const now = new Date();
    await this.db
      .insert(pushTokens)
      .values({ token: input.token, userId, platform: input.platform, locale: input.locale, lastSeenAt: now })
      .onConflictDoUpdate({ target: pushTokens.token, set: { userId, platform: input.platform, locale: input.locale, lastSeenAt: now } });
  }

  /** 없어도 성공 — 로그아웃 직전에 부르므로 실패로 흐름을 끊지 않는다 */
  async remove(token: string): Promise<void> {
    await this.db.delete(pushTokens).where(eq(pushTokens.token, token));
  }

  async removeMany(tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;
    await this.db.delete(pushTokens).where(inArray(pushTokens.token, tokens));
  }

  async forUsers(userIds: string[]): Promise<PushTokenRow[]> {
    if (userIds.length === 0) return [];
    return this.db.select({ token: pushTokens.token, userId: pushTokens.userId, locale: pushTokens.locale }).from(pushTokens).where(inArray(pushTokens.userId, userIds));
  }
}

export const pushTokensServiceProvider: Provider = {
  provide: PushTokensService,
  useFactory: (db: Db) => new PushTokensService(db),
  inject: [DB],
};
```

- [ ] **Step 7: Typecheck and commit**

Run: `pnpm --filter @bandapp/api exec tsc --noEmit -p tsconfig.json`
Expected: no errors.

```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/src/notifications
git commit -m "feat(api): PushSender (firebase-admin / log fallback) and push token store"
```

---

### Task 5: NotificationsService (create + query) and modules

**Files:**
- Create: `apps/api/src/notifications/notifications.service.ts`
- Create: `apps/api/src/notifications/cursor.ts`, `apps/api/src/notifications/cursor.spec.ts`
- Modify: `apps/api/src/notifications/notifications.module.ts`
- Create: `apps/api/src/notifications/notifications-http.module.ts` (controller added in Task 6)
- Modify: `apps/api/src/app.module.ts` (import `NotificationsHttpModule` instead of `NotificationsModule`)

**Interfaces:**
- Produces `NotificationsService` with:
  - `onCommentCreated(comment: TakeComment): Promise<void>`
  - `onSessionReady(sessionId: string): Promise<void>`
  - `list(bandId, userId, cursor: string | null, limit: number): Promise<NotificationPage>`
  - `unreadCount(bandId, userId): Promise<number>`
  - `markRead(id, userId): Promise<void>` (404 if not mine)
  - `markAllRead(bandId, userId): Promise<void>`
  - `settingsForUser(userId): Promise<NotificationSettings[]>`
  - `updateSettings(bandId, userId, input: UpdateNotificationSettingsInput): Promise<NotificationSettings>`
- Produces `encodeCursor(createdAt: Date, id: string): string`, `decodeCursor(cursor: string): { createdAt: Date; id: string }` (throws `BadRequestException`).
- `NotificationsModule` exports `NotificationsService`, `PushTokensService`.

- [ ] **Step 1: Write `cursor.spec.ts`**

```ts
import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "./cursor.js";

describe("cursor", () => {
  it("왕복", () => {
    const at = new Date("2026-10-12T03:04:05.678Z");
    const c = encodeCursor(at, "0c1a4e9e-0f4d-4f3b-9d1e-2f1a1b2c3d4e");
    expect(c).not.toContain("=");
    expect(decodeCursor(c)).toEqual({ createdAt: at, id: "0c1a4e9e-0f4d-4f3b-9d1e-2f1a1b2c3d4e" });
  });

  it.each(["", "nope", Buffer.from("{}").toString("base64url"), Buffer.from('{"t":"x","id":"y"}').toString("base64url")])("깨진 커서는 400: %s", (c) => {
    expect(() => decodeCursor(c)).toThrow(BadRequestException);
  });
});
```

- [ ] **Step 2: Implement `cursor.ts`**

```ts
import { BadRequestException } from "@nestjs/common";

/** (created_at desc, id desc) 페이지 커서. 불투명 base64url — 클라이언트는 그대로 돌려준다 */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt.toISOString(), id }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { t?: unknown; id?: unknown };
    if (typeof parsed.t !== "string" || typeof parsed.id !== "string") throw new Error("shape");
    const createdAt = new Date(parsed.t);
    if (Number.isNaN(createdAt.getTime())) throw new Error("date");
    return { createdAt, id: parsed.id };
  } catch {
    throw new BadRequestException("cursor is invalid");
  }
}
```

Run: `pnpm --filter @bandapp/api exec vitest run src/notifications/cursor.spec.ts` → PASS.

- [ ] **Step 3: Implement `notifications.service.ts`**

```ts
import { Logger, NotFoundException } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationItem,
  type NotificationPage,
  type NotificationSettings,
  type NotificationType,
  type TakeComment,
  type UpdateNotificationSettingsInput,
} from "@bandapp/types";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { bandMembers, bands, comments, notificationSettings, notifications, sessions, takes, users } from "../db/schema.js";
import { MembershipsService } from "../memberships/memberships.service.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { fanout, type NotificationEvent } from "./fanout.js";
import { PUSH_SENDER, type PushSender } from "./push-sender.js";
import { pushText } from "./push-text.js";
import { PushTokensService } from "./push-tokens.service.js";

const RETENTION_DAYS = 30;

const ITEM_COLUMNS = {
  id: notifications.id,
  type: notifications.type,
  readAt: notifications.readAt,
  createdAt: notifications.createdAt,
  actorId: notifications.actorId,
  actorName: users.displayName,
  sessionId: sessions.id,
  sessionTitle: sessions.title,
  sessionName: sessions.name,
  sessionStartedAt: sessions.startedAt,
  sessionTakeCount: sessions.takeCount,
  sessionDurationMs: sessions.durationMs,
  takeId: takes.id,
  takeIndex: takes.index,
  takeName: takes.name,
  commentId: comments.id,
  commentAtMs: comments.atMs,
  commentText: comments.text,
};
type ItemRow = { [K in keyof typeof ITEM_COLUMNS]: (typeof ITEM_COLUMNS)[K]["_"]["data"] | null } & { id: string; type: NotificationType; createdAt: Date; sessionId: string; sessionTitle: string; sessionStartedAt: Date; sessionTakeCount: number };

function toItem(row: ItemRow): NotificationItem {
  return {
    id: row.id,
    type: row.type,
    actor: row.actorId ? { id: row.actorId, name: row.actorName ?? null } : null,
    session: {
      id: row.sessionId,
      title: row.sessionTitle,
      name: row.sessionName ?? null,
      startedAt: row.sessionStartedAt.toISOString(),
      takeCount: row.sessionTakeCount,
      durationSec: Math.round((row.sessionDurationMs ?? 0) / 1000),
    },
    take: row.takeId && row.takeName !== null && row.takeIndex !== null ? { id: row.takeId, index: row.takeIndex, name: row.takeName } : null,
    comment: row.commentId && row.commentAtMs !== null && row.commentText !== null ? { id: row.commentId, atSec: row.commentAtMs / 1000, text: row.commentText } : null,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly db: Db,
    private readonly memberships: MembershipsService,
    private readonly tokens: PushTokensService,
    private readonly push: PushSender,
  ) {}

  // ---- 생성 (이벤트 지점에서 호출. 실패는 로그만 — 코멘트/세션은 이미 저장됐다) ----

  async onCommentCreated(comment: TakeComment): Promise<void> {
    try {
      const [session] = await this.db.select({ bandId: sessions.bandId }).from(sessions).where(eq(sessions.id, comment.sessionId));
      if (!session) return;
      let parentAuthorId: string | null = null;
      if (comment.parentId) {
        const [parent] = await this.db.select({ authorId: comments.authorId }).from(comments).where(eq(comments.id, comment.parentId));
        parentAuthorId = parent?.authorId ?? null;
      }
      await this.dispatch({ kind: "comment", bandId: session.bandId, sessionId: comment.sessionId, actorId: comment.authorId, commentId: comment.id, takeId: comment.takeId, parentAuthorId });
    } catch (err) {
      this.logger.error(`comment ${comment.id}: notification failed: ${String(err)}`);
    }
  }

  async onSessionReady(sessionId: string): Promise<void> {
    try {
      const [session] = await this.db.select({ bandId: sessions.bandId, createdBy: sessions.createdBy }).from(sessions).where(eq(sessions.id, sessionId));
      if (!session) return;
      await this.dispatch({ kind: "session_ready", bandId: session.bandId, sessionId, actorId: session.createdBy });
    } catch (err) {
      this.logger.error(`session ${sessionId}: notification failed: ${String(err)}`);
    }
  }

  /** 수신자 계산 → 행 insert → 푸시. 나중에 아웃박스로 옮길 수 있게 생성과 발송을 나눈다 (스펙 결정 5) */
  private async dispatch(event: NotificationEvent): Promise<void> {
    const memberIds = (await this.db.select({ userId: bandMembers.userId }).from(bandMembers).where(eq(bandMembers.bandId, event.bandId))).map((m) => m.userId);
    if (memberIds.length === 0) return;
    const settingRows = await this.db
      .select({ userId: notificationSettings.userId, sessionReady: notificationSettings.sessionReady, comments: notificationSettings.comments, commentScope: notificationSettings.commentScope })
      .from(notificationSettings)
      .where(and(eq(notificationSettings.bandId, event.bandId), inArray(notificationSettings.userId, memberIds)));
    const settings = new Map<string, UpdateNotificationSettingsInput>(settingRows.map((r) => [r.userId, { sessionReady: r.sessionReady, comments: r.comments, commentScope: r.commentScope }]));
    const recipients = fanout(event, memberIds, settings);
    if (recipients.length === 0) return;
    const inserted = await this.db
      .insert(notifications)
      .values(
        recipients.map((r) => ({
          userId: r.userId,
          bandId: event.bandId,
          type: r.type,
          actorId: event.actorId,
          sessionId: event.sessionId,
          takeId: event.kind === "comment" ? event.takeId : null,
          commentId: event.kind === "comment" ? event.commentId : null,
        })),
      )
      .returning({ id: notifications.id, userId: notifications.userId, type: notifications.type });
    await this.sendPush(event, inserted);
  }

  private async sendPush(event: NotificationEvent, created: Array<{ id: string; userId: string; type: NotificationType }>): Promise<void> {
    const tokenRows = await this.tokens.forUsers(created.map((c) => c.userId));
    if (tokenRows.length === 0) return;
    const [actor] = await this.db.select({ name: users.displayName }).from(users).where(eq(users.id, event.actorId));
    const [session] = await this.db.select({ title: sessions.title, name: sessions.name, takeCount: sessions.takeCount }).from(sessions).where(eq(sessions.id, event.sessionId));
    if (!session) return;
    const takeId = event.kind === "comment" ? event.takeId : null;
    const take = takeId ? (await this.db.select({ name: takes.name }).from(takes).where(eq(takes.id, takeId)))[0] : undefined;
    const comment = event.kind === "comment" ? (await this.db.select({ text: comments.text, atMs: comments.atMs }).from(comments).where(eq(comments.id, event.commentId)))[0] : undefined;
    const invalid: string[] = [];
    for (const n of created) {
      const mine = tokenRows.filter((t) => t.userId === n.userId);
      if (mine.length === 0) continue;
      const data: Record<string, string> = { notificationId: n.id, bandId: event.bandId, sessionId: event.sessionId, type: n.type };
      if (takeId) data.takeId = takeId;
      if (comment) data.atMs = String(comment.atMs);
      // 같은 사용자의 기기가 언어가 다를 수 있어 locale별로 문구를 만든다
      const byLocale = new Map<string, string[]>();
      for (const t of mine) byLocale.set(t.locale, [...(byLocale.get(t.locale) ?? []), t.token]);
      for (const [locale, tokens] of byLocale) {
        const text = pushText(locale, {
          type: n.type,
          actorName: actor ? (actor.name ?? "") : null,
          isSelf: n.userId === event.actorId,
          sessionLabel: session.name ?? session.title,
          takeCount: session.takeCount,
          takeName: take?.name ?? null,
          commentText: comment?.text ?? null,
        });
        try {
          const res = await this.push.send(tokens, { ...text, data });
          invalid.push(...res.invalidTokens);
        } catch (err) {
          this.logger.warn(`push to user ${n.userId} failed: ${String(err)}`);
        }
      }
    }
    if (invalid.length > 0) await this.tokens.removeMany(invalid);
  }

  // ---- 조회 ----

  async list(bandId: string, userId: string, cursor: string | null, limit: number): Promise<NotificationPage> {
    await this.memberships.assertMember(bandId, userId);
    // 30일 보존 — 크론 대신 조회 때 내 오래된 행을 지운다 (스펙 결정 9)
    await this.db.delete(notifications).where(and(eq(notifications.userId, userId), lt(notifications.createdAt, sql`now() - interval '${sql.raw(String(RETENTION_DAYS))} days'`)));
    const after = cursor ? decodeCursor(cursor) : null;
    const scope = and(eq(notifications.userId, userId), eq(notifications.bandId, bandId));
    const where = after ? and(scope, or(lt(notifications.createdAt, after.createdAt), and(eq(notifications.createdAt, after.createdAt), lt(notifications.id, after.id)))) : scope;
    const rows = await this.db
      .select(ITEM_COLUMNS)
      .from(notifications)
      .innerJoin(sessions, eq(sessions.id, notifications.sessionId))
      .leftJoin(users, eq(users.id, notifications.actorId))
      .leftJoin(takes, eq(takes.id, notifications.takeId))
      .leftJoin(comments, eq(comments.id, notifications.commentId))
      .where(where)
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const hasMore = rows.length > limit && last !== undefined;
    let remaining = 0;
    if (hasMore && last) {
      const [r] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(notifications)
        .where(and(scope, or(lt(notifications.createdAt, last.createdAt), and(eq(notifications.createdAt, last.createdAt), lt(notifications.id, last.id)))));
      remaining = r?.n ?? 0;
    }
    return {
      items: page.map((row) => toItem(row as ItemRow)),
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
      remaining,
      unreadCount: await this.countUnread(bandId, userId),
    };
  }

  async unreadCount(bandId: string, userId: string): Promise<number> {
    await this.memberships.assertMember(bandId, userId);
    return this.countUnread(bandId, userId);
  }

  private async countUnread(bandId: string, userId: string): Promise<number> {
    const [r] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.bandId, bandId), isNull(notifications.readAt), sql`${notifications.createdAt} >= now() - interval '${sql.raw(String(RETENTION_DAYS))} days'`));
    return r?.n ?? 0;
  }

  /** 내 알림만. 이미 읽었어도 성공 */
  async markRead(id: string, userId: string): Promise<void> {
    const updated = await this.db
      .update(notifications)
      .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
      .returning({ id: notifications.id });
    if (updated.length === 0) throw new NotFoundException("알림을 찾을 수 없어요.");
  }

  async markAllRead(bandId: string, userId: string): Promise<void> {
    await this.memberships.assertMember(bandId, userId);
    await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, userId), eq(notifications.bandId, bandId), isNull(notifications.readAt)));
  }

  // ---- 설정 ----

  /** 내 모든 밴드(삭제된 밴드 제외). 행이 없는 밴드는 기본값으로 채운다 */
  async settingsForUser(userId: string): Promise<NotificationSettings[]> {
    const rows = await this.db
      .select({ bandId: bandMembers.bandId, sessionReady: notificationSettings.sessionReady, comments: notificationSettings.comments, commentScope: notificationSettings.commentScope })
      .from(bandMembers)
      .innerJoin(bands, eq(bands.id, bandMembers.bandId))
      .leftJoin(notificationSettings, and(eq(notificationSettings.bandId, bandMembers.bandId), eq(notificationSettings.userId, userId)))
      .where(and(eq(bandMembers.userId, userId), isNull(bands.deletedAt)))
      .orderBy(asc(bands.createdAt));
    return rows.map((r) => ({
      bandId: r.bandId,
      sessionReady: r.sessionReady ?? DEFAULT_NOTIFICATION_SETTINGS.sessionReady,
      comments: r.comments ?? DEFAULT_NOTIFICATION_SETTINGS.comments,
      commentScope: r.commentScope ?? DEFAULT_NOTIFICATION_SETTINGS.commentScope,
    }));
  }

  async updateSettings(bandId: string, userId: string, input: UpdateNotificationSettingsInput): Promise<NotificationSettings> {
    await this.memberships.assertMember(bandId, userId);
    await this.db
      .insert(notificationSettings)
      .values({ userId, bandId, ...input, updatedAt: new Date() })
      .onConflictDoUpdate({ target: [notificationSettings.userId, notificationSettings.bandId], set: { ...input, updatedAt: new Date() } });
    return { bandId, ...input };
  }
}

export const notificationsServiceProvider: Provider = {
  provide: NotificationsService,
  useFactory: (db: Db, memberships: MembershipsService, tokens: PushTokensService, push: PushSender) => new NotificationsService(db, memberships, tokens, push),
  inject: [DB, MembershipsService, PushTokensService, PUSH_SENDER],
};
```

Note on `ItemRow`: if the mapped type above fights the compiler, replace it with an explicit interface listing each column's TS type (`actorId: string | null`, `actorName: string | null`, `sessionName: string | null`, `sessionDurationMs: number | null`, `takeId: string | null`, `takeIndex: number | null`, `takeName: string | null`, `commentId: string | null`, `commentAtMs: number | null`, `commentText: string | null`, `readAt: Date | null`, plus the non-null ones). The behavior is what matters.

- [ ] **Step 4: Modules**

`notifications.module.ts`:
```ts
import { Module } from "@nestjs/common";
import { DbModule } from "../db/db.module.js";
import { MembershipsModule } from "../memberships/memberships.module.js";
import { notificationsServiceProvider, NotificationsService } from "./notifications.service.js";
import { pushSenderProvider } from "./push-sender.js";
import { pushTokensServiceProvider, PushTokensService } from "./push-tokens.service.js";

/** 서비스만 — API와 워커가 둘 다 import한다. 컨트롤러는 NotificationsHttpModule */
@Module({
  imports: [DbModule, MembershipsModule],
  providers: [pushSenderProvider, pushTokensServiceProvider, notificationsServiceProvider],
  exports: [NotificationsService, PushTokensService],
})
export class NotificationsModule {}
```

`notifications-http.module.ts` (controllers array filled in Task 6):
```ts
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { NotificationsModule } from "./notifications.module.js";

@Module({
  imports: [NotificationsModule, AuthModule],
  controllers: [],
})
export class NotificationsHttpModule {}
```

In `app.module.ts` replace the `NotificationsModule` import/entry with `NotificationsHttpModule` from `./notifications/notifications-http.module.js`.

- [ ] **Step 5: Typecheck + run existing e2e smoke (app boots)**

Run: `pnpm --filter @bandapp/api exec tsc --noEmit -p tsconfig.json && pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/app.e2e-spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): NotificationsService — fan-out insert, push, inbox queries, settings"
```

---

### Task 6: HTTP endpoints + e2e (inbox, settings, push tokens) and comment wiring

**Files:**
- Create: `apps/api/src/notifications/notifications.controller.ts`
- Modify: `apps/api/src/notifications/notifications-http.module.ts`
- Modify: `apps/api/src/common/validation.ts`, `apps/api/src/common/validation.spec.ts` (add `requireBoolean`)
- Modify: `apps/api/src/comments/comments.service.ts`, `apps/api/src/comments/comments.module.ts` (call `onCommentCreated`)
- Modify: `apps/api/test/app-util.ts` (`FakePushSender`, `pushSender` override)
- Create: `apps/api/test/notifications.e2e-spec.ts`

**Interfaces:**
- Routes per spec API table. `GET /bands/:id/notifications` accepts `?cursor=&limit=` (default `NOTIFICATIONS_PAGE_SIZE`, max `NOTIFICATIONS_PAGE_MAX`).
- `FakePushSender { sent: Array<{ tokens: string[]; message: PushMessage }>; invalid: string[] }`.

- [ ] **Step 1: `requireBoolean` with unit test**

Append to `validation.spec.ts` (follow the file's existing describe style):
```ts
describe("requireBoolean", () => {
  it("true/false만 받는다", () => {
    expect(requireBoolean({ a: true }, "a")).toBe(true);
    expect(requireBoolean({ a: false }, "a")).toBe(false);
    for (const v of ["true", 1, null, undefined]) expect(() => requireBoolean({ a: v }, "a")).toThrow(BadRequestException);
  });
});
```
Implement in `validation.ts` (uses the file's private `field()` helper like `requireOneOf`):
```ts
export function requireBoolean(body: unknown, name: string): boolean {
  const value = field(body, name);
  if (typeof value !== "boolean") throw new BadRequestException(`${name} must be a boolean`);
  return value;
}
```
Run: `pnpm --filter @bandapp/api exec vitest run src/common/validation.spec.ts` → PASS.

- [ ] **Step 2: Test utilities** — in `test/app-util.ts` add

```ts
import { PUSH_SENDER, type PushMessage, type PushSender } from "../src/notifications/push-sender.js";

/** 보낸 푸시를 기록만 한다. invalid에 넣은 토큰은 서버가 지워야 한다 */
export class FakePushSender implements PushSender {
  sent: Array<{ tokens: string[]; message: PushMessage }> = [];
  invalid: string[] = [];
  async send(tokens: string[], message: PushMessage) {
    this.sent.push({ tokens, message });
    return { invalidTokens: tokens.filter((t) => this.invalid.includes(t)) };
  }
}
```
add `pushSender?: FakePushSender;` to the `createTestApp` overrides type and chain `.overrideProvider(PUSH_SENDER).useValue(overrides?.pushSender ?? new FakePushSender())` after the RevenueCat override (always override — never hit Firebase from tests).

- [ ] **Step 3: Write `test/notifications.e2e-spec.ts`**

```ts
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bandMembers, notifications, pushTokens, sessions, takes } from "../src/db/schema.js";
import { FakePushSender, FakeStorage, createTestApp, loginAs, providerUser } from "./app-util.js";
import { createTestDb, truncateAll } from "./db-util.js";

describe("notifications API", () => {
  const db = createTestDb();
  let app: INestApplication;
  let push: FakePushSender;
  let owner: { accessToken: string; userId: string };
  let minsu: { accessToken: string; userId: string };
  let bandId: string;
  let sessionId: string;
  let takeId: string;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const server = () => app.getHttpServer();

  async function memberOf(id: string, name: string) {
    const other = await createTestApp({ google: providerUser(id, name), storage: new FakeStorage() });
    const login = await loginAs(other);
    await other.close();
    await db.insert(bandMembers).values({ bandId, userId: login.userId, role: "member" });
    return login;
  }

  beforeEach(async () => {
    await truncateAll(db);
    push = new FakePushSender();
    app = await createTestApp({ google: providerUser("owner-1"), storage: new FakeStorage(), pushSender: push });
    owner = await loginAs(app);
    const band = await request(server()).post("/bands").set(auth(owner.accessToken)).send({ name: "FRIDAY NIGHT" }).expect(201);
    bandId = band.body.id;
    minsu = await memberOf("minsu", "Minsu");
    const [s] = await db
      .insert(sessions)
      .values({ bandId, createdBy: owner.userId, title: "Aug 28 Rehearsal", name: "Full set run-through", status: "ready", startedAt: new Date("2026-08-28T10:30:00Z"), durationMs: 8_040_000, takeCount: 1 })
      .returning();
    sessionId = s!.id;
    const [t] = await db.insert(takes).values({ sessionId, index: 0, name: "Take 1", startMs: 0, endMs: 240_000, type: "PERFORMANCE", confidence: 0.9, objectKey: "k" }).returning();
    takeId = t!.id;
  });
  afterEach(() => app.close());

  describe("코멘트 → 인박스", () => {
    it("작성자를 뺀 멤버에게 comment 행이 생기고 구조화된 항목으로 조회된다", async () => {
      const c = await request(server()).post(`/takes/${takeId}/comments`).set(auth(minsu.accessToken)).send({ atSec: 133, text: "Rushing going into the chorus" }).expect(201);
      const mine = await request(server()).get(`/bands/${bandId}/notifications`).set(auth(owner.accessToken)).expect(200);
      expect(mine.body).toEqual({
        items: [
          {
            id: expect.any(String),
            type: "comment",
            actor: { id: minsu.userId, name: "Minsu" },
            session: { id: sessionId, title: "Aug 28 Rehearsal", name: "Full set run-through", startedAt: "2026-08-28T10:30:00.000Z", takeCount: 1, durationSec: 8040 },
            take: { id: takeId, index: 0, name: "Take 1" },
            comment: { id: c.body.id, atSec: 133, text: "Rushing going into the chorus" },
            readAt: null,
            createdAt: expect.any(String),
          },
        ],
        nextCursor: null,
        remaining: 0,
        unreadCount: 1,
      });
      const theirs = await request(server()).get(`/bands/${bandId}/notifications`).set(auth(minsu.accessToken)).expect(200);
      expect(theirs.body.items).toEqual([]);
      const count = await request(server()).get(`/bands/${bandId}/notifications/unread-count`).set(auth(owner.accessToken)).expect(200);
      expect(count.body).toEqual({ count: 1 });
    });

    it("답글은 부모 작성자에게 reply, 제3자에게 comment; 원본 녹음 코멘트는 take가 null", async () => {
      const jihoon = await memberOf("jihoon", "Jihoon");
      const parent = await request(server()).post(`/sessions/${sessionId}/comments`).set(auth(owner.accessToken)).send({ atSec: 5, text: "orig" }).expect(201);
      await request(server()).post(`/sessions/${sessionId}/comments`).set(auth(minsu.accessToken)).send({ parentId: parent.body.id, text: "yes" }).expect(201);
      const ownerInbox = await request(server()).get(`/bands/${bandId}/notifications`).set(auth(owner.accessToken)).expect(200);
      expect(ownerInbox.body.items[0]).toMatchObject({ type: "reply", take: null, comment: { text: "yes" } });
      const jihoonInbox = await request(server()).get(`/bands/${bandId}/notifications`).set(auth(jihoon.accessToken)).expect(200);
      // jihoon은 owner의 원본 코멘트(comment)와 minsu의 답글(comment) 둘
      expect(jihoonInbox.body.items.map((i: { type: string }) => i.type)).toEqual(["comment", "comment"]);
    });

    it("설정이 off면 행이 생기지 않고, scope=mine은 reply만 받는다", async () => {
      await request(server()).put(`/bands/${bandId}/notification-settings`).set(auth(owner.accessToken)).send({ sessionReady: true, comments: true, commentScope: "mine" }).expect(200);
      const jihoon = await memberOf("jihoon", "Jihoon");
      await request(server()).put(`/bands/${bandId}/notification-settings`).set(auth(jihoon.accessToken)).send({ sessionReady: true, comments: false, commentScope: "all" }).expect(200);
      const parent = await request(server()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ atSec: 1, text: "mine" }).expect(201);
      await request(server()).post(`/takes/${takeId}/comments`).set(auth(minsu.accessToken)).send({ atSec: 2, text: "top" }).expect(201);
      await request(server()).post(`/takes/${takeId}/comments`).set(auth(minsu.accessToken)).send({ parentId: parent.body.id, text: "reply" }).expect(201);
      const ownerInbox = await request(server()).get(`/bands/${bandId}/notifications`).set(auth(owner.accessToken)).expect(200);
      expect(ownerInbox.body.items.map((i: { type: string; comment: { text: string } }) => [i.type, i.comment.text])).toEqual([["reply", "reply"]]);
      const jihoonInbox = await request(server()).get(`/bands/${bandId}/notifications`).set(auth(jihoon.accessToken)).expect(200);
      expect(jihoonInbox.body.items).toEqual([]);
    });

    it("코멘트를 지우면 알림도 사라진다 (cascade)", async () => {
      const c = await request(server()).post(`/takes/${takeId}/comments`).set(auth(minsu.accessToken)).send({ atSec: 1, text: "x" }).expect(201);
      await request(server()).delete(`/comments/${c.body.id}`).set(auth(minsu.accessToken)).expect(204);
      const inbox = await request(server()).get(`/bands/${bandId}/notifications`).set(auth(owner.accessToken)).expect(200);
      expect(inbox.body.items).toEqual([]);
    });
  });

  describe("읽음·페이지", () => {
    async function seed(n: number) {
      // 같은 트랜잭션 insert처럼 created_at이 겹치는 상황도 섞는다
      const now = new Date();
      await db.insert(notifications).values(
        Array.from({ length: n }, (_, i) => ({
          userId: owner.userId,
          bandId,
          type: "comment" as const,
          actorId: minsu.userId,
          sessionId,
          takeId,
          createdAt: new Date(now.getTime() - Math.floor(i / 2) * 1000),
        })),
      );
    }

    it("read → unreadCount 감소, 남의 알림 read는 404, read-all", async () => {
      await seed(3);
      const page = await request(server()).get(`/bands/${bandId}/notifications`).set(auth(owner.accessToken)).expect(200);
      expect(page.body.unreadCount).toBe(3);
      await request(server()).post(`/notifications/${page.body.items[0].id}/read`).set(auth(owner.accessToken)).expect(204);
      await request(server()).post(`/notifications/${page.body.items[0].id}/read`).set(auth(owner.accessToken)).expect(204); // 두 번도 204
      await request(server()).post(`/notifications/${page.body.items[1].id}/read`).set(auth(minsu.accessToken)).expect(404);
      let count = await request(server()).get(`/bands/${bandId}/notifications/unread-count`).set(auth(owner.accessToken)).expect(200);
      expect(count.body.count).toBe(2);
      await request(server()).post(`/bands/${bandId}/notifications/read-all`).set(auth(owner.accessToken)).expect(204);
      count = await request(server()).get(`/bands/${bandId}/notifications/unread-count`).set(auth(owner.accessToken)).expect(200);
      expect(count.body.count).toBe(0);
    });

    it("같은 시각에 만들어진 알림도 커서가 건너뛰지 않는다 (limit 기본 6, remaining)", async () => {
      await seed(15);
      const seen: string[] = [];
      let cursor: string | null = null;
      let remainingSeq: number[] = [];
      do {
        const res = await request(server()).get(`/bands/${bandId}/notifications`).query(cursor ? { cursor } : {}).set(auth(owner.accessToken)).expect(200);
        expect(res.body.items.length).toBeLessThanOrEqual(6);
        seen.push(...res.body.items.map((i: { id: string }) => i.id));
        remainingSeq.push(res.body.remaining);
        cursor = res.body.nextCursor;
      } while (cursor);
      expect(new Set(seen).size).toBe(15);
      expect(remainingSeq).toEqual([9, 3, 0]);
    });

    it("limit은 1~50, 깨진 커서는 400, 30일 지난 행은 지워진다", async () => {
      await request(server()).get(`/bands/${bandId}/notifications`).query({ limit: 0 }).set(auth(owner.accessToken)).expect(400);
      await request(server()).get(`/bands/${bandId}/notifications`).query({ limit: 51 }).set(auth(owner.accessToken)).expect(400);
      await request(server()).get(`/bands/${bandId}/notifications`).query({ cursor: "nope" }).set(auth(owner.accessToken)).expect(400);
      await db.insert(notifications).values({ userId: owner.userId, bandId, type: "comment", actorId: minsu.userId, sessionId, takeId, createdAt: new Date(Date.now() - 31 * 24 * 3600 * 1000) });
      const res = await request(server()).get(`/bands/${bandId}/notifications`).set(auth(owner.accessToken)).expect(200);
      expect(res.body.items).toEqual([]);
      expect(await db.select().from(notifications).where(eq(notifications.userId, owner.userId))).toEqual([]);
    });

    it("비멤버는 403", async () => {
      const stranger = await createTestApp({ google: providerUser("stranger"), storage: new FakeStorage() });
      const s = await loginAs(stranger);
      await stranger.close();
      await request(server()).get(`/bands/${bandId}/notifications`).set(auth(s.accessToken)).expect(403);
      await request(server()).post(`/bands/${bandId}/notifications/read-all`).set(auth(s.accessToken)).expect(403);
      await request(server()).put(`/bands/${bandId}/notification-settings`).set(auth(s.accessToken)).send({ sessionReady: true, comments: true, commentScope: "all" }).expect(403);
    });
  });

  describe("설정", () => {
    it("GET은 모든 밴드를 기본값으로 채워 주고 PUT 뒤 반영되며, 밴드를 나가면 설정이 사라진다", async () => {
      let res = await request(server()).get("/me/notification-settings").set(auth(minsu.accessToken)).expect(200);
      expect(res.body).toEqual([{ bandId, sessionReady: true, comments: true, commentScope: "all" }]);
      const put = await request(server()).put(`/bands/${bandId}/notification-settings`).set(auth(minsu.accessToken)).send({ sessionReady: false, comments: true, commentScope: "mine" }).expect(200);
      expect(put.body).toEqual({ bandId, sessionReady: false, comments: true, commentScope: "mine" });
      res = await request(server()).get("/me/notification-settings").set(auth(minsu.accessToken)).expect(200);
      expect(res.body).toEqual([{ bandId, sessionReady: false, comments: true, commentScope: "mine" }]);
      await request(server()).delete(`/bands/${bandId}/members/me`).set(auth(minsu.accessToken)).expect(204);
      res = await request(server()).get("/me/notification-settings").set(auth(minsu.accessToken)).expect(200);
      expect(res.body).toEqual([]);
    });

    it.each([
      { sessionReady: true, comments: true },
      { sessionReady: "yes", comments: true, commentScope: "all" },
      { sessionReady: true, comments: true, commentScope: "everyone" },
    ])("잘못된 입력은 400: %o", async (body) => {
      await request(server()).put(`/bands/${bandId}/notification-settings`).set(auth(owner.accessToken)).send(body).expect(400);
    });
  });

  describe("푸시 토큰", () => {
    it("upsert·다른 계정 덮어쓰기·삭제", async () => {
      await request(server()).put("/me/push-tokens").set(auth(owner.accessToken)).send({ token: "tok-1", platform: "ios", locale: "ko-KR" }).expect(204);
      await request(server()).put("/me/push-tokens").set(auth(owner.accessToken)).send({ token: "tok-1", platform: "ios", locale: "en" }).expect(204);
      let rows = await db.select().from(pushTokens);
      expect(rows).toEqual([expect.objectContaining({ token: "tok-1", userId: owner.userId, locale: "en" })]);
      await request(server()).put("/me/push-tokens").set(auth(minsu.accessToken)).send({ token: "tok-1", platform: "ios", locale: "en" }).expect(204);
      rows = await db.select().from(pushTokens);
      expect(rows[0]!.userId).toBe(minsu.userId);
      await request(server()).delete("/me/push-tokens/tok-1").set(auth(owner.accessToken)).expect(204); // 내 토큰이 아니어도 204
      await request(server()).delete("/me/push-tokens/tok-1").set(auth(minsu.accessToken)).expect(204);
      expect(await db.select().from(pushTokens)).toEqual([]);
    });

    it.each([{ platform: "ios", locale: "en" }, { token: "t", platform: "web", locale: "en" }, { token: "t", platform: "ios" }])("잘못된 입력은 400: %o", async (body) => {
      await request(server()).put("/me/push-tokens").set(auth(owner.accessToken)).send(body).expect(400);
    });

    it("코멘트가 달리면 수신자 토큰으로 locale별 문구가 가고, unregistered 토큰은 지워진다", async () => {
      await request(server()).put("/me/push-tokens").set(auth(owner.accessToken)).send({ token: "ko-dev", platform: "ios", locale: "ko-KR" }).expect(204);
      await request(server()).put("/me/push-tokens").set(auth(owner.accessToken)).send({ token: "en-dev", platform: "android", locale: "en-US" }).expect(204);
      await request(server()).put("/me/push-tokens").set(auth(minsu.accessToken)).send({ token: "minsu-dev", platform: "ios", locale: "en" }).expect(204);
      push.invalid = ["en-dev"];
      await request(server()).post(`/takes/${takeId}/comments`).set(auth(minsu.accessToken)).send({ atSec: 133, text: "Rushing" }).expect(201);
      // 작성자(minsu)에게는 안 간다
      expect(push.sent.flatMap((s) => s.tokens).sort()).toEqual(["en-dev", "ko-dev"]);
      const ko = push.sent.find((s) => s.tokens.includes("ko-dev"))!;
      expect(ko.message.title).toBe("Minsu님이 Take 1에 코멘트를 남겼어요");
      expect(ko.message.data).toEqual({ notificationId: expect.any(String), bandId, sessionId, type: "comment", takeId, atMs: "133000" });
      const en = push.sent.find((s) => s.tokens.includes("en-dev"))!;
      expect(en.message.title).toBe("Minsu commented on Take 1");
      const rows = await db.select({ token: pushTokens.token }).from(pushTokens);
      expect(rows.map((r) => r.token).sort()).toEqual(["ko-dev", "minsu-dev"]);
    });
  });
});
```

- [ ] **Step 4: Run to verify they fail**

Run: `pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/notifications.e2e-spec.ts`
Expected: FAIL (404s — no controller yet).

- [ ] **Step 5: Controller** — `notifications.controller.ts`

```ts
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { NOTIFICATIONS_PAGE_MAX, NOTIFICATIONS_PAGE_SIZE, type NotificationPage, type NotificationSettings, type RegisterPushTokenInput, type UpdateNotificationSettingsInput } from "@bandapp/types";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUserId } from "../auth/current-user-id.decorator.js";
import { requireBoolean, requireOneOf, requireString, requireUuidParam } from "../common/validation.js";
import { NotificationsService } from "./notifications.service.js";
import { PushTokensService } from "./push-tokens.service.js";

const TOKEN_MAX = 4096;
const LOCALE_MAX = 35; // BCP 47 최대 길이

function parseSettings(body: unknown): UpdateNotificationSettingsInput {
  return {
    sessionReady: requireBoolean(body, "sessionReady"),
    comments: requireBoolean(body, "comments"),
    commentScope: requireOneOf(body, "commentScope", ["all", "mine"] as const),
  };
}

function parsePushToken(body: unknown): RegisterPushTokenInput {
  const token = requireString(body, "token");
  if (token.length > TOKEN_MAX) throw new BadRequestException(`token must be at most ${TOKEN_MAX} characters`);
  const locale = requireString(body, "locale");
  if (locale.length > LOCALE_MAX) throw new BadRequestException(`locale must be at most ${LOCALE_MAX} characters`);
  return { token, platform: requireOneOf(body, "platform", ["ios", "android"] as const), locale };
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return NOTIFICATIONS_PAGE_SIZE;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > NOTIFICATIONS_PAGE_MAX) throw new BadRequestException(`limit must be 1-${NOTIFICATIONS_PAGE_MAX}`);
  return n;
}

@Controller()
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly tokens: PushTokensService,
  ) {}

  @Get("bands/:id/notifications")
  list(@CurrentUserId() userId: string, @Param("id") bandId: string, @Query("cursor") cursor?: string, @Query("limit") limit?: string): Promise<NotificationPage> {
    requireUuidParam(bandId, "id");
    return this.notifications.list(bandId, userId, cursor ?? null, parseLimit(limit));
  }

  @Get("bands/:id/notifications/unread-count")
  async unreadCount(@CurrentUserId() userId: string, @Param("id") bandId: string): Promise<{ count: number }> {
    requireUuidParam(bandId, "id");
    return { count: await this.notifications.unreadCount(bandId, userId) };
  }

  @Post("notifications/:id/read")
  @HttpCode(204)
  async markRead(@CurrentUserId() userId: string, @Param("id") id: string): Promise<void> {
    requireUuidParam(id, "id");
    await this.notifications.markRead(id, userId);
  }

  @Post("bands/:id/notifications/read-all")
  @HttpCode(204)
  async markAllRead(@CurrentUserId() userId: string, @Param("id") bandId: string): Promise<void> {
    requireUuidParam(bandId, "id");
    await this.notifications.markAllRead(bandId, userId);
  }

  /** 내 모든 밴드 — Me 행 요약과 설정 화면이 한 번에 쓴다 */
  @Get("me/notification-settings")
  settings(@CurrentUserId() userId: string): Promise<NotificationSettings[]> {
    return this.notifications.settingsForUser(userId);
  }

  @Put("bands/:id/notification-settings")
  updateSettings(@CurrentUserId() userId: string, @Param("id") bandId: string, @Body() body: unknown): Promise<NotificationSettings> {
    requireUuidParam(bandId, "id");
    return this.notifications.updateSettings(bandId, userId, parseSettings(body));
  }

  @Put("me/push-tokens")
  @HttpCode(204)
  async registerToken(@CurrentUserId() userId: string, @Body() body: unknown): Promise<void> {
    await this.tokens.upsert(userId, parsePushToken(body));
  }

  /** 로그아웃·탈퇴 직전. 내 토큰이 아니어도 204 */
  @Delete("me/push-tokens/:token")
  @HttpCode(204)
  async removeToken(@Param("token") token: string): Promise<void> {
    await this.tokens.remove(token);
  }
}
```

Register it: `controllers: [NotificationsController]` in `notifications-http.module.ts` (import from `./notifications.controller.js`).

Route-order note: `GET bands/:id/notifications/unread-count` is a distinct static segment so Nest matches it before `bands/:id/notifications`; `me/...` routes live here and not in `MeController` to keep `MeController` free of notification deps — `/me` prefix conflicts are fine because paths are full matches.

- [ ] **Step 6: Wire `CommentsService.create` to notifications**

`comments.module.ts`: add `NotificationsModule` to `imports`.
`comments.service.ts`: import `NotificationsService` from `../notifications/notifications.service.js`; add constructor param `private readonly notifications: NotificationsService` (last) and update `commentsServiceProvider` (`inject: [DB, TakesService, SessionsService, NotificationsService]`). In `create`, replace the final `return this.getOne(inserted.id);` with:
```ts
    const created = await this.getOne(inserted.id);
    // 알림은 보조 — 실패해도 코멘트는 저장됐다 (서비스 안에서 삼킨다)
    await this.notifications.onCommentCreated(created);
    return created;
```

- [ ] **Step 7: Run all e2e + unit, fix until green**

Run: `pnpm --filter @bandapp/api exec tsc --noEmit -p tsconfig.json && pnpm --filter @bandapp/api test`
Expected: PASS. (Leaving a band is `DELETE /bands/:bandId/members/me` in `bands.controller.ts`.)

- [ ] **Step 8: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat(api): notification endpoints, settings, push tokens; comments emit notifications"
```

---

### Task 7: Worker — notify on session ready

**Files:**
- Modify: `apps/api/src/worker/session-analysis.service.ts`, `apps/api/src/worker/session-analysis.service.spec.ts`
- Modify: `apps/api/src/worker/worker.module.ts`

**Interfaces:**
- Produces `SessionReadyHook { onSessionReady(sessionId: string): Promise<void> }`; `SessionAnalysisService` gains an optional 8th constructor param `readyHook: SessionReadyHook` (default no-op). `NotificationsService` satisfies the interface structurally.

- [ ] **Step 1: Write failing specs** (append to `session-analysis.service.spec.ts`; reuse the file's existing `fakeDb`/`fakeStorage`/`fakeGemini`/`fakeFfmpeg`/`fakeCharges` helpers exactly as the neighbouring "ready" test does — copy the setup lines of the test at line ~144)

```ts
  describe("session ready 알림 (2026-10-12)", () => {
    const gemini = { analyzeFile: async () => [] } as unknown as GeminiService;
    function hook(fail = false) {
      const calls: string[] = [];
      return { calls, hook: { onSessionReady: async (id: string) => { calls.push(id); if (fail) throw new Error("boom"); } } };
    }

    it("ready 커밋 뒤 onSessionReady를 한 번 부른다", async () => {
      const { db, state } = fakeDb({ id: "s", bandId: "b", status: "analyzing" });
      const { storage } = fakeStorage();
      const { ffmpeg } = fakeFfmpeg(90 * MIN + 500);
      const { charges } = fakeCharges();
      const h = hook();
      await new SessionAnalysisService(db, storage, gemini, ffmpeg, charges, tmp, 0, h.hook).run("s");
      expect(state.updates.at(-1)).toMatchObject({ status: "ready" });
      expect(h.calls).toEqual(["s"]);
    });

    it("다른 워커가 먼저 끝냈으면(StaleSessionError) 부르지 않는다", async () => {
      const { db } = fakeDb({ id: "s", bandId: "b", status: "analyzing" }, undefined, { staleOnReady: true });
      const { storage } = fakeStorage();
      const { ffmpeg } = fakeFfmpeg(90 * MIN + 500);
      const { charges } = fakeCharges();
      const h = hook();
      await new SessionAnalysisService(db, storage, gemini, ffmpeg, charges, tmp, 0, h.hook).run("s");
      expect(h.calls).toEqual([]);
    });

    it("훅이 던져도 세션은 ready로 남고 failed로 바뀌지 않는다", async () => {
      const { db, state } = fakeDb({ id: "s", bandId: "b", status: "analyzing" });
      const { storage } = fakeStorage();
      const { ffmpeg } = fakeFfmpeg(90 * MIN + 500);
      const { charges } = fakeCharges();
      const h = hook(true);
      await new SessionAnalysisService(db, storage, gemini, ffmpeg, charges, tmp, 0, h.hook).run("s");
      expect(state.updates.at(-1)).toMatchObject({ status: "ready" });
      expect(state.updates.some((u) => u.status === "failed")).toBe(false);
    });
  });
```
These mirror the helpers already in the file (`fakeDb`, `fakeStorage`, `fakeFfmpeg(durationMs)`, `fakeCharges`, `tmp` from `beforeEach`, inline `gemini` object).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bandapp/api exec vitest run src/worker/session-analysis.service.spec.ts`
Expected: FAIL — constructor takes 7 args / hook never called.

- [ ] **Step 3: Implement**

In `session-analysis.service.ts`:
```ts
/** ready 커밋 뒤 호출되는 훅 — NotificationsService가 구조적으로 만족한다. 워커 테스트는 기록기를 꽂는다 */
export interface SessionReadyHook {
  onSessionReady(sessionId: string): Promise<void>;
}
const NOOP_READY_HOOK: SessionReadyHook = { onSessionReady: async () => undefined };
```
Add constructor param after `retryDelayMs`: `private readonly readyHook: SessionReadyHook = NOOP_READY_HOOK,`.
Right after the `await this.db.transaction(...)` block (still inside `try`, before the `this.logger.log(...)` line) add:
```ts
      // 알림은 커밋 뒤, 보조 작업 — 실패해도 세션은 ready다 (2026-10-12 스펙 결정 5)
      await this.readyHook.onSessionReady(sessionId).catch((err) => this.logger.warn(`session ${sessionId}: ready notification failed: ${String(err)}`));
```
Update the provider:
```ts
export const sessionAnalysisServiceProvider: Provider = {
  provide: SessionAnalysisService,
  useFactory: (db: Db, storage: StorageService, gemini: GeminiService, charges: BillingChargeService, notifications: NotificationsService) =>
    new SessionAnalysisService(db, storage, gemini, new ExecFfmpegRunner(), charges, tmpdir(), 2000, notifications),
  inject: [DB, StorageService, GeminiService, BillingChargeService, NotificationsService],
};
```
(import `NotificationsService` from `../notifications/notifications.service.js`).

`worker.module.ts`: add `NotificationsModule` (from `../notifications/notifications.module.js`) to `imports`.

- [ ] **Step 4: Run worker specs + typecheck**

Run: `pnpm --filter @bandapp/api exec tsc --noEmit -p tsconfig.json && pnpm --filter @bandapp/api exec vitest run src/worker`
Expected: PASS.

- [ ] **Step 5: Boot the worker context once** to catch DI wiring errors (NotificationsModule inside WorkerModule):

Run: `cd apps/api && DATABASE_URL=postgresql://band:band@localhost:5432/band SQS_ANALYSIS_QUEUE_URL=http://localhost/q node -e "import('./dist/worker/worker.module.js')" 2>&1 | head -5` — simpler: `pnpm --filter @bandapp/api build` and confirm no DI error at `nest build`; the real check is `docker compose up -d --build worker && docker compose logs worker --tail 20` showing `Nest application successfully started`-equivalent consumer start log without `Nest can't resolve dependencies`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src
git commit -m "feat(worker): notify band when a session becomes ready"
```

---

### Task 8: Env, docs

**Files:**
- Modify: `.env.example`, `README.md` (server section), `infra/README.md`, `apps/api/src/notifications/notifications.module.ts` (doc comment only if needed)

- [ ] **Step 1: `.env.example`** — append after the RevenueCat block:

```
# Firebase Cloud Messaging (푸시). Firebase 콘솔 > 프로젝트 설정 > 서비스 계정 > 새 비공개 키 생성한 JSON을
# 한 줄로 넣는다 (APPLE_PRIVATE_KEY처럼 개행은 \n). 비어 있으면 푸시는 로그만 남기고 인박스·설정은 정상 동작한다.
FIREBASE_SERVICE_ACCOUNT_JSON=
```

- [ ] **Step 2: README / infra notes**

In `README.md` server feature list add one line: "알림 — 코멘트·세션 완료 인박스(밴드별 설정, 30일), FCM 푸시(`FIREBASE_SERVICE_ACCOUNT_JSON` 없으면 로그만)". In `infra/README.md` add `FIREBASE_SERVICE_ACCOUNT_JSON` to the list of task-definition secrets for both `api` and `worker` services (the worker sends session-ready pushes).

- [ ] **Step 3: Full test run and commit**

Run: `pnpm --filter @bandapp/api test`
Expected: PASS.

```bash
git add .env.example README.md infra/README.md
git commit -m "docs: FIREBASE_SERVICE_ACCOUNT_JSON and notifications notes"
```

---

## Self-review notes

- Spec coverage: data (T1), comment read (T2), fanout/push text (T3), PushSender/tokens (T4), service + modules (T5), API + comment wiring (T6), worker (T7), env/docs (T8). `MembershipsService.assertMember` is used for every band-scoped call. Not covered here by design: api-client and mobile (separate plan).
- Review Focus 1–2 → T3 tests; 3 → T6 "같은 시각…" test (bulk seeds pairs with identical `created_at`); 4 → T2 first e2e; 5 → T4 unit + T6 push e2e.
- Names used across tasks: `takeColumns`, `sessionColumns`, `unreadTakeCommentCount`, `unreadSessionCommentCount`, `CommentsService.markRead/list(scope, userId)`, `NotificationsService.onCommentCreated/onSessionReady/list/unreadCount/markRead/markAllRead/settingsForUser/updateSettings`, `PushTokensService.upsert/remove/removeMany/forUsers`, `PUSH_SENDER`, `FakePushSender`, `SessionReadyHook`.
