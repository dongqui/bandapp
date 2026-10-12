# Notifications (Mobile + api-client) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alerts tab + notification sheet, per-band notification settings screen, Me › Notifications row, FCM token lifecycle and deep links via `@react-native-firebase/messaging`, comment read marks from the take screen, and the matching `api-client` (HTTP + Mock) methods.

**Architecture:** `api-client` gains `notifications.*` and `comments.markRead`; `MockApiClient` ships a seeded inbox so the UI runs without a server. `src/services/push.ts` is the only file that touches Firebase and degrades to no-ops when the native module is absent. `NotificationsProvider` owns the current band's unread count, sheet visibility, first-run permission prompt, token sync and deep-link handling; `NotificationSheet` and `NotificationSettingsScreen` render the design; the tab bar grows a 4th "Alerts" cell. Text rendering, grouping and summaries are pure functions with vitest tests.

**Tech Stack:** Expo 57 / RN 0.86 / expo-router, `@react-native-firebase/app` + `messaging` (modular API), `expo-build-properties`, `expo-localization`, i18next, vitest (pure TS only).

**Spec:** `docs/superpowers/specs/2026-10-12-notifications-design.md` — implement after `docs/superpowers/plans/2026-10-12-notifications-server.md` (types in `@bandapp/types` come from that plan's Task 1).

## Global Constraints

- UI copy is English in `en.ts` with a Korean twin in `ko.ts`; `resources.test.ts` enforces identical keys and interpolation variables. Never use `{{count}}`.
- Pure helpers under `src/features/notifications/*.ts` must not import `react-native`, `expo-*` or `@/ui` so `vitest run src` can load them.
- Design constants (2026-10-12 snapshot): active tab bg `rgba(255,255,255,0.09)`, inactive fg `#7A7F88`, read item title `#C6CAD1` weight 400, unread `#F2F3F5` weight 600, unread dot = accent 8px, badge = accent pill 16px with 2px border `#1A1C21`, mono 9px `#0B0C0E`. Toggle 46×28, knob 22px white, on = accent, off `#2A2D33`. Sheet height 640, radius 20, bg `#15171B`.
- Inbox is current-band scoped; page size 6 (`NOTIFICATIONS_PAGE_SIZE`).
- Firebase is optional at build time: without `GOOGLE_SERVICES_JSON` + `GOOGLE_SERVICES_PLIST` the plugin is not added and `push.permission()` returns `"unavailable"`; everything else must still work.
- Native modules added here (`@react-native-firebase/*`, `expo-build-properties`) require rebuilding the dev client (`pnpm --filter mobile android` / `ios`, see memory note on Windows Android builds).
- Tests: `pnpm --filter mobile test`, `pnpm --filter @bandapp/api-client test` (check its package.json script name; `vitest run` otherwise), typecheck `pnpm --filter mobile typecheck`.

## Review Focus

1. **Push for a band that is not the current one** must switch band before navigating, and a 403 (kicked out) must toast, not crash. → Task 4 provider `open()` + `parsePushData` tests (Task 2).
2. **Cold-start push before auth/bands are loaded** must be queued and consumed once, not dropped or opened twice. → Task 4 pending-target effect (manual check listed) + Task 2 `parsePushData` null cases.
3. **Timezone boundary for TODAY/EARLIER** — a notification at 23:50 local yesterday is EARLIER even if it is "1h" ago. → Task 2 `groupByDay` test.
4. **Mark-all-read when some pages are not loaded** must zero the badge and the loaded items. → Task 5 sheet (uses server `read-all` then `refresh()`), Task 1 Mock test.
5. **Turning the "Someone comments" toggle off hides the scope radio and sends `commentScope` unchanged** (PUT requires all three fields). → Task 6 screen logic + Task 1 Mock test of `updateSettings` validation.

---

### Task 1: api-client — interface, HTTP, Mock

**Files:**
- Modify: `packages/api-client/src/client.ts`, `packages/api-client/src/http/HttpApiClient.ts`
- Modify: `packages/api-client/src/mock/seed.ts`, `packages/api-client/src/mock/MockApiClient.ts`
- Test: `packages/api-client/src/mock/MockApiClient.test.ts`, `packages/api-client/src/http/HttpApiClient.spec.ts`

**Interfaces:**
- Produces on `RehearsalApiClient`:
```ts
notifications: {
  list(bandId: string, cursor?: string): Promise<NotificationPage>;
  unreadCount(bandId: string): Promise<number>;
  markRead(id: string): Promise<void>;
  markAllRead(bandId: string): Promise<void>;
  settings(): Promise<NotificationSettings[]>;
  updateSettings(bandId: string, input: UpdateNotificationSettingsInput): Promise<NotificationSettings>;
  registerPushToken(input: RegisterPushTokenInput): Promise<void>;
  removePushToken(token: string): Promise<void>;
};
comments: { /* existing */; markRead(target: CommentTarget): Promise<void> };
```

- [ ] **Step 1: Failing Mock tests** (append to `MockApiClient.test.ts`)

```ts
describe("notifications (mock)", () => {
  it("seeded inbox: 2 unread today, older read, page size 6 with remaining", async () => {
    const api = new MockApiClient();
    const page = await api.notifications.list(BAND);
    expect(page.items).toHaveLength(6);
    expect(page.unreadCount).toBe(2);
    expect(page.remaining).toBe(5);
    expect(page.nextCursor).not.toBeNull();
    expect(page.items[0]).toMatchObject({ type: "comment", actor: { name: "Minsu" }, take: { name: "Take 1" }, comment: { atSec: 133 }, readAt: null });
    const rest = await api.notifications.list(BAND, page.nextCursor!);
    expect(rest.items).toHaveLength(5);
    expect(rest.nextCursor).toBeNull();
    expect(rest.remaining).toBe(0);
    expect(await api.notifications.list("b2")).toMatchObject({ items: [], unreadCount: 0 });
  });

  it("markRead / markAllRead update unreadCount and emit", async () => {
    const api = new MockApiClient();
    const listener = vi.fn();
    api.subscribe(listener);
    const first = (await api.notifications.list(BAND)).items[0]!;
    await api.notifications.markRead(first.id);
    expect(await api.notifications.unreadCount(BAND)).toBe(1);
    await api.notifications.markAllRead(BAND);
    expect(await api.notifications.unreadCount(BAND)).toBe(0);
    expect((await api.notifications.list(BAND)).items.every((i) => i.readAt !== null)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("settings default to all-on per band and round-trip", async () => {
    const api = new MockApiClient();
    expect(await api.notifications.settings()).toEqual([
      { bandId: "b1", sessionReady: true, comments: true, commentScope: "all" },
      { bandId: "b2", sessionReady: true, comments: true, commentScope: "all" },
    ]);
    await api.notifications.updateSettings("b2", { sessionReady: false, comments: true, commentScope: "mine" });
    expect((await api.notifications.settings())[1]).toEqual({ bandId: "b2", sessionReady: false, comments: true, commentScope: "mine" });
  });

  it("push tokens register/remove without error", async () => {
    const api = new MockApiClient();
    await api.notifications.registerPushToken({ token: "t", platform: "ios", locale: "ko-KR" });
    await api.notifications.removePushToken("t");
  });

  it("comments.markRead clears unread for that target and the take's unreadCommentCount", async () => {
    const api = new MockApiClient();
    const before = await api.comments.list({ takeId: "s1-t0" });
    expect(before.some((c) => c.unread)).toBe(true);
    expect((await api.takes.list("s1"))[0]!.unreadCommentCount).toBeGreaterThan(0);
    await api.comments.markRead({ takeId: "s1-t0" });
    expect((await api.comments.list({ takeId: "s1-t0" })).every((c) => !c.unread)).toBe(true);
    expect((await api.takes.list("s1"))[0]!.unreadCommentCount).toBe(0);
    // 내 코멘트는 처음부터 unread가 아니다
    const mine = await api.comments.create({ takeId: "s1-t1" }, { atSec: 3, text: "me" });
    expect(mine.unread).toBe(false);
  });
});
```

- [ ] **Step 2: Failing HTTP tests** (append to `HttpApiClient.spec.ts`, following that file's `fakeFetch`/`client` helpers — mirror how an existing `comments.update` test asserts method/path/body)

```ts
describe("notifications", () => {
  it("list/unreadCount/markRead/markAllRead/settings/tokens hit the spec paths", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const client = clientWith(async (url, init) => {
      calls.push({ method: init?.method ?? "GET", path: url.toString().replace("https://api", ""), body: init?.body ? JSON.parse(init.body as string) : undefined });
      return new Response(init?.method === "PUT" && url.toString().includes("push-tokens") ? null : JSON.stringify({ items: [], nextCursor: null, remaining: 0, unreadCount: 0, count: 3 }), { status: init?.method === "PUT" && url.toString().includes("push-tokens") ? 204 : 200 });
    });
    const listener = vi.fn();
    client.subscribe(listener);
    await client.notifications.list("b1");
    await client.notifications.list("b1", "abc");
    expect(await client.notifications.unreadCount("b1")).toBe(3);
    await client.notifications.markRead("n1");
    await client.notifications.markAllRead("b1");
    await client.notifications.settings();
    await client.notifications.updateSettings("b1", { sessionReady: true, comments: false, commentScope: "all" });
    await client.notifications.registerPushToken({ token: "tok", platform: "android", locale: "en" });
    await client.notifications.removePushToken("tok");
    await client.comments.markRead({ takeId: "t1" });
    await client.comments.markRead({ sessionId: "s1" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /bands/b1/notifications",
      "GET /bands/b1/notifications?cursor=abc",
      "GET /bands/b1/notifications/unread-count",
      "POST /notifications/n1/read",
      "POST /bands/b1/notifications/read-all",
      "GET /me/notification-settings",
      "PUT /bands/b1/notification-settings",
      "PUT /me/push-tokens",
      "DELETE /me/push-tokens/tok",
      "POST /takes/t1/comments/read",
      "POST /sessions/s1/comments/read",
    ]);
    // markRead, markAllRead, updateSettings, comments.markRead ×2 → emit
    expect(listener).toHaveBeenCalledTimes(5);
  });
});
```
Replace `clientWith(fetchFn)` with whatever helper the spec file already uses to build an `HttpApiClient` with a fake `fetchFn` and a token storage that returns an access token (read the top of the file).

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @bandapp/api-client exec vitest run`
Expected: FAIL — `notifications` undefined.

- [ ] **Step 4: Interface** — in `client.ts` import `NotificationPage, NotificationSettings, RegisterPushTokenInput, UpdateNotificationSettingsInput` from `@bandapp/types`, add `markRead(target: CommentTarget): Promise<void>;` to `comments`, and add the `notifications` block from **Interfaces** after `comments`.

- [ ] **Step 5: HttpApiClient**

```ts
  comments = {
    /* existing list/create/update/remove */
    markRead: async (target: CommentTarget): Promise<void> => {
      await this.request<void>("POST", `${commentsPath(target)}/read`);
      this.emit(); // unreadCommentCount가 바뀐다
    },
  };

  notifications = {
    list: (bandId: string, cursor?: string): Promise<NotificationPage> =>
      this.request<NotificationPage>("GET", `/bands/${bandId}/notifications${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
    unreadCount: async (bandId: string): Promise<number> => (await this.request<{ count: number }>("GET", `/bands/${bandId}/notifications/unread-count`)).count,
    markRead: async (id: string): Promise<void> => {
      await this.request<void>("POST", `/notifications/${id}/read`);
      this.emit();
    },
    markAllRead: async (bandId: string): Promise<void> => {
      await this.request<void>("POST", `/bands/${bandId}/notifications/read-all`);
      this.emit();
    },
    settings: (): Promise<NotificationSettings[]> => this.request<NotificationSettings[]>("GET", "/me/notification-settings"),
    updateSettings: async (bandId: string, input: UpdateNotificationSettingsInput): Promise<NotificationSettings> => {
      const s = await this.request<NotificationSettings>("PUT", `/bands/${bandId}/notification-settings`, input);
      this.emit();
      return s;
    },
    registerPushToken: (input: RegisterPushTokenInput): Promise<void> => this.request<void>("PUT", "/me/push-tokens", input),
    removePushToken: (token: string): Promise<void> => this.request<void>("DELETE", `/me/push-tokens/${encodeURIComponent(token)}`),
  };
```

- [ ] **Step 6: Mock seed** — in `seed.ts` add to `MockState`:

```ts
  /** 인박스 — 서버처럼 압축 저장하고 조회 때 세션·take·멤버로 펼친다 */
  notifications: MockNotification[];
  notificationSettings: Record<string, UpdateNotificationSettingsInput>; // bandId → 설정. 없으면 기본값
  /** commentKey(target) → read_at ISO (2026-10-12 코멘트 읽음) */
  readMarks: Record<string, string>;
```
and the type + seed:
```ts
export interface MockNotification {
  id: string;
  bandId: string;
  type: NotificationType;
  actorId: string; // members[bandId] 안의 id
  sessionId: string;
  takeId: string | null;
  comment: { id: string; atSec: number; text: string } | null;
  readAt: string | null;
  createdAt: string;
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

/** 디자인 프로토타입의 inbox 샘플(2026-10-12). 앞 2개만 오늘·미읽음 */
export function seedNotifications(): MockNotification[] {
  const c = (id: string, actorId: string, sessionId: string, takeIdx: number | null, atSec: number, text: string, h: number, read: boolean, type: NotificationType = "comment"): MockNotification => ({
    id, bandId: "b1", type, actorId, sessionId, takeId: takeIdx === null ? null : `${sessionId}-t${takeIdx}`, comment: { id: `${id}-c`, atSec, text }, readAt: read ? hoursAgo(h - 1) : null, createdAt: hoursAgo(h),
  });
  const s = (id: string, actorId: string, sessionId: string, h: number): MockNotification => ({ id, bandId: "b1", type: "session_ready", actorId, sessionId, takeId: null, comment: null, readAt: hoursAgo(h - 1), createdAt: hoursAgo(h) });
  return [
    c("n1", "m2", "s1", 0, 133, "Rushing going into the chorus", 2, false),
    c("n2", "m4", "s1", 0, 28, "Drums a bit loud in the intro?", 3, false),
    c("n3", "m3", "s1", 3, 221, "Love the new ending, keep it", 30, true),
    s("n4", "m3", "s1", 50),
    c("n5", "m4", "s2", 1, 112, "Bass and kick are finally locked in here", 200, true),
    s("n6", "m2", "s2", 220),
    c("n7", "m3", "s3", 4, 47, "Can we drop the second verse for the gig?", 380, true),
    c("n8", "m2", "s3", 2, 150, "Yeah, let’s end on the chorus instead", 381, true, "reply"),
    s("n9", "m4", "s3", 400),
    c("n10", "m3", "s3", 1, 65, "A bit slow here, try 84?", 500, true),
    s("n11", "m2", "s3", 520),
  ];
}
```
In `createSeedState()` set `notifications: seedNotifications(), notificationSettings: {}, readMarks: {}`. Add `unreadCommentCount: 0` to the `session()` helper and to `generateTakes` objects (the Mock recomputes them on read; see Step 7). Import `NotificationType`, `UpdateNotificationSettingsInput` from `@bandapp/types`.

- [ ] **Step 7: MockApiClient**

Add helpers (private):
```ts
  /** 서버 규칙과 같게: 내 코멘트 제외, mark 이후 것만 (2026-10-12 스펙 결정 13) */
  private unreadIn(target: CommentTarget): number {
    const mark = this.state.readMarks[commentKey(target)];
    return (this.state.comments[commentKey(target)] ?? []).filter((c) => c.authorId !== MOCK_USER.id && (!mark || c.createdAt > mark)).length;
  }
  private withUnread(take: Take): Take { return { ...take, unreadCommentCount: this.unreadIn({ takeId: take.id }) }; }
  private sessionUnread(session: Session): number {
    return (this.state.takes[session.id] ?? []).reduce((n, t) => n + this.unreadIn({ takeId: t.id }), this.unreadIn({ sessionId: session.id }));
  }
  private settingsOf(bandId: string): NotificationSettings { return { bandId, ...(this.state.notificationSettings[bandId] ?? DEFAULT_NOTIFICATION_SETTINGS) }; }
  private expand(n: MockNotification): NotificationItem {
    const session = this.mustSession(n.sessionId);
    const take = n.takeId ? this.findTake(n.takeId) : undefined;
    const actor = (this.state.members[n.bandId] ?? []).find((m) => m.id === n.actorId);
    return {
      id: n.id, type: n.type,
      actor: actor ? { id: actor.id, name: actor.name } : null,
      session: { id: session.id, title: session.title, name: session.name ?? null, startedAt: session.startedAt, takeCount: session.takeCount, durationSec: session.durationSec },
      take: take ? { id: take.id, index: take.index, name: take.name } : null,
      comment: n.comment, readAt: n.readAt, createdAt: n.createdAt,
    };
  }
```
Apply `withUnread`/`sessionUnread` where takes and sessions are returned (`takes.list`, `sessions.list`, `sessions.get`, and any single-take return). In `comments.list` map `unread: c.authorId !== MOCK_USER.id && (!mark || c.createdAt > mark)`; in `comments.create` set `unread: false` on the new comment; add
```ts
    markRead: async (target: CommentTarget): Promise<void> => {
      this.state.readMarks[commentKey(target)] = new Date().toISOString();
      this.emit();
    },
```
Add the `notifications` block:
```ts
  notifications = {
    list: async (bandId: string, cursor?: string): Promise<NotificationPage> => {
      const all = this.state.notifications.filter((n) => n.bandId === bandId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const start = cursor ? Number(cursor) : 0; // mock 커서 = 오프셋
      const page = all.slice(start, start + NOTIFICATIONS_PAGE_SIZE);
      const next = start + page.length;
      return {
        items: page.map((n) => this.expand(n)),
        nextCursor: next < all.length ? String(next) : null,
        remaining: Math.max(0, all.length - next),
        unreadCount: all.filter((n) => n.readAt === null).length,
      };
    },
    unreadCount: async (bandId: string): Promise<number> => this.state.notifications.filter((n) => n.bandId === bandId && n.readAt === null).length,
    markRead: async (id: string): Promise<void> => {
      const n = this.state.notifications.find((x) => x.id === id);
      if (!n) throw new ApiError(404, "알림을 찾을 수 없어요.");
      n.readAt ??= new Date().toISOString();
      this.emit();
    },
    markAllRead: async (bandId: string): Promise<void> => {
      const now = new Date().toISOString();
      for (const n of this.state.notifications) if (n.bandId === bandId && n.readAt === null) n.readAt = now;
      this.emit();
    },
    settings: async (): Promise<NotificationSettings[]> => this.state.bands.map((b) => this.settingsOf(b.id)),
    updateSettings: async (bandId: string, input: UpdateNotificationSettingsInput): Promise<NotificationSettings> => {
      this.mustBand(bandId);
      if (typeof input.sessionReady !== "boolean" || typeof input.comments !== "boolean" || !["all", "mine"].includes(input.commentScope)) throw new ApiError(400, "invalid settings");
      this.state.notificationSettings[bandId] = { ...input };
      this.emit();
      return this.settingsOf(bandId);
    },
    registerPushToken: async (): Promise<void> => undefined,
    removePushToken: async (): Promise<void> => undefined,
  };
```
Import `DEFAULT_NOTIFICATION_SETTINGS, NOTIFICATIONS_PAGE_SIZE` and the types from `@bandapp/types`, `MockNotification` from `./seed`.

- [ ] **Step 8: Run tests + typecheck everything that consumes the client**

Run: `pnpm --filter @bandapp/types build && pnpm --filter @bandapp/api-client exec vitest run && pnpm --filter mobile typecheck`
Expected: api-client PASS; mobile typecheck passes (mobile does not yet use the new methods; `Take`/`Session` extra fields are additive).

- [ ] **Step 9: Commit**

```bash
git add packages/api-client
git commit -m "feat(api-client): notifications, settings, push tokens, comment read marks (http + mock)"
```

---

### Task 2: i18n keys and pure view helpers

**Files:**
- Modify: `apps/mobile/src/i18n/en.ts`, `apps/mobile/src/i18n/ko.ts`
- Create: `apps/mobile/src/features/notifications/notificationView.ts`, `notificationView.test.ts`
- Create: `apps/mobile/src/features/notifications/settingsView.ts`, `settingsView.test.ts`
- Create: `apps/mobile/src/features/notifications/pushTarget.ts`, `pushTarget.test.ts`

**Interfaces:**
- `notificationView(item: NotificationItem, meId: string, now: Date): NotificationView`
- `groupByDay(views: NotificationView[], now: Date): Array<{ label: "today" | "earlier"; items: NotificationView[] }>`
- `whenLabel(createdAtIso: string, now: Date): string` → `"now" | "{m}m" | "{h}h" | "Aug 28"`
- `meNfValue(permission: PushPermission, settings: NotificationSettings[]): { kind: "off" } | { kind: "on" } | { kind: "partial"; on: number; total: number }`
- `settingsSummary(s: UpdateNotificationSettingsInput): SummaryKey` (one of six keys)
- `PushPermission = "allowed" | "ask" | "denied" | "unavailable"`
- `PendingTarget { notificationId: string | null; bandId: string; sessionId: string; takeId: string | null; atSec: number | null }`, `parsePushData(data: Record<string, unknown> | undefined): PendingTarget | null`, `targetOf(item: NotificationItem, bandId: string): PendingTarget`, `routeFor(t: PendingTarget): string`.

- [ ] **Step 1: i18n keys** — add to `en.ts` (and Korean equivalents to `ko.ts`, same keys):

```ts
  me: { /* existing */ settings: "SETTINGS", notifications: "Notifications", nfOn: "On", nfOff: "Off", nfPartial: "{{on}} of {{total}} bands" },
  notifications: {
    tab: "Alerts",
    title: "Notifications",
    markAllRead: "Mark all read",
    settings: "Notification settings",
    today: "TODAY",
    earlier: "EARLIER",
    showOlder: "Show older ({{n}})",
    last30: "Notifications from the last 30 days",
    emptyTitle: "Nothing yet",
    emptyBody: "New sessions and comments in {{band}} show up here.",
    gone: "This notification is no longer available.",
    now: "now",
    formerMember: "A former member",
    original: "the original recording",
    sessionReadySelf: "Your recording is ready",
    sessionReady: "{{actor}}'s recording is ready",
    takesFound: "{{n}} takes found",
    takeFound: "1 take found",
    commented: "{{actor}} commented on {{target}}",
    replied: "{{actor}} replied to you on {{target}}",
  },
  notificationSettings: {
    back: "Back",
    backMe: "Me",
    title: "Notification settings",
    subtitle: "Choose what Take N tells you about.",
    offTitle: "Notifications are off",
    offBody: "Turn them on to hear when a session is ready and when your band leaves feedback.",
    turnOn: "Turn on notifications",
    deniedTitle: "Blocked in Settings",
    deniedBody: "Take N can’t send notifications until you allow them in Settings › Take N › Notifications.",
    unavailableTitle: "Notifications unavailable",
    unavailableBody: "This build was made without push notifications.",
    openSettings: "Open Settings",
    forThisBand: "For this band only",
    bandsSheet: "Notification settings for",
    notifyWhen: "NOTIFY ME WHEN",
    sessionReady: "A session is ready",
    sessionReadyHint: "A bandmate’s recording has been split into takes.",
    comments: "Someone comments",
    commentsHint: "New feedback or a reply on a take.",
    scopeAll: "All comments and replies",
    scopeMine: "Only replies to my comments",
    saveFailed: "Couldn’t save. Try again.",
    summary: {
      all: "Sessions · all comments",
      mine: "Sessions · replies to me",
      sessionsOnly: "Sessions only",
      commentsOnly: "Comments only",
      repliesOnly: "Replies to me only",
      off: "Off",
    },
  },
```
Korean (`ko.ts`): `settings: "설정"`, `notifications: "알림"`, `nfOn: "켜짐"`, `nfOff: "꺼짐"`, `nfPartial: "{{total}}개 밴드 중 {{on}}개"`; `tab: "알림"`, `title: "알림"`, `markAllRead: "모두 읽음"`, `settings: "알림 설정"`, `today: "오늘"`, `earlier: "이전"`, `showOlder: "이전 알림 보기 ({{n}})"`, `last30: "최근 30일의 알림"`, `emptyTitle: "아직 없어요"`, `emptyBody: "{{band}}의 새 세션과 코멘트가 여기에 보여요."`, `gone: "더 이상 볼 수 없는 알림이에요."`, `now: "지금"`, `formerMember: "탈퇴한 멤버"`, `original: "원본 녹음"`, `sessionReadySelf: "내 녹음이 준비됐어요"`, `sessionReady: "{{actor}}님의 녹음이 준비됐어요"`, `takesFound: "테이크 {{n}}개"`, `takeFound: "테이크 1개"`, `commented: "{{actor}}님이 {{target}}에 코멘트를 남겼어요"`, `replied: "{{actor}}님이 {{target}}의 내 코멘트에 답글을 남겼어요"`; settings block translated similarly (`deniedTitle: "설정에서 차단됨"`, `deniedBody: "설정 › Take N › 알림에서 허용해야 알림을 보낼 수 있어요."`, `unavailableBody: "이 빌드에는 푸시 알림이 들어 있지 않아요."`, `forThisBand: "이 밴드에만 적용"`, `bandsSheet: "알림 설정할 밴드"`, `notifyWhen: "이럴 때 알려주기"`, `sessionReady: "세션이 준비되면"`, `sessionReadyHint: "밴드 멤버의 녹음이 테이크로 나눠졌을 때"`, `comments: "코멘트가 달리면"`, `commentsHint: "테이크에 새 피드백이나 답글이 달렸을 때"`, `scopeAll: "모든 코멘트와 답글"`, `scopeMine: "내 코멘트에 달린 답글만"`, `saveFailed: "저장하지 못했어요. 다시 시도해 주세요."`, summaries `"세션 · 모든 코멘트"`, `"세션 · 내게 온 답글"`, `"세션만"`, `"코멘트만"`, `"내게 온 답글만"`, `"꺼짐"`).

Run: `pnpm --filter mobile exec vitest run src/i18n` → PASS (keys match).

- [ ] **Step 2: `notificationView.test.ts`**

```ts
import type { NotificationItem } from "@bandapp/types";
import { describe, expect, it } from "vitest";
import { groupByDay, notificationView, whenLabel } from "./notificationView";

const now = new Date("2026-08-29T21:24:00+09:00");
const base: NotificationItem = {
  id: "n1", type: "comment",
  actor: { id: "m2", name: "Minsu" },
  session: { id: "s1", title: "Aug 27 Rehearsal", name: "Full set run-through", startedAt: "2026-08-27T19:03:00+09:00", takeCount: 7, durationSec: 8040 },
  take: { id: "t", index: 0, name: "Take 1" },
  comment: { id: "c", atSec: 133, text: "Rushing going into the chorus" },
  readAt: null, createdAt: "2026-08-29T19:24:00+09:00",
};

describe("notificationView", () => {
  it("코멘트: 제목 재료·본문·메타·when·unread", () => {
    const v = notificationView(base, "me", now);
    expect(v).toMatchObject({ id: "n1", kind: "comment", actorName: "Minsu", targetName: "Take 1", body: "“Rushing going into the chorus”", meta: "FULL SET RUN-THROUGH · 02:13", when: "2h", unread: true, initial: "M" });
    expect(v.target).toEqual({ notificationId: "n1", bandId: "", sessionId: "s1", takeId: "t", atSec: 133 });
  });
  it("답글은 kind reply, 원본 녹음 코멘트는 targetName null·takeId orig", () => {
    const v = notificationView({ ...base, type: "reply", take: null }, "me", now);
    expect(v.kind).toBe("reply");
    expect(v.targetName).toBeNull();
    expect(v.target.takeId).toBe("orig");
  });
  it("세션 완료: 본인/타인, 메타는 날짜·길이, 세션 이름 없으면 title", () => {
    const item: NotificationItem = { ...base, type: "session_ready", take: null, comment: null, actor: { id: "me", name: "Dongjin" }, readAt: "2026-08-29T20:00:00+09:00" };
    const self = notificationView(item, "me", now);
    expect(self).toMatchObject({ kind: "session_ready_self", body: "Full set run-through", takeCount: 7, meta: "AUG 27 · 2H 14M", unread: false });
    expect(self.target).toMatchObject({ takeId: null, atSec: null });
    const other = notificationView({ ...item, actor: { id: "m3", name: "Jihoon" }, session: { ...item.session, name: null } }, "me", now);
    expect(other).toMatchObject({ kind: "session_ready", actorName: "Jihoon", body: "Aug 27 Rehearsal" });
  });
  it("actor null → formerMember 표시 플래그, 이름 비면 ?", () => {
    expect(notificationView({ ...base, actor: null }, "me", now)).toMatchObject({ actorName: null, initial: "?" });
    expect(notificationView({ ...base, actor: { id: "x", name: null } }, "me", now)).toMatchObject({ actorName: "?", initial: "?" });
  });
});

describe("whenLabel", () => {
  it("now / m / h / 날짜", () => {
    expect(whenLabel("2026-08-29T21:23:40+09:00", now)).toBe("now");
    expect(whenLabel("2026-08-29T21:10:00+09:00", now)).toBe("14m");
    expect(whenLabel("2026-08-29T18:24:00+09:00", now)).toBe("3h");
    expect(whenLabel("2026-08-28T23:50:00+09:00", now)).toBe("Aug 28");
  });
});

describe("groupByDay", () => {
  it("로컬 기준 오늘만 TODAY, 어제 23:50은 EARLIER (1h 전이어도)", () => {
    const todayLate = new Date("2026-08-29T00:30:00+09:00");
    const a = notificationView({ ...base, id: "a", createdAt: "2026-08-29T00:10:00+09:00" }, "me", todayLate);
    const b = notificationView({ ...base, id: "b", createdAt: "2026-08-28T23:50:00+09:00" }, "me", todayLate);
    expect(groupByDay([a, b], todayLate)).toEqual([
      { label: "today", items: [a] },
      { label: "earlier", items: [b] },
    ]);
    expect(groupByDay([b], todayLate)).toEqual([{ label: "earlier", items: [b] }]);
    expect(groupByDay([], todayLate)).toEqual([]);
  });
});
```
Note: tests use `+09:00` offsets; `whenLabel`/`groupByDay` use the runtime's local timezone for day boundaries, so run vitest with `TZ=Asia/Seoul` — add `"test": "cross-env TZ=Asia/Seoul vitest run src"`? Simpler: compute "today" with an injectable `tz` offset… Keep it simple: in the test file set `process.env.TZ = "Asia/Seoul"` at the very top before imports (Node honors it at first Date use). If the existing `time.test.ts` already pins TZ, mirror that.

- [ ] **Step 3: Implement `notificationView.ts`**

```ts
import type { NotificationItem } from "@bandapp/types";
import { fmtClock } from "@/lib/time";
import { targetOf, type PendingTarget } from "./pushTarget";

export type NotificationKind = "session_ready_self" | "session_ready" | "comment" | "reply";

/** 인박스 한 줄의 표시 모델. 문구 조립은 컴포넌트가 t()로 한다 — 이 파일은 RN을 모른다 */
export interface NotificationView {
  id: string;
  kind: NotificationKind;
  /** null = 탈퇴한 멤버(formerMember 문구), "?" = 이름 없음 */
  actorName: string | null;
  initial: string;
  /** 코멘트형: take 이름, 원본 녹음이면 null(original 문구) */
  targetName: string | null;
  /** 코멘트형: “본문”, 세션형: 세션 이름(없으면 title) */
  body: string;
  takeCount: number;
  meta: string;
  when: string;
  unread: boolean;
  target: PendingTarget;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (d: Date) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;
const hm = (sec: number) => { const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60); return h ? `${h}H ${m}M` : `${m}M`; };

export function notificationView(item: NotificationItem, meId: string, now: Date): NotificationView {
  const sessionLabel = item.session.name ?? item.session.title;
  const actorName = item.actor === null ? null : item.actor.name?.trim() || "?";
  const initial = (actorName ?? "?")[0]!.toUpperCase();
  const common = { id: item.id, actorName, initial, takeCount: item.session.takeCount, when: whenLabel(item.createdAt, now), unread: item.readAt === null, target: targetOf(item, "") };
  if (item.type === "session_ready") {
    return {
      ...common,
      kind: item.actor?.id === meId ? "session_ready_self" : "session_ready",
      targetName: null,
      body: sessionLabel,
      meta: `${shortDate(new Date(item.session.startedAt)).toUpperCase()} · ${hm(item.session.durationSec)}`,
    };
  }
  return {
    ...common,
    kind: item.type,
    targetName: item.take?.name ?? null,
    body: `“${item.comment?.text ?? ""}”`,
    meta: `${sessionLabel.toUpperCase()} · ${fmtClock(item.comment?.atSec ?? 0)}`,
  };
}

/** 디자인 when: 1분 미만 now, 1시간 미만 Nm, 24시간 미만 Nh, 그 외 "Aug 28" */
export function whenLabel(createdAtIso: string, now: Date): string {
  const diffMin = Math.floor((now.getTime() - new Date(createdAtIso).getTime()) / 60_000);
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}m`;
  if (diffMin < 24 * 60) return `${Math.floor(diffMin / 60)}h`;
  return shortDate(new Date(createdAtIso));
}

const sameLocalDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** 로컬 날짜 기준 TODAY / EARLIER. 어제 23:50은 1시간 전이어도 EARLIER */
export function groupByDay(views: NotificationView[], now: Date): Array<{ label: "today" | "earlier"; items: NotificationView[] }> {
  const today = views.filter((v) => sameLocalDay(new Date(v.createdAt), now));
  const earlier = views.filter((v) => !sameLocalDay(new Date(v.createdAt), now));
  const out: Array<{ label: "today" | "earlier"; items: NotificationView[] }> = [];
  if (today.length) out.push({ label: "today", items: today });
  if (earlier.length) out.push({ label: "earlier", items: earlier });
  return out;
}
```
`NotificationView` also carries `createdAt: string` (add the field to the interface and `createdAt: item.createdAt` to `common`) so `groupByDay` can read the raw timestamp. `target.bandId` is `""` here and is filled by the sheet with the current band id (`{ ...v.target, bandId }`) — say so in a comment on `targetOf`.

- [ ] **Step 4: `pushTarget.ts` + test**

```ts
import type { NotificationItem } from "@bandapp/types";

/** 푸시 data / 인박스 항목 → 이동 목적지. takeId "orig" = 원본 녹음(기존 /take/orig 라우트) */
export interface PendingTarget {
  notificationId: string | null;
  bandId: string;
  sessionId: string;
  takeId: string | null;
  atSec: number | null;
}

export function targetOf(item: NotificationItem, bandId: string): PendingTarget {
  if (item.type === "session_ready") return { notificationId: item.id, bandId, sessionId: item.session.id, takeId: null, atSec: null };
  return { notificationId: item.id, bandId, sessionId: item.session.id, takeId: item.take?.id ?? "orig", atSec: item.comment?.atSec ?? null };
}

/** FCM data는 전부 문자열. 필수 키가 빠지면 null — 모르는 푸시는 무시한다 */
export function parsePushData(data: Record<string, unknown> | undefined | null): PendingTarget | null {
  if (!data) return null;
  const str = (k: string) => (typeof data[k] === "string" && (data[k] as string).length > 0 ? (data[k] as string) : null);
  const bandId = str("bandId"), sessionId = str("sessionId"), type = str("type");
  if (!bandId || !sessionId || !type) return null;
  if (type === "session_ready") return { notificationId: str("notificationId"), bandId, sessionId, takeId: null, atSec: null };
  const atMs = str("atMs");
  return { notificationId: str("notificationId"), bandId, sessionId, takeId: str("takeId") ?? "orig", atSec: atMs !== null && Number.isFinite(Number(atMs)) ? Number(atMs) / 1000 : null };
}

export function routeFor(t: PendingTarget): string {
  if (t.takeId === null) return `/session/${t.sessionId}`;
  const at = t.atSec === null ? "" : `?at=${t.atSec}`;
  return `/session/${t.sessionId}/take/${t.takeId}${at}`;
}
```
Test (`pushTarget.test.ts`):
```ts
import { describe, expect, it } from "vitest";
import { parsePushData, routeFor } from "./pushTarget";

describe("parsePushData", () => {
  it("코멘트 푸시 → take 라우트 + at, 원본은 orig, 세션은 세션 상세", () => {
    const c = parsePushData({ notificationId: "n", bandId: "b", sessionId: "s", type: "comment", takeId: "t", atMs: "133000" })!;
    expect(c).toEqual({ notificationId: "n", bandId: "b", sessionId: "s", takeId: "t", atSec: 133 });
    expect(routeFor(c)).toBe("/session/s/take/t?at=133");
    expect(routeFor(parsePushData({ bandId: "b", sessionId: "s", type: "reply", atMs: "5000" })!)).toBe("/session/s/take/orig?at=5");
    expect(routeFor(parsePushData({ bandId: "b", sessionId: "s", type: "session_ready" })!)).toBe("/session/s");
  });
  it("필수 키가 빠지면 null, atMs가 숫자가 아니면 at 없이", () => {
    expect(parsePushData(undefined)).toBeNull();
    expect(parsePushData({ sessionId: "s", type: "comment" })).toBeNull();
    expect(parsePushData({ bandId: "b", sessionId: "s", type: "comment", atMs: "x" })).toMatchObject({ atSec: null });
  });
});
```

- [ ] **Step 5: `settingsView.ts` + test**

```ts
import type { NotificationSettings, UpdateNotificationSettingsInput } from "@bandapp/types";

export type PushPermission = "allowed" | "ask" | "denied" | "unavailable";
export type SummaryKey = "all" | "mine" | "sessionsOnly" | "commentsOnly" | "repliesOnly" | "off";

/** 밴드 시트의 한 줄 요약 (디자인 summ) */
export function settingsSummary(s: UpdateNotificationSettingsInput): SummaryKey {
  if (s.sessionReady && s.comments) return s.commentScope === "mine" ? "mine" : "all";
  if (s.sessionReady) return "sessionsOnly";
  if (s.comments) return s.commentScope === "mine" ? "repliesOnly" : "commentsOnly";
  return "off";
}

/** Me 행 값 (디자인 meNfValue): 권한 없거나 전부 off → off, 전부 on → on, 아니면 n of m */
export function meNfValue(permission: PushPermission, settings: NotificationSettings[]): { kind: "off" } | { kind: "on" } | { kind: "partial"; on: number; total: number } {
  const on = settings.filter((s) => s.sessionReady || s.comments).length;
  if (permission !== "allowed" || on === 0) return { kind: "off" };
  if (on === settings.length) return { kind: "on" };
  return { kind: "partial", on, total: settings.length };
}
```
Test:
```ts
import { describe, expect, it } from "vitest";
import { meNfValue, settingsSummary } from "./settingsView";

const s = (bandId: string, sessionReady: boolean, comments: boolean, commentScope: "all" | "mine" = "all") => ({ bandId, sessionReady, comments, commentScope });

describe("settingsSummary", () => {
  it("6가지", () => {
    expect(settingsSummary(s("b", true, true))).toBe("all");
    expect(settingsSummary(s("b", true, true, "mine"))).toBe("mine");
    expect(settingsSummary(s("b", true, false))).toBe("sessionsOnly");
    expect(settingsSummary(s("b", false, true))).toBe("commentsOnly");
    expect(settingsSummary(s("b", false, true, "mine"))).toBe("repliesOnly");
    expect(settingsSummary(s("b", false, false))).toBe("off");
  });
});

describe("meNfValue", () => {
  const all = [s("a", true, true), s("b", true, false)];
  it("권한 없으면 off, 전부 on이면 on, 일부면 partial", () => {
    expect(meNfValue("ask", all)).toEqual({ kind: "off" });
    expect(meNfValue("denied", all)).toEqual({ kind: "off" });
    expect(meNfValue("unavailable", all)).toEqual({ kind: "off" });
    expect(meNfValue("allowed", all)).toEqual({ kind: "on" });
    expect(meNfValue("allowed", [s("a", true, true), s("b", false, false)])).toEqual({ kind: "partial", on: 1, total: 2 });
    expect(meNfValue("allowed", [s("a", false, false)])).toEqual({ kind: "off" });
    expect(meNfValue("allowed", [])).toEqual({ kind: "off" });
  });
});
```

- [ ] **Step 6: Run tests, commit**

Run: `pnpm --filter mobile test`
Expected: PASS.

```bash
git add apps/mobile/src/i18n apps/mobile/src/features/notifications
git commit -m "feat(mobile): notification i18n keys and pure view helpers"
```

---

### Task 3: Push service and Firebase build config

**Files:**
- Modify: `apps/mobile/package.json` (add `@react-native-firebase/app`, `@react-native-firebase/messaging`, `expo-build-properties`)
- Modify: `apps/mobile/app.config.ts`, `apps/mobile/.env.example`
- Create: `apps/mobile/src/services/push.ts`
- Modify: `apps/mobile/src/services/secure-storage.ts` (key `pushAsked`)

**Interfaces:**
- `push.permission(): Promise<PushPermission>`, `push.request(): Promise<PushPermission>`, `push.getToken(): Promise<string | null>`, `push.onTokenRefresh(cb): () => void`, `push.onOpened(cb: (t: PendingTarget) => void): () => void` (also delivers the cold-start notification once), `push.onForegroundMessage(cb: () => void): () => void`, `push.openSystemSettings(): void`.

- [ ] **Step 1: Install**

Run: `pnpm --filter mobile add @react-native-firebase/app @react-native-firebase/messaging expo-build-properties`
Expected: three deps added. Check `npx expo install --check` inside `apps/mobile` reports no version mismatch for `expo-build-properties`; if it suggests a version, use that one.

- [ ] **Step 2: `app.config.ts`** — after the `googleIosUrlScheme` check add:

```ts
// Firebase(FCM)는 선택이다. 두 설정 파일 경로가 모두 있을 때만 플러그인을 붙인다 — 없으면 push.ts가 "unavailable"로
// 돌아 인박스·설정만 동작한다 (2026-10-12 스펙 롤아웃 2). 파일은 Firebase 콘솔에서 받는다 (.env.example 참고).
const googleServicesJson = process.env.GOOGLE_SERVICES_JSON;
const googleServicesPlist = process.env.GOOGLE_SERVICES_PLIST;
const firebaseEnabled = Boolean(googleServicesJson && googleServicesPlist);
if (!firebaseEnabled) console.warn("[app.config] GOOGLE_SERVICES_JSON/PLIST가 없어 이 빌드에는 푸시 알림이 빠진다.");
```
and in the returned config:
```ts
  const plugins: Plugins = [
    ...((config.plugins ?? []) as Plugins),
    ["expo-dev-client", { launchMode: "most-recent" }],
    ["@react-native-google-signin/google-signin", { iosUrlScheme: googleIosUrlScheme }],
    ...(firebaseEnabled
      ? ([
          "@react-native-firebase/app",
          "@react-native-firebase/messaging",
          // react-native-firebase는 iOS에서 static frameworks가 필요하다
          ["expo-build-properties", { ios: { useFrameworks: "static" } }],
        ] as Plugins)
      : []),
  ];
  return {
    ...config,
    plugins,
    ios: { ...config.ios, ...(firebaseEnabled ? { googleServicesFile: googleServicesPlist } : {}) },
    android: { ...config.android, ...(firebaseEnabled ? { googleServicesFile: googleServicesJson } : {}) },
  } as ExpoConfig;
```
`.env.example` — append:
```
# Firebase Cloud Messaging (선택). Firebase 콘솔 > 프로젝트 설정 > 내 앱에서 받은 파일의 경로. 둘 다 있어야 플러그인이 붙는다.
# 네이티브 모듈이라 바꾼 뒤 dev client 재빌드 필요. 비어 있으면 알림 설정 화면이 "이 빌드에는 푸시가 없다"고 안내한다.
GOOGLE_SERVICES_JSON=./google-services.json
GOOGLE_SERVICES_PLIST=./GoogleService-Info.plist
```
Add `google-services.json` and `GoogleService-Info.plist` to `apps/mobile/.gitignore`.

- [ ] **Step 3: secure-storage key** — add `pushAsked: "push.asked",` to `KEYS`.

- [ ] **Step 4: `push.ts`**

```ts
import { Linking, PermissionsAndroid, Platform } from "react-native";
import { getLocales } from "expo-localization";
import { secureStorage } from "@/services/secure-storage";
import type { PushPermission } from "@/features/notifications/settingsView";
import { parsePushData, type PendingTarget } from "@/features/notifications/pushTarget";

/**
 * Firebase를 만지는 유일한 파일 (2026-10-12 스펙). 네이티브 모듈이 없는 빌드(GOOGLE_SERVICES_* 없음, Expo Go)에서는
 * require가 던지거나 getApp()이 던진다 — 그 경우 모든 함수가 no-op이고 permission()은 "unavailable"이다.
 */
type Messaging = typeof import("@react-native-firebase/messaging");
type Loaded = { m: Messaging; inst: ReturnType<Messaging["getMessaging"]> };

let loaded: Loaded | null | undefined;
function fb(): Loaded | null {
  if (loaded !== undefined) return loaded;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const app = require("@react-native-firebase/app") as typeof import("@react-native-firebase/app");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require("@react-native-firebase/messaging") as Messaging;
    loaded = { m, inst: m.getMessaging(app.getApp()) };
  } catch {
    loaded = null;
  }
  return loaded;
}

const POST_NOTIFICATIONS = "android.permission.POST_NOTIFICATIONS" as const;

async function androidGranted(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  if (Platform.Version < 33) return true; // 13 미만은 런타임 권한이 없다
  return PermissionsAndroid.check(POST_NOTIFICATIONS);
}

export const push = {
  /** 디자인의 OS 상태 3가지 + 이 빌드에 Firebase가 없음 */
  async permission(): Promise<PushPermission> {
    const f = fb();
    if (!f) return "unavailable";
    if (Platform.OS === "android") {
      if (await androidGranted()) return "allowed";
      // Android는 "안 물어봄"과 "거부"를 구분해 주지 않는다 — 우리가 물었는지로 가른다
      return (await secureStorage.get("pushAsked")) ? "denied" : "ask";
    }
    const status = await f.m.hasPermission(f.inst);
    const S = f.m.AuthorizationStatus;
    if (status === S.AUTHORIZED || status === S.PROVISIONAL) return "allowed";
    return status === S.NOT_DETERMINED ? "ask" : "denied";
  },

  /** OS 다이얼로그. 결과를 바로 돌려준다 */
  async request(): Promise<PushPermission> {
    const f = fb();
    if (!f) return "unavailable";
    await secureStorage.set("pushAsked", "1");
    if (Platform.OS === "android") {
      if (Platform.Version < 33) return "allowed";
      const r = await PermissionsAndroid.request(POST_NOTIFICATIONS);
      return r === PermissionsAndroid.RESULTS.GRANTED ? "allowed" : "denied";
    }
    const status = await f.m.requestPermission(f.inst);
    return status === f.m.AuthorizationStatus.AUTHORIZED || status === f.m.AuthorizationStatus.PROVISIONAL ? "allowed" : "denied";
  },

  async getToken(): Promise<string | null> {
    const f = fb();
    if (!f) return null;
    try {
      return await f.m.getToken(f.inst);
    } catch (err) {
      console.warn("fcm getToken failed", err);
      return null;
    }
  },

  onTokenRefresh(cb: (token: string) => void): () => void {
    const f = fb();
    return f ? f.m.onTokenRefresh(f.inst, cb) : () => undefined;
  },

  /** 백그라운드/종료 상태에서 푸시를 눌러 열었을 때. 콜드 스타트 건은 구독 직후 한 번 전달된다 */
  onOpened(cb: (t: PendingTarget) => void): () => void {
    const f = fb();
    if (!f) return () => undefined;
    let cancelled = false;
    void f.m.getInitialNotification(f.inst).then((msg) => {
      const t = parsePushData(msg?.data);
      if (t && !cancelled) cb(t);
    });
    const off = f.m.onNotificationOpenedApp(f.inst, (msg) => {
      const t = parsePushData(msg.data);
      if (t) cb(t);
    });
    return () => {
      cancelled = true;
      off();
    };
  },

  /** 앱이 켜져 있을 때 도착 — 배너 없이 배지·인박스만 갱신한다 (스펙 결정 11) */
  onForegroundMessage(cb: () => void): () => void {
    const f = fb();
    return f ? f.m.onMessage(f.inst, () => cb()) : () => undefined;
  },

  openSystemSettings(): void {
    void Linking.openSettings();
  },

  platform(): "ios" | "android" {
    return Platform.OS === "ios" ? "ios" : "android";
  },

  locale(): string {
    return getLocales()[0]?.languageTag ?? "en";
  },
};
```
If the modular exports (`getMessaging`, `hasPermission`, `requestPermission`, `getToken`, `onTokenRefresh`, `getInitialNotification`, `onNotificationOpenedApp`, `onMessage`, `AuthorizationStatus`) differ in the installed version, check `node_modules/@react-native-firebase/messaging/lib/modular/index.d.ts` and adapt names — keep the `push` surface identical.

- [ ] **Step 5: Typecheck, commit**

Run: `pnpm --filter mobile typecheck`
Expected: PASS.

```bash
git add apps/mobile/package.json pnpm-lock.yaml apps/mobile/app.config.ts apps/mobile/.env.example apps/mobile/.gitignore apps/mobile/src/services
git commit -m "feat(mobile): optional Firebase messaging plugin and push service wrapper"
```

---

### Task 4: NotificationsProvider, token lifecycle, deep links

**Files:**
- Create: `apps/mobile/src/features/notifications/NotificationsProvider.tsx`
- Create: `apps/mobile/src/features/notifications/useNotificationSettings.ts`
- Modify: `apps/mobile/app/_layout.tsx`, `apps/mobile/src/features/auth/AuthProvider.tsx`

**Interfaces:**
- `useNotifications(): { unreadCount: number; permission: PushPermission; refreshPermission(): Promise<void>; requestPermission(): Promise<PushPermission>; refresh(): void; sheetOpen: boolean; setSheetOpen(v: boolean): void; open(target: PendingTarget): Promise<void> }`
- `useNotificationSettings(): { data: NotificationSettings[] | undefined; reload(): void }` (wraps `useApiData`).

- [ ] **Step 1: `useNotificationSettings.ts`**

```ts
import { useApiData } from "@/api";

/** 내 모든 밴드의 알림 설정 — Me 행 요약과 설정 화면이 같이 쓴다 */
export function useNotificationSettings() {
  return useApiData(async (api) => api.notifications.settings(), []);
}
```

- [ ] **Step 2: `NotificationsProvider.tsx`**

```tsx
import { ApiError } from "@bandapp/api-client";
import { useRouter } from "expo-router";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api";
import { useAuth } from "@/features/auth/AuthProvider";
import { useCurrentBand } from "@/features/band/useCurrentBand";
import { push } from "@/services/push";
import { useToast } from "@/ui";
import { routeFor, type PendingTarget } from "./pushTarget";
import type { PushPermission } from "./settingsView";

interface NotificationsValue {
  unreadCount: number;
  permission: PushPermission;
  refreshPermission(): Promise<void>;
  requestPermission(): Promise<PushPermission>;
  /** 배지 다시 읽기 */
  refresh(): void;
  sheetOpen: boolean;
  setSheetOpen(v: boolean): void;
  /** 알림(인박스·푸시)을 열어 목적지로 간다. 밴드가 다르면 먼저 바꾼다 (스펙 결정 4) */
  open(target: PendingTarget): Promise<void>;
}

const Ctx = createContext<NotificationsValue | null>(null);

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const router = useRouter();
  const toast = useToast();
  const { t } = useTranslation();
  const { state } = useAuth();
  const authed = state.status === "authenticated";
  const { band, bands, loading, setCurrentBand } = useCurrentBand();
  const [unreadCount, setUnreadCount] = useState(0);
  const [permission, setPermission] = useState<PushPermission>("unavailable");
  const [sheetOpen, setSheetOpen] = useState(false);
  const pending = useRef<PendingTarget | null>(null);
  const [pendingTick, setPendingTick] = useState(0);
  const lastToken = useRef<string | null>(null);

  const refreshPermission = useCallback(async () => setPermission(await push.permission()), []);
  useEffect(() => {
    void refreshPermission();
  }, [refreshPermission]);

  const refresh = useCallback(() => {
    const bandId = band?.id;
    if (!authed || !bandId) {
      setUnreadCount(0);
      return;
    }
    api.notifications.unreadCount(bandId).then(setUnreadCount).catch((e) => console.warn("unread count failed", e));
  }, [api, authed, band?.id]);

  // 갱신 시점: 밴드 변경·로그인, 데이터 변경 통지, 포그라운드 복귀(권한도 다시 읽음 — iOS 설정에서 돌아온 경우), 포그라운드 푸시. 주기 폴링 없음
  useEffect(() => {
    refresh();
    const offApi = api.subscribe(refresh);
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") {
        refresh();
        void refreshPermission();
      }
    });
    const offMsg = push.onForegroundMessage(refresh);
    return () => {
      offApi();
      sub.remove();
      offMsg();
    };
  }, [api, refresh, refreshPermission]);

  /** 허용 상태 + 로그인 → 토큰 등록. 토큰 갱신도 같은 경로 */
  const syncToken = useCallback(async () => {
    if (!authed) return;
    const token = await push.getToken();
    if (!token) return;
    lastToken.current = token;
    await api.notifications.registerPushToken({ token, platform: push.platform(), locale: push.locale() }).catch((e) => console.warn("push token register failed", e));
  }, [api, authed]);

  useEffect(() => {
    if (!authed || permission !== "allowed") return;
    void syncToken();
    return push.onTokenRefresh(() => void syncToken());
  }, [authed, permission, syncToken]);

  // 첫 권한 요청: 첫 밴드에 들어온 직후 한 번 (스펙 결정 10). 거부하면 다시 묻지 않는다 (pushAsked 플래그는 push.request가 남긴다)
  const askedThisRun = useRef(false);
  useEffect(() => {
    if (askedThisRun.current || !authed || loading || bands.length === 0 || permission !== "ask") return;
    askedThisRun.current = true;
    void push.request().then(setPermission);
  }, [authed, loading, bands.length, permission]);

  const requestPermission = useCallback(async () => {
    const p = await push.request();
    setPermission(p);
    return p;
  }, []);

  const open = useCallback(
    async (target: PendingTarget) => {
      setSheetOpen(false);
      if (band?.id !== target.bandId) setCurrentBand(target.bandId);
      try {
        if (target.notificationId) await api.notifications.markRead(target.notificationId);
        // 멤버인지 먼저 확인 — 쫓겨났으면 403
        await api.sessions.get(target.sessionId);
        router.push(routeFor(target));
      } catch (err) {
        if (err instanceof ApiError && (err.status === 403 || err.status === 404)) toast.show(t("notifications.gone"));
        else toast.show(t("notifications.gone"));
      }
    },
    [api, band?.id, router, setCurrentBand, t, toast],
  );

  // 푸시 탭 (콜드 스타트 포함). 인증·밴드가 준비되기 전에 오면 pending에 두고 아래 effect가 소비한다
  useEffect(() => {
    return push.onOpened((target) => {
      pending.current = target;
      setPendingTick((n) => n + 1);
    });
  }, []);
  useEffect(() => {
    if (!pending.current || !authed || loading) return;
    const target = pending.current;
    pending.current = null;
    void open(target);
  }, [authed, loading, open, pendingTick]);

  /** 로그아웃·탈퇴 직전에 AuthProvider가 부른다 */
  useEffect(() => {
    pushTokenHandle.current = () => (lastToken.current ? api.notifications.removePushToken(lastToken.current).catch(() => undefined) : Promise.resolve());
  }, [api]);

  return <Ctx.Provider value={{ unreadCount, permission, refreshPermission, requestPermission, refresh, sheetOpen, setSheetOpen, open }}>{children}</Ctx.Provider>;
}

