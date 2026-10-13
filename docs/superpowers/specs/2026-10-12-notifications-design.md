# 알림(인박스 · 푸시 · 설정) · 코멘트 읽음 설계

## 목표

Claude Design "Rehersal app"에 2026-10-12 추가된 알림 화면을 구현하고, 코멘트에 "내가 읽었는지" 상태를 붙인다.

- **Alerts 탭**: 하단 탭바가 Sessions · Band · Alerts · Me 4탭. 벨 아이콘에 미읽음 배지(`9+`).
- **Notification sheet**: 현재 밴드의 인박스. TODAY / EARLIER 그룹, 6개씩 "Show older (n)", 미읽음 점, "Mark all read", 톱니 → 설정 화면, 바닥에 "Notifications from the last 30 days". 항목을 누르면 세션 상세 또는 테이크 피드백 화면의 해당 시점으로 이동하고 읽음 처리.
- **Notification settings** (Me › SETTINGS › Notifications): 밴드 드롭다운(밴드별 설정), "A session is ready" 토글, "Someone comments" 토글 + 범위(All comments and replies / Only replies to my comments). OS 권한 상태 3가지(안 물어봄 → "Turn on notifications", 거부 → "Open Settings", 허용). Me 행에는 "On / Off / 2 of 4 bands" 요약.
- **알림 종류 2개**: 세션 분석 완료, 코멘트/답글.
- **푸시**: Firebase Cloud Messaging. Firebase 프로젝트는 아직 없으므로 자격 증명이 없을 때도 인박스·배지·설정·읽음이 전부 동작하고, 나중에 키만 넣으면 푸시가 켜지는 구조로 만든다.
- **코멘트 읽음**: 유저 기준 "내가 안 읽은 코멘트"(A안). 읽음 확인(누가 읽었는지, read receipt)은 하지 않는다. 데이터와 API만 만들고 코멘트 목록의 표시는 이번 범위에서 뺀다.

## 결정 사항

1. **수신자당 1행(fan-out on write).** 읽음·수신 여부·종류가 사람마다 달라서다. 밴드는 3~6명 규모라 행 수 부담이 없다. 사건 1행 + 사람별 상태(fan-out on read)는 설정을 나중에 켰을 때 과거 사건이 소급 노출되어 디자인("off면 기록 안 함")과 어긋난다.
2. **설정이 off면 인박스 행도 만들지 않는다** (디자인 프로토타입 `nfBlock` 그대로). 나중에 켜도 과거 알림은 없다.
3. **session_ready 수신자에 업로더 본인 포함.** 처리 중 앱을 닫아도 푸시로 안다. 본인에게는 "Your recording is ready"로 렌더한다. 같은 `sessionReady` 토글을 따른다.
4. **인박스·배지는 현재 밴드 기준.** 디자인 시트 헤더에 밴드명이 있고 설정도 밴드별이다. 푸시는 다른 밴드 것일 수 있으므로 열 때 접근 확인을 거친 뒤 현재 밴드를 바꾼다(죽은 알림이 밴드를 바꾸지 않도록).
5. **알림 생성은 이벤트 지점에서 즉시** (코멘트 생성 직후, 세션 ready 커밋 직후). 아웃박스·큐는 두지 않되 "수신자 계산 + 행 생성"과 "발송"을 분리된 메서드로 두어 나중에 옮길 수 있게 한다.
6. **푸시 SDK는 `@react-native-firebase/messaging` + 서버 `firebase-admin`.** Expo Push Service는 쓰지 않는다. iOS는 Firebase 콘솔에 APNs 키를 올려 FCM이 중계한다.
7. **푸시 문구는 서버가 만든다.** 사용자 언어를 모르므로 기기 토큰에 `locale`을 저장해 en/ko 템플릿을 고른다. 인박스 문구는 클라이언트 i18n이 만든다(구조화된 응답).
8. **제목·본문을 저장하지 않고 조회 시 join으로 렌더한다.** 코멘트 수정이면 최신 본문, 코멘트/테이크/세션 삭제면 알림도 cascade로 사라져 깨진 링크가 생기지 않는다.
9. **30일 보존.** 크론 없이 목록 조회 때 그 사용자의 30일 지난 행을 지운다.
10. **OS 권한은 첫 밴드 진입 직후 한 번 묻는다** (디자인 갭). 디자인은 설정 화면의 "Turn on notifications"에서만 묻는데, 그러면 설정 화면에 안 들어간 사람은 영영 푸시를 못 받는다. 거부하면 다시 묻지 않고 설정 화면의 안내 카드("Blocked in iOS Settings" → Open Settings)에 맡긴다.
11. **포그라운드에서는 배너 없이 배지·인박스만 갱신한다.** 디자인의 `showPush` 배너는 OS 배너를 흉내 낸 것이다. iOS는 앱이 켜져 있으면 기본적으로 배너를 띄우지 않고, 인앱 배너는 추가 작업(notifee 등)이라 범위에서 뺀다.
12. **앱 아이콘 배지 숫자는 넣지 않는다.** 밴드가 여럿일 때 의미가 애매하고 디자인에도 없다.
13. **코멘트 "읽음"의 단위는 대상(테이크 또는 원본 녹음)별 "여기까지 봤다" 시각 1개.** 테이크/원본 화면을 열 때 now()로 갱신한다. 코멘트별 읽음 행은 두지 않는다.
14. **`unavailable`(Firebase 없는 빌드)에서도 설정 화면은 쓸 수 있다.** 토글이 인박스 행도 거르므로(결정 2) 푸시를 못 받는 빌드에서도 의미가 있다. 막는 것은 `ask`/`denied`뿐이고, Me 행 값도 `unavailable`이면 설정 그대로 보여 준다.

