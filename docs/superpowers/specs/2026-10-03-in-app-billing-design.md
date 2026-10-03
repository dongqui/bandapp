# 인앱 결제 설계

## 목표

출시(2026-10-02 결정)부터 AI 분석을 유료로 판다. 애플·구글 인앱결제만 쓰고 RevenueCat으로 연동한다. 과금 단위는 **오너 개인의 시간 풀**이다. 밴드 오너가 구독하면 풀이 생기고, 오너는 자기가 오너인 밴드를 풀에 연결한다. 연결된 밴드의 멤버 전원은 돈을 내지 않고 풀의 분석 시간을 쓴다.

정책 배경은 Claude Docs "bandapp 결제 정책 초안"(https://claude.ai/code/artifact/2a4342e6-4be2-438a-8f5d-60e41bbb1a75)에 있다. 화면은 Claude Design "Rehersal app"의 B01~B06 화면을 따른다.

현재 상태:
- 결제·플랜·사용량 코드는 어디에도 없다.
- 오너는 `bandMembers.role`(`owner|member`)로 관리한다. 오너 양도는 `BandsService.transferOwnership`에 있고, 오너는 양도 전에 밴드를 나갈 수 없다.
- 분석 흐름: `completeUpload` → SQS → Nest 워커(`worker/session-analysis.service.ts`). 녹음 길이는 워커가 ffprobe로 확정하고, 그 뒤에 Gemini를 청크 단위로 호출한다. 임포트는 API 시점에 `durationMs`가 null일 수 있다.
- `/sessions/:id/retry`는 호출할 때마다 Gemini를 다시 돌린다.
- 모바일은 Expo SDK 57 + expo-router + prebuild 구조다. 데이터는 `useApiData`로 가져오고, api-client는 Http/Mock 두 구현을 둔다.

## 범위

**포함:**
- DB: `billing_pools`, `analysis_charges`, `billing_events` 테이블, `bands.pool_id`·`bands.free_used_sec` 컬럼, `session_status`에 `waiting_for_time` 추가 (마이그레이션 1개)
- 플랜표 상수와 시간 계산 모듈 (순수 함수)
- 워커 분석 게이트: 예약 → 확정/환불
- API: 밴드 결제 조회, 풀 연결/해제, 구매 후 동기화, RevenueCat 웹훅
- 오너 양도 시 풀 연결 해제
- 모바일: `react-native-purchases` 설치, 결제 화면 B01~B06, Band 화면 진입 카드, 세션 목록의 시간 부족 상태
- 디자인에 없는 UI는 `design-delegation`으로 Claude Design에 먼저 요청 (아래 "디자인 갭")

**제외:**
- 무료 분석을 Gemini Flex로 처리, `usageMetadata` 원가 기록 — 원가 최적화 작업으로 따로 한다
- 무료 분석 월 총예산 상한, 녹음 1회 분석 상한, 베타 밴드 혜택
- 구독을 다른 사람에게 넘기기
- 사업자 등록, 스토어 판매 설정, 약관·개인정보처리방침 본문 (앱은 링크만 둔다)

## 플랜

코드 상수 `PLANS`가 유일한 기준이다. 가격은 앱이 스토어에서 받아 표시하고 코드에는 넣지 않는다.

| 키 | 분석 시간 | 갱신 | 스토어 상품 |
|---|---|---|---|
| `free` | 밴드당 3h, **평생 1회** (초기화 없음) | — | — |
| `band` | 풀당 월 20h | 구독 갱신일 | 자동갱신 구독, 구독 그룹 `analysis` |
| `plus` | 풀당 월 40h | 구독 갱신일 | 같은 구독 그룹 |
| `extra` | 풀에 3h 추가, 이월됨 | — | 소모성(consumable) |

- band와 plus를 같은 구독 그룹에 넣어, 업그레이드·다운그레이드를 스토어가 처리하게 한다.
- RevenueCat entitlement는 `band`와 `plus` 2개를 만든다. 어느 플랜인지는 서버가 활성 상품 ID로 판단한다.
- 추가 시간(`extra`)은 활성 유료 풀이 있는 오너만 살 수 있다. 디자인에서도 무료일 때는 "View plans"만 보인다.

## 데이터 모델

**`billing_pools`** — 구독자 1명당 1행

| 컬럼 | 설명 |
|---|---|
| `id` | uuid |
| `owner_user_id` | unique, users FK. RevenueCat app user id도 이 값을 쓴다 |
| `plan` | `band` \| `plus` \| null (구독한 적 없거나 만료됨) |
| `status` | `active` \| `grace` \| `expired` |
| `store` | `app_store` \| `play_store` \| null |
| `period_start`, `period_end` | 현재 구독 기간 |
| `will_renew` | false면 해지 예정 (디자인의 "Renewal canceled") |
| `used_sec` | 이번 기간에 확정된 월 시간 사용량 |
| `extra_sec` | 남은 추가 시간 |
| `updated_at` | |

- 월 남은 시간: `PLANS[plan].monthlySec − used_sec − (예약된 pool charge 합)`
- `active`와 `grace`일 때만 월 시간을 쓸 수 있다.

**`bands`** 컬럼 추가:
- `pool_id`: nullable, billing_pools FK, on delete set null
- `free_used_sec`: int, 기본값 0

**`analysis_charges`** — 차감 원장

| 컬럼 | 설명 |
|---|---|
| `session_id` | unique. 세션당 1행이라 이중 차감이 생기지 않는다 |
| `band_id` | |
| `pool_id` | nullable |
| `free_sec`, `monthly_sec`, `extra_sec` | 각 출처에서 차감한 양 |
| `state` | `reserved` \| `charged` \| `refunded` |
| `created_at`, `updated_at` | |

**`billing_events`**:
- 컬럼: `id`(RevenueCat event id, PK), `type`, `app_user_id`, `transaction_id`, `payload` jsonb, `received_at`
- 웹훅 중복과 추가 시간의 중복 반영을 막는 용도다.
- 소모성 상품의 `transaction_id`에는 unique를 건다.

**`session_status`** 값 추가: `waiting_for_time`

## 사용 가능 시간 규칙

밴드 B의 시간 출처와 차감 순서는 아래와 같다.

| 상황 | 차감 순서 |
|---|---|
| `B.pool_id` 있음, 풀 `active`/`grace` | 풀 월 시간 → 풀 추가 시간 |
| `B.pool_id` 있음, 풀 `expired` | 밴드 무료 잔여 → 풀 추가 시간 |
| `B.pool_id` 없음 | 밴드 무료 잔여 |

- 밴드 무료 잔여는 `3h − free_used_sec`이다.
- 연결된 밴드는 풀이 활성인 동안 무료 시간을 쓰지 않는다. 남은 무료 시간은 그대로 남아, 풀이 만료되면 다시 쓴다.
- 이미 산 추가 시간은 구독이 만료돼도 없어지지 않는다.
- 월 시간은 갱신 때 `used_sec = 0`으로 초기화되고 이월되지 않는다.
- 업그레이드나 다운그레이드가 반영되면 `plan`만 바꾸고 `used_sec`는 유지한다. 디자인 B04의 "after" 계산과 같다.
- **풀 연결**:
  - 내가 오너인 밴드만 연결할 수 있고, 개수 제한은 없다.
  - 결제를 시작한 밴드는 구매 성공 시 자동으로 연결된다.
  - 다른 사람의 풀에 연결된 밴드는 연결할 수 없다. 오너가 1명이라 사실상 생기지 않지만 서버에서 막는다.
- **오너 양도**:
  - `transferOwnership` 트랜잭션 안에서 `pool_id = null`로 바꾼다. 밴드는 남은 무료 시간으로 돌아간다.
  - 진행 중인 예약은 그대로 둔다. 예약은 원래 출처에서 확정되거나 환불된다.
- **밴드 삭제**: soft-delete된 밴드는 연결 목록과 계산에서 뺀다.

## 분석 게이트 (워커)

`session-analysis.service.ts`에서 ffprobe 직후, 첫 Gemini 호출 전에 실행한다.

1. 같은 세션의 `analysis_charges`가 이미 있는지 본다.
   - `charged`면 차감 없이 분석을 진행한다 (재분석 무료).
   - `reserved`면 지난 시도의 예약을 다시 쓴다.
2. 트랜잭션 안에서 밴드 행과 풀 행을 `SELECT … FOR UPDATE`로 잠그고, 위 규칙대로 출처별 차감량을 계산한다.
3. 시간이 녹음 길이 전체에 못 미치면 세션을 `waiting_for_time`으로 바꾸고 종료한다. 분석은 전부 하거나 아예 안 한다.
4. 충분하면 다음을 처리한다.
   - `analysis_charges`를 `reserved`로 insert한다.
   - 무료 시간을 썼으면 그만큼 `bands.free_used_sec`를 올린다.
   - 추가 시간을 썼으면 그만큼 `pool.extra_sec`를 내린다.
   - 월 시간은 예약 합계로 계산하므로 `used_sec`에 바로 더하지 않는다.
5. 분석이 성공하면 `charged`로 바꾸고, 월 시간분을 `pool.used_sec`에 더한다.
6. 분석이 실패하면(`fail()`) `refunded`로 바꾸고, 무료 시간과 추가 시간을 되돌린다.
   - 단, 예약이 지난 기간에 걸렸고 그 사이 갱신이 일어났다면 월 시간분은 되돌릴 필요가 없다. 예약은 계산에서 빠질 뿐이다.

- `/retry`는 `failed`, 오래 멈춘 `analyzing`에 더해 `waiting_for_time`도 받는다. 시간을 산 뒤 디자인의 "Continue analysis"가 이 API를 부른다.
- 녹음, 업로드, 재생, 코멘트, 수동 take는 시간과 관계없이 항상 된다.

## API

- **`GET /bands/:bandId/billing`** — 밴드 멤버 누구나 볼 수 있다. 응답 항목:
  - `plan` (`free` | `band` | `plus`), `source` (`free` | `pool`)
  - `availableSec`, `monthlyTotalSec`, `monthlyLeftSec`, `monthlyUsedSec`, `extraSec`, `freeLeftSec`
  - `periodEnd`, `willRenew`, `store`
  - `isOwner`, `poolOwnedByMe`
  - `myPool` — 요청자가 오너이고 풀을 가졌을 때: `{ plan, status, linkedBands: [{ id, name }] }`
  - `canLinkToMyPool`
- **`POST /bands/:bandId/billing/link`**, **`POST /bands/:bandId/billing/unlink`** — 오너만 호출할 수 있다. 대상은 요청자의 풀이다.
- **`POST /billing/sync`** — 본문은 `{ bandId?: string }`.
  - 서버가 RevenueCat REST `GET /v1/subscribers/{userId}`로 상태를 읽어 풀에 반영한다.
  - 반영할 것: 활성 구독(plan, period, will_renew, store)과, 아직 반영하지 않은 소모성 거래(`non_subscriptions`의 transaction id)의 추가 시간.
  - `bandId`가 있고 요청자가 그 밴드의 오너이며 풀이 활성이면 자동으로 연결한다.
  - 구매 직후와 B06의 "Check status"에서 부른다.
- **`POST /webhooks/revenuecat`** — `AuthGuard`를 쓰지 않는다.
  - `Authorization` 헤더를 `REVENUECAT_WEBHOOK_SECRET`과 비교한다.
  - `billing_events` insert가 충돌하면 200을 즉시 반환한다 (중복).
  - 그 외에는 이벤트 종류와 관계없이 해당 `app_user_id`를 `/billing/sync`와 같은 동기화 함수로 처리한다. 이벤트 순서가 뒤바뀌어도 결과가 같다.
  - 갱신 판단: 동기화할 때 `period_start`가 바뀌었으면 `used_sec = 0`.
- **환경변수**:
  - 서버: `REVENUECAT_WEBHOOK_SECRET`, `REVENUECAT_API_KEY`
  - 모바일: `EXPO_PUBLIC_RC_IOS_KEY`, `EXPO_PUBLIC_RC_ANDROID_KEY`
  - 모두 사용하는 시점에 lazy하게 읽는다 (기존 패턴).
- **api-client**: `bands.billing(id)`, `bands.linkPool(id)`, `bands.unlinkPool(id)`, `billing.sync(bandId?)`를 `HttpApiClient`와 `MockApiClient` 양쪽에 추가한다. 타입은 `packages/types`에 둔다.

## 모바일

- `react-native-purchases` 설치 (config plugin 불필요).
  - 앱 시작 시 플랫폼별 키로 `Purchases.configure`를 부른다.
  - 로그인 뒤 `Purchases.logIn(userId)`, 로그아웃 시 `Purchases.logOut()`.
  - Mock API 모드(`EXPO_PUBLIC_API_URL` 비어 있음)에서는 구매를 흉내 내는 mock 구현을 쓴다.
- 화면은 `src/features/billing/`에 둔다.
  - B01 Plan & usage: Band 화면 플랜 카드에서 진입
  - B02 Plans
  - B03 Not enough time 시트: 세션 목록에서 `waiting_for_time` 세션을 누르면 뜬다
  - B04 Subscription review
  - B05 Extra time
  - B06 Purchase status
- **구매 흐름**:
  1. `Purchases.getOfferings()`에서 가격을 표시한다. 디자인의 "Loading prices…" 상태가 여기에 해당한다.
  2. `purchasePackage`로 구매한다.
  3. `billing.sync(bandId)`를 부른다.
  4. B06에 결과를 보여준다.
     - 사용자 취소: 이전 화면으로 돌아간다.
     - 스토어 실패: `failed`
     - Android 보류 결제: `pending`
     - 구매는 됐는데 sync 응답에 아직 반영이 안 됨: `delayed`
     - 반영됨: `success`
- **업그레이드·다운그레이드**: Android는 `googleProductChangeInfo`로 기존 구독을 교체한다. iOS는 같은 그룹이라 스토어가 처리한다.
- **해지·재개**: `Purchases.showManageSubscriptions()`로 스토어 화면을 연다. 돌아오면 sync를 불러 B06 `canceled`/`resumed`를 보여준다.
- **오너가 아닐 때**:
  - B01은 사용량만 보여준다. 결제 버튼 자리에 "플랜은 오너만 바꿀 수 있어요" 안내를 둔다.
  - B03 시트의 구매 버튼도 같은 안내로 바꾼다. "Not now"는 그대로 둔다.

### 디자인 갭

구현 전에 `design-delegation`으로 Claude Design에 요청한다.

1. 풀이 있는 오너가 아직 연결 안 된 자기 밴드를 열었을 때: B01에 "내 플랜에 이 밴드 추가"
2. 연결된 밴드 목록 보기와 연결 해제 (B01 하위)
3. 연결된 밴드의 B01에 "N개 밴드와 시간 공유 중" 표시
4. 오너 양도 확인 문구에 "이 밴드는 내 플랜에서 빠집니다"
5. 비오너용 B01·B03 안내
6. 무료 문구: "Free time resets monthly"와 "Free · 3h / month"를 "밴드당 3시간 1회"로 바꾼 버전
7. 만료됐지만 추가 시간이 남은 밴드의 B01 표시

## 에러 처리

- B01 로딩 실패: 디자인의 "Couldn't load your plan" + Retry
- 웹훅·sync 실패: RevenueCat이 웹훅을 재시도한다. 앱은 B06 `delayed`에서 "Check status"로 다시 sync한다.
- 게이트 트랜잭션 실패: 기존 워커 재시도와 SQS 재전달에 맡긴다. `analysis_charges.session_id` unique 제약으로 이중 예약을 막는다.
- 환불(REFUND 이벤트): 동기화 결과 구독이 없어지면 `expired`가 된다. 소모성 상품을 환불해도 `extra_sec`는 회수하지 않는다. 이미 썼을 수 있고 금액이 작다.

## 테스트

- **API 단위 (vitest)**:
  - 시간 계산 모듈: 출처별 차감 순서, 만료 풀 + 추가 시간, 무료 1회, 플랜 변경 시 `used_sec` 유지
  - 게이트: 예약 → 확정/환불, 부족 시 `waiting_for_time`, 재분석 무료, 기존 예약 재사용
  - 동기화: 갱신 시 초기화, 소모성 거래 중복 방지
- **API e2e**:
  - 웹훅: 시크릿 거부, 같은 event id 중복
  - link/unlink 권한 (비오너, 남의 밴드)
  - 오너 양도 시 연결 해제
  - `/billing` 응답 형태
  - `/retry`가 `waiting_for_time` 수용
  - RevenueCat REST는 fake로 대체한다.
- **모바일**: 표시용 포맷과 B06 상태 결정 같은 순수 로직만 vitest로 테스트한다.
- **수동**:
  - iOS Sandbox와 Google 라이선스 테스터로 구독, 업그레이드, 추가 시간, 해지/재개를 확인한다.
  - 사전 조건: 스토어 콘솔 상품 생성과 RevenueCat 프로젝트 설정.
