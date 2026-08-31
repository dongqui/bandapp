# Apple 토큰 revoke · 계정 삭제 연동 설계

- **날짜:** 2026-08-31
- **상태:** 검토 대기
- **선행 문서:** [2026-08-30-auth-bands-invites-design.md](2026-08-30-auth-bands-invites-design.md) (스펙 결정 8·9가 이 문서의 출발점)

## 목적

Sign in with Apple로 가입한 사용자가 회원 탈퇴할 때, 로컬 세션뿐 아니라 **Apple 측 사용자 인가(user authorization)까지 무효화**한다. 현재 `UsersService.deleteAccount`는 `auth_sessions`를 revoke하고 `user_identities`를 삭제하지만 Apple에는 아무것도 알리지 않아, 사용자의 Apple ID 설정에 이 앱이 계속 연결된 상태로 남는다.

App Store 심사에서 Sign in with Apple + 계정 삭제를 함께 제공하는 앱에 요구되는 항목이므로, 심사 제출 전에 해소한다.

## 범위

**포함:**
- `POST https://appleid.apple.com/auth/token` — 로그인 시 `authorizationCode` → `refresh_token` 교환
- `POST https://appleid.apple.com/auth/revoke` — 탈퇴 시 refresh token 무효화
- `.p8` 개인키로 ES256 `client_secret` JWT 생성
- `user_identities.provider_refresh_token` 컬럼 + 마이그레이션
- 모바일 → API 로그인 계약에 `authorizationCode` 추가
- `packages/api-client`의 `loginWithApple` 시그니처를 객체 파라미터로 변경

**제외:**
- **Apple server-to-server notifications.** 사용자가 Apple ID 설정에서 앱 연결을 끊거나 Apple ID 자체를 삭제할 때 오는 웹훅. 공개 엔드포인트·서명 검증·이벤트 처리가 따로 필요한 별개 요구사항이라 후속 스펙으로 미룬다.
- **Google 측 토큰 revoke.** 컬럼은 provider 무관하게 `provider_refresh_token`으로 두되, 이번에는 APPLE만 채운다.
- **저장 토큰 암호화.** 아래 결정 4 참조.

## 근거 사실 (Apple 공식 문서 확인)

| 항목 | 내용 |
|---|---|
| revoke가 받는 토큰 | **refresh token 또는 access token.** `identityToken`(id_token)은 받지 않는다 |
| revoke 엔드포인트 | `POST /auth/revoke` — `client_id`, `client_secret`, `token`, `token_type_hint` |
| refresh token 획득 | `POST /auth/token` — `client_id`, `client_secret`, `code`, `grant_type=authorization_code` |
| `redirect_uri` | 최초 인가 요청에 redirect_uri를 준 경우에만 필요. 네이티브 iOS 플로우는 주지 않으므로 **생략** |
| `authorizationCode` 수명 | 5분, 1회용 |
| `authorizationCode` 제공 시점 | **매 로그인마다.** `fullName`과 달리 최초 1회 제한이 없다 (expo-apple-authentication SDK 57 `AppleAuthenticationCredential.authorizationCode: string \| null`) |
| `client_secret` | ES256 JWT. `kid`=Key ID, `iss`=Team ID, `sub`=client_id, `aud`=`https://appleid.apple.com`, `exp` 최대 6개월 |
| `client_id` | App ID(`com.bandapp.app`). **Team ID를 포함하면 안 된다** |
| revoke 응답 | 성공 또는 "이미 무효" 모두 200. 본문 없음 |

`authorizationCode`가 매 로그인마다 온다는 점이 설계를 단순하게 만든다 — 최초 로그인을 놓치면 영영 못 얻는 값이 아니라서, 교환 실패 시 다음 로그인에 자연스럽게 재시도된다.

## 확정된 결정

1. **revoke 실패는 탈퇴를 막지 않는다 (best-effort).** 네트워크 오류·Apple 장애·토큰 부재 모두 error 로그만 남기고 삭제는 그대로 커밋한다. "탈퇴가 안 되는" 상태를 만드는 쪽이 사용자와 심사 양쪽에서 더 나쁘다. 실패 재시도 큐는 두지 않는다(YAGNI).

