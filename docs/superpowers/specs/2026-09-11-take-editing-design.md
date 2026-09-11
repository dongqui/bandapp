# Take 경계 편집·삭제 설계 (스펙 B)

## 목표

타임라인 뷰어([스펙 A](2026-09-11-timeline-viewer-design.md)) 위에서 AI가 뽑은 take의 시작/종료 경계를 핸들로 고치고, 잘못 뽑힌 take를 지운다. 경계를 고치면 서버가 take 오디오를 다시 자르고 피크를 다시 계산한다. take 추가·분할·병합·이름 변경·playhead 스크럽·편집 이력은 이 스펙 밖이다.

현재 상태: `takes` 행은 워커가 만들고(`startMs/endMs/index/name/objectKey/peaks`) API는 조회(`GET /sessions/:id/takes`, `GET /takes/:id/audio`)만 한다. take 코멘트의 `at_ms`는 take 시작 기준 상대 시각이고 답글은 부모의 시각을 물려받는다. 분석 큐 메시지는 `AnalyzeSessionJob { sessionId }` 하나이며 워커 `AnalysisConsumer`가 `SessionAnalysisService.run`을 부른다. 타임라인 화면은 `useTimelineViewport`(팬·핀치·탭을 detector 하나로), `TakeLane`(필 탭 → 선택 + fit), 선택 카드("Open take")까지 있다. 세션 상세 칩은 스펙 A 동안 "Timeline"이고 디자인 원안은 "Edit takes"다.

## 범위

**포함:**
- `takes.version`, `takes.audio_status`, `takes.audio_error` 컬럼 — 마이그레이션 `0009`
- `PATCH /takes/:id`(경계 변경 + 코멘트 시각 이동 + 재컷 잡 발행), `DELETE /takes/:id`
- 워커 재컷 잡(`RecutTakeJob`) — 새 키로 컷 업로드, 사이드카로 피크 재계산, 옛 키 삭제
- api-client `takes.update`, `takes.remove` (HTTP + Mock 시뮬레이션)
- 앱: 선택한 take의 핸들 드래그(초안), edge auto pan, 미리 듣기 seek, Save/Cancel, 삭제, `updating/failed` 상태 표시(타임라인 카드·`TakeRow`·take 플레이어), 갱신 중 3초 폴링
- 순수 함수 `lib/timeline/edit.ts` + vitest, API 단위·e2e, 워커 스펙
- 세션 상세 칩 라벨을 디자인대로 "Edit takes"로 되돌림

**제외:**
- playhead 스크럽(핸들을 잡고 끄는 seek) — 탭 seek와 ±1초로 충분
- take 추가·분할·병합, 이름 변경, 편집 이력·되돌리기
- 겹침 허용·리플 편집 (결정 5)
- 실시간 동기화(다른 멤버의 편집을 푸시로 받기) — 버전 충돌 409 + 새로고침으로 충분
- 재컷 큐 전용 인프라 — 기존 분석 큐를 같이 쓴다

## 결정

1. **범위는 경계 편집 + 삭제.** 실제로 가장 흔한 두 교정("경계가 조금 틀렸다", "이건 take가 아니다")만 다룬다. 추가·분할은 다음 스펙.

2. **코멘트는 절대 시각을 보존한다.** start가 `oldStart → newStart`로 바뀌면 그 take의 모든 코멘트(답글 포함)의 `at_ms`에 `oldStart − newStart`를 더한다. 새 구간 밖으로 밀려난 코멘트는 지우지도 자르지도 않는다 — 값이 음수이거나 길이를 넘을 수 있다. 플레이어는 마커를 `[0, duration]`으로 clamp해 가장자리에 그리고 목록에는 그대로 보인다. 원본 녹음 코멘트는 절대 시각이라 영향 없음.

3. **재컷은 비동기 워커 잡.** `PATCH`는 DB만 바꾸고 `audioStatus=updating`으로 둔 채 잡을 큐에 넣는다. 3시간 원본을 API 요청 안에서 다룰 수 없다. 갱신 중 take는 재생을 막고 "Updating audio…"를 보인다. 같은 값으로 다시 `PATCH`하는 것을 허용해 실패 재시도로 쓴다(별도 retry 엔드포인트 없음).