## 데이터

마이그레이션 0013. 테이블 4개 추가, 응답 타입 필드 추가.

**`notification_settings`** — 밴드별 알림 설정. 행이 없으면 기본값(전부 on, scope all). 처음 바꿀 때 upsert.

| 컬럼 | 설명 |
|---|---|
| `user_id` uuid, `band_id` uuid | 복합 PK. FK `(band_id, user_id)` → `band_members(band_id, user_id)` ON DELETE CASCADE — 밴드를 나가거나 쫓겨나면 설정도 사라진다 |
| `session_ready` bool not null default true | "A session is ready" |
| `comments` bool not null default true | "Someone comments" |
| `comment_scope` enum `notification_comment_scope` (`all`, `mine`) not null default `all` | "Only replies to my comments" |
| `updated_at` timestamptz | |

**`notifications`** — 인박스. 수신자 1명당 1행.

| 컬럼 | 설명 |
|---|---|
| `id` uuid PK | |
| `user_id` uuid FK users cascade | 수신자 |
| `band_id` uuid FK bands cascade | |
| `type` enum `notification_type` (`session_ready`, `comment`, `reply`) | `reply` = 수신자의 최상위 코멘트에 달린 답글. 남의 코멘트에 달린 답글은 수신자 입장에서 `comment` |
| `actor_id` uuid FK users set null | 업로더·코멘트 작성자. null이면 "탈퇴한 멤버" |
| `session_id` uuid FK sessions cascade not null | |
| `take_id` uuid FK takes cascade null | 원본 녹음 코멘트·session_ready면 null |
| `comment_id` uuid FK comments cascade null | session_ready면 null |
| `read_at` timestamptz null | 미읽음 = null |
| `created_at` timestamptz | |

인덱스 `(user_id, band_id, created_at desc, id desc)`.

**`push_tokens`** — 기기 토큰.

| 컬럼 | 설명 |
|---|---|
| `token` text PK | FCM 토큰. 같은 토큰이 다른 계정으로 로그인하면 `user_id`가 덮어써진다 |
| `user_id` uuid FK users cascade | |
| `platform` enum `push_platform` (`ios`, `android`) | |
| `locale` text not null | 기기 언어 태그(`en`, `ko`, …). 템플릿은 앞 두 글자로 고르고 없으면 `en` |
| `created_at`, `last_seen_at` timestamptz | upsert마다 `last_seen_at` 갱신 |

FCM이 `messaging/registration-token-not-registered` 또는 `messaging/invalid-argument`를 돌려주면 행을 삭제한다.

**`comment_read_marks`** — 코멘트 읽음(A안).

