# 인증 · 회원가입 · 팀 초대 설계

- **날짜:** 2026-08-30
- **상태:** 검토 대기
- **근거 문서:** 사용자 제공 "Band Rehearsal App — 인증 · 회원가입 · 팀 초대 기획서" (대화로 전달, 27개 섹션). 이 문서는 기획서의 결정을 그대로 따르고, 기획서가 정하지 않은 리포 수준의 기술 선택만 추가로 확정한다.

## 목적

Google/Apple 소셜 로그인으로 최초 로그인 시 자동 회원가입하고, 자체 Access/Refresh Token 세션을 운영하며, Band 멤버십 기반 서버 권한 검증과 초대 링크 → 로그인 → 팀 참가 흐름을 끊김 없이 제공한다.

## 범위

**포함:**
- PostgreSQL 스키마 + 마이그레이션 (users, user_identities, auth_sessions, bands, band_members, band_invites) — 이 리포 최초의 DB 레이어
- NestJS: /auth/google, /auth/apple, /auth/refresh, /auth/logout, /me(GET/DELETE), bands/memberships/invites API, AuthGuard, Band authorization
- 모바일: 로그인 화면, SecureStore 토큰 저장, 세션 복원, 초대 딥링크(+pendingInviteToken 보존), 팀 생성/참가 온보딩, Band 전환 상태, 로그아웃/회원 탈퇴
- packages/types · packages/api-client 계약 확장 + 실제 HTTP 클라이언트

**제외 (기획서 25장 "나중에" + 이번 단계 유보):**
- LINE / Kakao / Email Magic Link, 계정 연결·병합, 기기별 세션 관리 UI, 역할별 초대/승인 대기
- 웹 Invite Landing 페이지, Universal Link/App Link 도메인 연동, deferred deep link (초대 코드 수동 입력이 복구 경로)
- sessions/recordings API의 DB 저장 및 밴드 스코핑 (기존 Gemini 파이프라인은 그대로 둠 — 후속 스펙에서 band_id 권한 적용)
- CI 구성

## 확정된 결정

기획서의 결정(이메일/비번 가입 없음, canonical ID는 `users.id`, Provider token 서버 검증, 인증·권한 분리, JWT payload 최소화 `{sub}`, refresh hash 저장, 초대 링크 우선 UX 등)은 전부 그대로 채택한다. 아래는 기획서가 정하지 않아 이번에 확정한 것들이다.

