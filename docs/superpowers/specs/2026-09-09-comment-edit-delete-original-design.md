# 코멘트 수정·삭제와 원본 녹음 코멘트 설계

## 목표

멤버가 자기 코멘트·답글의 본문을 고치거나 지울 수 있게 하고, 잘린 take뿐 아니라 원본 녹음에도 코멘트를 남길 수 있게 한다. 디자인은 Claude Design `Rehearsal App.dc.html`의 "Take Feedback" 화면(코멘트 `···` 시트, 편집 배너, 삭제 확인 다이얼로그)과 "Session Detail"의 `openOriginal` 동작을 따른다.

현재 상태: `comments` 컨트롤러는 GET/POST뿐이다. `comments.take_id`가 NOT NULL이라 원본 녹음에는 코멘트를 달 수 없고, `TakePlayerScreen`은 `takeId === "orig"`일 때 코멘트 목록과 입력창을 숨긴다 ([2026-09-04 스펙](2026-09-04-upload-analysis-takes-feedback-design.md) 결정 6). 스레드는 [2026-09-07 스펙](2026-09-07-comment-threads-design.md)대로 작성만 된다.

## 범위

**포함:**
- `PATCH /comments/:id`, `DELETE /comments/:id` (작성자만)
- `comments.session_id` 추가, `take_id` nullable, `updated_at` 추가 — 마이그레이션 `0006`
- `GET/POST /sessions/:id/comments` (원본 녹음 코멘트, take와 같은 규칙)
- `@bandapp/types`·`packages/api-client`(HTTP/Mock) 계약 갱신, Mock 시드에 원본 코멘트 추가
- 모바일: `···` 액션 시트, 편집 모드, 삭제 확인, "edited" 표기, 원본 녹음 화면의 코멘트 켜기

**제외:**
- 밴드 owner의 타인 코멘트 삭제(중재)
- 시점(atSec) 수정 — 시점을 바꾸려면 지우고 다시 남긴다
- 삭제된 코멘트의 흔적(tombstone) 표시
- 세션 상세 "Original recording" 칩의 코멘트 수 표시 (디자인에 없다)
- 이 화면 문구의 i18n 이관 (백로그 항목이 한 번에 처리한다)
- "Edit takes" 칩 (디자인에 있으나 Take 경계 편집 백로그 항목)

## 결정

1. **수정·삭제는 작성자만.** 서버는 `author_id === userId`를 본다. owner 중재는 나중에 필요해지면 더한다.

2. **수정은 본문만, `updatedAt`으로 "edited"를 표시한다.** `comments.updated_at`은 nullable이고 수정할 때만 채운다. `updatedAt !== null`이면 클라이언트가 "edited"를 그린다. 시점은 답글이 부모의 시점을 물려받는 구조와 얽히므로 건드리지 않는다.

3. **부모를 지우면 답글도 사라진다.** `parent_id`의 기존 `ON DELETE CASCADE`에 맡긴다. 삭제 확인 다이얼로그는 디자인대로 본문 인용만 보여주고 답글 수는 말하지 않는다.

4. **원본 녹음 코멘트는 같은 테이블, 같은 타입이다.** `comments.session_id NOT NULL`을 모든 행에 두고(기존 행은 마이그레이션에서 take로 backfill), `take_id`는 원본 코멘트면 NULL. `TakeComment` 타입 이름은 유지하고 `takeId: string | null`, `sessionId: string`을 더한다. 별도 테이블·타입은 스레드·수정·삭제 로직을 두 벌로 만들어 탈락.

5. **부모 검증은 "같은 대상"이다.** take 코멘트의 부모는 같은 `take_id`, 원본 코멘트의 부모는 같은 `session_id`이면서 `take_id IS NULL`인 최상위 코멘트. 아니면 400.

6. **세션 `commentCount`는 원본 코멘트를 포함한다.** `SESSION_WITH_COUNTS`의 서브쿼리를 `c.session_id = sessions.id and c.parent_id is null`로 바꾼다 — takes 조인이 사라진다. take의 `commentCount`는 그대로.

7. **코멘트 id 단독 경로.** `PATCH/DELETE /comments/:id`는 코멘트 → `session_id` → `sessions.loadForMember`로 멤버십을 확인한 뒤 작성자를 본다. 순서: 없으면 404 → 비멤버 403 → 작성자 아님 403.

8. **api-client는 target 객체를 받는다.** `comments.list(target)`, `comments.create(target, input)`에서 `target`은 `{ takeId }` 또는 `{ sessionId }`. 모바일 화면이 이미 `isOriginal`로 갈라지므로 한 코드 경로로 합쳐진다. `update(id, { text })`, `remove(id)`를 더한다.