| 컬럼 | 설명 |
|---|---|
| `user_id` uuid FK users cascade | |
| `session_id` uuid FK sessions cascade not null | |
| `take_id` uuid FK takes cascade null | 원본 녹음 코멘트는 null |
| `read_at` timestamptz not null | |

유니크 인덱스 `(user_id, session_id, take_id) NULLS NOT DISTINCT` (PG 17, docker-compose는 `postgres:17`). PK 대신 유니크 인덱스를 쓰는 이유는 `take_id`가 null일 수 있어서다.

**응답 타입 변경** (`@bandapp/types`)

- `TakeComment.unread: boolean` — `created_at > 내 read_at`(마크 없으면 전부)이고 작성자가 내가 아님.
- `Take.unreadCommentCount: number`, `Session.unreadCommentCount: number` — 같은 규칙으로 센 수. 세션은 모든 테이크 + 원본 합계.
- 새 타입:

```ts
type NotificationType = "session_ready" | "comment" | "reply";

interface NotificationItem {
  id: string;
  type: NotificationType;
  /** null = 탈퇴한 멤버 */
  actor: { id: string; name: string | null } | null;
  session: { id: string; title: string; name: string | null; startedAt: string; takeCount: number; durationSec: number };
  /** 원본 녹음 코멘트·session_ready면 null */
  take: { id: string; index: number; name: string } | null;
  /** session_ready면 null */
  comment: { id: string; atSec: number; text: string } | null;
  readAt: string | null;
  createdAt: string;
}

interface NotificationPage {
  items: NotificationItem[];
  /** 더 없으면 null */
  nextCursor: string | null;
  /** 이 페이지 뒤에 남은 개수 — "Show older (n)" */
  remaining: number;
  /** 밴드 기준 미읽음 수 */
  unreadCount: number;
}

type CommentScope = "all" | "mine";

interface NotificationSettings {
  bandId: string;
  sessionReady: boolean;
  comments: boolean;
  commentScope: CommentScope;
}

interface RegisterPushTokenInput {
  token: string;
  platform: "ios" | "android";
  locale: string;
}
```

## 서버

`NotificationsModule`(현재 빈 모듈)을 채우고 `AppModule`·`WorkerModule` 둘 다에서 import한다.

### NotificationsService — 생성·조회

- `onCommentCreated(comment: TakeComment)` — `CommentsService.create`가 insert 뒤 호출. 수신자 = 밴드 멤버 − 작성자. 답글이면 부모 코멘트 작성자에게는 `reply`, 나머지에게는 `comment`. 설정 필터: `comments=false`면 제외, `commentScope=mine`이면 `reply`만 통과.
- `onSessionReady(sessionId: string)` — 워커가 ready 트랜잭션 **커밋 뒤** 호출. 수신자 = 밴드 멤버 전원(업로더 포함). `sessionReady=false`면 제외.
- 둘 다 `notifications` 행을 bulk insert한 뒤 `PushSender`에 넘긴다. 원래 작업과 분리된다 — 코멘트는 이미 저장됐고 세션은 이미 ready이므로, 여기서 실패하면 `logger.error`만 남기고 호출자에게 던지지 않는다. 호출자는 `void notifications.onX(...).catch(...)`가 아니라 서비스 안에서 try/catch로 삼킨 결과를 `await`한다(테스트에서 순서를 보장하기 위해).
- 수신자 계산·타입 결정·설정 필터는 DB 없는 순수 함수 `fanout.ts`로 뺀다: `(event, members, settingsByUser) → Array<{ userId, type }>`.
- 조회: `list(bandId, userId, cursor, limit)`, `unreadCount(bandId, userId)`, `markRead(id, userId)`, `markAllRead(bandId, userId)`. `list`는 먼저 `DELETE FROM notifications WHERE user_id = ? AND created_at < now() - interval '30 days'`를 실행한다.
- 커서는 `created_at`·`id`를 base64url로 묶은 불투명 문자열. `remaining`은 커서 뒤 행 수 count.
- `actor.name`은 `users.display_name`(null 가능). 행위자 행이 없으면(`actor_id` null) `actor: null`.

### PushSender

```ts
interface PushMessage {
  title: string;
  body: string;
  data: Record<string, string>; // notificationId, bandId, sessionId, type, takeId?, atMs?
}
interface PushSender {
  /** 수신자 1명의 토큰 묶음에 메시지 1개. 서비스가 locale별로 묶어 호출한다 */
  send(tokens: string[], message: PushMessage): Promise<{ invalidTokens: string[] }>;
}
```