export function useNotifications(): NotificationsValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useNotifications must be used within NotificationsProvider");
  return v;
}

/** AuthProvider → NotificationsProvider 방향의 최소 브리지 (session-events와 같은 패턴). 로그아웃 전에 토큰을 지운다 */
export const pushTokenHandle: { current: () => Promise<void> } = { current: async () => undefined };
```

- [ ] **Step 3: Wire into `_layout.tsx`** — import `NotificationsProvider` and wrap inside `ToastProvider`:

```tsx
              <ToastProvider>
                <NotificationsProvider>
                  <StatusBar style="light" />
                  <Stack ... />
                </NotificationsProvider>
              </ToastProvider>
```
(`ToastProvider` is inside `AuthGate` → `CurrentBandProvider`, so `useCurrentBand`/`useToast` resolve.)

- [ ] **Step 4: AuthProvider — remove token on sign-out / delete**

```ts
import { pushTokenHandle } from "@/features/notifications/NotificationsProvider";
// ...
  async function signOut(): Promise<void> {
    await pushTokenHandle.current(); // 토큰을 먼저 지운다 — 세션이 사라지면 못 지운다
    await api.auth.logout();
    await purchases.logOut().catch(() => {});
    setState({ status: "guest" });
  }

  async function deleteAccount(): Promise<void> {
    await pushTokenHandle.current();
    await api.auth.deleteAccount();
    await purchases.logOut().catch(() => {});
    setState({ status: "guest" });
  }
