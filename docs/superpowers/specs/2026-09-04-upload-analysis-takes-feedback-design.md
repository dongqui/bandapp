# 오디오 업로드 → AI 연주 구간 분리 → Take → 피드백 설계

- **날짜:** 2026-09-04
- **상태:** 검토 대기
- **선행 문서:** [2026-08-30-gemini-analysis-design.md](2026-08-30-gemini-analysis-design.md), [2026-09-02-team-management-api-design.md](2026-09-02-team-management-api-design.md), [2026-08-25-audio-segmentation-poc-design.md](2026-08-25-audio-segmentation-poc-design.md)

## 목적

합주 녹음이 앱에서 서버 저장소로 올라가고, 워커가 연주 구간(Take)을 찾아 잘라 두며, 멤버가 각 Take의 특정 시점에 코멘트를 남기는 흐름을 mock 없이 끝까지 동작시킨다.

현재 상태: 서버에는 Gemini 분석 파이프라인(API→SQS→Worker→Gemini→로그)만 있고 sessions/takes/comments API와 테이블은 없다. 모바일은 이 세 도메인을 `MockApiClient`에 위임하고, 녹음 화면은 타이머만 도는 시뮬레이션이다. R2는 env placeholder뿐이다.

## 범위

**포함:**
- R2 버킷 연동(`StorageService`), `sessions`·`recordings`·`takes`·`comments` 테이블과 마이그레이션
- presigned multipart 업로드 API와 이어 올리기 조회
- 워커: R2 다운로드 → 청크 분할 → Gemini 분석 → 병합 → Take 오디오 잘라 R2 업로드 → DB 저장 → 세션 상태 전이
- sessions/takes/comments API (밴드 멤버십 검증)
- `@bandapp/types`·`packages/api-client` 계약과 HTTP/Mock 양쪽 구현, 업로드 오케스트레이터
- 모바일: 파일 가져오기(m4a)와 실제 녹음(AAC-LC m4a) → 업로드 → 처리 화면 폴링 → Take 재생(expo-audio) → 코멘트
- Windows에서 서버 전 구간을 검증할 수 있는 dev 로그인과 업로드 스크립트

**제외 (백로그 `docs/backlog.md`로 이관):**
- 가져오기에서 원본(wav/영상 등) 업로드 + 서버 변환
- 검출기(YAMNet/PANNs 등) 전처리를 Python 워커에 이식
- 앱을 완전히 종료한 뒤 업로드 이어하기 (서버 ListParts는 준비됨)
- 3시간 백그라운드 녹음 안정성·중단 복구
- Take 경계 편집, 실제 파형, 원본 녹음에 대한 코멘트
- 대댓글 UI·작성 (스키마 자리만 이번에 확보)
- 녹음 중 `+MARK`를 분석 힌트로 쓰기

## 확정된 결정

1. **인코딩은 모바일에서 한다.** AAC-LC m4a, 128kbps, 44.1kHz, 스테레오. 3시간이 약 170MB로, 업로드가 현실적이고 서버 재인코딩이 없다. 가져오기도 m4a만 받는다(`audio/mp4`, `audio/x-m4a`). 원본 업로드+서버 변환은 백로그.

2. **분석은 Gemini 단독, 고정 청크 분할.** 20분 청크, 앞뒤 30초 겹침. 통짜 요청은 3시간에서 응답 시간·실패 비용·타임스탬프 정확도가 위험하다. 청크 목록을 만드는 `planChunks()`는 순수 함수이며, 나중에 검출기 전처리가 들어오면 이 함수가 "후보 구간 목록"을 내는 것으로 바뀐다. 이것이 유일한 끼움 지점이다.

3. **업로드는 모바일이 R2에 직접 한다.** 서버는 multipart 업로드를 만들고 파트별 presigned PUT URL을 발급하며, 완료 시 `CompleteMultipartUpload`를 호출한다. 파일이 API 프로세스를 거치지 않는다. 파트 크기 10MB(R2 최소 5MB), URL 유효 1시간. 이어 올리기 상태는 서버(ListParts)가 갖는다.

4. **Take 재생은 잘라낸 파일로 한다.** 워커가 ffmpeg `-c copy`로 take별 m4a를 만들어 R2에 올리고, 앱은 presigned GET URL로 재생한다. 원본은 재분석·경계 편집 재료로 보관한다. 원본 재생 화면은 원본 presigned URL을 처음부터 튼다.