- `FirebasePushSender`: `firebase-admin` `messaging().sendEachForMulticast`. 서비스가 수신자·locale별로 문구를 만들어 넘긴다. `FIREBASE_SERVICE_ACCOUNT_JSON`(서비스 계정 JSON을 한 줄로, Apple 키와 같은 방식)이 있을 때만 provider가 이걸 고른다.
- `LogPushSender`: 환경변수가 없으면 이것. 수신 토큰 수·제목·본문을 `logger.log`로 남긴다. Firebase 없이도 전체 흐름이 도는 이유.
- 문구는 `push-text.ts` 순수 함수. en/ko 두 템플릿, 인박스 문구(모바일 `notificationText.ts`)와 같은 규칙:

| type | 제목 | 본문 |
|---|---|---|
| `session_ready` (타인) | `{actor}'s recording is ready` | `{session.name ?? title} · {takeCount} takes found` |
| `session_ready` (본인) | `Your recording is ready` | 같음 |
| `comment` | `{actor} commented on {take.name ?? "the original recording"}` | `“{text}”` |
| `reply` | `{actor} replied to you on {take.name ?? "the original recording"}` | `“{text}”` |

actor가 null이면 "탈퇴한 멤버"(ko) / "A former member"(en), display_name이 null이면 `?`.

- 메시지는 `notification {title, body}` + `data`. `data`의 모든 값은 문자열. `atMs`는 코멘트 `at_ms`.

### PushTokensService

`upsert(userId, input)` (토큰 PK 충돌 시 `user_id`·`platform`·`locale`·`last_seen_at` 갱신), `remove(token)` (없어도 성공), `forUsers(userIds)`.

### 코멘트 읽음

- `CommentsService.markRead(scope, userId)` — `comment_read_marks` upsert (`ON CONFLICT (user_id, session_id, take_id) DO UPDATE SET read_at = now()`).
- `list`는 내 마크를 한 번 읽어 각 코멘트에 `unread`를 붙인다.
- `Take.unreadCommentCount` / `Session.unreadCommentCount`는 기존 `commentCount` 서브쿼리 옆에 마크를 left join한 서브쿼리로 센다: `author_id <> me AND (mark.read_at IS NULL OR c.created_at > mark.read_at)`.

### 엣지

- 코멘트 삭제 → 알림 cascade. 재분석으로 생성 take가 지워지면 그 take의 코멘트·알림·읽음 마크도 cascade. 수동 take는 남는다.
- 알림을 눌렀는데 코멘트가 이미 삭제됨 → 행 자체가 cascade로 없어 목록에 나오지 않는다. 세션 알림은 세션이 있으면 항상 유효.
- 워커 중복 전달: ready 업데이트가 0행이면 `StaleSessionError`로 끝나므로 `onSessionReady`는 성공한 한 번만 호출된다.
- 밴드 비멤버의 알림 조회·설정 변경 → 403(`memberships.assertMember`). 남의 알림 `read` → 404.

## API

전부 인증 필요. 경로는 기존 관례(`/bands/:id/...`, `/me/...`, 리소스 단독)를 따른다.

**인박스**

| 메서드 | 경로 | 설명 |
|---|---|---|
| `GET /bands/:id/notifications?cursor=&limit=` | → `NotificationPage` | 멤버만. `limit` 기본 6, 최대 50. 30일 이내만. 호출 때 그 사용자의 더 오래된 행 삭제 |
| `GET /bands/:id/notifications/unread-count` | → `{ count }` | 탭 배지용 |
| `POST /notifications/:id/read` | → 204 | 내 알림만(아니면 404). 이미 읽었어도 204 |
| `POST /bands/:id/notifications/read-all` | → 204 | "Mark all read" |

**설정**

| 메서드 | 경로 | 설명 |
|---|---|---|
| `GET /me/notification-settings` | → `NotificationSettings[]` | 내 모든 밴드. 행이 없는 밴드는 기본값으로 채운다. Me 행 요약과 설정 화면 밴드 시트가 한 번에 쓴다 |
| `PUT /bands/:id/notification-settings` | `{ sessionReady, comments, commentScope }` → `NotificationSettings` | 멤버만. 세 필드 모두 필수(전체 교체) |

