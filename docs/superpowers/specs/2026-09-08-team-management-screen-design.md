# 팀 관리 화면 + 서버 갭 + i18n 인프라 설계

- **날짜:** 2026-09-08
- **상태:** 검토 대기
- **선행 문서:** [2026-09-02-team-management-api-design.md](2026-09-02-team-management-api-design.md), [2026-08-30-auth-bands-invites-design.md](2026-08-30-auth-bands-invites-design.md)
- **디자인:** Claude Design 프로젝트 "Rehersal app"의 `Rehearsal App.dc.html`, "Band" 화면

## 목적

팀 관리 API(2026-09-02)는 서버까지만 만들고 모바일 배선을 미뤘다. 이번에 그 화면을 디자인대로 만든다. 디자인이 요구하는 것 중 서버에 없는 넷을 같이 채운다.

1. **파트 자유 입력.** `band_part`가 enum이라 "Synth", "Sax"를 못 넣는다. 프리셋은 UI로 제공하고 직접 입력도 받는다.
2. **밴드 이름 변경.**
3. **소유권 이전.** `leave`가 owner에게 "먼저 소유권을 넘기거나 팀을 삭제하라"고 안내하지만 두 경로 다 없다.
4. **밴드 삭제.**

화면 문구는 i18n으로 넣는다. 앱이 지금 영어(밴드 탭)와 한국어(설정, 서버 오류)로 섞여 있어, 이번 화면부터 리소스 기반으로 간다.

## 범위

**포함:**
- `band_members.part` enum → text, `bands.deleted_at` 추가, 마이그레이션
- `PATCH /bands/:bandId`(이름 변경), `POST /bands/:bandId/transfer`(소유권 이전), `DELETE /bands/:bandId`(soft delete)
- `PATCH /bands/:bandId/members/me`의 `part` 검증을 문자열로 변경
- 삭제된 밴드를 멤버십·목록·초대에서 제외
- 밴드 오류에 `code` 부여, `@bandapp/types`의 `BandErrorCode`
- `packages/api-client` HTTP·Mock 양쪽
- 모바일 i18n 인프라(`i18next` + `react-i18next` + `expo-localization`), ko/en 리소스
- 팀 관리 화면: 멤버 목록, 본인 시트, 파트 시트, 타인 시트, 이전 시트, 이름 변경 시트, 확인 다이얼로그
- e2e(`bands.e2e-spec.ts`, `invites.e2e-spec.ts`), 모바일 순수 로직 테스트

**제외:**
- **기존 화면 문구의 i18n 이관.** 세션·녹음·설정·초대 랜딩의 하드코딩 문구는 그대로 둔다. 백로그.
- **언어 전환 UI.** 기기 언어만 따른다.
- **삭제된 밴드의 영구 삭제(행 + R2 객체).** 배치로 별도 진행. 백로그.
- **Owner의 타인 파트 설정.** 2026-09-02 결정 3 유지.
- **초대 목록·취소 화면.** 디자인에 없다.

## 확정된 결정

1. **파트는 text로 저장하고, 프리셋은 키로 저장한다.** 값은 프리셋 키(`vocal | guitar | bass | drums | keyboard`) 또는 사용자가 직접 친 문자열이다. 프리셋을 표시 문자열("Vocals", "보컬")이 아니라 키로 저장하는 이유: 한국어 사용자와 영어 사용자가 같은 밴드에 있을 때 각자 언어로 봐야 한다. 자유 문자열은 친 그대로 저장하고 번역 없이 표시한다.

   클라이언트는 표시할 때 값이 프리셋 키면 번역하고 아니면 그대로 보여준다. 직접 입력한 값이 현재 언어의 프리셋 라벨과 대소문자 무시 일치하면 키로 정규화한다("guitar" → `guitar`, "기타" → `guitar`).

   `other`는 없앤다. 자유 입력이 생겨 의미가 없다. 마이그레이션에서 `other`는 NULL로 만든다.

2. **서버는 파트 문자열을 검증만 하고 해석하지 않는다.** trim 후 1~20자면 저장, 아니면 400. NULL은 해제. 프리셋 키 목록은 `@bandapp/types`에 두지만 서버는 참조하지 않는다 — 프리셋이 늘어도 서버가 바뀔 이유가 없다.

3. **밴드 삭제는 soft delete.** `bands.deleted_at`만 채운다. `users.deleted_at`과 같은 관례다. 행과 R2 객체는 남긴다. 실수 삭제 복구가 필요해지면 이 값을 비우면 되고, 영구 삭제는 나중에 배치가 맡는다.

   디자인 문구("This can't be undone")는 사용자 관점에서 참이다 — 앱에서 되돌릴 방법은 없다.