2. **revoke는 DB 트랜잭션 밖, 커밋 후에 호출한다.** 외부 HTTP 왕복이 트랜잭션을 붙잡으면 안 되고, best-effort라 롤백 대상도 아니다.

3. **`authorizationCode` 교환은 저장된 토큰이 없을 때만 동기 실행한다.** 최초 로그인·재설치 때만 Apple 왕복이 한 번 늘고, 교환에 실패하면 토큰이 없는 채로 남아 다음 로그인에 자동 재시도된다. 매 로그인 교환은 왕복 낭비, 비동기 교환은 실패 추적과 테스트가 어려워 채택하지 않는다.

4. **저장 토큰은 평문.** `/auth/token`과 `/auth/revoke` 모두 `.p8`로 서명한 `client_secret`을 함께 요구하므로, 이 토큰 단독으로는 아무 요청도 성립하지 않는다. `.p8`은 DB가 아니라 환경변수에 있어 DB 단독 유출 시 실질 피해가 없다. 앱 레벨 암호화는 crypto 유틸·키 관리·키 로테이션 비용만 추가한다.

5. **Apple 자격증명 환경변수가 없으면 전 기능 no-op.** `APPLE_TEAM_ID`/`APPLE_KEY_ID`/`APPLE_PRIVATE_KEY` 중 하나라도 비어 있으면 교환·revoke를 건너뛰고 warn을 한 번 남긴다. throw하지 않는다.

   기존 관례(결정 14: "env 미설정 시 throw")에서 의도적으로 벗어난다. `APPLE_BUNDLE_ID`는 로그인이 성립하려면 반드시 있어야 하는 값이라 throw가 맞지만, `.p8` 자격증명은 부가 기능이고 아직 발급 전이다. 없다고 로그인·탈퇴가 죽으면 안 된다.

6. **`AppleTokenService`를 신설한다.** 기존 `AppleAuthService`는 id_token 검증(JWKS)만 하고 Apple에 요청을 보내지 않는다. REST API 호출·client_secret 서명은 책임이 다르므로 분리한다.

7. **`loginWithApple`을 객체 파라미터로 바꾼다.** `(idToken, displayName?)`에 세 번째 optional 인자를 붙이면 호출부가 읽기 어려워진다. `appleCredential()`이 이미 객체를 반환하므로 오히려 단순해진다. 배포된 클라이언트가 없어 호환성 부담이 없다.

8. **`authorizationCode`는 optional.** Apple이 `null`을 줄 수 있고, 없어도 로그인은 성공해야 한다.

## 데이터 모델

`user_identities`에 nullable 컬럼 하나를 추가한다.

```
user_identities    ... (기존 유지)
                   provider_refresh_token text null   ← 신규
```

기존 행은 NULL로 남고 다음 로그인 때 채워진다. drizzle-kit으로 마이그레이션을 생성한다.

## 컴포넌트

### `AppleTokenService` (신규 · `apps/api/src/auth/apple-token.service.ts`)

Apple REST API 호출만 담당한다. DB를 모른다.

```ts
exchangeAuthorizationCode(code: string): Promise<string | null>
revokeAll(refreshTokens: string[]): Promise<void>   // 절대 throw하지 않는다
```

- `client_secret`은 호출 시점마다 생성한다. ES256 서명은 저렴하고, 캐싱하면 만료 관리가 붙는다.
- 서명은 `jose`(`importPKCS8` + `SignJWT`)로 한다 — 이미 의존성에 있고 결정 2("jose 단일")를 따른다.
- 자격증명 미설정 시 `exchangeAuthorizationCode`는 `null`, `revokeAll`은 즉시 반환.

### `AuthService.loginWithApple` (변경)

```
idToken 검증 (기존)
→ findOrCreateByIdentity (기존)
→ authorizationCode가 있고 저장된 토큰이 없으면
     exchangeAuthorizationCode → 성공 시 저장
→ 어떤 실패도 로그인을 막지 않는다
```

### `UsersService` (변경)

