# 업로드 재개·캐시 정리 설계

## 목표

앱이 죽거나 화면을 벗어나 끊긴 업로드를 세션 목록의 `uploading` 행에서 이어 올리고, 업로드가 끝난 녹음·가져오기 파일이 캐시에 쌓이지 않게 한다. [2026-09-04 백로그](../../backlog.md)의 "앱 종료 후 업로드 재개"와 "업로드 성공 후 캐시 디렉터리 정리" 두 항목이다.

현재 상태: [uploadRecording](../../../packages/api-client/src/upload.ts)이 create → 파트 PUT → complete를 한 번에 하고, create 뒤에 실패하면 `UploadRecordingError.sessionId`를 던진다. [useUploadSession](../../../apps/mobile/src/features/upload/useUploadSession.ts)은 그 id를 `pendingSessionIdRef`에만 들고 있어 화면을 벗어나면 잃어버린다. 서버 `GET /sessions/:id/upload`(ListParts)와 `resumeRecordingUpload`는 준비돼 있다. 세션 목록의 `uploading` 행은 눌러도 "Still finding takes…" 토스트만 뜬다. 녹음(expo-audio)과 가져오기(`copyToCacheDirectory: true`) 파일은 모두 캐시 디렉터리에 남는다.

## 범위

**포함:**
- 앱 소유 디렉터리 `documentDirectory/uploads/`에 파일을 옮기고 `pending.json`에 이어 올리기 레코드를 남기는 로컬 스토어
- `uploadRecording`·`sessions.upload`의 `onCreated` 콜백
- 세션 목록 `uploading` 행의 "Tap to continue uploading" 표시와 탭 → 재개 화면
- `ProcessingScreen`/`useUploadSession`의 재개 모드와 오류 분기
- 업로드 성공 시 파일·레코드 삭제, 앱 시작 시 고아 파일 정리

**제외:**
- 앱 시작 시 자동 재개, 백그라운드 업로드 — 화면 밖 진행 상태 관리가 필요해 별도 스펙
- 세션 삭제 API — 다른 기기에서 시작한 `uploading` 세션은 토스트로만 안내 (백로그 "세션 삭제 API와 R2 객체 정리")
- 이번 변경 이전에 캐시에 쌓인 파일 청소 — 어떤 파일이 우리 것인지 알 수 없어 손대지 않는다
- 서버 변경 — 없음

## 결정

1. **레코드는 파일과 같은 폴더의 `pending.json`.** `documentDirectory/uploads/`에 `<uuid>.m4a`와 `pending.json`(sessionId → 레코드 맵)을 둔다. 한 폴더가 정리 단위라 고아 정리는 "레코드 없는 파일 삭제"로 끝난다. SecureStore는 비밀이 아닌 값을 키체인에 넣고 iOS 값당 2KB 제한이 있어 탈락, AsyncStorage는 의존성이 늘고 파일과 레코드가 갈라져 탈락.

2. **파일은 create 전에 앱 소유 디렉터리로 `moveAsync`.** 캐시는 OS가 저장공간 부족 시 지울 수 있어 재개를 보장하지 못한다. 이동이라 캐시 사본은 즉시 사라진다(정리 항목의 절반이 여기서 해결). iOS `documentDirectory`는 iCloud 백업 대상이지만 업로드가 끝나면 바로 지우므로 감수한다.

3. **재개는 목록 행 탭으로만.** 로컬 레코드가 있는 `uploading` 행은 "Tap to continue uploading"을 보이고, 탭하면 `/processing?sessionId=<id>`로 간다. 레코드가 없는 `uploading` 행은 "This upload was started on another device" 토스트.

4. **`onCreated` 콜백.** `uploadRecording`과 `RehearsalApiClient.sessions.upload`에 `onCreated?(sessionId: string): Promise<void>`를 더한다. create 직후, 파트 PUT 전에 호출한다. 콜백이 던지면 세션은 이미 만들어졌으니 `UploadRecordingError(sessionId)`로 감싼다. Mock도 같은 시점에 부른다. 이어 올리기도 클라이언트 메서드 `sessions.resumeUpload(id, source, onProgress?)`로 노출한다 — Http는 `resumeRecordingUpload`에 위임하고 Mock은 진행률만 흉내 내므로 웹 프리뷰에서 재개 화면이 돈다.

5. **스토어가 이어 올리기의 단일 진실.** 훅의 `pendingSessionIdRef`를 없앤다. 첫 업로드도 재개도 "레코드가 있으면 `resumeRecordingUpload`, 없으면 처음부터"로 판단한다.