5. **세션과 녹음은 1:1이되 테이블은 나눈다.** `recordings`는 저장 객체와 업로드 상태를, `sessions`는 사용자에게 보이는 상태를 갖는다. 백로그의 원본 가져오기(세션당 원본+변환본)와 저장 수명주기가 다르다.

6. **코멘트는 Take에만 달고, 대댓글 자리를 스키마에 둔다.** `comments.parent_id`(nullable 자기참조)를 지금 넣고 API는 `parentId`를 실어 평면 목록으로 내려준다. 스레드 UI와 답글 작성은 다음 세션. 원본 녹음 화면은 코멘트 입력을 숨긴다.

7. **워커 실패는 세션 `failed`로 기록하고 메시지를 삭제한다.** 재시도는 사용자가 `POST /sessions/:id/retry`로 한다. Gemini의 일시 오류는 청크 단위 재시도(2회)로 흡수한다. 무한 재전달을 막기 위한 결정이며, 워커 프로세스가 죽는 경우만 SQS visibility 만료로 재전달된다.

8. **긴 작업 동안 visibility를 연장한다.** 워커는 처리 중 60초마다 `ChangeMessageVisibility`(5분)를 호출한다. 큐의 기본 visibility timeout도 5분으로 올린다(`init-aws.sh`).

9. **분석은 멱등이다.** 재시도 시 그 세션의 기존 takes와 R2 take 객체를 지우고 다시 만든다. 세션 상태가 `analyzing`이 아니면 메시지를 무시하고 삭제한다.

10. **dev 로그인을 추가한다.** `POST /auth/dev { secret, displayName? }`는 `DEV_LOGIN_SECRET`이 설정되고 `NODE_ENV !== "production"`일 때만 열린다. `auth_provider` enum에 `DEV`를 더한다. Windows에서는 Google/Apple 로그인 없이는 서버를 끝까지 검증할 수 없기 때문이다.

11. **기존 dev 전용 `POST /recordings/:id/analysis`와 `audioPath`를 제거한다.** 워커 메시지는 `{ sessionId }`만 갖는다. 로컬 파일 경로를 컨테이너 안에서 해석하던 `resolveAudioPath`는 워커 임시 디렉터리 기준으로 대체된다.

12. **로컬 개발도 실제 R2 dev 버킷을 쓴다.** LocalStack S3를 추가하지 않는다. e2e는 `StorageService`를 `overrideProvider`로 대체한다. R2 API 토큰은 시크릿이므로 사용자가 직접 발급해 `.env`에 넣는다.

13. **와이어 단위는 기존 계약대로 초(sec)를 유지하고, 정밀도가 필요한 곳만 ms를 쓴다.** `Session.durationSec`, `Take.durationSec`, `TakeComment.atSec`은 그대로. `Take`에 `startMs`/`endMs`/`type`을 더한다. DB는 전부 ms.

14. **`Session.startedAt`은 오프셋이 붙은 ISO 8601로 바꾼다.** 기존 타입 주석("타임존 접미사 없음")을 뒤집는다. 모바일 `lib/time.ts`는 `new Date()`로 파싱하므로 오프셋이 붙어도 로컬 시각 표시가 그대로 맞는다. Mock 시드는 그대로 둔다(오프셋 없는 문자열도 파싱된다).

15. **업로드 오케스트레이터는 `packages/api-client`에 순수 함수로 둔다.** 입력은 `readPart(partNumber) → Promise<Blob>`와 `fetch`. 파트 2개 동시, 파트별 3회 재시도, 진행률 콜백. 모바일은 RN 네이티브 Blob(`fetch(uri).then(r => r.blob())` 후 `slice()`)로 메모리에 올리지 않고 파트를 읽는다. Blob slice가 어떤 플랫폼에서 동작하지 않으면 `expo-file-system/legacy`의 `readAsStringAsync({ position, length })` base64 경로로 대체한다.

## 데이터 모델