9. **삭제 확인은 `ConfirmDialog`.** 디자인이 공용 확인 다이얼로그(제목·본문·빨간 주 버튼·Cancel)를 쓴다. 답글이 있든 없든 항상 확인한다.

10. **"edited" 표기는 디자인에 없다.** 요청으로 더한다: `updatedAt`이 있으면 코멘트는 시각 옆, 답글은 이름 옆에 `textFaint` small 텍스트 `· edited`.

11. **문구는 영어 하드코딩.** 이 화면의 기존 문구가 그렇고, 같은 화면에 한국어 리소스 문구가 섞이면 더 나쁘다. i18n 이관 백로그 항목이 화면 단위로 옮긴다.

## 스키마

```
comments  + session_id uuid NOT NULL fk→sessions cascade   (backfill: takes.session_id)
          ~ take_id    uuid NULL     fk→takes cascade       (원본 코멘트면 NULL)
          + updated_at timestamptz NULL                      (수정 시에만)
          + index (session_id, at_ms)
```

마이그레이션 `0006`: 컬럼을 nullable로 추가 → `UPDATE comments SET session_id = (SELECT session_id FROM takes WHERE takes.id = comments.take_id)` → NOT NULL → `take_id` DROP NOT NULL → 인덱스. drizzle-kit이 만든 SQL에 backfill 문장을 손으로 끼운다(`0005`와 같은 방식).

## API 계약

```
GET    /takes/:id/comments                    (기존)
POST   /takes/:id/comments                    (기존)
GET    /sessions/:id/comments                 → TakeComment[]  at_ms, created_at 순, 원본 코멘트만 (take_id IS NULL)
POST   /sessions/:id/comments                 { atSec, text } | { parentId, text } → 201
       - 규칙은 take와 같다. 길이 상한은 session.durationMs (null이면 검사 생략)
       - parentId가 이 세션의 원본 최상위 코멘트가 아니면 400
PATCH  /comments/:id   { text }               → 200 TakeComment (updatedAt 채워짐)
       - text 1~500자 trim. 작성자 아니면 403
DELETE /comments/:id                          → 204. 작성자 아니면 403. 답글은 cascade
```

```ts
export interface TakeComment {
  id: string;
  sessionId: string;
  /** 원본 녹음 코멘트면 null */
  takeId: string | null;
  authorId: string;
  authorName: string;
  parentId: string | null;
  atSec: number;
  text: string;
  createdAt: string;
  /** 본문을 수정한 적 있으면 채워진다 → "edited" */
  updatedAt: string | null;
}
export type CommentTarget = { takeId: string } | { sessionId: string };
export interface UpdateCommentInput { text: string }

comments: {
  list(target: CommentTarget): Promise<TakeComment[]>;
  create(target: CommentTarget, input: CreateCommentInput): Promise<TakeComment>;
  update(id: string, input: UpdateCommentInput): Promise<TakeComment>;
  remove(id: string): Promise<void>;
};
```

## 서버

- `CommentsService`는 대상을 `CommentScope = { sessionId, takeId: string | null, lengthMs: number | null }`로 받는다. `scopeForTake(takeId, userId)`는 `takes.loadForMember`, `scopeForSession(sessionId, userId)`는 `sessions.loadForMember`로 만든다. `list(scope)`·`create(scope, input)`가 공통이다.
- `update(id, userId, { text })`·`remove(id, userId)`: 코멘트 행을 읽고(없으면 404) → `sessions.loadForMember(row.sessionId, userId)` → `row.authorId !== userId`면 `ForbiddenException`. update는 `updated_at = now()`.
- 컨트롤러: `CommentsController`를 `@Controller()`로 바꿔 `takes/:id/comments`, `sessions/:id/comments`, `comments/:id`를 함께 둔다. `CommentsModule`이 `SessionsModule`을 import한다(`TakesModule`이 이미 하듯).
- `SESSION_WITH_COUNTS.commentCount` 서브쿼리 교체 (결정 6).
- `truncateAll`은 그대로(`comments`가 이미 있다).

## api-client