6. **오류 분기(재개 모드).**
   - 레코드 없음 또는 파일 없음 → 레코드 discard, "Recording file is missing", 재시도 버튼 없음.
   - `ApiError` 404 → discard, "This session no longer exists", 재시도 없음.
   - `ApiError` 409(이미 업로드 완료) → discard 후 `sessions.get(id)`로 현재 세션을 받아 analyzing/ready 흐름에 합류.
   - 그 외(네트워크) → 레코드 유지, "Try again"이 resume을 다시 부른다.

7. **정리 시점.** complete 성공 직후 `discard(sessionId)`(파일+레코드). create 전에 실패하면 옮겨 둔 파일만 지운다. 앱 시작 시 루트 레이아웃에서 `sweepOrphans()` 한 번. 세션 목록이 로드되면 목록에 있으면서 상태가 `uploading`이 아닌 레코드를 discard한다(목록에 없는 레코드는 다른 밴드의 것일 수 있어 건드리지 않는다). `sweepOrphans()`는 그 전에 `createdAt`이 7일(R2 멀티파트 업로드 만료 규칙과 같은 값) 넘었거나 파싱할 수 없는 레코드부터 파일과 함께 discard한다 — 그 이후엔 서버에도 이어 올릴 파트가 없다.

8. **스토어 실패는 업로드를 막지 않는다.** 읽기·쓰기·삭제는 모두 try/catch로 감싸 `console.warn`만 남긴다. 레코드를 못 남기면 재개가 안 될 뿐 업로드는 진행된다. 예외: `stage`(파일 이동) 실패는 원래 URI로 그대로 업로드한다 — 재개는 못 하지만 지금과 같은 동작.

9. **파일 시스템 어댑터 주입.** 스토어는 `{ documentDirectory, moveAsync, deleteAsync, readAsStringAsync, writeAsStringAsync, makeDirectoryAsync, readDirectoryAsync, getInfoAsync }` 최소 인터페이스를 받는다. 네이티브는 `expo-file-system/legacy`, 웹(`documentDirectory === null`)과 테스트는 메모리 구현을 쓴다. 모바일 테스트가 순수 vitest라 RN 모듈 모킹 없이 스토어와 오류 분기를 검증하려는 것.

## 구성 요소

### `packages/api-client/src/upload.ts`
- `UploadRecordingOptions.onCreated?: (sessionId: string) => Promise<void>`.
- `uploadRecording`: `create` → `await opts.onCreated?.(session.id)` → `resumeUpload`. try 블록이 `onCreated`부터 감싼다.
- `client.ts`의 `sessions.upload(bandId, input, source, onProgress?, onCreated?)`. Http는 `uploadRecording`에 전달, Mock은 create 뒤 진행률 루프 전에 호출.

### `apps/mobile/src/features/upload/pendingUploads.ts`
```ts
export interface PendingUpload {
  sessionId: string;
  bandId: string;
  fileUri: string;
  source: "recording" | "import";
  createdAt: string; // ISO
}
export interface UploadFs {
  documentDirectory: string | null;
  moveAsync(o: { from: string; to: string }): Promise<void>;
  deleteAsync(uri: string, o?: { idempotent?: boolean }): Promise<void>;
  readAsStringAsync(uri: string): Promise<string>;
  writeAsStringAsync(uri: string, s: string): Promise<void>;
  makeDirectoryAsync(uri: string, o?: { intermediates?: boolean }): Promise<void>;
  readDirectoryAsync(uri: string): Promise<string[]>;
  getInfoAsync(uri: string): Promise<{ exists: boolean }>;
}
export function createPendingUploads(fs: UploadFs) {
  return {
    /** 캐시의 파일을 uploads/<uuid>.m4a로 옮기고 새 URI를 돌려준다. 실패하면 throw — 호출자가 원래 URI로 진행 */
    stage(uri: string): Promise<string>;
    add(rec: PendingUpload): Promise<void>;
    get(sessionId: string): Promise<PendingUpload | null>;
    list(): Promise<PendingUpload[]>;
    /** 레코드와 파일을 지운다. 어느 쪽이 없어도 조용히 성공 */
    discard(sessionId: string): Promise<void>;
    /** stage만 됐고 레코드가 없는 파일을 지운다 (create 실패 경로) */
    dropFile(uri: string): Promise<void>;
    /** 레코드가 가리키지 않는 uploads/*.m4a 삭제 */
    sweepOrphans(): Promise<void>;
  };
}
export const pendingUploads = createPendingUploads(Platform.OS === "web" ? memoryFs() : expoFs());
```
- `pending.json` 파싱 실패는 빈 맵으로 취급하고 경고.