```
sessions      id uuid pk, band_id fk→bands cascade, created_by fk→users,
              title text, name text null,
              status session_status(uploading|analyzing|failed|ready),
              started_at timestamptz, duration_ms int null,
              take_count int default 0,
              analysis_error text null, analysis_model text null,
              created_at/updated_at

recordings    id uuid pk, session_id fk→sessions cascade UNIQUE,
              object_key text, content_type text, size_bytes bigint,
              upload_id text null, part_size int, part_count int,
              upload_status upload_status(pending|completed|aborted),
              completed_at timestamptz null, created_at

takes         id uuid pk, session_id fk→sessions cascade,
              index int, name text, start_ms int, end_ms int,
              type take_type(PERFORMANCE|PARTIAL_PRACTICE), confidence real,
              object_key text, created_at
              UNIQUE(session_id, index)

comments      id uuid pk, take_id fk→takes cascade,
              author_id fk→users, parent_id fk→comments null,
              at_ms int, text text, created_at
              INDEX(take_id, at_ms)

auth_provider enum에 DEV 추가
```

R2 객체 키:

```
bands/{bandId}/sessions/{sessionId}/original.m4a
bands/{bandId}/sessions/{sessionId}/takes/{takeId}.m4a
```

`take_count`와 `Session.commentCount`, `Take.commentCount`는 조회 시 집계한다. `take_count`만 세션 행에 두는 이유는 목록 화면이 세션마다 takes를 세는 대신 한 번에 읽기 위함이고, 워커가 ready로 바꿀 때 함께 쓴다.

## API 계약

모두 `AuthGuard` 뒤에 있고, 밴드 스코프는 `assertMember`로 검증한다. 세션 스코프 엔드포인트는 세션을 읽어 그 `band_id`로 검증한다. 세션이 없으면 404, 멤버가 아니면 403이다(존재 여부를 노출하지 않으려면 둘을 합쳐야 하지만, 세션 ID는 UUID라 추측이 불가능하고 초대 스펙 결정 7과 같은 근거로 구분한다).

### 세션·업로드

```
POST /bands/:bandId/sessions
  { startedAt: ISO, durationMs?: number, sizeBytes: number,
    contentType: "audio/mp4" | "audio/x-m4a", source: "recording" | "import" }
  → 201 { session: Session, upload: { partSize, partCount } }
  - sizeBytes는 1 이상 2GB 이하. partSize=10MB, partCount=ceil(sizeBytes/partSize)
  - StorageService.createMultipartUpload → recordings.upload_id
  - title은 startedAt 로컬 날짜로 "Sep 4 Rehearsal" (기존 Mock과 동일 규칙)

POST /sessions/:id/upload/parts
  { partNumbers: number[] }  → 200 [{ partNumber, url }]
  - 1..partCount 범위 밖이면 400. 최대 100개씩.
  - 세션이 uploading이 아니면 409

GET  /sessions/:id/upload
  → 200 { partSize, partCount, uploadedParts: [{ partNumber, etag }] }   (ListParts)

POST /sessions/:id/upload/complete
  { parts: [{ partNumber, etag }] }  → 200 Session (status analyzing)
  - partCount와 개수가 다르면 400
  - CompleteMultipartUpload → recordings.upload_status=completed → sessions.status=analyzing
    → SQS { sessionId }. 큐 발행 실패 시 세션은 failed로 남긴다(사용자가 retry).

POST /sessions/:id/retry
  → 200 Session
  - failed가 아니면 409. status=analyzing, analysis_error=null, SQS 발행

GET  /bands/:bandId/sessions   → Session[]   started_at 내림차순
GET  /sessions/:id             → Session
GET  /sessions/:id/audio       → { url, expiresAt }   원본 presigned GET (1시간). uploading이면 409
```

### Take·코멘트

```
GET  /sessions/:id/takes       → Take[]   index 순
GET  /takes/:id/audio          → { url, expiresAt }
GET  /takes/:id/comments       → TakeComment[]   at_ms, created_at 순
POST /takes/:id/comments       { atSec: number, text: string }  → 201 TakeComment
  - text 1~500자, atSec 0 이상 take 길이 이하
```

### dev 로그인

```
POST /auth/dev   { secret: string, displayName?: string }  → LoginResponse
  - DEV_LOGIN_SECRET 미설정 또는 NODE_ENV=production이면 404
  - secret 불일치면 401
  - identity (DEV, subject=displayName ?? "dev") 로 기존 사용자 재사용
```

### 타입 (`@bandapp/types`)

