# 팀 관리 API 갭 메우기 설계

- **날짜:** 2026-09-02
- **상태:** 검토 대기
- **선행 문서:** [2026-08-30-auth-bands-invites-design.md](2026-08-30-auth-bands-invites-design.md)

## 목적

팀 관리 화면이 요구하는 것을 서버가 아직 제공하지 못한다.

1. **팀원의 파트.** `BandMember`는 `{ id, name, role }`뿐이라 목록에 "서연 · Vocal"을 그릴 수 없다.
2. **Owner의 팀원 내보내기.** `DELETE /bands/:bandId/members/me`(본인 탈퇴)만 있고 타인을 제거하는 경로가 없다.
3. **초대 실패 사유.** `InvitesService.findValid`가 미존재·만료·취소·소진을 전부 404 하나로 뭉갠다. 화면은 "만료됐어요"와 "더 이상 쓸 수 없어요"를 다르게 보여줘야 한다.
4. **안정적인 초대 링크.** 초대 화면이 열릴 때마다 새 초대가 발급돼, 밴드 하나에 7일간 유효한 링크가 화면을 연 횟수만큼 떠다닌다. 화면이 보여주는 QR·링크는 밴드당 하나여야 한다.

이 넷을 채워 팀 관리 화면이 mock 없이 실제 서버로 동작하게 한다.

## 범위

**포함:**
- `band_part` enum + `band_members.part` 컬럼 + 마이그레이션
- `PATCH /bands/:bandId/members/me` — 본인 파트 설정·해제
- `DELETE /bands/:bandId/members/:userId` — Owner의 팀원 내보내기 (활성 초대 동반 revoke)
- `InvitesService.findValid` 사유 구분 (4가지 code)
- 초대 토큰을 해시 대신 평문으로 저장하고 활성 초대를 재사용
- 오류 응답에 `code`를 싣고 `ApiError.code`로 전달
- `@bandapp/types`의 `BandPart`·`InviteErrorCode`·`BandMember.part`
- `packages/api-client`의 HTTP·Mock 양쪽 구현
- e2e 테스트 (`test/bands.e2e-spec.ts`, `test/invites.e2e-spec.ts`)

**제외:**
- **모바일 화면 배선.** 새 API를 쓰는 화면 작업은 별도로 진행한다. 이 스펙은 계약과 서버 구현까지다.
- **Admin 역할.** MVP는 owner·member 둘뿐이다. 권한 체계는 건드리지 않는다.
- **소유권 이전.** `leave`가 owner를 막을 때 안내하는 "소유권을 넘기거나"는 아직 구현이 없다. 이번 범위 밖이다.
- **파트 이력·통계.** 현재 값만 저장한다.

## 확정된 결정

1. **파트는 `band_members`에 둔다, `users`가 아니라.** 한 사람이 밴드마다 다른 파트를 맡을 수 있고, PRD도 "팀원 목록의 각 팀원의 파트"로 규정한다. 사용자 프로필 속성이 아니라 멤버십 속성이다.

2. **`band_part`는 pgEnum, 값은 소문자.** `bandRole`·`authProvider`가 이미 pgEnum이고, `bandRole`은 `@bandapp/types`의 유니온과 값을 맞추기 위해 소문자를 쓴다. 같은 관례를 따른다. 목록에 없는 파트를 위해 `other`를 둔다.

   와이어 값은 `vocal`이고 화면 표기(`VOCAL`, `Vocal`)는 클라이언트 책임이다. 서버는 표시 문자열을 모른다.

3. **파트는 본인만 설정한다.** 엔드포인트는 `/members/me` 하나뿐이고 타인의 파트를 쓰는 경로는 만들지 않는다. PRD상 Owner 권한은 파트 "확인"까지다. 나중에 Owner 대리 설정이 필요해지면 그때 별도 엔드포인트로 추가한다 — 지금 만들면 쓰는 곳 없는 권한 분기만 늘어난다.

4. **파트 해제는 `part: null`.** 미설정이 정상 상태다(초대 과정에서 파트를 묻지 않는 것이 PRD 정책이므로 갓 참여한 멤버는 항상 `null`이다). 해제 전용 엔드포인트 대신 같은 `PATCH`에 `null`을 받는다.