1. **ORM = Drizzle ORM + drizzle-kit + node-postgres(pg).** 리포에 DB 레이어가 전무해 신규 선정. 선정 이유: ESM/nodenext와 마찰 없음, 데코레이터·리플렉션 없이 순수 함수형이라 기존 useFactory provider 관례와 unit test 스타일에 맞음, SQL 마이그레이션 파일이 명시적으로 생성됨. `pg.Pool`은 lazy connect라 DB 없이도 AppModule 부팅이 가능해 기존 health e2e가 깨지지 않는다.
2. **JWT/검증 라이브러리 = jose 단일.** 자체 Access Token 서명(HS256, `JWT_ACCESS_SECRET`), Google JWKS(`https://www.googleapis.com/oauth2/v3/certs`), Apple JWKS(`https://appleid.apple.com/auth/keys`) 검증을 모두 jose로 처리. `@nestjs/jwt`/passport는 도입하지 않는다(리포의 최소 의존성·직접 구현 관례).
3. **토큰 정책: Access 30분, Refresh 60일 + rotation.** 기획서 범위(15~30분/30~90일)의 중간값. `/auth/refresh`는 기존 세션을 revoke하고 새 refresh token을 발급한다(재사용된 refresh는 404가 아니라 401). Refresh token은 `randomBytes(32).base64url` 원문을 클라이언트에 주고 DB에는 SHA-256 hex만 저장.
4. **Refresh 검증/회전은 auth_sessions 테이블 단독으로 처리.** revoked_at IS NULL AND expires_at > now 조건. 전체 로그아웃/탈퇴 시 user 단위 일괄 revoke.
5. **band_members.role DB enum은 소문자 `owner`/`member`.** `@bandapp/types`의 기존 `MemberRole = "owner" | "member"`와 일치시켜 경계 매핑 제거. provider enum은 기획서 표기대로 대문자 `GOOGLE`/`APPLE`.
6. **검증은 기존 관례대로 hand-rolled.** class-validator/zod 도입하지 않음. DTO가 전부 1~2필드 문자열이라 컨트롤러에서 직접 타입 체크 후 BadRequestException.
7. **로그인 rate limit = @nestjs/throttler**, AuthController에만 ThrottlerGuard 적용(60초 20회). 기획서 20장 요구 충족용 최소 구성.
8. **Apple displayName은 클라이언트가 최초 가입 시 body로 전달.** Apple ID token에는 이름이 없고 이름은 첫 인증 때 클라이언트에만 내려오므로 `POST /auth/apple { idToken, displayName? }`로 받고, 신규 가입일 때만 저장한다. 기획서 6장 API에 필드 하나 추가되는 변경.
9. **회원 탈퇴 규칙:** 다른 멤버가 있는 Band의 유일한 owner면 409 Conflict(선행 처리 요구, 기획서 18장). 본인 혼자인 Band는 함께 삭제. 이후 모든 auth_sessions revoke, user_identities 삭제, users는 display_name/profile_image_url NULL + deleted_at 세팅(soft delete, FK 보존).
10. **초대 토큰 = `randomBytes(24).base64url`(32자), DB에는 SHA-256 hex만 저장.** 유효기간 7일, role MEMBER, owner만 생성(기획서 11장 MVP 정책). 만료/취소/소진/미존재는 전부 404 단일 응답(토큰 존재 여부 노출 방지). join은 idempotent — 이미 멤버면 200 + `alreadyMember: true`.
11. **모바일 상태관리는 zustand가 아니라 React Context.** 기획서 22장은 `stores/auth.store.ts`를 예시했지만 리포 관례(ApiProvider Context + hook, "추가 스타일링/상태 의존성 없음" 결정)를 따라 `AuthProvider`/`CurrentBandProvider` Context로 구현. 파일 배치는 기획서 구조를 준용해 `src/services/secure-storage.ts`, `src/features/auth/` 등을 사용.
12. **Google 로그인 = @react-native-google-signin/google-signin(네이티브), Apple = expo-apple-authentication.** 둘 다 idToken을 직접 반환해 기획서 4장 서버 검증 구조와 맞음. Expo Go에서는 동작하지 않으므로 dev build(`npx expo run:ios|android`)가 검증 경로. app.json에 `ios.bundleIdentifier`/`android.package` 신설 필요.
13. **HTTP 클라이언트는 packages/api-client의 `HttpApiClient`.** 기존 `RehearsalApiClient` 인터페이스를 auth/invites로 확장하고 MockApiClient도 함께 구현(기존 모바일 화면 무수정 컴파일 유지가 목표). 401 → refresh → 원요청 재시도(단일 비행), refresh 실패 시 토큰 클리어 + onSessionExpired 콜백. `Band.inviteCode` 필드는 제거하고 invite는 별도 API로.
14. **env는 기존 관례대로 process.env 직접 읽기 + 미설정 시 throw.** @nestjs/config 도입하지 않음. 사용자가 실제 값을 나중에 제공하며, 테스트는 vitest config의 `test.env` 기본값으로 돈다.
15. **DB를 만지는 서버 테스트는 `*.e2e-spec.ts`**(vitest.config.e2e.ts)로 작성하고 로컬 docker postgres(localhost:5432, band/band)를 사용, 각 테스트 전 TRUNCATE. 순수 로직(토큰, 검증)은 `*.spec.ts` 단위 테스트.
16. **로그인 화면 시안은 클로드 디자인에 있음(사용자 언급).** DesignSync로 접근 가능한 프로젝트 목록에는 아직 없어, 1차 구현은 기획서 3장 와이어프레임 + 모바일 기존 다크 테마 토큰으로 하고, 시안 공유 시 별도 폴리시 패스로 맞춘다.

## 데이터 모델

기획서 5·7·9·11장 그대로. 컬럼 세부:

```
users              id uuid pk default gen_random_uuid, display_name text null,
                   profile_image_url text null, created_at/updated_at timestamptz, deleted_at null
user_identities    id uuid pk, user_id fk→users cascade, provider enum(GOOGLE|APPLE),
                   provider_subject text, email text null, email_verified bool null,
                   created_at/updated_at  · UNIQUE(provider, provider_subject)
auth_sessions      id uuid pk, user_id fk→users cascade, refresh_token_hash text unique,
                   device_name/platform text null, expires_at, last_used_at null,
                   revoked_at null, created_at
bands              id uuid pk, name text, created_at/updated_at
band_members       band_id fk→bands cascade, user_id fk→users cascade,
                   role enum(owner|member), joined_at  · PK(band_id, user_id)
band_invites       id uuid pk, band_id fk→bands cascade, token_hash text unique,
                   created_by fk→users, expires_at, max_uses int null,
                   used_count int default 0, revoked_at null, created_at
```

## API 명세 (응답 타입은 @bandapp/types)

```
POST   /auth/google                { idToken }                → LoginResponse
POST   /auth/apple                 { idToken, displayName? }  → LoginResponse
POST   /auth/refresh               { refreshToken }           → AuthTokens
POST   /auth/logout    (Bearer)    { refreshToken }           → 204
GET    /me             (Bearer)                               → User
DELETE /me             (Bearer)                               → 204 | 409(유일 owner)
POST   /bands          (Bearer)    { name }                   → Band
GET    /bands          (Bearer)                               → Band[]
GET    /bands/:bandId/members         (Bearer, 멤버만)        → BandMember[]
DELETE /bands/:bandId/members/me      (Bearer, 멤버만)        → 204 | 409(owner+타멤버)
POST   /bands/:bandId/invites         (Bearer, owner만)       → BandInvite { id, url, expiresAt }
GET    /invites/:token             (공개)                     → InvitePreview
POST   /invites/:token/join        (Bearer)                   → { bandId, alreadyMember }
DELETE /bands/:bandId/invites/:inviteId (Bearer, owner만)     → 204

LoginResponse = { accessToken, refreshToken, user: User, isNewUser }
User          = { id, displayName: string|null, profileImageUrl: string|null }
InvitePreview = { band: { name, memberCount }, invitedBy: { displayName }, expiresAt }
Band          = { id, name, memberCount }   ← inviteCode 필드 제거
```

권한 실패는 403(멤버 아님/owner 아님), 인증 실패는 401, 초대 무효는 404. 오류 메시지는 기획서 19장 문구를 쓰고 OAuth 내부 문자열을 노출하지 않는다.

## 환경 변수 (사용자가 추후 제공)

```
# apps/api (.env)
DATABASE_URL              이미 존재 (postgres:5432 컨테이너용 / 테스트는 localhost:5432 기본값)
JWT_ACCESS_SECRET         자체 Access Token HS256 시크릿
GOOGLE_CLIENT_IDS         쉼표 구분 audience 목록 (web,iOS,Android client id)
APPLE_BUNDLE_ID           Apple ID token audience (= iOS 번들 ID)
INVITE_LINK_BASE_URL      초대 URL 프리픽스, 예: https://app.example.com

# apps/mobile
EXPO_PUBLIC_API_URL              예: http://<LAN IP>:3001 (호스트 포트는 3001)
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID GoogleSignin.configure의 webClientId
app.json: ios.bundleIdentifier / android.package (2026-09-01 com.taken.app으로 확정)
```

## 디렉토리 구조

기획서 21·22장을 리포 관례(빈 스텁 모듈 재사용, `.js` suffix ESM)에 맞춰 적용:

```
apps/api/src/
├─ db/         db.constants.ts db.module.ts schema.ts        (+ apps/api/drizzle/ 마이그레이션)
├─ auth/       auth.module.ts auth.controller.ts auth.service.ts auth.guard.ts
│              me.controller.ts (기획서 6장 — /me는 인증 API 소속)
│              current-user-id.decorator.ts token.service.ts auth-sessions.service.ts
│              google-auth.service.ts apple-auth.service.ts provider-token.ts
├─ users/      users.module.ts users.service.ts
├─ bands/      bands.module.ts bands.controller.ts bands.service.ts
├─ memberships/memberships.module.ts memberships.service.ts
└─ invites/    invites.module.ts invites.controller.ts invites.service.ts

apps/mobile/
├─ app/ login.tsx onboarding.tsx settings.tsx invite/[token].tsx   (thin re-export)
└─ src/
   ├─ features/auth/       AuthProvider.tsx LoginScreen.tsx authGate.ts providers/{google,apple}.ts
   ├─ features/invites/    InviteLandingScreen.tsx pendingInvite.ts
   ├─ features/onboarding/ OnboardingScreen.tsx
   ├─ features/settings/   SettingsScreen.tsx
   ├─ features/band/       CurrentBandProvider.tsx (useCurrentBand 대체)
   └─ services/            secure-storage.ts token-storage.ts

packages/types/src/        user.ts auth.ts invite.ts (+ band.ts 수정)
packages/api-client/src/   client.ts 확장, http/HttpApiClient.ts, mock 확장
```

## 테스트 전략

- **unit (`*.spec.ts`)**: TokenService(서명/검증/해시), Google/Apple 검증(jose 로컬 JWKS로 서명한 가짜 토큰 — issuer/audience/만료/변조 거부), HttpApiClient(fetch mock — 401→refresh→재시도, 단일 비행, 세션 만료), pendingInvite 순수 로직.
- **e2e (`*.e2e-spec.ts`)**: 로컬 postgres 대상. Provider 검증 서비스는 `overrideProvider`로 스텁. 가입→로그인→refresh rotation→logout, Band 생성/조회/권한(비멤버 403), 초대 생성→조회→참가(idempotent)→revoke, 탈퇴 규칙. vitest e2e config가 `test.env`로 DATABASE_URL/JWT_ACCESS_SECRET 등 기본값 주입, globalSetup에서 마이그레이션 적용.
- 모바일은 기존 관례대로 typecheck + 순수 로직 vitest + dev build 수동 검증.

## 검증 기준

기획서 26장의 완료 조건 10개를 그대로 사용한다. 이 중 1–2(실제 Provider 가입)와 3(실기기 세션 복원), 7–8(딥링크 왕복)은 사용자 env 제공 + dev build 후 수동 검증 항목이고, 나머지는 e2e 테스트로 자동 검증한다.

## 후속 작업

이번 범위에서는 다루지 않지만, 리뷰 과정에서 확인된 항목:

- `auth_sessions` 만료 행 주기적 삭제(purge) — `expires_at < now`인 행은 죽은 무게(dead weight)로 테이블에 계속 쌓인다. 워커 또는 크론으로 정리하는 작업이 필요하다.
- refresh 토큰 재사용 감지 시 세션 패밀리 일괄 revoke — 현재는 재사용된 refresh 요청을 401로만 거부하고, 같은 패밀리의 다른 세션은 살려둔다.
- AuthGuard의 사용자 존재(soft-delete) 확인이 요청당 PK 조회를 1회 추가한다 — 부하가 커지면 캐시 적용 여부를 검토한다.
- `@nestjs/throttler`의 Nest 12 peer 지원 릴리스 트래킹 — 현재는 peer 경고를 감수하고 쓰는 상태다.
- POST /auth/logout의 AuthGuard 제거 검토 — refresh token 소지 자체가 증명이라 rotation 우회 revoke가 단순해짐 (현재는 클라이언트가 회전 감지 후 재-revoke)
- InviteSheet를 owner에게만 노출 (현재 member에게 403으로 빈 시트)
- pendingInviteToken 만료 처리 (저장 후 장기간 지나면 폐기)
- Android 실빌드 시 Google 콘솔에 SHA-1 등록된 Android OAuth client 필요 (코드 변경 없음, 콘솔 설정)
- 실서버 모드에서 sessions/takes/comments는 Mock 위임이라 실제 밴드 UUID와 시드가 어긋나 목록이 비어 보임 — sessions API 랜딩 시 해소 (스펙 결정 13)