```
(`pushTokenHandle` is a plain module object, so importing it from AuthProvider does not create a React-tree dependency cycle; the provider only assigns `current`.)

- [ ] **Step 5: Typecheck and run the app in mock mode**

Run: `pnpm --filter mobile typecheck`, then start the web preview via `preview_start` (launch.json entry for the mobile web dev server) and confirm the app boots, logs no `useNotifications must be used…` error, and `permission` is `"unavailable"` (web has no Firebase).

Manual check for Review Focus 2 (device only, after Firebase exists): kill the app, send a test push from the Firebase console with data `{bandId, sessionId, type:"session_ready"}`, tap it, and confirm the app lands on the session once.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/app/_layout.tsx apps/mobile/src/features/notifications apps/mobile/src/features/auth/AuthProvider.tsx
git commit -m "feat(mobile): NotificationsProvider — badge count, permission prompt, token sync, deep links"
```

---

### Task 5: Alerts tab and Notification sheet

**Files:**
- Modify: `apps/mobile/src/ui/TabBar.tsx`, `apps/mobile/app/(tabs)/_layout.tsx`
- Create: `apps/mobile/src/features/notifications/NotificationSheet.tsx`, `NotificationRow.tsx`

**Interfaces:**
- `TabKey = "sessions" | "band" | "alerts" | "me"`; `TabBar` gets `alerts: { unread: number }`.
- `NotificationSheet({ visible, onClose, onOpenSettings })`.