4. **밴드 멤버 누구나 편집·삭제, 동시 편집은 버전으로 막는다.** `PATCH` body의 `version`이 현재 행과 다르면 409 `take_version_conflict`. 앱은 "Someone else changed this take" 토스트 후 목록을 새로고침하고 초안을 버린다.

5. **겹침 금지, 이웃 경계에서 멈춤.** 같은 세션에서 `index`가 바로 앞인 take의 `endMs` ≤ `startMs`, `endMs` ≤ 바로 뒤 take의 `startMs`. 순서(`index`)는 절대 바뀌지 않는다. 최소 길이 250ms. 앱은 드래그 중에 같은 규칙으로 clamp하고 서버가 최종 검증한다.

6. **삭제해도 남은 take 이름·번호는 그대로.** "Take 1, 2, 4"가 된다. 밴드가 이미 이름으로 대화했을 수 있다. `index`는 정렬용이라 빈 번호가 있어도 된다. 코멘트가 달린 take는 확인 다이얼로그가 "코멘트 N개도 함께 지워져요"를 보이고 cascade로 지운다.

7. **초안 → Save.** 핸들 드래그는 shared value 초안만 바꾸고 서버를 부르지 않는다. 카드의 Save가 `PATCH` 한 번. 다른 take 선택·뒤로 가기·화면 이탈 시 초안이 있으면 "Discard changes?"를 묻는다.

8. **제스처 우선순위는 detector 하나 안의 hit-test.** 스펙 A의 `useTimelineViewport` 팬 `onBegin`에서 손가락 x가 핸들 x의 ±24px 안이면 `handle-start`/`handle-end` 모드, 아니면 `pan`. 핸들 모드에서는 핀치 업데이트를 무시한다. 별도 detector와 cross-detector 관계는 RNGH v3에서 검증되지 않아 쓰지 않는다. 초안 22-E(핸들 중 타임라인이 움직임)는 이 구조로 원천 차단된다.

9. **재컷 결과는 새 키.** `takes/{takeId}-v{version}.m4a`에 올리고 `objectKey`를 바꾼 뒤 옛 키를 지운다. 같은 키에 덮어쓰면 앱이 최대 1시간 캐시한 presigned URL이 옛 파일을 가리킨다.

10. **피크는 사이드카로 다시 계산한다.** 워커가 `sessions.peaks_key`의 `peaks.bin`을 내려받아 `parsePeaksFile` 상당의 파서로 읽고 `slicePeaks(hires, peaksPerSec, startMs, endMs, PEAK_BUCKETS)`. 원본을 다시 디코드하지 않는다. 사이드카가 없으면 `peaks: null`(평평한 플레이스홀더).

11. **오래된 재컷 잡은 건너뛴다.** 잡의 `version`이 take의 현재 `version`과 다르면 이미 다음 편집이 덮어썼으므로 아무것도 하지 않는다. 마지막 잡만 `ready`로 바꾼다.

## 스키마

```sql
CREATE TYPE "take_audio_status" AS ENUM('ready', 'updating', 'failed');
ALTER TABLE "takes" ADD COLUMN "version" integer NOT NULL DEFAULT 1;
ALTER TABLE "takes" ADD COLUMN "audio_status" "take_audio_status" NOT NULL DEFAULT 'ready';
ALTER TABLE "takes" ADD COLUMN "audio_error" text;
```

drizzle: `takeAudioStatus = pgEnum("take_audio_status", [...])`, `version: integer("version").notNull().default(1)`, `audioStatus: takeAudioStatus("audio_status").notNull().default("ready")`, `audioError: text("audio_error")`. 마이그레이션 `0009`는 `db:generate`. 기존 행은 `version 1 / ready`.

## 타입·API 계약

`packages/types`:

```ts
export type TakeAudioStatus = "ready" | "updating" | "failed";

export interface Take {
  // ...기존
  /** PATCH 낙관적 잠금용. 경계를 바꿀 때마다 +1 */
  version: number;
  /** 재컷 진행 상태. updating이면 플레이어가 재생을 막는다 */
  audioStatus: TakeAudioStatus;
}

export interface UpdateTakeInput {
  startMs: number;
  endMs: number;
  /** 목록에서 본 값. 다르면 409 take_version_conflict */
  version: number;
}

/** SQS 메시지 — 기존 AnalyzeSessionJob과 같은 큐를 쓴다 */
export type RecutTakeJob = { type: "recut"; takeId: string; version: number };
export type QueueJob = AnalyzeSessionJob | RecutTakeJob;
```