### `apps/mobile/src/features/upload/useUploadSession.ts`
- 입력: `UploadParams | ResumeParams`(`{ sessionId }`) | null.
- 첫 업로드: `stagedUri = await pendingUploads.stage(fileUri).catch(() => fileUri)` → `fileUploadSource(stagedUri)` → `api.sessions.upload(..., onProgress, (id) => pendingUploads.add({...}))` → settle 시 `discard(id)`. create 전 실패(`UploadRecordingError`가 아님)면 `dropFile(stagedUri)`(stage가 성공했을 때만).
- 재개: `pendingUploads.get(sessionId)` → 없으면 결정 6 첫째 분기 → `fileUploadSource(record.fileUri)` → `api.sessions.resumeUpload` → settle 시 `discard`.
- `retry`: 서버 failed → `retryAnalysis`(기존), 레코드 있음 → 재개, 그 외 → 처음부터(첫 업로드 params가 있을 때만).
- 오류 → 상태 매핑은 순수 함수 `classifyUploadFailure(err, mode): { message; discard: boolean; retryable: boolean; refetch: boolean }`로 빼서 테스트한다. 훅은 결과대로 discard·`sessions.get`·phase를 처리한다.
- 반환에 `retryable: boolean` 추가 — `ProcessingScreen`이 false면 "Try again" 칩을 숨긴다.

### `apps/mobile/src/features/sessions/SessionsScreen.tsx`, `SessionRow.tsx`
- `usePendingUploadIds()`: `useFocusEffect`로 포커스마다 `pendingUploads.list()` → `Set<string>`.
- 목록 로드 후 결정 7의 prune.
- `SessionRow` prop `resumable?: boolean`. uploading 문구: resumable이면 "Tap to continue uploading", 아니면 "Uploading…".
- `onRowPress`: uploading + resumable → `router.push({ pathname: "/processing", params: { sessionId } })`; uploading + !resumable → 토스트.

### `apps/mobile/src/features/recording/ProcessingScreen.tsx`
- `sessionId` 파라미터가 있으면 `ResumeParams`. 캡션에 "Resuming upload… N%". `retryable`이 false면 칩 대신 "Back to sessions" 칩으로 `router.replace("/")`.

### `apps/mobile/app/_layout.tsx`
- `RootLayout` 마운트 시 `void pendingUploads.sweepOrphans()`.

## 데이터 흐름

```
녹음 stop / 가져오기 pick
  → /processing?fileUri=…
  → stage: cache/x.m4a → documents/uploads/<uuid>.m4a
  → create (서버 uploading 세션)
  → onCreated: pending.json[sessionId] = {fileUri: uploads/<uuid>.m4a, …}
  → 파트 PUT … (앱 죽음)

세션 목록 (포커스)
  → pending.json 읽기 → uploading 행에 resumable 표시
  → 탭 → /processing?sessionId=…
  → GET /sessions/:id/upload → 남은 파트 PUT → complete
  → discard: 파일 + 레코드 삭제 → analyzing 폴링 (기존)
```

## 테스트

- `packages/api-client/src/upload.spec.ts`: `onCreated`가 create 뒤·첫 파트 전에 sessionId로 호출된다; `onCreated`가 던지면 `UploadRecordingError.sessionId`가 채워지고 파트 PUT은 없다.
- `packages/api-client/src/mock/MockApiClient.test.ts`: Mock `upload`도 `onCreated`를 부른다.
- `apps/mobile/src/features/upload/createPendingUploads.test.ts`(메모리 fs): stage가 파일을 옮기고 새 URI를 준다; add/get/list/discard; discard는 파일이 없어도 성공; sweepOrphans는 레코드 없는 파일만 지운다; 깨진 pending.json은 빈 맵.
- `apps/mobile/src/features/upload/classifyUploadFailure.test.ts`: 파일 없음/404/409/네트워크 네 분기.
- 수동: 웹 프리뷰(Mock, 메모리 fs)에서 가져오기 → Processing → 목록. 기기 검증(dev build)은 백로그 "기기 검증" 항목에 추가: 이동 후 expo-audio 파일 접근, 앱 강제 종료 후 재개.

## 문서

- `README.md` 업로드 설명에 재개 한 줄.
- `docs/backlog.md`: 두 항목 삭제, "이전 캐시 파일 청소", "자동 재개", 기기 검증 항목 추가.