- [ ] **Step 1: TabBar** — change `TabKey`, add prop `alerts: { unread: number }`, and insert the Alerts cell between Band and Me:

```tsx
        {cell(
          "alerts",
          t("notifications.tab"),
          <View style={{ position: "relative", width: 22, height: 20, alignItems: "center", justifyContent: "center" }}>
            <Svg width={20} height={20} viewBox="0 0 20 20" fill="none">
              <Path d="M4.8 14.5V9a5.2 5.2 0 0 1 10.4 0v5.5l1.4 1.5H3.4z" stroke={fg("alerts")} strokeWidth={1.7} strokeLinejoin="round" strokeLinecap="round" />
              <Path d="M8.2 18.2a1.9 1.9 0 0 0 3.6 0" stroke={fg("alerts")} strokeWidth={1.7} strokeLinecap="round" />
            </Svg>
            {alerts.unread > 0 ? (
              <View
                style={{
                  position: "absolute", top: -5, left: 13, minWidth: 16, height: 16, paddingHorizontal: 4, borderRadius: 8,
                  backgroundColor: colors.accent, borderWidth: 2, borderColor: "#1A1C21", alignItems: "center", justifyContent: "center",
                }}
              >
                <AppText style={{ fontFamily: font.monoSemiBold, fontSize: 9, color: "#0B0C0E", lineHeight: 11 }}>{alerts.unread > 9 ? "9+" : String(alerts.unread)}</AppText>
              </View>
            ) : null}
          </View>,
        )}
```
Use `useTranslation` for labels (`Sessions`/`Band`/`Me` can stay literal as today; only the new one needs `t`). Import `font` from `@/theme`.