```ts
export interface Session {
  id: string; bandId: string; title: string; name?: string;
  status: SessionStatus;
  /** ISO 8601, 오프셋 포함 */
  startedAt: string;
  /** 워커가 측정하기 전(가져오기)에는 0 */
  durationSec: number;
  takeCount: number; commentCount: number;
}

export interface Take {
  id: string; sessionId: string; index: number; name: string;
  durationSec: number; startMs: number; endMs: number;
  type: TakeCandidateType; commentCount: number;
}

export interface TakeComment {
  id: string; takeId: string; authorId: string; authorName: string;
  /** 대댓글용. 이번 범위에서는 항상 null */
  parentId: string | null;
  atSec: number; text: string; createdAt: string;
}

export interface CreateSessionInput {
  startedAt: string; durationMs?: number; sizeBytes: number;
  contentType: "audio/mp4" | "audio/x-m4a"; source: "recording" | "import";
}
export interface CreateSessionResult { session: Session; upload: { partSize: number; partCount: number } }
export interface UploadPartUrl { partNumber: number; url: string }
export interface UploadStatus { partSize: number; partCount: number; uploadedParts: Array<{ partNumber: number; etag: string }> }
export interface UploadedPart { partNumber: number; etag: string }
export interface AudioUrl { url: string; expiresAt: string }
```

### 클라이언트 (`packages/api-client`)

`RehearsalApiClient`:

```ts
sessions: {
  list(bandId): Promise<Session[]>;
  get(id): Promise<Session>;
  create(bandId, input: CreateSessionInput): Promise<CreateSessionResult>;   // 시그니처 변경
  partUrls(id, partNumbers: number[]): Promise<UploadPartUrl[]>;
  uploadStatus(id): Promise<UploadStatus>;
  completeUpload(id, parts: UploadedPart[]): Promise<Session>;
  retryAnalysis(id): Promise<Session>;
  audioUrl(id): Promise<AudioUrl>;
};
takes: { list(sessionId): Promise<Take[]>; audioUrl(takeId): Promise<AudioUrl> };
comments: { list(takeId): Promise<TakeComment[]>; create(takeId, { atSec, text }): Promise<TakeComment> };
```

`HttpApiClient`는 세 도메인의 Mock 위임(`fallback`)을 제거하고 실제로 구현한다. `MockApiClient`는 새 메서드를 채워 서버 없는 모드를 유지한다(`partUrls`는 가짜 URL, `completeUpload`는 기존 `scheduleAnalysis`).

업로드 오케스트레이터:

```ts
export async function uploadRecording(opts: {
  client: RehearsalApiClient; bandId: string; input: CreateSessionInput;
  readPart: (partNumber: number, range: { start: number; end: number }) => Promise<Blob>;
  fetchFn?: typeof fetch;
  onProgress?: (p: { uploadedBytes: number; totalBytes: number }) => void;
  concurrency?: number;   // 기본 2
}): Promise<Session>
```

흐름: `create` → `uploadStatus`로 이미 올라간 파트 제외(같은 앱 실행 안의 재시도) → 남은 파트의 URL을 100개씩 받아 PUT(응답 `ETag` 헤더 수집, 파트별 3회 재시도) → `completeUpload`. 어떤 파트가 3회 실패하면 throw하고 세션은 uploading으로 남는다.

## 워커 파이프라인

`apps/api/src/worker/analysis.consumer.ts`가 `{ sessionId }`를 받아 `SessionAnalysisService.run(sessionId)`를 호출한다. 처리 중 60초마다 visibility를 연장하고, 끝나면(성공·실패 모두) 메시지를 삭제한다.

```
1. 세션·녹음 로드. status !== analyzing 이면 무시.
2. 기존 takes 삭제 + R2 take 객체 삭제 (재시도 멱등성).
3. 임시 디렉터리 생성. StorageService.downloadToFile(original.m4a).
4. ffprobe → durationMs. sessions.duration_ms 갱신.
5. chunks = planChunks(durationMs, { chunkMs: 20*60*1000, overlapMs: 30*1000 })
6. 청크마다: ffmpeg -ss -t -c copy → chunk.m4a
            GeminiService.analyzeFile(absPath) (2회 재시도, 마지막 실패는 throw)
            후보의 startMs/endMs += chunk.startMs
            Gemini 업로드 파일 삭제 (files.delete, 실패는 경고만)
7. takes = mergeCandidates(all, { overlapMs, minDurationMs: 20_000 })
8. take마다: ffmpeg -ss -to -c copy → take.m4a → StorageService.putFile(takes/{takeId}.m4a)
9. 트랜잭션: takes 삽입, sessions.status=ready, take_count, analysis_model
10. finally: 임시 디렉터리 삭제
실패: sessions.status=failed, analysis_error=message (500자 절단). 이미 올린 take 객체는 다음 실행이 지운다.
```