`AnalyzeSessionJob`은 그대로(`{ sessionId }`, `type` 없음) — 컨슈머가 `"type" in job && job.type === "recut"`로 분기한다.

**`PATCH /takes/:id`** body `UpdateTakeInput` → `Take`. 오류:
- 403/404 비멤버·없음 (기존 `loadForMember`)
- 409 `{ code: "session_not_ready" }` 세션이 `ready`가 아닐 때
- 409 `{ code: "take_version_conflict" }`
- 400 `{ code: "take_range_invalid" }` — 정수 아님, `startMs < 0`, `endMs > durationMs`, `endMs − startMs < 250`
- 400 `{ code: "take_overlap" }` — 이웃과 겹침

**`DELETE /takes/:id`** → 204. 403/404, 세션이 `ready`가 아니면 409 `session_not_ready`(재분석 중 삭제하면 워커의 `resetTakes`와 경합한다).

api-client:

```ts
takes: {
  list(sessionId): Promise<Take[]>;
  audioUrl(takeId): Promise<AudioUrl>;
  update(takeId: string, input: UpdateTakeInput): Promise<Take>;   // emit()
  remove(takeId: string): Promise<void>;                            // emit()
}
```

Mock: `update`는 검증(범위·겹침·버전)을 서버와 같은 규칙으로 하고 `audioStatus=updating`으로 둔 뒤 1.5초 후 `ready`로 바꾸며 `emit()`; 코멘트 `atSec`을 함께 옮긴다. `remove`는 행과 코멘트를 지우고 `takeCount`를 줄인다.

## 서버

`TakesService`:

```
update(takeId, userId, input):
  row = loadForMember(takeId, userId)                // 기존
  session = sessions row; status !== "ready" → 409 session_not_ready
  if input.version !== row.version → 409 take_version_conflict
  validateRange(input, session.durationMs)           // 순수 함수, 400 take_range_invalid
  neighbors = 같은 세션 takes 중 index < row.index의 max(endMs), index > row.index의 min(startMs)
  if overlap → 400 take_overlap
  tx:
    update takes set startMs, endMs, version = version + 1, audioStatus = 'updating', audioError = null
      where id = takeId and version = input.version   // 0행이면 409 (경합)
    update comments set at_ms = at_ms + (row.startMs − input.startMs) where take_id = takeId
  producer.enqueueRecut(takeId, row.version + 1)      // 실패하면 audioStatus = 'failed', audioError = "재컷 요청을 보내지 못했어요." (세션 enqueue 실패 처리와 같은 패턴)
  return toTake(reload)

remove(takeId, userId):
  row = loadForMember; session ready 검사
  tx: delete takes where id; update sessions set take_count = take_count − 1
  storage.deleteObjects([row.objectKey])  // 실패는 warn — 세션 삭제 정리 배치(백로그)가 줍는다
```

`validateRange`·`overlaps`는 `apps/api/src/takes/take-rules.ts`에 순수 함수로 두고 단위 테스트한다. 앱의 `lib/timeline/edit.ts`와 같은 상수(`MIN_TAKE_MS = 250`)를 `@bandapp/types`가 export한다.

`AnalysisProducer.enqueueRecut(takeId, version)` — 같은 큐 URL에 `RecutTakeJob` 발행.

`TAKE_WITH_COUNT`·`toTake`에 `version`, `audioStatus` 추가.

## 워커

`AnalysisConsumer.handle`: `job.type === "recut"`이면 `TakeRecutService.run(takeId, version)`, 아니면 기존.

`TakeRecutService.run(takeId, version)`:

```
take = takes row (없으면 warn·return); if take.version !== version → 결정 11, return
session, recording 읽기
workDir = mkdtemp
try:
  original ← storage.downloadToFile(recording.objectKey)
  cut ← ffmpeg.cut(original, take.startMs, take.endMs, out)
  newKey = takeKey(bandId, sessionId, `${takeId}-v${version}`)   // takeKey는 id 문자열을 그대로 쓴다
  storage.putFile(newKey, out, "audio/mp4")
  peaks = session.peaksKey ? slicePeaks(parse(download peaks.bin), …) : null   // 다운로드 실패면 null + warn
  updated = update takes set objectKey = newKey, peaks, audioStatus = 'ready', audioError = null
            where id = takeId and version = version
  if updated 0행 → 다른 편집이 먼저 갔다 — 방금 올린 newKey를 지우고 return
  storage.deleteObjects([oldKey])   // 실패는 warn
catch err:
  update takes set audioStatus = 'failed', audioError = message.slice(0, 500) where id = takeId and version = version
finally rm workDir
```

`FfmpegRunner`는 변경 없음. `peaks.bin` 파서는 워커 `peaks.ts`에 `decodePeaksFile(buf): { peaksPerSec, hires }`로 두고(`encodePeaksFile`의 역), 앱 파서와 같은 헤더 상수를 쓴다.

## 모바일

### 순수 함수 `src/lib/timeline/edit.ts` (전부 `"worklet"`)

```ts
MIN_TAKE_MS (= @bandapp/types)
HANDLE_HIT_PX = 24            // 핸들 좌우 터치 영역
EDGE_PX = 24                  // auto pan 시작 가장자리
EDGE_MAX_PX_PER_FRAME = 12

interface Draft { startMs: number; endMs: number }
interface Neighbors { prevEndMs: number | null; nextStartMs: number | null }

hitTestHandle(v, draft, xPx): "start" | "end" | null   // 둘 다 맞으면 가까운 쪽
trimDraft(draft, handle, ms, neighbors, durationMs): Draft
  // start: [max(0, prevEnd), end − MIN], end: [start + MIN, min(duration, nextStart)]
autoPanPxPerFrame(xPx, widthPx): number
  // x < EDGE → −(EDGE − x)/EDGE · MAX, x > width − EDGE → +…, 아니면 0
previewSeekMs(draft, handle): number   // start → draft.start, end → max(draft.start, draft.end − 2000)
shiftCommentAtSec(atSec, oldStartMs, newStartMs): number   // (Mock·플레이어 clamp 테스트용)
```

### 상태·제스처 (`useTimelineViewport` 확장 → `useTakeEditing`)

- shared value: `draft: Draft | null`, `editMode: "pan" | "handle-start" | "handle-end" | null`, `fingerX`, `neighbors`.
- 팬 `onBegin`: `draft`가 있고 `hitTestHandle(...)`이 맞으면 `editMode = handle-*`, `follow = false`; 아니면 기존 `pan`.
- 팬 `onUpdate`: 핸들 모드면 `fingerX = e.x`, `draft = trimDraft(draft, handle, xToTime(v, e.x), neighbors, duration)`; 팬 모드면 기존.
- 핀치 `onUpdate`: `editMode`가 핸들이면 무시.
- `useFrameCallback`: 핸들 모드에서 `dx = autoPanPxPerFrame(fingerX, width)`가 0이 아니면 `startMs = panViewport(v, −dx).startMs`(viewport가 손가락 쪽으로 흐른다) 후 `draft`를 `xToTime(새 v, fingerX)`로 다시 계산.
- 팬 `onFinalize`: 핸들 모드였으면 `scheduleOnRN(onHandleRelease, handle)` → `clock.seekTo(previewSeekMs(...))`, `editMode = null`.
- take 선택 시 `draft = { take.startMs, take.endMs }`, `neighbors`는 index 기준 이웃에서 계산. `dirty = draft !== 원본`은 `useAnimatedReaction`으로 React 미러.

### 화면