4. **삭제된 밴드는 `MembershipsService.roleOf` 한 곳에서 막는다.** `roleOf`가 `bands`를 조인해 `deleted_at is null`인 경우에만 role을 돌려준다. 세션·take·코멘트·초대 생성·멤버 목록 등 밴드 스코프 라우트가 전부 `assertMember`/`assertOwner`를 지나므로 이 한 곳으로 닫힌다. 별도 "밴드 존재 확인"을 라우트마다 넣지 않는다.

   `listForUser`는 자체 쿼리라 따로 필터한다. 초대 `preview`/`join`은 이미 `bands`를 조회하므로 거기서 `deleted_at`을 보고 `invite_not_found`로 답한다(2026-09-02 결정 10과 같은 결과).

5. **마지막 멤버가 나가면 hard delete 대신 soft delete.** 기존 `leave`는 마지막 멤버일 때 행을 지웠다. 결정 3과 맞춘다.

6. **밴드 이름 변경은 owner만.** 2026-08-30 스펙이 "밴드 설정"을 owner 권한으로 뒀고, 디자인의 이전 확인 문구도 "새 owner가 멤버와 밴드 설정을 관리한다"고 쓴다. 디자인은 "Band name" 행을 전원에게 보여주지만 member에게는 숨긴다.

7. **소유권 이전은 owner→member 교체 한 번이다.** 트랜잭션으로 대상을 owner, 본인을 member로 바꾼다. 밴드당 owner는 항상 정확히 1명이다. 대상이 멤버가 아니면 404, 본인이면 409.

8. **밴드 오류에 `code`를 싣는다.** 초대 오류와 같은 방식(`{ message, code }`). 클라이언트는 code가 있으면 번역하고 없으면 서버 메시지를 그대로 보여준다. 서버 메시지는 한국어로 남겨둔다 — 이 스펙 이후 code가 없는 밴드 오류는 없어야 하므로 실사용에서는 보이지 않는다.

9. **i18n은 `i18next` + `react-i18next` + `expo-localization`.** 리소스는 TS 객체. `en`이 타입 원본이고 `ko`는 `typeof en`으로 강제해 키 누락을 타입체크가 잡는다. 언어는 `getLocales()[0].languageCode`, ko가 아니면 en. 런타임 언어 전환은 만들지 않는다.

10. **확인 다이얼로그는 새 UI 컴포넌트.** 디자인이 중앙 다이얼로그(제목·본문·주 버튼·보조 버튼·Cancel)를 쓰고, `Alert.alert`로는 보조 버튼 색(danger/safe)과 본문 스타일을 못 맞춘다. `src/ui/ConfirmDialog.tsx`로 만든다. 설정 화면의 기존 `Alert.alert`는 이번에 안 바꾼다.

11. **Invite 버튼은 owner에게만 보인다.** 서버 `createInvite`가 이미 owner 전용이라 member에게는 403으로 빈 시트가 뜨던 문제(2026-08-30 후속 항목)를 여기서 닫는다.

## 데이터 모델

```
bands              deleted_at  timestamptz null   ← 신규

band_members       part        text null          ← band_part enum에서 변경

band_part enum                                    ← 삭제
```

마이그레이션(`drizzle-kit generate` 후 손질):

```sql
ALTER TABLE band_members ALTER COLUMN part TYPE text USING part::text;
UPDATE band_members SET part = NULL WHERE part = 'other';
DROP TYPE band_part;
ALTER TABLE bands ADD COLUMN deleted_at timestamptz;
```

`vocal`·`guitar`·`bass`·`drums`·`keyboard`는 문자열이 그대로 프리셋 키가 되므로 변환이 없다. `other`→NULL과 `DROP TYPE`은 생성기가 안 만들 수 있으니 손으로 넣고 주석을 남긴다.

## 공유 타입 (`@bandapp/types`)

```ts
// band.ts
export const BAND_PART_PRESETS = ["vocal", "guitar", "bass", "drums", "keyboard"] as const;
export type BandPartPreset = (typeof BAND_PART_PRESETS)[number];

export interface BandMember {
  id: string;
  name: string;
  role: MemberRole;
  /** null = 미설정. 프리셋 키(BAND_PART_PRESETS)거나 사용자가 직접 친 문자열. */
  part: string | null;
}

export type BandErrorCode =
  | "band_forbidden"            // 403 멤버 아님 (삭제된 밴드 포함)
  | "band_owner_only"           // 403 owner 전용
  | "band_owner_must_transfer"  // 409 owner가 leave
  | "band_member_not_found"     // 404 대상 userId가 멤버 아님
  | "band_cannot_remove_self"   // 409 removeMember 대상이 본인
  | "band_cannot_remove_owner"  // 409 removeMember 대상이 owner
  | "band_transfer_self";       // 409 transfer 대상이 본인
```