5. **내보내기는 그 밴드의 활성 초대를 전부 revoke한다.** 초대는 `maxUses`가 `null`이라 7일간 횟수 제한 없이 재사용된다. 이것을 그대로 두면 내보낸 사람이 폰에 남은 링크로 즉시 돌아와 내보내기가 무력해진다.

   차단 목록 테이블 대신 초대 무효화를 택한 이유: 테이블·마이그레이션·"차단 해제" 정책이 따라붙는 데 비해 얻는 것이 "다른 사람 링크는 살아있다"뿐이다. 무효화는 `revokedAt`만 쓰면 되고 규칙이 한 줄로 설명된다 — *누군가를 내보내면 기존 초대 링크는 모두 무효가 되고 새로 만들어야 한다.*

   대가는 명시한다: 합주실에서 띄워둔 QR이 같이 죽는다. 내보내기와 초대가 동시에 일어나는 일이 드물고, 죽었다는 사실이 화면에 드러나므로(410 `invite_revoked`) 감수한다.

6. **초대 토큰을 평문으로 저장하고 활성 초대를 재사용한다.** `token_hash`를 `token`으로 바꾼다.

   지금은 화면 진입마다 새 초대가 발급된다(`InviteSheet`가 마운트 시 `createInvite`를 호출한다). 해시만 저장하면 기존 초대의 URL을 복원할 수 없어 재사용이 원리적으로 불가능하고, 그 결과 밴드 하나에 7일간 유효한 링크가 화면을 연 횟수만큼 떠다닌다.

   **평문 저장의 실제 위험이 작은 이유:** 초대 토큰이 주는 권한은 "로그인한 계정으로 그 밴드의 member가 된다"뿐이다(`join`은 `AuthGuard` 뒤에 있다). 그런데 `band_invites`를 읽을 수 있는 공격자는 `sessions`·`takes`·`comments`도 같이 읽는다 — 가입해서 얻을 것이 이미 손에 있다. 이 DB의 저장 정책도 같은 기준으로 갈려 있다: 단독으로 계정을 탈취할 수 있는 `auth_sessions.refresh_token`은 해시이고, `.p8` 없이는 아무것도 못 하는 `user_identities.provider_refresh_token`은 평문이다. 초대 토큰은 후자에 가깝다.

   **오히려 노출이 줄어든다.** 재사용이 되면 밴드당 살아있는 링크가 항상 1개다. 지금은 화면을 연 횟수만큼이다.

   **남는 위험은 두 가지이며 감수한다.** (a) `band_invites`만 새는 부분 유출 — 백업, 로그, 분석용 리드 레플리카, 한 테이블만 뽑는 SQL 인젝션. (b) 유출을 막은 뒤에도 그 사이 가입해둔 계정이 정당한 멤버로 남는 것. TTL 7일과 결정 5의 revoke(내보내기 시 전부 무효화, 수동 비활성화도 동일)가 창을 좁힌다.

   **채택하지 않은 대안:** 해시를 유지한 채 발급할 때마다 기존 활성 초대를 revoke하면 살아있는 링크는 1개가 되지만, PRD가 중심에 둔 시나리오를 깬다 — 합주실에서 띄워둔 QR이 다른 멤버의 화면 진입만으로 조용히 죽는다. 저장 시 암호화(env 키)도 가능하나 crypto 유틸·키 관리·로테이션 비용에 비해 얻는 것이 (a)뿐이다.

7. **초대 실패 사유는 토큰을 찾았을 때만 밝힌다.** 기존 주석("미존재/만료/취소/소진을 구분하지 않고 404 — 토큰 존재 여부를 노출하지 않는다")을 의도적으로 뒤집는다.

   근거: 토큰은 `randomBytes(24)` = 192비트 랜덤이라 추측이 불가능하다. 사유를 알아내려면 이미 유효한 토큰 문자열을 손에 쥐고 있어야 하고, 그 경우 얻는 정보는 "내가 받은 이 링크가 만료된 건지 취소된 건지"뿐이다. 반대편의 비용은 실사용자가 매번 같은 문구를 보고 무엇을 해야 할지 모른다는 것이다.

   찾지 못한 토큰은 기존대로 404 하나로 답한다.

8. **상태 코드는 404와 410으로 나눈다.** 토큰이 존재한 적 없으면 404 `Not Found`, 존재했지만 더 이상 유효하지 않으면 410 `Gone`. HTTP 의미론과 맞고, 클라이언트는 어차피 `code`로 분기하므로 상태 코드는 부차적이다.

9. **오류 `code`는 예외 본문에 싣는다.** `ApiError`가 `status`와 `message`만 갖고 있어 클라이언트가 문구 매칭 없이는 분기할 수 없다. Nest의 `HttpException`에 객체를 넘기면 그 객체가 그대로 응답 본문이 되므로 `{ message, code }`를 넘긴다. 기존 `errorMessage()`가 이미 `body.message`를 읽고 있어 하위 호환된다.

10. **"존재하지 않는 팀"은 별도 상태로 만들지 않는다.** `band_invites.band_id`가 `onDelete: cascade`라 밴드가 삭제되면 초대 행도 함께 사라진다. 그 상황은 `invite_not_found`로 수렴하며, 도달 불가능한 분기를 만들 이유가 없다.