밴드별 GET은 만들지 않는다.

**푸시 토큰**

| 메서드 | 경로 | 설명 |
|---|---|---|
| `PUT /me/push-tokens` | `RegisterPushTokenInput` → 204 | upsert. 다른 계정에 묶여 있던 토큰이면 내 것으로 바뀐다 |
| `DELETE /me/push-tokens/:token` | → 204 | 로그아웃·탈퇴 직전에 호출. 내 토큰이 아니어도 204 |

**코멘트 읽음**

| 메서드 | 경로 | 설명 |
|---|---|---|
| `POST /takes/:id/comments/read` | → 204 | 테이크 화면을 열 때 |
| `POST /sessions/:id/comments/read` | → 204 | 원본 녹음 화면을 열 때 |

기존 응답 변경: `GET .../comments` 각 항목에 `unread`, `Take`·`Session`에 `unreadCommentCount`.

**api-client** — `RehearsalApiClient`에 추가:

```ts
notifications: {
  list(bandId: string, cursor?: string): Promise<NotificationPage>;
  unreadCount(bandId: string): Promise<number>;
  markRead(id: string): Promise<void>;
  markAllRead(bandId: string): Promise<void>;
  settings(): Promise<NotificationSettings[]>;
  updateSettings(bandId: string, input: Omit<NotificationSettings, "bandId">): Promise<NotificationSettings>;
  registerPushToken(input: RegisterPushTokenInput): Promise<void>;
  removePushToken(token: string): Promise<void>;
};
comments: { ...기존; markRead(target: CommentTarget): Promise<void> };
```

`markRead`·`markAllRead`·`updateSettings` 뒤에 `emit()`. `MockApiClient`에는 디자인 샘플과 같은 모양의 인박스 11건(TODAY 2건 미읽음, EARLIER 9건)과 밴드별 설정을 넣어 서버 없이 UI를 볼 수 있게 한다.

## 모바일

### 패키지·빌드

- `@react-native-firebase/app`, `@react-native-firebase/messaging`, `expo-build-properties`(iOS `useFrameworks: "static"`, react-native-firebase 요구사항). 네이티브 모듈이라 **dev client 재빌드** 필요.
- `app.config.ts`: `GOOGLE_SERVICES_JSON`·`GOOGLE_SERVICES_PLIST`(파일 경로) 환경변수가 **둘 다 있을 때만** `@react-native-firebase/app` 플러그인과 `ios.googleServicesFile`·`android.googleServicesFile`을 붙인다. 없으면 경고만 하고 빼서 지금처럼 Firebase 없이 빌드·실행된다.

### `src/services/push.ts`

Firebase를 감싸는 유일한 파일. 네이티브 모듈이 없으면(`getApp()` throw) 모든 함수가 no-op이고 `permission()`이 `"unavailable"`.

- `permission(): Promise<"allowed" | "ask" | "denied" | "unavailable">`
- `request(): Promise<"allowed" | "denied">` — OS 다이얼로그. Android 13+는 `POST_NOTIFICATIONS` 런타임 권한.
- `syncToken(api)` — 허용 상태이고 로그인됐을 때 `getToken()` → `registerPushToken({ token, platform, locale })`. `locale`은 `expo-localization`의 첫 언어 태그. `onTokenRefresh`도 같은 함수를 부른다. 마지막으로 등록한 토큰을 메모리에 두어 로그아웃 때 `removePushToken`에 쓴다.
- `onOpened(handler: (t: PendingTarget) => void)` — `getInitialNotification` + `onNotificationOpenedApp`. 페이로드 `data`를 `PendingTarget`으로 변환(`parsePushData.ts` 순수 함수; 필드가 빠지면 null).
- `onForegroundMessage(handler)` — 배지·인박스 갱신 트리거.

```ts
interface PendingTarget {
  notificationId: string | null; // 인박스에서 열면 그 id, 푸시면 data.notificationId
  bandId: string;
  sessionId: string;
  takeId: string | null; // 코멘트형. 원본 녹음 코멘트면 "orig"
  atSec: number | null;
}
```

### `NotificationsProvider` (`src/features/notifications/`)