- 핸들·초안 구간·Save/Cancel·삭제·상태 표시의 모양은 Claude Design이 정한다(브리프 아래). 동작: 선택 카드에 초안이 dirty면 Save/Cancel, 아니면 Open take + ···(Delete take).
- Save: `api.takes.update(id, { ...draft, version })` → 성공 시 takes 새로고침, 초안 = 새 값, 카드가 "Updating audio…". 409 → 토스트 "Someone else changed this take" + 새로고침 + 초안 폐기. 400 → 토스트(범위/겹침 — 앱이 먼저 clamp하므로 드묾).
- Cancel: 초안을 원본으로.
- 다른 take 선택·뒤로 가기(`router.back` 가로채기 `beforeRemove`)·화면 blur 시 dirty면 `ConfirmDialog` "Discard changes?".
- Delete: ··· 시트 → `ConfirmDialog`(제목 "Delete Take 3?", 본문에 코멘트 수가 0보다 크면 "N comments will be deleted too") → `api.takes.remove` → 새로고침·선택 해제.
- 폴링: 목록에 `audioStatus === "updating"`이 하나라도 있으면 3초 간격 `reload`, 없어지면 정지. 타임라인·세션 상세 둘 다.
- `TakeRow`: `updating`이면 파형 자리에 "Updating audio…", `failed`면 "Audio update failed". `TakePlayerScreen`: `updating`이면 재생 버튼 비활성 + 안내, `failed`면 "Retry" 버튼(현재 값으로 `update`). 마커는 `Math.min(Math.max(0, atSec), durationSec)`로 clamp(결정 2).
- 세션 상세 칩: "Edit takes".

### 디자인 브리프 (Claude Design)

`design-delegation` 프리앰블 뒤에:
- 목적: Timeline 화면에서 선택한 take의 시작/종료 경계를 끌어 고치고, take를 지운다.
- 필수 요소: 선택 take의 start/end 핸들(시각 3px, 터치 24dp)과 초안 구간 표시(파형·레인 양쪽), 초안이 바뀌면 카드의 Save/Cancel, 카드의 ···(Delete take), 재생 중 미리 듣기 표시 없음(기존 playhead 그대로).
- 상태: take `updating`(카드·Session Detail 행·Take Feedback 플레이어), `failed`(+Retry), "Discard changes?" 다이얼로그, "Delete Take N?" 다이얼로그(코멘트 수 문구), 409 토스트.
- 정책(변경 금지): 겹침 금지·이웃에서 멈춤, 최소 250ms, 삭제해도 번호 유지, 멤버 누구나 편집.

## 테스트

- **types build**, **api 단위**: `take-rules.spec.ts`(범위·최소 길이·겹침·이웃 null), `takes.service.spec.ts`(버전 불일치 409, 코멘트 이동량, enqueue 실패 → failed), `analysis.producer.spec.ts`(recut 메시지 형식).
- **api e2e**: `PATCH` 성공(코멘트 `atSec` 이동 확인, `version+1`, `audioStatus updating`), 409 버전, 400 겹침·범위, 세션 analyzing 409, 비멤버 403; `DELETE` 204 + 코멘트 cascade + `takeCount` 감소 + 재조회 404.
- **워커**: `take-recut.service.spec.ts` — 새 키 업로드·옛 키 삭제·사이드카 피크 128개·stale version 스킵·컷 실패 → failed·update 0행이면 새 객체 삭제; `analysis.consumer.spec.ts` — recut 분기. `peaks.spec.ts` — `decodePeaksFile(encodePeaksFile(x)) == x`.
- **api-client**: Mock `update`(검증·1.5초 후 ready·코멘트 이동), `remove`; Http 경로.
- **mobile vitest**: `edit.test.ts` — hitTest(±24, 가까운 쪽), trimDraft 각 경계, autoPan 속도 곡선, previewSeek, shiftCommentAtSec.
- **웹 프리뷰**: 핸들 드래그(마우스), Save → updating → 1.5초 후 ready, 409는 Mock에 버전 어긋남 시나리오 없음(단위 테스트로), 삭제 흐름.
- **기기 검증**: 핸들 vs 팬/핀치 우선순위(핸들 잡고 두 번째 손가락), edge auto pan + 드래그 + 시각 계산, 핸들 드래그 중 앱 전환 후 `onFinalize` 정리, 스펙 A 미검증 항목(핀치 focal, 핀치→팬, 백그라운드 복귀).

## 문서

README API 목록에 `PATCH/DELETE /takes/:id`. `docs/backlog.md`: "Take 경계 편집 (스펙 B)" 항목 제거, 남기는 것 — take 추가/분할/병합·이름 변경, playhead 스크럽, 편집 이력, 재컷 실패 스위퍼(`updating`에 1시간 이상 머문 take를 failed로), 세션 삭제 정리 배치에 `-v{n}` 키 패턴.