## 데이터 모델

`band_members`에 nullable 컬럼 하나와 enum 하나를 추가한다.

```
band_part enum     vocal | guitar | bass | drums | keyboard | other   ← 신규

band_members       band_id   uuid   (기존)
                   user_id   uuid   (기존)
                   role      band_role   (기존)
                   joined_at timestamptz (기존)
                   part      band_part null   ← 신규
```

`band_invites`는 토큰 컬럼을 교체한다.

```
band_invites       token_hash text not null unique   ← 삭제
                   token      text not null unique   ← 신규 (평문, 결정 6)
```

마이그레이션은 `drizzle-kit generate`로 뽑는다(`0002_*.sql`). `band_members.part`는 기존 행이 전부 `null`로 남고 백필이 없다 — 미설정이 정상 상태다.

토큰 컬럼 교체는 생성된 SQL을 손봐야 한다. `not null` 컬럼을 기본값 없이 추가할 수 없고 해시에서 평문을 복원할 수도 없으므로, 컬럼 교체 앞에 `DELETE FROM band_invites;`를 넣어 기존 초대를 무효화한다. 아직 출시 전이라 살아있는 초대는 개발용뿐이고, 무효화되면 화면을 다시 열 때 새로 발급된다. 이 `DELETE`가 손으로 넣은 것임을 마이그레이션 파일에 주석으로 남긴다.

## API 계약

### `PATCH /bands/:bandId/members/me`

인증 필요. 호출자가 그 밴드의 멤버여야 한다(`assertMember`).

```
요청  { "part": "guitar" }   또는   { "part": null }
응답  200  BandMember   (갱신된 자신의 행)
```

- `part`가 `band_part` 값도 `null`도 아니면 400
- 멤버가 아니면 403 (`assertMember`가 던진다)
- `bandId`가 UUID가 아니면 400 (`requireUuidParam`)

### `DELETE /bands/:bandId/members/:userId`

인증 필요. Owner 전용.

```
응답  204  (본문 없음)
```

검증 순서와 실패:

| 상황 | 응답 |
|---|---|
| 호출자가 owner가 아님 | 403 |
| `userId`가 그 밴드의 멤버가 아님 | 404 |
| `userId`가 호출자 자신 | 409 — 팀 나가기를 안내 |
| 대상이 owner | 409 |

성공 경로는 한 트랜잭션이다:

1. `band_members`에서 `(bandId, userId)` 삭제
2. 같은 밴드의 `revoked_at IS NULL`인 초대를 전부 `revoked_at = now()`

자기 자신 검사를 owner 검사보다 뒤에 두는 이유: owner가 아닌 멤버가 자기 자신을 넣어 호출해도 403이 먼저 나와야 한다. 멤버십 존재 여부를 권한 없이 물어볼 수 있게 하지 않는다.

### `POST /bands/:bandId/invites` (동작 변경)

계약은 그대로 `BandInvite`를 반환하지만, 발급 전에 활성 초대를 먼저 찾는다.

```
활성 초대 있음  → 그 초대의 url·expiresAt을 그대로 반환 (신규 발급 없음)
활성 초대 없음  → 새로 발급
```

"활성"의 정의는 `findValid`와 같다 — `revoked_at IS NULL`, 만료 전, `max_uses` 미소진. 여러 개가 걸리면 가장 최근 것을 쓴다.

동시에 두 요청이 들어오면 둘 다 "없음"으로 판정해 각각 발급할 수 있다. 막지 않는다 — 결과는 활성 초대 2개이고 둘 다 유효하며, 결정 5의 revoke가 개수와 무관하게 전부 무효화한다. 이를 막으려면 밴드 단위 락이 필요한데, 얻는 것에 비해 비싸다.

결정 5와 맞물리는 흐름이 자연스럽다: 팀원을 내보내면 활성 초대가 전부 revoke되므로, 다음에 초대 화면을 열면 "활성 없음"으로 판정돼 새 링크가 발급된다. 화면 문구("다시 참여하려면 새 초대가 필요해요")가 실제 동작과 일치한다.

### 초대 조회·참여의 실패 응답

`preview`(`GET /invites/:token`)와 `join`(`POST /invites/:token/join`)이 공유하는 `findValid`가 아래로 갈린다.

| 상황 | 상태 | code | message |
|---|---|---|---|
| 토큰 미존재 | 404 | `invite_not_found` | 유효하지 않은 초대예요. |
| `revoked_at` 있음 | 410 | `invite_revoked` | 더 이상 사용할 수 없는 초대예요. |
| `expires_at` 지남 | 410 | `invite_expired` | 초대가 만료되었어요. |
| `max_uses` 소진 | 410 | `invite_exhausted` | 초대 사용 횟수가 모두 찼어요. |