- HTTP: target으로 경로를 고른다 (`"takeId" in target`). update는 PATCH, remove는 DELETE 후 둘 다 `emit()`.
- Mock: `state.comments`의 키를 `take:<id>` / `session:<id>`로 바꾸고 `commentKey(target)` 헬퍼. `update`는 본문과 `updatedAt`을 바꾼다. `remove`는 코멘트와 그 답글을 지우고, 최상위였다면 take·세션 `commentCount`를 1 내린다(원본 코멘트는 세션만). 작성자가 `MOCK_USER.id`가 아니면 throw. 시드에 `session:s1` 원본 코멘트 두 개와 `updatedAt`이 있는 코멘트 하나를 둔다. `Session.commentCount` 시드 계산에 원본 코멘트를 더한다.

## 모바일

- `useComments(target: CommentTarget | undefined)`.
- `TakePlayerScreen`: `target = isOriginal ? { sessionId: session.id } : { takeId: take.id }`. 원본일 때도 목록·입력·"No feedback yet…" 빈 문구를 그린다. "Feedback lives on takes…" 문구는 지운다. 상태 추가: `actionTarget: TakeComment | null`(시트), `editTarget: TakeComment | null`(편집 모드), `confirmDelete: TakeComment | null`.
- `CommentThread`: `meId` prop. `authorId === meId`인 코멘트·답글의 "Reply" 옆에 `···` 링크(`textFaint`, letterSpacing) → `onActions(comment)`. `updatedAt`이 있으면 `· edited` (결정 10).
- `CommentActionSheet.tsx` (features/takes): 공용 `BottomSheet` 안에 인용문 한 줄(`"{text}"`, `numberOfLines={1}`, caption 색, 아래 구분선) → `SheetRow` "Edit comment"/"Edit reply" → `SheetRow danger` "Delete comment"/"Delete reply". 답글 여부는 `parentId !== null`.
- `SheetRow`를 `features/band/`에서 `src/ui/`로 옮긴다(`ui/index.ts` export, band의 import 경로 수정). 내용은 그대로.
- 편집 시작: 시트 닫기 → `editTarget` 설정, `replyTo` 해제, `input = text`. `CommentInput`에 `editing?: { isReply: boolean; onCancel }` prop — 답글 배너와 같은 스타일로 "Editing comment"/"Editing reply" + ✕. 포커스는 `replyingTo`처럼 객체 의존성으로. placeholder는 답글 모드가 아니면 기존 "Leave feedback at …"(프리필돼 있어 보이지 않는다).
- 전송(`send`): `editTarget`이 있으면 `api.comments.update(id, { text })` → reload. 없으면 기존 분기. 편집 중 본문이 비면 무시(기존과 동일).
- 삭제: 시트 Delete → 시트 닫고 `confirmDelete` → `ConfirmDialog` 제목 "Delete comment?"/"Delete reply?", 본문 `“{text 60자, 넘으면 …}” will be removed for everyone in the band.`, 주 버튼 danger "Delete comment"/"Delete reply", `cancelLabel` "Cancel", `busy` 동안 잠금. 확인 → `api.comments.remove(id)` → reload → 토스트 "Comment deleted"/"Reply deleted". 삭제된 것이 `editTarget`이면 편집 모드도 해제.
- 실패: 수정·삭제 모두 토스트 "Something went wrong"(기존 패턴). 이미 지워진 코멘트(404)도 같은 토스트 후 reload.
- 파형 마커·`groupThreads`는 그대로(원본 코멘트도 `parentId`로 묶인다).

## 테스트

- **API e2e** (`comments.e2e-spec.ts`): 응답 shape에 `sessionId`·`takeId`·`updatedAt: null` / PATCH가 본문만 바꾸고 `updatedAt`을 채우며 목록에 반영 / 타인 코멘트 PATCH·DELETE 403, 비멤버 403, 없는 id 404 / 부모 DELETE 후 답글도 목록에서 사라지고 take·세션 `commentCount` 감소 / 원본 코멘트 생성·조회(take 목록엔 안 섞임), 세션 `commentCount`에 포함, 답글이 부모 시점 상속 / take 코멘트를 원본 답글의 부모로 주면 400, 그 반대도 400 / 세션 길이 초과 400.
- **api-client**: HTTP가 target별 경로·PATCH·DELETE를 부른다. Mock `update`가 `updatedAt`을 찍고, `remove`가 답글까지 지우고 카운트를 내리며, 원본 시드가 `list({ sessionId })`로 나온다.
- **모바일**: `groupThreads`는 변경 없음. 화면 상태 전환(편집 시작이 답글 모드를 끊는 것 등)은 순수 함수로 뺄 만큼 크지 않아 수동 확인.

## 백로그에 남기는 것

owner 중재 삭제, 시점 수정, 삭제 흔적 표시. 이 화면 문구의 i18n 이관은 기존 항목 그대로.