`BandPart` 타입은 삭제한다. 쓰던 곳(`requireBandPartOrNull`, Mock, `MemberRow`)을 같이 고친다.

## API 계약

모두 인증 필요. `bandId`·`userId`는 `requireUuidParam`.

### `PATCH /bands/:bandId`

```
요청  { "name": "Friday Night" }
응답  200  Band
```

- `assertOwner`. member면 403 `band_owner_only`.
- `name`은 trim 후 1~50자(`create`와 같은 규칙), 아니면 400.

### `POST /bands/:bandId/transfer`

```
요청  { "userId": "<uuid>" }
응답  204
```

- `assertOwner`.
- 대상이 멤버가 아니면 404 `band_member_not_found`. 본인이면 409 `band_transfer_self`.
- 트랜잭션: 대상 `role = owner`, 호출자 `role = member`.
- 검증 순서는 `removeMember`와 같다 — owner 확인이 먼저다.

### `DELETE /bands/:bandId`

```
응답  204
```

- `assertOwner`.
- `bands.deleted_at = now()`. 멤버·초대·세션 행은 그대로.
- 이미 삭제된 밴드는 `roleOf`가 null을 주므로 403 `band_forbidden`으로 떨어진다. 멱등이 아니지만 두 번 누를 수 있는 UI가 아니다.

### `PATCH /bands/:bandId/members/me` (변경)

```
요청  { "part": "guitar" } | { "part": "Synth" } | { "part": null }
응답  200  BandMember
```

- `part`가 문자열이면 trim 후 1~20자, 아니면 400. null은 해제. 그 외 타입은 400.
- `requireBandPartOrNull`을 `requirePartOrNull`로 교체.

### 기존 엔드포인트의 code

| 엔드포인트 | 상황 | 상태 | code |
|---|---|---|---|
| `assertMember` 전부 | 멤버 아님 / 밴드 삭제됨 | 403 | `band_forbidden` |
| `assertOwner` 전부 | member | 403 | `band_owner_only` |
| `DELETE /members/me` | owner이고 다른 멤버가 있음 | 409 | `band_owner_must_transfer` |
| `DELETE /members/:userId` | 대상 없음 | 404 | `band_member_not_found` |
| `DELETE /members/:userId` | 대상이 본인 | 409 | `band_cannot_remove_self` |
| `DELETE /members/:userId` | 대상이 owner | 409 | `band_cannot_remove_owner` |

### 삭제된 밴드의 파급

- `GET /bands` 목록에서 제외.
- `GET /invites/:token`, `POST /invites/:token/join`: 밴드가 삭제됐으면 404 `invite_not_found`.
- 그 외 밴드 스코프 라우트: `roleOf`가 null → 403 `band_forbidden`.

## API 클라이언트

`RehearsalApiClient.bands`에 추가:

```ts
rename(bandId: string, name: string): Promise<Band>;
transferOwnership(bandId: string, userId: string): Promise<void>;
delete(bandId: string): Promise<void>;
```

`setMyPart(bandId, part: string | null)`로 시그니처 변경.

Mock은 같은 규칙을 흉내 낸다: rename은 이름 교체, transfer는 role 교체, delete는 목록에서 제거(Mock에는 deleted_at 개념이 없다 — 목록에서 빠지는 것이 관찰 가능한 전부다). 오류는 `ApiError(status, message, code)`로 던져 화면의 code 분기가 Mock에서도 동작하게 한다.

## 모바일 i18n 인프라

```
apps/mobile/src/i18n/
  index.ts     i18next 초기화. 언어 감지, 리소스 등록, react-i18next 바인딩. 루트 _layout에서 import.
  en.ts        export const en = { ... }  ← 타입 원본
  ko.ts        export const ko: Resource = { ... }   ← Resource = typeof en
  types.ts     Resource 타입, react-i18next 모듈 확장(키 자동완성)
```

키 구조(단일 네임스페이스, 중첩 객체):