- `hasProviderRefreshToken(userId, provider): Promise<boolean>`
- `saveProviderRefreshToken(userId, provider, token): Promise<void>`
- `deleteAccount(userId)` 반환 타입: `Promise<void>` → `Promise<{ appleRefreshTokens: string[] }>`

  기존 `delete(userIdentities)`에 `.returning()`을 붙여 삭제된 행에서 토큰을 회수한다. 추가 쿼리가 없고 트랜잭션 안이라 경합이 없다. UsersService는 DB 전용으로 유지한다.

### `MeController.deleteMe` (변경)

```ts
const { appleRefreshTokens } = await this.users.deleteAccount(userId);
await this.appleTokens.revokeAll(appleRefreshTokens);
return; // 204
```

`MeController`는 `auth/` 안에 있고 이미 `UsersService`에 의존하므로, `AppleTokenService` 추가에 순환 의존이 생기지 않는다. (`UsersService`가 `AppleTokenService`를 직접 부르면 users → auth → users 순환이 된다.)

### 모바일 · 계약

- `providers/apple.ts` — `credential.authorizationCode`를 함께 반환
- `packages/api-client` `client.ts` / `HttpApiClient` / `MockApiClient` — 시그니처 변경
- `AuthProvider.tsx` — 객체 전달로 호출부 정리
- `auth.controller.ts` — `optionalString(body, "authorizationCode")` 추가

## 환경변수

`.env.example`에 추가한다.

```
# Apple Developer 포털 > Keys > Sign in with Apple 키(.p8)에서 얻는다.
# client_id는 기존 APPLE_BUNDLE_ID를 재사용한다.
APPLE_TEAM_ID=5JZBZK5HDQ
APPLE_KEY_ID=
APPLE_PRIVATE_KEY=
```

`APPLE_PRIVATE_KEY`는 `.p8` 파일 내용(PEM)을 그대로 넣되 개행을 `\n`으로 이스케이프한다. 서비스가 읽을 때 복원한다.

## 오류 처리

| 상황 | 동작 |
|---|---|
| 자격증명 env 미설정 | warn 1회, 교환·revoke 건너뜀. 로그인·탈퇴 정상 |
| `authorizationCode` 없음(null) | 교환 건너뜀. 로그인 성공 |
| `/auth/token` 실패 | warn. 로그인 성공, 토큰 미저장 → 다음 로그인에 재시도 |
| 저장된 토큰 없이 탈퇴 | revoke 건너뜀. 204 |
| `/auth/revoke` 실패 | error 로그. 204 |

Apple 응답 본문의 오류 문자열은 클라이언트에 노출하지 않는다(결정: 기획서 19장 유지).

## 테스트

`fetch`를 목킹한 단위 테스트(`*.spec.ts`)로 다룬다. DB를 만지는 부분은 `*.e2e-spec.ts`(결정 15).

- `client_secret` JWT의 `alg`/`kid`/`iss`/`sub`/`aud`/`exp` 클레임
- `client_id`에 Team ID가 섞이지 않는지
- `/auth/token` 성공 → `refresh_token` 반환 / 400 → `null`
- `/auth/revoke` 폼 파라미터(`token_type_hint=refresh_token`)
- 자격증명 미설정 시 fetch가 아예 호출되지 않는지
- 저장된 토큰이 있으면 로그인 시 교환하지 않는지
- `revokeAll`이 어떤 입력에도 throw하지 않는지
- `deleteAccount`가 삭제된 identity에서 Apple 토큰을 회수하는지 (e2e)
- revoke가 실패해도 `DELETE /me`가 204인지

## 검증 제약

`.p8` 키 발급은 **Apple Developer Program 멤버십이 활성화된 뒤에야** 가능하다 (2026-08-31 기준 갱신 결제 완료·반영 대기). 따라서 이번 구현은 목킹된 단위·e2e 테스트까지만 검증하고, 실제 Apple 서버 왕복 확인은 키 발급 후 별도로 수행한다. 결정 5(자격증명 없으면 no-op) 덕분에 그 사이에도 로그인·탈퇴는 정상 동작한다.