- [ ] **Step 2: TabsLayout**

```tsx
  const { unreadCount, sheetOpen, setSheetOpen } = useNotifications();
  const active: TabKey = sheetOpen ? "alerts" : pathname.startsWith("/band") ? "band" : pathname.startsWith("/me") ? "me" : "sessions";
  const go = (tab: TabKey) => {
    if (tab === "alerts") {
      setSheetOpen(!sheetOpen);
      return;
    }
    setSheetOpen(false);
    router.navigate(tab === "sessions" ? "/" : `/${tab}`);
  };
  // ...
          <TabBar active={active} alerts={{ unread: unreadCount }} me={...} onPressTab={go} onPressRecord={() => { setSheetOpen(false); setNewSessionOpen(true); }} />
  // ...
      <NotificationSheet visible={sheetOpen} onClose={() => setSheetOpen(false)} onOpenSettings={() => { setSheetOpen(false); router.push("/notifications?from=sheet"); }} />
```
(Rename the existing `sheetOpen` state for `NewSessionSheet` to `newSessionOpen` to avoid the clash.)

- [ ] **Step 3: `NotificationRow.tsx`**

```tsx
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { font, useTheme } from "@/theme";
import { AppText, PressableOpacity } from "@/ui";
import type { NotificationView } from "./notificationView";

/** 인박스 한 줄 (디자인 Notification sheet 항목). 문구는 kind별 i18n 키로 조립 */
export function NotificationRow({ view, onPress }: { view: NotificationView; onPress: () => void }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const actor = view.actorName ?? t("notifications.formerMember");
  const target = view.targetName ?? t("notifications.original");
  const title =
    view.kind === "session_ready_self" ? t("notifications.sessionReadySelf")
    : view.kind === "session_ready" ? t("notifications.sessionReady", { actor })
    : view.kind === "reply" ? t("notifications.replied", { actor, target })
    : t("notifications.commented", { actor, target });
  const body = view.kind.startsWith("session_ready") ? `${view.body} · ${view.takeCount === 1 ? t("notifications.takeFound") : t("notifications.takesFound", { n: view.takeCount })}` : view.body;
  return (
    <PressableOpacity onPress={onPress} style={{ flexDirection: "row", gap: 12, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: colors.border }}>
      <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors.borderStrong, alignItems: "center", justifyContent: "center" }}>
        <AppText style={{ fontFamily: font.mono, fontSize: 13, color: colors.textSecondary }}>{view.initial}</AppText>
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
          <AppText style={{ flex: 1, fontSize: 15, lineHeight: 20, color: view.unread ? colors.text : colors.textSecondary, fontWeight: view.unread ? "600" : "400" }}>{title}</AppText>
          <AppText style={{ fontFamily: font.mono, fontSize: 11, color: colors.textFaint }}>{view.when === "now" ? t("notifications.now") : view.when}</AppText>
        </View>
        <AppText style={{ fontSize: 14, lineHeight: 20, color: colors.textSecondary }}>{body}</AppText>
        <AppText style={{ fontFamily: font.mono, fontSize: 11, color: colors.textFaint }}>{view.meta}</AppText>
      </View>
      <View style={{ width: 8, paddingTop: 7 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent, opacity: view.unread ? 1 : 0 }} />
      </View>
    </PressableOpacity>
  );
}
```