```
common.cancel, common.save, common.you
band.header.yourBand, band.header.members
band.invite.button, band.invite.title, band.invite.subtitle, band.invite.copy, band.invite.copied
band.manage.title, band.manage.bandName, band.manage.transfer, band.manage.leave, band.manage.delete
band.role.owner, band.role.member
band.part.title, band.part.subtitle, band.part.placeholder, band.part.none
band.part.preset.vocal / guitar / bass / drums / keyboard
band.self.changePart, band.self.transfer, band.self.transferSubtitle
band.member.makeOwner, band.member.makeOwnerSubtitle, band.member.remove
band.transfer.title, band.transfer.subtitle
band.rename.title
band.confirm.remove.title / body / primary        ({{name}}, {{band}})
band.confirm.transfer.title / body / primary
band.confirm.delete.title / body / primary
band.confirm.leave.title / body / primary
band.confirm.ownerLeave.title / body / primary / secondary
band.toast.removed, band.toast.transferred, band.toast.deleted, band.toast.left, band.toast.renamed, band.toast.partSet
errors.generic
errors.band_forbidden, errors.band_owner_only, errors.band_owner_must_transfer,
errors.band_member_not_found, errors.band_cannot_remove_self, errors.band_cannot_remove_owner,
errors.band_transfer_self
errors.invite_not_found, errors.invite_revoked, errors.invite_expired, errors.invite_exhausted
```

영어 문구는 디자인 프로토타입의 것을 그대로 쓴다. 한국어는 설정 화면·서버 메시지의 어투("~해요")를 따른다.

헬퍼 `src/i18n/apiErrorMessage.ts`:

```ts
export function apiErrorMessage(err: unknown, t: TFunction): string
```
`ApiError`이고 `code`가 `errors.*`에 있으면 번역, 없으면 `err.message`, `ApiError`가 아니면 `errors.generic`.

파트 표시·정규화 `src/features/band/partValue.ts`:

```ts
export function partLabel(part: string | null, t: TFunction): string   // 키면 번역, 아니면 그대로, null이면 band.part.none
export function normalizePartInput(input: string, t: TFunction): string | null  // trim, 빈 문자열이면 null, 프리셋 라벨과 대소문자 무시 일치하면 키
```

## 팀 관리 화면

디렉토리 `apps/mobile/src/features/band/`. 기존 `BandScreen`·`MemberRow`·`InviteSheet`를 고치고 나머지는 신규.

### BandScreen

- 헤더: `YOUR BAND` / 밴드 이름 / `MEMBERS · n`. 기존과 같다.
- 멤버 목록: `MemberRow`에 파트(`partLabel`)와 OWNER 배지, 탭 가능하면 chevron. 본인 행 이름 뒤에 `(You)`.
- 탭 조건: 본인이면 `SelfMemberSheet`, owner가 타인을 누르면 `MemberSheet`, 그 외는 탭 불가(chevron 없음).
- `+ Invite member`: owner만.
- MANAGE 섹션: `Band name`(owner, 현재 이름 + chevron), `Transfer ownership`(owner), `Leave band`(전원, danger 색), `Delete band`(owner, danger 색).
- owner 판정: 멤버 목록에서 `useAuth().state.user.id`와 같은 행의 `role`. 목록을 아직 못 불러왔으면 member로 취급해 owner 전용 UI를 숨긴다(깜빡임보다 안전).
- 상태: `sheet: null | { kind: "self" } | { kind: "member"; member } | { kind: "part" } | { kind: "transfer" } | { kind: "rename" } | { kind: "invite" }`, `confirm: null | { kind: "remove"; member } | { kind: "transfer"; member } | { kind: "delete" } | { kind: "leave" } | { kind: "ownerLeave" }`.
- 액션 성공 후: 멤버 `reload()` + `refreshBands()`(memberCount·이름 갱신), 토스트. 나가기·삭제 후에는 `router.replace("/")`(세션 탭). 밴드가 0개면 기존 `bandGate`가 온보딩으로 보낸다. `CurrentBandProvider`는 현재 밴드가 목록에서 사라지면 이미 첫 밴드로 넘어가므로(`list.find(...) ?? list[0]`) 추가 처리가 없다.
- 액션 실패: `apiErrorMessage`로 토스트. 시트·다이얼로그는 닫는다.
- 진행 중(`busy`)에는 확인 버튼을 비활성화해 두 번 누름을 막는다.

### 시트

모두 기존 `BottomSheet` 위. 행은 `SheetActionRow` 또는 그와 같은 패딩·radius의 행.