`CurrentBandProvider` 안쪽, `ToastProvider` 바깥에 둔다.

- 상태: 현재 밴드 `unreadCount`, 시트 열림 여부, `pendingTarget`.
- 갱신: 밴드 변경, 앱 포그라운드 복귀(`AppState` active), 포그라운드 푸시 수신, `api.subscribe` 통지. 주기 폴링은 없다.
- 첫 권한 요청(결정 10): `permission() === "ask"`이고 밴드가 1개 이상이며 Sessions 화면이 처음 마운트됐을 때 `request()`. 물었다는 사실은 `expo-secure-store`에 플래그로 남겨(AsyncStorage 미도입) 다시 묻지 않는다. 허용되면 `syncToken`.
- `open(target)`: 멤버십 확인(`bands`에 없으면 토스트) → `api.sessions.get(sessionId)`로 접근 확인(403/404/오류면 토스트 `notifications.gone`("더 이상 볼 수 없는 알림이에요"), 밴드는 바꾸지 않음) → 다르면 `setCurrentBand(target.bandId)` → `notificationId`가 있으면 `markRead`(best-effort, 실패해도 이동) → 이동. 세션형은 `/session/:sessionId`, 코멘트형은 `/session/:sessionId/take/:takeId?at=<sec>`.
- 콜드 스타트: 인증 복원·밴드 로딩 전에 푸시가 들어오면 `pendingTarget`에 두고 `BandGate` 통과 뒤 소비.

### UI

- `TabBar`: `TabKey`에 `"alerts"` 추가, 4칸. 벨 아이콘 + 배지(`9+`). Alerts는 라우트가 아니라 **시트 토글** — `TabsLayout`이 `NotificationSheet`를 `NewSessionSheet`처럼 올린다. 시트가 열려 있으면 Alerts 탭이 활성 색, 다른 탭은 비활성.
- `NotificationSheet`: 헤더(Notifications · 밴드명 · Mark all read(미읽음 있을 때) · 톱니), TODAY / EARLIER 그룹(`groupByDay.ts` 순수 함수, 기기 로컬 기준 오늘), 항목(이니셜 아바타 · 제목 · 상대시간 · 본문 · 메타 · 미읽음 점; 읽은 항목은 `#C6CAD1` 400, 미읽음은 `#F2F3F5` 600), "Show older (n)", 끝에 "Notifications from the last 30 days"(더 없고 6개 넘게 봤을 때), 빈 상태("Nothing yet / New sessions and comments in {band} show up here."). 문구는 `notificationText.ts` 순수 함수(en/ko). 메타는 코멘트형 `{SESSION NAME} · {mm:ss}`, 세션형 `{AUG 27} · {2H 14M}`.
- 톱니 → 시트 닫고 `/notifications?from=sheet`. 설정 화면의 뒤로가기는 `from=sheet`면 "Back" + 돌아가서 시트 다시 열기, 아니면 "Me".
- `app/notifications.tsx` → `NotificationSettingsScreen`: OS 상태 카드(`ask` → "Turn on notifications" = `request()`, `denied` → "Open Settings" = `Linking.openSettings()`, `unavailable`은 `denied`와 같은 카드에 문구만 "이 빌드에서는 알림을 쓸 수 없어요"), 밴드 드롭다운 + 밴드 시트(각 밴드 요약: "Sessions · all comments" / "Sessions · replies to me" / "Sessions only" / "Comments only" / "Replies to me only" / "Off"), 토글 2개, scope 라디오(코멘트 on일 때만). `ask`/`denied`이면 아래 영역 0.35 투명도 + 터치 차단. `unavailable`은 카드만 보이고 컨트롤은 그대로 쓸 수 있다 — 토글이 인박스 행도 거르기 때문이다(결정 2, 14). 토글마다 즉시 PUT, 실패하면 되돌리고 토스트. 포그라운드 복귀 때 `permission()`을 다시 읽어 iOS 설정에서 돌아온 경우를 반영한다.
- Me 화면에 SETTINGS 섹션 + "Notifications" 행. 값 요약 `meNfValue.ts` 순수 함수: `ask`/`denied`이거나 모든 밴드 off → "Off", 모든 밴드에 하나라도 on → "On", 아니면 "{n} of {m} bands" (`unavailable`은 설정값만으로 계산 — 결정 14).
- `TakePlayerScreen`: 마운트 시 `comments.markRead(target)` 호출(원본은 세션 타깃). `?at=` 쿼리가 있으면 로드 뒤 그 시점으로 `seekTo`. 코멘트의 `unread`는 받기만 하고 표시하지 않는다.
- 로그아웃·탈퇴: `signOut`/`deleteAccount` 안에서 `removePushToken`을 먼저(실패해도 진행) 보내고 세션을 지운다. 로그인 성공 뒤 `syncToken`.