`planChunks(durationMs, opts)`: 청크 i는 `[i*chunkMs - overlapMs, (i+1)*chunkMs + overlapMs]`를 `[0, durationMs]`로 잘라낸 구간. 길이가 `chunkMs` 이하이면 청크 하나.

`mergeCandidates(candidates, opts)`: startMs 순 정렬 후, 앞 구간과 겹치거나 맞닿는(`gap <= 0`) 후보를 하나로 합친다(구간 합집합, type은 둘 중 PERFORMANCE 우선, confidence는 최대). 그 뒤 `endMs - startMs < minDurationMs`인 것을 버리고 index를 0부터 다시 매긴다. 이름은 `Take {index+1}`. 겹침 구간에서 같은 연주가 양쪽 청크에 잡히면 이 규칙으로 하나가 된다. 겹침 없이 떨어진 두 후보는 합치지 않는다 — gap-merge(PRD §12의 "10초 이내 병합")는 Gemini 프롬프트가 이미 하고 있다고 보고, 필요해지면 옵션으로 추가한다.

ffmpeg/ffprobe는 `child_process.execFile`로 호출하며 `FfmpegRunner` 인터페이스 뒤에 두어 테스트에서 대체한다. worker 이미지(`apps/api/Dockerfile`)에 `apk add ffmpeg`.

Gemini 서비스 변경: `analyzeAudio(relativePath)` → `analyzeFile(absolutePath)`로 바꾸고 워크스페이스 경로 해석을 제거한다. 나머지(업로드→ACTIVE→structured output→검증)는 유지.

## 스토리지

`apps/api/src/storage/storage.service.ts` — `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`.

```ts
interface StorageService {
  createMultipartUpload(key, contentType): Promise<{ uploadId }>;
  presignUploadPart(key, uploadId, partNumber, expiresSec): Promise<string>;
  listParts(key, uploadId): Promise<Array<{ partNumber, etag }>>;
  completeMultipartUpload(key, uploadId, parts): Promise<void>;
  abortMultipartUpload(key, uploadId): Promise<void>;
  presignGet(key, expiresSec): Promise<string>;
  downloadToFile(key, path): Promise<void>;
  putFile(key, path, contentType): Promise<void>;
  deleteObjects(keys): Promise<void>;
}
```

env: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`. 엔드포인트는 `https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com`으로 유도하고 `R2_ENDPOINT`는 override용으로만 남긴다. region은 `auto`. 클라이언트는 lazy 생성이며 env가 비어 있으면 호출 시점에 throw한다(키 없이도 부팅 가능, Gemini와 같은 관례). `STORAGE_PROVIDER`는 쓰는 곳이 없으므로 `.env.example`에서 제거한다.

R2 버킷은 `taken-rehearsal-dev`다(계정 `a4ae56e6…`, APAC). `band-rehearsal-dev`는 이름이 이미 점유돼 있어 쓸 수 없었다. 대시보드에서 생성했고 CORS도 적용했다: `AllowedOrigins: ["*"]`, `AllowedMethods: ["GET","PUT"]`, `AllowedHeaders: ["*"]`, `ExposeHeaders: ["ETag"]`. 네이티브 앱은 CORS를 검사하지 않으므로 이 설정은 Expo 웹 미리보기용이다. 웹에서 PUT 응답의 ETag를 읽으려면 `ExposeHeaders`가 필수다. 버킷 기본 수명주기 규칙이 미완료 multipart 업로드를 7일 뒤 자동 중단한다. API 토큰(Object Read & Write, 이 버킷 한정)은 사용자가 발급해 `.env`에 넣는다.

## 모바일

새 의존성: `expo-audio`, `expo-document-picker`. 둘 다 네이티브 모듈이라 dev build 재생성이 필요하다.

- **가져오기** (`NewSessionSheet` → `ImportFlow`): `getDocumentAsync({ type: ["audio/mp4","audio/x-m4a"] })` → `{ uri, size }` → `uploadRecording` → 처리 화면. `durationMs`는 보내지 않는다(워커가 측정).
- **녹음** (`RecordingScreen`): `useAudioRecorder`에 커스텀 옵션(`.m4a`, AAC, 128000bps, 44100Hz, 2ch). 정지하면 `recorder.uri`와 `durationMillis`로 `uploadRecording`. 마이크 권한 요청을 녹음 진입 시 한다. `+MARK`는 토스트만 유지.
- **처리 화면** (`ProcessingScreen`): 업로드 진행률(실제 바이트 기준)을 표시하다 `analyzing`이 되면 문구 단계로 넘어가고, 세션 상태를 3초마다 폴링한다. `ready`면 세션으로 이동, `failed`면 재시도 버튼.
- **재생** (`usePlayback` → expo-audio): `useAudioPlayer(url)`, 200ms 상태 갱신, seek. URL은 화면 진입 시 `takes.audioUrl`/`sessions.audioUrl`로 받는다. 파형은 기존 시드 파형 유지.
- **코멘트**: 기존 UI 그대로. `commentKey` 우회를 걷어내고 take id를 직접 쓴다. 원본 화면은 `CommentInput`을 숨긴다.
- 파일 파트 읽기: `src/features/upload/readFilePart.ts` — `fetch(uri).then(r => r.blob())`를 한 번 하고 `blob.slice(start, end)`를 파트마다 반환.

## 검증 스크립트 (Windows)

`apps/api/scripts/upload-session.ts` (tsx 실행):

```
UPLOAD_FILE=poc/data/raw_sessions/IMG_2811.m4a API_URL=http://localhost:3001 DEV_LOGIN_SECRET=... \
  pnpm --filter @bandapp/api upload-session
