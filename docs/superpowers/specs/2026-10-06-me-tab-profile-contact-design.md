# Me 탭 · 프로필 · 문의하기 설계

## 목표

Claude Design "Rehersal app"에 2026-10-06 추가된 화면을 구현한다.

- **네브바 교체**: 하단 고정 바(SESSIONS / + / BAND) → 플로팅 필 3탭(Sessions · Band · Me) + 오른쪽 녹음 버튼. 녹음 버튼은 기존 "New session" 시트를 연다.
- **Me 화면**(새 탭): 아바타(사진 또는 이니셜) · 이름 · 이메일, SUBSCRIPTION 카드, SUPPORT → Contact us, Sign out.
- **이름 변경** 시트("Your name"), **프로필 사진** 시트(Take photo / Choose from library / Remove photo).
- **Contact us** 화면: 주제 칩 4개, 본문, "앱 버전·기기 모델이 첨부된다" 안내, Send.

기존 `/settings` 화면(로그아웃·회원 탈퇴)과 Band 화면의 ⚙ 진입점은 Me 탭으로 흡수한다.

## 디자인 갭 (사용자 확인 필요)

- **회원 탈퇴**가 Me 디자인에 없다. 앱스토어 심사(5.1.1)상 앱 안에서 탈퇴가 가능해야 하므로 Sign out 아래에 같은 스타일의 "Delete account" 행 + 기존 확인 다이얼로그를 둔다. 디자인에 반영해 달라고 요청한다.
- 디자인의 Sign out은 확인 없이 바로 로그아웃한다. 그대로 따른다.
- 네브바의 `backdrop-filter: blur`는 RN 기본 뷰로 못 만든다 — 반투명 배경색만 적용한다 (expo-blur 미도입).

## 데이터

**users**: `profile_image_key text` 추가. 제공자(구글) 사진 URL은 기존 `profile_image_url`에 그대로 두고, 직접 올린 사진은 R2 키(`avatars/{userId}/{uuid}.jpg`)로 둔다. 응답의 `profileImageUrl`은 키가 있으면 7일 presigned GET, 없으면 제공자 URL.

**support_requests** (새 테이블)

| 컬럼 | 설명 |
|---|---|
| `id` uuid | |
| `user_id` uuid FK users (cascade) | |
| `email` text null | 보낼 당시의 identity 이메일 스냅샷 |
| `topic` text | `billing` · `broken` · `idea` · `other` |
| `body` text | trim 후 1~2000자 |
| `app_version` text null, `device` text null | 클라이언트가 보낸 값 |
| `created_at` | |

**User 타입**: `email: string | null` 추가 (첫 identity의 email). Me 화면과 Contact 문구("We reply to {email}")에 쓴다.

**BandBilling.myPool**: `periodEnd` · `willRenew` · `store` 추가. Me 카드가 "내 구독" 기준이라 연결 밴드의 풀이 아닌 내 풀의 갱신 정보가 필요하다.

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| `PATCH /me` | `{ displayName }` trim 1~50자 → User | |
| `PUT /me/photo` | multipart `photo` (jpeg/png/webp, ≤10MB) → User | R2 업로드 후 이전 키 삭제 |
| `DELETE /me/photo` | 204 | 키·제공자 URL 모두 비운다 (디자인: 제거 후 이니셜) |
| `POST /support/requests` | `{ topic, body, appVersion?, device? }` → 201 `{ id }` | 저장 후 `SUPPORT_WEBHOOK_URL`이 있으면 `{ text }` JSON POST(best-effort) |

알림: 이메일 발송 인프라가 없으므로 웹훅(Slack/Discord 호환 `{text}`)만 둔다. 환경변수 없으면 DB 저장만.

## 모바일

- 라우트: `app/(tabs)/me.tsx`, `app/contact.tsx`. `app/settings.tsx`와 `SettingsScreen` 삭제. `authGate`의 `settings` 예외 제거.
- `TabBar`: 디자인대로 재작성. 활성 탭 배경 `rgba(255,255,255,0.09)`, 비활성 글자 `#7A7F88`. Me 탭 아이콘은 22px 아바타(사진/이니셜), 활성일 때 흰 링.
- 사진: `expo-image-picker`(카메라/라이브러리, 1:1 크롭) → `expo-image-manipulator`로 512px JPEG 0.8 → 업로드. 네이티브 모듈이라 **dev client 재빌드 필요**.
- `AuthProvider`에 `updateUser(user)` 추가 — 이름·사진 변경 뒤 상태 갱신. api-client는 변경 후 `emit()`해서 Band 화면 멤버 이름도 다시 불러온다.
- Me 구독 카드(디자인 `mePlanName/Price/Meta/Cta`)는 현재 밴드의 `billing` 응답으로 계산한다 (`mePlanView.ts` 순수 함수):
  - `myPool` 활성(plan 있고 status≠expired): "{Plan} plan", "{price} / month", willRenew ? "Renews {date} · Billed through the {store}" : "Renewal canceled · Active until {date}", "Bands on your plan" 행(연결 수), CTA "Change plan"
  - `myPool` 만료(plan 있고 expired): "{Plan} plan ended", "Ended {date}. Extra time on your bands is still usable.", CTA "Resubscribe"
  - 풀 없음 + 현재 밴드가 남의 플랜에 연결: "No subscription", "{band} uses {owner}'s plan. A plan you start covers bands you own.", CTA "View plans"
  - 그 외: "Free", "Each band gets 3h of analysis once.", CTA "View plans"
  - 멤버라 `myPool`이 null로 오는 경우(서버가 오너에게만 채움)도 "풀 없음"으로 본다. 내 풀 정보가 필요하므로 서버는 `myPool`을 오너 여부와 무관하게 채우도록 바꾼다.
- 결제 화면 컨텍스트 `from: "me"` 추가: B01a 뒤로가기 라벨 "Me", 구매 완료 "Done"은 Me로 복귀.
- i18n: `me.*`, `contact.*` 네임스페이스. 기기 정보는 `Platform.OS/Version` + Android `Model`, iOS `systemName`; 앱 버전은 `expo-constants`.

## 범위 제외

- 이메일 알림 발송, 관리자용 문의 목록 화면
- 사진 업로드 진행률 표시 (파일이 작아 토스트로 충분)
- 멤버 목록·코멘트의 아바타 사진 표시 (디자인이 이니셜 유지)