- [ ] **Step 4: `NotificationSheet.tsx`**

```tsx
import type { NotificationItem } from "@bandapp/types";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal, Pressable, ScrollView, View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { useApi } from "@/api";
import { useAuth } from "@/features/auth/AuthProvider";
import { useCurrentBand } from "@/features/band/useCurrentBand";
import { font, radius, useTheme } from "@/theme";
import { AppText, MonoLabel, PressableOpacity } from "@/ui";
import { NotificationRow } from "./NotificationRow";
import { useNotifications } from "./NotificationsProvider";
import { groupByDay, notificationView } from "./notificationView";

const SHEET_HEIGHT = 640;

/** 디자인 "Notification sheet" (2026-10-12): 현재 밴드 인박스, TODAY/EARLIER, 6개씩 더 보기 */
export function NotificationSheet({ visible, onClose, onOpenSettings }: { visible: boolean; onClose: () => void; onOpenSettings: () => void }) {
  const api = useApi();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { band } = useCurrentBand();
  const { state } = useAuth();
  const meId = state.status === "authenticated" ? state.user.id : "";
  const { open, refresh } = useNotifications();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [unread, setUnread] = useState(0);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(
    async (next?: string) => {
      if (!band) return;
      const page = await api.notifications.list(band.id, next);
      setItems((prev) => (next ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setRemaining(page.remaining);
      setUnread(page.unreadCount);
      setLoaded(true);
    },
    [api, band],
  );

  useEffect(() => {
    if (!visible) return;
    setLoaded(false);
    load().catch((e) => console.warn("notifications load failed", e));
  }, [visible, load]);

  const now = useMemo(() => new Date(), [items]);
  const groups = useMemo(() => groupByDay(items.map((i) => notificationView(i, meId, now)), now), [items, meId, now]);
  const bandId = band?.id ?? "";

  const markAllRead = async () => {
    await api.notifications.markAllRead(bandId);
    const at = new Date().toISOString();
    setItems((prev) => prev.map((i) => (i.readAt ? i : { ...i, readAt: at })));
    setUnread(0);
    refresh();
  };

  return (
    <Modal transparent visible={visible} animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)" }} onPress={onClose} />
      <View style={{ height: SHEET_HEIGHT, backgroundColor: colors.surface, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet }}>
        <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: colors.borderStronger, alignSelf: "center", marginTop: 10 }} />
        <View style={{ paddingHorizontal: 20, paddingTop: 14, paddingBottom: 8, flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <View style={{ gap: 4 }}>
            <AppText style={{ fontSize: 20, fontWeight: "700", color: colors.text }}>{t("notifications.title")}</AppText>
            <AppText style={{ fontFamily: font.mono, fontSize: 11, letterSpacing: 1.8, color: colors.textMuted }}>{band?.name.toUpperCase()}</AppText>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
            {unread > 0 ? (
              <PressableOpacity onPress={() => void markAllRead()}>
                <AppText style={{ fontSize: 14, color: colors.accent }}>{t("notifications.markAllRead")}</AppText>
              </PressableOpacity>
            ) : null}
            <PressableOpacity onPress={onOpenSettings} accessibilityLabel={t("notifications.settings")} style={{ width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: colors.borderStronger, alignItems: "center", justifyContent: "center" }}>
              <Svg width={16} height={16} viewBox="0 0 16 16" fill="none">
                <Path d="M2.5 4.5h11M2.5 11.5h11" stroke={colors.textSecondary} strokeWidth={1.4} strokeLinecap="round" />
                <Circle cx={10.5} cy={4.5} r={1.8} stroke={colors.textSecondary} strokeWidth={1.4} fill={colors.surface} />
                <Circle cx={5.5} cy={11.5} r={1.8} stroke={colors.textSecondary} strokeWidth={1.4} fill={colors.surface} />
              </Svg>
            </PressableOpacity>
          </View>
        </View>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }}>
          {loaded && items.length === 0 ? (
            <View style={{ paddingVertical: 80, paddingHorizontal: 20, alignItems: "center", gap: 8 }}>
              <AppText style={{ fontSize: 16, fontWeight: "600", color: colors.text }}>{t("notifications.emptyTitle")}</AppText>
              <AppText style={{ fontSize: 14, lineHeight: 21, color: colors.textMuted, textAlign: "center" }}>{t("notifications.emptyBody", { band: band?.name ?? "" })}</AppText>
            </View>
          ) : null}
          {groups.map((g) => (
            <View key={g.label}>
              <MonoLabel style={{ paddingTop: 18, paddingBottom: 4, letterSpacing: 1.6 }}>{t(g.label === "today" ? "notifications.today" : "notifications.earlier")}</MonoLabel>
              {g.items.map((v) => (
                <NotificationRow key={v.id} view={v} onPress={() => void open({ ...v.target, bandId })} />
              ))}
            </View>
          ))}
          {cursor ? (
            <PressableOpacity onPress={() => void load(cursor)} style={{ marginTop: 16, borderWidth: 1, borderColor: colors.borderStronger, borderRadius: radius.input, padding: 12, alignItems: "center" }}>
              <AppText style={{ fontSize: 14, color: colors.textSecondary }}>{t("notifications.showOlder", { n: remaining })}</AppText>
            </PressableOpacity>
          ) : loaded && items.length > 6 ? (
            <AppText style={{ paddingTop: 18, textAlign: "center", fontSize: 13, color: colors.textFaint }}>{t("notifications.last30")}</AppText>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}
```
Reactive `open()` on row press already marks read and navigates; after navigation the provider's `api.subscribe` listener refreshes the badge (HttpApiClient `markRead` emits).