판정 순서는 revoked → expired → exhausted다. 취소된 초대가 나중에 만료 시각을 넘겨도 사용자에게는 "취소됨"이 더 정확한 설명이다.

`max_uses`는 현재 항상 `null`(무제한)이라 `invite_exhausted`는 지금은 발생하지 않는다. `findValid`가 이미 그 조건을 검사하고 있으므로 분기만 맞춰두고, 나중에 1회용 초대가 생기면 그대로 동작한다.

## 오류 코드 전달 경로

서버는 `HttpException`에 객체를 넘긴다.

```ts
throw new GoneException({ message: "초대가 만료되었어요.", code: "invite_expired" });
```

클라이언트는 `ApiError`에 `code`를 더한다. [`HttpApiClient.errorMessage()`](../../../packages/api-client/src/http/HttpApiClient.ts)는 `{ message, code }`를 함께 뽑는 형태로 바꾸고, 나머지 호출부는 `message`만 쓰므로 그대로 둔다.

```ts
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) { ... }
}
```

`code`를 optional로 두어 기존 예외(코드 없이 던지는 것들)를 건드리지 않는다.

## 타입 파급

`@bandapp/types`:

```ts
export type BandPart = "vocal" | "guitar" | "bass" | "drums" | "keyboard" | "other";

export interface BandMember {
  id: string;
  name: string;
  role: MemberRole;
  part: BandPart | null;   // 신규
}

export type InviteErrorCode =
  | "invite_not_found"
  | "invite_revoked"
  | "invite_expired"
  | "invite_exhausted";
```

`BandMember.part`를 optional이 아니라 필수 nullable로 둔다. optional로 두면 "아직 안 불러왔다"와 "설정 안 했다"가 구분되지 않는다.

`packages/api-client`:

- `bands.setMyPart(bandId, part)` → `Promise<BandMember>`
- `bands.removeMember(bandId, userId)` → `Promise<void>`
- `RehearsalApiClient` 인터페이스, `HttpApiClient`, `MockApiClient` 세 곳 모두 반영
- `mock/seed.ts`의 멤버 픽스처에 `part` 채우기

## 테스트

기존 e2e 하네스(`test/db-util.ts`, `test/app-util.ts`)를 그대로 쓴다.

`test/bands.e2e-spec.ts`:
- 파트 설정 → `GET /members`에 반영되는지
- `part: null`로 해제되는지
- 정의되지 않은 파트 문자열 → 400
- 멤버가 아닌 사용자의 `PATCH` → 403
- Owner가 멤버를 내보냄 → 204, 목록에서 사라짐
- 내보내기가 그 밴드의 활성 초대를 revoke하는지
- 내보낸 뒤 다시 발급하면 이전과 다른 url이 나오는지
- member가 다른 member를 내보내려 함 → 403
- owner가 자기 자신을 내보내려 함 → 409
- 멤버가 아닌 `userId` → 404
- 다른 밴드의 초대는 revoke되지 않는지

`test/invites.e2e-spec.ts`:
- revoked 초대 → 410 `invite_revoked`
- 만료 초대 → 410 `invite_expired`
- 없는 토큰 → 404 `invite_not_found`
- revoked이면서 만료된 초대 → `invite_revoked`가 이긴다
- `join`도 같은 code를 내는지
- 두 번 발급하면 같은 url이 나오는지 (재사용)
- revoke 뒤 발급하면 다른 url이 나오는지
- 만료된 초대만 있을 때 발급하면 새로 나오는지
- 발급된 토큰으로 바로 `preview`가 되는지 (평문 저장 왕복 확인)

`packages/api-client`:
- `errorMessage`가 `code`를 뽑아 `ApiError.code`에 싣는지
- `code` 없는 오류 응답에서 `ApiError.code`가 `undefined`인지

## 후속 작업

이번 범위에서 의도적으로 미룬 것들.

1. **모바일 화면 배선.** 파트 설정 시트, 팀원 관리 시트, 내보내기 확인, 초대 오류 4분기가 새 API를 쓰도록 연결하는 작업.
2. **소유권 이전.** `leave`가 owner에게 "소유권을 넘기거나 팀을 삭제해야 해요"라고 안내하지만 두 경로 모두 구현이 없다.
3. **`max_uses`를 쓰는 1회용 초대.** 분기는 준비돼 있으나 이를 발급하는 경로가 없다.
4. **만료된 초대 행 정리.** 재사용이 생겨도 만료·revoke된 행은 계속 쌓인다. 양이 문제될 규모가 아니라 지금은 두지만, 정리 작업이 필요해지면 배치로 지운다.