```

dev 로그인 → 밴드 생성(또는 첫 밴드) → `uploadRecording`(Node `fs` 기반 `readPart`) → 세션이 ready/failed가 될 때까지 폴링 → takes 출력 → 첫 take의 presigned URL을 받아 임시 파일로 내려 ffprobe 길이를 출력한다. 이 스크립트가 통과하면 서버 전 구간이 실제 R2·Gemini로 검증된 것이다.

## 오류 처리

| 상황 | 동작 |
|---|---|
| 파트 PUT 실패 | 클라이언트가 파트별 3회 재시도, 그래도 실패면 throw. 세션은 uploading 유지 |
| complete 시 ETag 불일치 | R2가 거부 → 400. 세션 uploading 유지 |
| SQS 발행 실패 | 세션 failed + analysis_error. 사용자가 retry |
| R2 다운로드 실패·ffmpeg 실패·Gemini 최종 실패 | 세션 failed + analysis_error |
| Gemini가 take 0개 | 정상. ready, take_count 0. 화면은 "No takes found" |
| 워커 프로세스 사망 | visibility 만료 후 재전달 → 멱등 재실행 |
| R2 env 미설정 | 세션 생성 시 500 + 로그. 부팅은 가능 |

## 테스트

- **단위 (`*.spec.ts`)**: `planChunks`(경계·겹침·짧은 파일), `mergeCandidates`(겹침 병합, 맞닿음, 최소 길이, type 우선, index 재부여), `uploadRecording`(fetch mock: 파트 재시도, 이미 올라간 파트 건너뛰기, 진행률, 동시성), 검증 함수, `SessionAnalysisService`(storage·gemini·ffmpeg mock: 성공 경로, 청크 재시도, 실패 시 failed 기록, 멱등 재실행), consumer(visibility 연장, 성공·실패 모두 삭제), dev 로그인 게이트.
- **e2e (`*.e2e-spec.ts`, StorageService override)**: 세션 생성→파트 URL→상태→완료→analyzing + SQS 발행(SQS mock), 비멤버 403, 없는 세션 404, uploading 아닌 세션에 파트 요청 409, retry 규칙, takes 목록, 코멘트 생성·조회·검증, `truncateAll`에 새 테이블 추가.
- **라이브**: 검증 스크립트로 45분 m4a 전 구간.
- **모바일**: typecheck + `uploadRecording`은 api-client 단위 테스트로 커버. 실기기 검증은 맥/iOS.

## 후속 작업 (백로그로 이관)

`docs/backlog.md`에 다음을 남긴다: 가져오기 원본 업로드+서버 변환, 검출기 전처리(Python 워커, `planChunks` 교체), 앱 종료 후 업로드 재개(로컬 `{sessionId, fileUri}` 보관), 3시간 백그라운드 녹음 안정성, Take 경계 편집, 실제 파형, 원본 녹음 코멘트, 대댓글 UI, `+MARK` 분석 힌트, gap-merge 옵션, 세션 삭제 API와 R2 객체 정리.
