# 피드백 화면 댓글·대댓글 설계

## 목표

Take 피드백 화면에서 코멘트에 답글을 달고 스레드로 볼 수 있게 한다. 디자인은 Claude Design `Rehearsal App.dc.html`의 "Take Feedback" 화면을 따른다.

현재 상태: `comments.parent_id`와 `TakeComment.parentId`는 [2026-09-04 스펙](2026-09-04-upload-analysis-takes-feedback-design.md) 결정 6으로 자리만 있고 항상 null이다. 모바일은 평면 목록에 코멘트를 그리고, 입력창은 재생 위치에 코멘트를 남기기만 한다.

## 범위

**포함:**
- `POST /takes/:id/comments`에 `parentId` 추가, 답글 검증
- `commentCount` 집계를 최상위 코멘트만 세도록 변경
- `@bandapp/types`·`packages/api-client`(HTTP/Mock) 계약 갱신, Mock 시드에 답글 추가
- 모바일: 스레드 표시, 더 보기 페이징, 답글 작성(배너·프리필·포커스)

**제외:**
- 코멘트 수정·삭제
- 2단계 이상 중첩 (답글의 답글은 같은 스레드에 `@이름` 프리필로 붙는다)
- 답글 알림

## 결정

1. **스레드는 1단계다.** 답글은 항상 최상위 코멘트에 붙는다. 답글의 "Reply"를 누르면 같은 부모에 붙고, 입력창에 `@작성자 `가 미리 채워진다(부모 작성자와 같으면 생략). 디자인 프로토타입의 동작을 그대로 따른다.

2. **답글은 시점을 갖지 않고 부모의 시점을 물려받는다.** 서버가 `at_ms`를 부모에서 복사한다. 클라이언트는 답글에 `atSec`을 보내지 않는다. 답글이 부모 옆에 정렬되고, 파형 마커는 최상위 코멘트만 그린다.

3. **`CreateCommentInput`은 `{ text, atSec?, parentId? }`.** `parentId`가 없으면 `atSec`이 필수(기존과 동일). `parentId`가 있으면 `atSec`은 무시한다. 부모가 같은 take에 없거나 부모 자체가 답글이면 400.

4. **목록 API는 평면 그대로다.** `GET /takes/:id/comments`는 지금처럼 `at_ms, created_at` 순 평면 배열을 내려주고, 클라이언트가 `parentId`로 묶는다. 새 엔드포인트를 만들지 않는다.

5. **`commentCount`는 최상위 코멘트만 센다.** 디자인의 "N comments" 라벨은 스레드 수를 뜻한다. `TAKE_WITH_COUNT`·`SESSION_WITH_COUNTS`의 서브쿼리에 `parent_id is null`을 더한다.

6. **페이징은 클라이언트 상태다.** 코멘트 4개씩 "View more comments (N)", 답글은 접힌 채 "View replies (N)" → 3개씩 "View more replies (N)". 한번 펼친 답글은 접지 않는다(디자인에 접기 진입점이 없다). 답글을 보내면 그 스레드의 답글을 전부 펼치고, 코멘트를 보내면 표시 개수를 1 늘린다.

7. **입력창은 제어 컴포넌트로 바꾼다.** 답글 모드에서는 입력창 위에 "Replying to 이름 ✕" 배너가 뜨고 placeholder가 "Add a reply…"로 바뀌며 입력창에 포커스가 간다. ✕나 전송으로 답글 모드를 벗어난다.

## API 계약

```
POST /takes/:id/comments
  { atSec: number, text: string }                 → 201 TakeComment (parentId: null)
  { parentId: string, text: string }              → 201 TakeComment (atSec = 부모의 atSec)
  - text 1~500자
  - parentId 없음 → atSec 0 이상 take 길이 이하 (기존)
  - parentId가 이 take의 최상위 코멘트가 아니면 400
```

```ts
export interface TakeComment {
  id; takeId; authorId; authorName;
  /** 답글이면 부모(최상위 코멘트) id. 1단계만 허용한다 */
  parentId: string | null;
  /** 답글은 부모의 시점을 물려받는다 */
  atSec: number;
  text; createdAt;
}
export interface CreateCommentInput {
  text: string;
  /** parentId가 없을 때 필수 */
  atSec?: number;
  /** 있으면 답글. atSec은 무시된다 */
  parentId?: string;
}
```

## 모바일

- `features/takes/threads.ts` — `groupThreads(comments): Thread[]`. `parentId === null`인 코멘트를 `atSec, createdAt` 순으로 두고, 각각에 `createdAt` 순 답글 배열을 붙인다. 부모가 목록에 없는 답글은 버린다. 순수 함수, 단위 테스트.
- `CommentThread.tsx` — 코멘트 한 스레드. 아바타(30) · 이름 · 시점 · 본문(누르면 5초 전으로 seek) · "Reply" · 접힌 답글 토글 · 답글 행(아바타 24, "Reply") · "View more replies". 디자인대로 행 사이 구분선은 없다.
- `CommentInput.tsx` — `value/onChangeText` 제어, `replyingTo?: { name; onCancel }` 배너, `autoFocus` 대신 `ref.focus()`로 답글 시작 시 포커스.
- `TakePlayerScreen.tsx` — 상태: `input`, `replyTo: { parentId, name } | null`, `shownThreads`(4), `shownReplies: Record<parentId, number>`. 전송은 `api.comments.create(take.id, replyTo ? { parentId, text } : { atSec, text })`. 파형 마커는 스레드 부모의 `atSec`만.

## 테스트

- API e2e: 답글 생성이 부모의 atSec을 물려받고 `parentId`를 실어 돌아온다 / 다른 take의 코멘트·답글을 부모로 주면 400 / `commentCount`가 답글을 세지 않는다.
- Mock: `create({ parentId })`가 답글을 붙이고 카운트를 올리지 않는다 / 시드 답글이 목록에 있다.
- 모바일: `groupThreads` 정렬·묶기·고아 답글 제거.