- [ ] **Step 5: Verify in the web preview (mock mode)**

Run `preview_start` for the mobile web server; log in (mock), tap Alerts: expect badge `2`, sheet with TODAY (2 unread) / EARLIER, "Show older (5)", then "Notifications from the last 30 days" after expanding; "Mark all read" zeroes badge; tapping "Minsu commented on Take 1" lands on `/session/s1/take/s1-t0?at=133`. Take a screenshot for the summary.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/ui/TabBar.tsx "apps/mobile/app/(tabs)/_layout.tsx" apps/mobile/src/features/notifications
git commit -m "feat(mobile): Alerts tab with unread badge and notification sheet"
```

---

### Task 6: Notification settings screen and Me row

**Files:**
- Create: `apps/mobile/app/notifications.tsx`, `apps/mobile/src/features/notifications/NotificationSettingsScreen.tsx`, `apps/mobile/src/ui/Toggle.tsx`
- Modify: `apps/mobile/src/ui/index.ts` (export Toggle), `apps/mobile/src/features/me/MeScreen.tsx`

- [ ] **Step 1: `Toggle.tsx`** (design 46×28)

```tsx
import { View } from "react-native";
import { useTheme } from "@/theme";
import { PressableOpacity } from "./PressableOpacity";

export function Toggle({ value, onChange, disabled = false }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const { colors } = useTheme();
  return (
    <PressableOpacity onPress={() => onChange(!value)} disabled={disabled} accessibilityRole="switch" accessibilityState={{ checked: value, disabled }} style={{ width: 46, height: 28, borderRadius: 14, backgroundColor: value ? colors.accent : colors.borderStronger }}>
      <View style={{ position: "absolute", top: 3, left: value ? 21 : 3, width: 22, height: 22, borderRadius: 11, backgroundColor: "#FFFFFF" }} />
    </PressableOpacity>
  );
}
```
Export from `ui/index.ts`.

- [ ] **Step 2: Route** — `app/notifications.tsx`: `export { NotificationSettingsScreen as default } from "@/features/notifications/NotificationSettingsScreen";`

- [ ] **Step 3: `NotificationSettingsScreen.tsx`**

```tsx
import type { NotificationSettings, UpdateNotificationSettingsInput } from "@bandapp/types";
import { DEFAULT_NOTIFICATION_SETTINGS } from "@bandapp/types";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, View } from "react-native";
import { useApi } from "@/api";
import { useCurrentBand } from "@/features/band/useCurrentBand";
import { push } from "@/services/push";
import { font, radius, space, useTheme } from "@/theme";
import { AppText, Avatar, BottomSheet, MonoLabel, PressableOpacity, Screen, SheetActionRow, Toggle, useToast } from "@/ui";
import { useNotifications } from "./NotificationsProvider";
import { settingsSummary } from "./settingsView";
import { useNotificationSettings } from "./useNotificationSettings";