### i18n

`en.ts`/`ko.ts`에 `notifications.*`, `notificationSettings.*`, `me.settings.*` 키 추가. 리소스 테스트(`resources.test.ts`)가 두 언어 키 일치를 검사한다.

## 테스트

**서버** (vitest, 기존 fake db 패턴)

- `fanout.spec.ts`: 작성자 제외, 답글은 부모 작성자만 `reply`, `scope=mine`은 `reply`만, `comments=false`/`sessionReady=false` 제외, 설정 행 없으면 기본값, session_ready에 업로더 포함.
- `push-text.spec.ts`: en/ko, 본인 세션 "Your recording is ready", 원본 녹음 코멘트 문구, actor null, display_name null.
- `notifications.service.spec.ts`: 커서 페이지·`remaining`·`unreadCount`, 30일 삭제, 남의 알림 read → 404, 비멤버 403, 푸시 실패가 행 생성을 깨지 않음.
- `firebase-push-sender.spec.ts`: admin SDK를 가짜로 꽂아 unregistered 토큰이 `invalidTokens`로 돌아오고 행이 삭제되는지. provider가 환경변수 유무로 `LogPushSender`/`FirebasePushSender`를 고르는지.
- `comments.service.spec.ts` 확장: `unread`(마크 없음·마크 이전·내 코멘트), `markRead` upsert, `create` 뒤 `onCommentCreated` 호출.
- `session-analysis.service.spec.ts` 확장: ready 커밋 뒤 `onSessionReady` 호출, `StaleSessionError`면 호출 없음, 알림 실패가 분석 결과를 깨지 않음.
- e2e: 설정 PUT → GET 왕복과 기본값 채움, 코멘트 작성 → 다른 멤버 인박스에 행·작성자 인박스엔 없음·답글은 `reply`, read-all, 토큰 upsert/삭제/다른 계정 덮어쓰기, 밴드 탈퇴 시 설정 cascade, `/takes/:id/comments/read` 뒤 `unread`·`unreadCommentCount` 변화.

**모바일** (vitest, 순수 함수)

- `groupByDay`, `notificationText`, `meNfValue`, `parsePushData`, `MockApiClient` 인박스(markRead가 unreadCount를 줄이는지).

## 롤아웃

1. 마이그레이션 0013 + 서버. Firebase 없이 `LogPushSender`로 배포 가능.
2. 모바일: 패키지·`push.ts`·UI. Firebase 설정 파일 없이 빌드하면 `unavailable`로 돌아 인박스·설정·읽음만 동작.
3. **사용자 수동 작업** (Firebase 준비되면): Firebase 프로젝트 생성 → iOS/Android 앱 등록(`com.projectn.taken`) → `google-services.json`·`GoogleService-Info.plist`를 `apps/mobile/` 아래 두고 `.env`에 경로 → Apple Developer에서 APNs 키 발급해 Firebase 콘솔에 업로드 → 서비스 계정 JSON 발급해 서버 `FIREBASE_SERVICE_ACCOUNT_JSON` → dev client 재빌드 → 실기기 검증(시뮬레이터는 APNs 불가, Android 에뮬레이터는 Play 서비스 이미지면 가능).
4. `.env.example` 양쪽, README, 인프라 메모(Fargate 태스크 환경변수 추가) 갱신.

## 범위 밖

- 코멘트 `unread`의 UI 표시(목록 강조, 테이크 행 배지).
- 앱 아이콘 배지 숫자, 포그라운드 인앱 배너, 읽음 확인(read receipt).
- 알림 종류 추가(멤버 가입·초대·결제 등), 이메일.
- 알림 아웃박스·재시도 큐.