- **SelfMemberSheet**: 아바타·이름·역할 라벨 헤더. `Change part`(현재 파트 우측 표시) → 파트 시트. owner면 `Transfer ownership` → 이전 시트.
- **PartSheet**: 제목·부제. 프리셋 5행(선택된 것에 ✓). 아래 텍스트 입력(플레이스홀더 "Or type your own — e.g. Synth, Sax…")과 ✓ 버튼. Enter/✓로 `normalizePartInput` → `setMyPart`. 빈 입력은 무시.
- **MemberSheet** (owner가 타인): 헤더. `Make owner` → 이전 확인. `Remove from band`(danger) → 내보내기 확인.
- **TransferSheet**: 본인 제외 멤버 목록. 탭 → 이전 확인.
- **RenameSheet**: 입력(현재 이름 채움) + Save. trim 후 빈 값이면 무시. 1~50자 초과는 서버 400 → 토스트.
- **InviteSheet**: 기존 유지, 문구만 i18n.

### ConfirmDialog (`src/ui/ConfirmDialog.tsx`)

```ts
{
  visible; title; body;
  primary: { label; onPress; danger?: boolean };
  secondary?: { label; onPress };   // danger 색 텍스트 버튼
  onCancel;
  busy?: boolean;
}
```

디자인대로 중앙 카드, 배경 dim, `Modal` 기반. 5개 확인의 문구:

| kind | 제목 | 주 버튼 | 보조 |
|---|---|---|---|
| remove | Remove {name}? | Remove (danger) | — |
| transfer | Make {name} the owner? | Transfer ownership (safe) | — |
| delete | Delete {band}? | Delete band (danger) | — |
| leave | Leave {band}? | Leave band (danger) | — |
| ownerLeave | Transfer ownership first | Transfer ownership (safe) → 이전 시트 | Delete band → delete 확인 |

`ownerLeave`는 클라이언트가 owner임을 알 때 바로 띄운다. 서버 409 `band_owner_must_transfer`가 오면(목록이 낡았을 때) 같은 다이얼로그를 띄운다.

## 오류 처리

- 네트워크·서버 오류는 전부 토스트. 화면 상태는 액션 전으로.
- 403 `band_forbidden`이 밴드 스코프 라우트에서 오면 밴드가 삭제됐거나 내보내진 것이다. 토스트 후 `refreshBands()` — 목록에서 빠지면 gate가 처리한다. 이 규칙은 이번 화면에만 넣고 앱 전역 처리는 안 한다.
- 초대 랜딩의 오류 문구는 그대로 두되, `errors.invite_*` 키는 미리 넣어 다음 이관 때 쓴다.

## 테스트

**서버 e2e** (`apps/api/test/bands.e2e-spec.ts`):
- rename: owner 200, member 403 `band_owner_only`, 빈 이름·51자 400
- transfer: 성공 후 members에서 role 교체 확인, 대상 없음 404, 본인 409, member가 호출 403
- delete: 204 후 `GET /bands`에서 빠짐, 멤버 목록 403 `band_forbidden`, 세션 목록 403, member가 호출 403
- leave: 마지막 멤버가 나가면 soft delete(행 남고 목록에서 빠짐), owner 409에 code
- setMyPart: 자유 문자열 저장·조회, 21자 400, null 해제
- 기존 removeMember 오류에 code

**서버 e2e** (`invites.e2e-spec.ts`): 삭제된 밴드의 초대는 preview·join 모두 404 `invite_not_found`.

**모바일** (vitest, 순수 로직):
- `partValue.test.ts`: 키 번역, 자유 문자열 그대로, null, 라벨→키 정규화(대소문자·양쪽 언어), 빈 입력 null
- `apiErrorMessage.test.ts`: code 있음/없음/ApiError 아님
- 리소스 키 누락은 `ko: Resource` 타입으로 `pnpm typecheck`가 잡는다.

화면 자체는 Mock 모드(`EXPO_PUBLIC_API_URL` 비움)로 웹 프리뷰에서 눈으로 확인한다. owner/member 두 상태를 보려면 Mock 시드에 member 계정 시나리오가 필요하다 — Mock의 `MOCK_USER`가 owner인 밴드 하나와 member인 밴드 하나를 시드한다.

## 진행

스펙 하나, 플랜 둘.

1. **서버 플랜**: types → 마이그레이션 → `MembershipsService` → `BandsService`·컨트롤러 → invites 파급 → api-client HTTP·Mock → e2e.
2. **모바일 플랜**: i18n 인프라 → `partValue`·`apiErrorMessage` → `ConfirmDialog` → 시트들 → `BandScreen` → Mock 시드.

## 후속 작업 (백로그로 이관)

- 삭제된 밴드 영구 삭제 배치(행 + R2 객체). 세션 삭제 정리 배치와 같이.
- 기존 화면(세션·녹음·설정·초대 랜딩) 문구의 i18n 이관. 설정 화면의 `Alert.alert`를 `ConfirmDialog`로.
- 언어 전환 UI.