/** 디자인 "Notifications" 설정 화면 (2026-10-12). 밴드별 설정, OS 권한 카드 3종, 토글 즉시 저장 */
export function NotificationSettingsScreen() {
  const { from } = useLocalSearchParams<{ from?: string }>();
  const router = useRouter();
  const api = useApi();
  const toast = useToast();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { band, bands } = useCurrentBand();
  const { permission, requestPermission, setSheetOpen } = useNotifications();
  const { data: all, reload } = useNotificationSettings();
  const [bandId, setBandId] = useState<string | null>(null);
  const [bandsSheet, setBandsSheet] = useState(false);
  /** 낙관적 반영 — 실패하면 서버 값으로 되돌린다 */
  const [local, setLocal] = useState<Record<string, UpdateNotificationSettingsInput>>({});

  useEffect(() => {
    if (!bandId && band) setBandId(band.id);
  }, [band, bandId]);

  const settingsOf = (id: string): UpdateNotificationSettingsInput => local[id] ?? stripBand(all?.find((s) => s.bandId === id)) ?? DEFAULT_NOTIFICATION_SETTINGS;
  const current = bandId ? settingsOf(bandId) : DEFAULT_NOTIFICATION_SETTINGS;
  const currentBand = bands.find((b) => b.id === bandId) ?? band;

  const save = async (patch: Partial<UpdateNotificationSettingsInput>) => {
    if (!bandId) return;
    const before = settingsOf(bandId);
    const next = { ...before, ...patch }; // PUT은 세 필드 모두 — scope는 바뀌지 않아도 같이 보낸다
    setLocal((l) => ({ ...l, [bandId]: next }));
    try {
      await api.notifications.updateSettings(bandId, next);
      reload();
    } catch {
      setLocal((l) => ({ ...l, [bandId]: before }));
      toast.show(t("notificationSettings.saveFailed"));
    }
  };

  const back = () => {
    router.back();
    if (from === "sheet") setSheetOpen(true);
  };
  const ok = permission === "allowed";

  return (
    <Screen>
      <View style={{ paddingHorizontal: 16 }}>
        <PressableOpacity onPress={back} style={{ flexDirection: "row", alignItems: "center", gap: 6, padding: 8, alignSelf: "flex-start" }}>
          <AppText style={{ fontSize: 18, lineHeight: 18, color: colors.textMuted }}>‹</AppText>
          <AppText style={{ fontSize: 14, color: colors.textMuted }}>{t(from === "sheet" ? "notificationSettings.back" : "notificationSettings.backMe")}</AppText>
        </PressableOpacity>
      </View>
      <View style={{ paddingHorizontal: space.screenX, paddingTop: 6, paddingBottom: 18, gap: 6 }}>
        <AppText variant="title">{t("notificationSettings.title")}</AppText>
        <AppText variant="body" style={{ color: colors.textMuted }}>{t("notificationSettings.subtitle")}</AppText>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.screenX, paddingBottom: 60 }}>
        {permission === "ask" ? (
          <Card title={t("notificationSettings.offTitle")} body={t("notificationSettings.offBody")} cta={t("notificationSettings.turnOn")} primary onPress={() => void requestPermission()} />
        ) : permission === "denied" ? (
          <Card title={t("notificationSettings.deniedTitle")} body={t("notificationSettings.deniedBody")} cta={t("notificationSettings.openSettings")} onPress={() => push.openSystemSettings()} />
        ) : permission === "unavailable" ? (
          <Card title={t("notificationSettings.unavailableTitle")} body={t("notificationSettings.unavailableBody")} />
        ) : null}

        <View style={{ opacity: ok ? 1 : 0.35 }} pointerEvents={ok ? "auto" : "none"}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingBottom: 22 }}>
            <PressableOpacity onPress={() => setBandsSheet(true)} style={{ flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 16, paddingVertical: 7, paddingHorizontal: 12 }}>
              <AppText style={{ fontFamily: font.mono, fontSize: 11, letterSpacing: 1.8, color: colors.textSecondary }}>{currentBand?.name.toUpperCase()}</AppText>
              <AppText style={{ fontSize: 8, color: colors.textFaint }}>▼</AppText>
            </PressableOpacity>
            <AppText variant="caption">{t("notificationSettings.forThisBand")}</AppText>
          </View>
          <MonoLabel style={{ paddingBottom: 4, letterSpacing: 1.6 }}>{t("notificationSettings.notifyWhen")}</MonoLabel>
          <Row title={t("notificationSettings.sessionReady")} hint={t("notificationSettings.sessionReadyHint")} value={current.sessionReady} onChange={(v) => void save({ sessionReady: v })} />
          <Row title={t("notificationSettings.comments")} hint={t("notificationSettings.commentsHint")} value={current.comments} onChange={(v) => void save({ comments: v })} />
          {current.comments ? (
            <View style={{ paddingLeft: 14, paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: colors.border }}>
              {(["all", "mine"] as const).map((scope) => (
                <PressableOpacity key={scope} onPress={() => void save({ commentScope: scope })} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingVertical: 12 }}>
                  <AppText style={{ fontSize: 14, color: current.commentScope === scope ? colors.text : colors.textMuted }}>{t(scope === "all" ? "notificationSettings.scopeAll" : "notificationSettings.scopeMine")}</AppText>
                  <AppText style={{ fontSize: 15, color: colors.accent, opacity: current.commentScope === scope ? 1 : 0 }}>✓</AppText>
                </PressableOpacity>
              ))}
            </View>
          ) : null}
        </View>
      </ScrollView>

      <BottomSheet visible={bandsSheet} onClose={() => setBandsSheet(false)} title={t("notificationSettings.bandsSheet")}>
        {bands.map((b) => (
          <SheetActionRow
            key={b.id}
            icon={<Avatar label={b.name[0] ?? "?"} size={40} />}
            title={b.name}
            subtitle={t(`notificationSettings.summary.${settingsSummary(settingsOf(b.id))}`)}
            onPress={() => { setBandId(b.id); setBandsSheet(false); }}
            trailing={b.id === bandId ? <AppText style={{ fontSize: 16, color: colors.accent }}>✓</AppText> : undefined}
          />
        ))}
      </BottomSheet>
    </Screen>
  );
}

function stripBand(s: NotificationSettings | undefined): UpdateNotificationSettingsInput | undefined {
  return s ? { sessionReady: s.sessionReady, comments: s.comments, commentScope: s.commentScope } : undefined;
}

function Row({ title, hint, value, onChange }: { title: string; hint: string; value: boolean; onChange: (v: boolean) => void }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 16, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: colors.border }}>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <AppText style={{ fontSize: 15, color: colors.text }}>{title}</AppText>
        <AppText style={{ fontSize: 13, lineHeight: 19, color: colors.textMuted }}>{hint}</AppText>
      </View>
      <Toggle value={value} onChange={onChange} />
    </View>
  );
}

function Card({ title, body, cta, primary = false, onPress }: { title: string; body: string; cta?: string; primary?: boolean; onPress?: () => void }) {
  const { colors } = useTheme();
  return (
    <View style={{ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 14, padding: 18, gap: 12, marginBottom: 22 }}>
      <AppText style={{ fontSize: 16, fontWeight: "600", color: colors.text }}>{title}</AppText>
      <AppText style={{ fontSize: 14, lineHeight: 21, color: colors.textSecondary }}>{body}</AppText>
      {cta && onPress ? (
        <PressableOpacity onPress={onPress} style={{ borderRadius: radius.input, padding: 13, alignItems: "center", backgroundColor: primary ? colors.accent : "transparent", borderWidth: primary ? 0 : 1, borderColor: colors.borderStronger }}>
          <AppText style={{ fontSize: 14, fontWeight: "600", color: primary ? "#0B0C0E" : colors.text }}>{cta}</AppText>
        </PressableOpacity>
      ) : null}
    </View>
  );
}
```
Permission re-read on returning from iOS Settings is already handled by the provider's `AppState` listener (`refreshPermission`).

- [ ] **Step 4: Me row** — in `MeScreen.tsx` import `useNotifications`, `useNotificationSettings`, `meNfValue`; compute
```tsx
  const { permission } = useNotifications();
  const { data: nfSettings } = useNotificationSettings();
  const nf = meNfValue(permission, nfSettings ?? []);
  const nfValue = nf.kind === "on" ? t("me.nfOn") : nf.kind === "off" ? t("me.nfOff") : t("me.nfPartial", { on: nf.on, total: nf.total });
```
and render between the subscription card and SUPPORT:
```tsx
        <MonoLabel style={{ paddingTop: 32, paddingBottom: 4, letterSpacing: 1.6 }}>{t("me.settings")}</MonoLabel>
        <ListRow title={t("me.notifications")} value={nfValue} chevron onPress={() => router.push("/notifications")} />
```
Extend `ListRow` with an optional `value?: string` rendered before the chevron (`<AppText style={{ fontSize: 14, color: colors.textMuted }}>{value}</AppText>`).

- [ ] **Step 5: Verify in web preview**: Me shows SETTINGS › Notifications "Off" (web = unavailable); open it → unavailable card, dimmed body; band dropdown lists both mock bands with summaries; toggling (still possible in mock? body is dimmed when not allowed — temporarily confirm with `permission` forced to `"allowed"` in dev or test on device later). Screenshot.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/app/notifications.tsx apps/mobile/src/ui apps/mobile/src/features/notifications apps/mobile/src/features/me/MeScreen.tsx
git commit -m "feat(mobile): notification settings screen and Me › Notifications row"
```

---

### Task 7: Take screen read marks + `at` deep link, docs

**Files:**
- Modify: `apps/mobile/src/features/takes/TakePlayerScreen.tsx`
- Modify: `README.md` (mobile section), memory/docs as needed

- [ ] **Step 1: TakePlayerScreen**

Read `at` from params and mark read on open:
```tsx
  const { id, takeId, at } = useLocalSearchParams<{ id: string; takeId: string; at?: string }>();
  // ...after `target` is defined:
  // 이 대상의 코멘트를 "지금까지 봤다"로 기록 (2026-10-12 스펙 결정 13). 대상이 바뀔 때 한 번
  const targetKey = target ? ("takeId" in target ? `take:${target.takeId}` : `session:${target.sessionId}`) : null;
  useEffect(() => {
    if (!target) return;
    api.comments.markRead(target).catch((e) => console.warn("markRead failed", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey, api]);

  // 알림에서 들어온 시점으로 한 번만 이동 — 오디오 URL과 take 길이가 준비된 뒤
  const seeked = useRef(false);
  useEffect(() => {
    const sec = at !== undefined ? Number(at) : NaN;
    if (seeked.current || !take || !url || !Number.isFinite(sec)) return;
    seeked.current = true;
    playback.seekTo(Math.max(0, sec - 5)); // 코멘트 탭과 같은 5초 전 (디자인 pos)
  }, [at, take, url, playback]);
```
(Import `useRef` if not present.) If `playback.seekTo` before the player has loaded is ignored by expo-audio, move the seek into `usePlayback`'s status listener on first `isLoaded` — verify on device/web.

- [ ] **Step 2: Web check**: open `/session/s1/take/s1-t0?at=133` in the preview → position jumps to ~02:08; go back to the session → Take 1 `unreadCommentCount` is 0 (Mock). Screenshot.

- [ ] **Step 3: README** — in the mobile section add: "알림: 하단 Alerts 탭(현재 밴드 인박스), Me › Notifications 설정(밴드별), FCM 푸시는 `GOOGLE_SERVICES_JSON/PLIST`가 있을 때만 빌드에 포함". Note the rebuild requirement.

- [ ] **Step 4: Full checks and commit**

Run: `pnpm --filter mobile typecheck && pnpm --filter mobile test && pnpm --filter @bandapp/api-client exec vitest run`
Expected: PASS.

```bash
git add apps/mobile/src/features/takes/TakePlayerScreen.tsx README.md
git commit -m "feat(mobile): mark comments read on take screen, seek to notified position"
```

---

## Manual follow-ups (user; not automatable)

1. Firebase project → register iOS/Android apps (`com.projectn.taken`) → download `google-services.json` / `GoogleService-Info.plist` into `apps/mobile/` → set paths in `apps/mobile/.env`.
2. Apple Developer → APNs key → upload to Firebase Cloud Messaging settings.
3. Service account JSON → server `FIREBASE_SERVICE_ACCOUNT_JSON` (local `.env`, Fargate task secrets for api + worker).
4. Rebuild dev client (`pnpm --filter mobile android` via the `B:` subst workflow; iOS on a Mac) and test on a real device: permission prompt on first band, token row appears in `push_tokens`, comment from another member arrives as banner, tap deep-links to the take at the comment time, cold-start tap works.

## Self-review notes

- Spec coverage: api-client (T1), i18n + pure helpers (T2), push wrapper + build config (T3), provider/token/deep link/first prompt (T4), tab + sheet (T5), settings + Me row (T6), read marks + `at` + docs (T7).
- Review Focus: 1 → T4 `open()` switches band and toasts on 403/404; 2 → T4 pending effect + manual check; 3 → T2 `groupByDay` test with 23:50; 4 → T5 `markAllRead` zeroes `unread`, refreshes provider, and T1 Mock test; 5 → T6 `save()` always sends all three fields, T1 Mock validation.
- Names consistent across tasks: `useNotifications`, `NotificationsProvider`, `pushTokenHandle`, `push.*`, `notificationView/groupByDay/whenLabel`, `settingsSummary/meNfValue`, `parsePushData/targetOf/routeFor/PendingTarget`, `useNotificationSettings`, `TabKey "alerts"`, route `/notifications?from=sheet`, query `?at=<sec>`.
