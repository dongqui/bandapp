# Gemini 오디오 분석 연동 — 설계

- 날짜: 2026-08-30
- 브랜치: `feat/gemini-analysis` (main 8743a5d 기준)
- 근거 문서: `band-app-dev-environment.md` §10–11, §22–23 (Gemini SDK / Service / PoC / Take 스키마)
- 선행: 로컬 개발 환경 (2026-08-29 스펙) — API→SQS→Worker 경로 동작 확인 완료

## 목표

Worker가 분석 job을 받으면 로컬 오디오 파일을 Gemini로 분석해 Take 후보 구간(JSON)을 로그로 출력한다. 운영 경로(API→SQS→Worker→Gemini)와 동일한 흐름을 dev에서 검증한다.

```text
POST /recordings/:id/analysis  body: { audioPath?: string }
        ↓
SQS { recordingId, audioPath? }
        ↓
Worker consumer
        ├─ audioPath 없음 → 기존과 동일 (수신 로그만)
        └─ audioPath 있음 → GeminiService.analyzeAudio()
                              ↓ Files API 업로드 → ACTIVE 대기 → structured output 분석
                              ↓ TakeCandidate[] 로그 출력 (DB 저장은 다음 단계)
```

## 범위 제외

DB 저장, R2 연동, Gemini 재시도·업로드 파일 삭제 lifecycle, Python 워커의 Gemini 호출, 실시간 분석. `audioPath`는 dev 전용 필드로, R2 연동 시 R2 다운로드로 대체된다.

## 구성 요소

### 1. 타입 (`packages/types/src/analysis.ts` 신설)

```ts
export type TakeCandidateType = "PERFORMANCE" | "PARTIAL_PRACTICE";

export interface TakeCandidate {
  startMs: number;
  endMs: number;
  type: TakeCandidateType;
  confidence: number; // 0..1
}

export interface RecordingAnalysisResult {
  recordingId: string;
  model: string;
  takes: TakeCandidate[];
}
```

`index.ts`에서 재export. 기존 `Take`(UI 도메인 타입)와는 별개 — TakeCandidate는 AI 분석의 원시 출력이고, 사용자가 수정 가능한 초안이다.

### 2. GeminiService (`apps/api/src/analysis/gemini.service.ts`)

- 의존성: `@google/genai` (공식 SDK). 레거시 `@google/generative-ai`는 사용하지 않는다.
- env: `GEMINI_API_KEY`(필수, 호출 시점 검증), `GEMINI_MODEL`(기본 `gemini-3.6-flash`), `GEMINI_TIMEOUT_MS`(기본 300000).
- `analyzeAudio(filePath: string): Promise<TakeCandidate[]>`
  1. `files.upload`으로 오디오 업로드
  2. 파일 상태가 `ACTIVE`가 될 때까지 폴링 (PROCESSING 동안 대기, FAILED면 throw)
  3. 분석 요청: 프롬프트(가이드 §11 — 잡담·튜닝·단발 연주 제외, 연주 구간 타임스탬프) + 업로드 파일 URI, **structured output**으로 `{ takes: TakeCandidate[] }` JSON 스키마 강제
  4. 응답 파싱 + 검증(takes 배열 존재, 숫자 필드, startMs < endMs, type enum) 후 반환. 검증 실패 시 throw.
- 전체에 타임아웃 적용. 실패는 그대로 throw — 호출자(consumer)의 미삭제/재전달 정책을 따른다.
- SDK 클라이언트는 생성자에서 lazy 초기화하지 않고 호출 시점에 `GEMINI_API_KEY`를 검증한다 (키 없이도 모듈 부팅은 가능해야 함 — API 프로세스도 AnalysisModule을 로드하므로).
- 주의: 가이드 문서 예시의 `client.interactions.create`는 설치되는 SDK 버전의 실제 API와 다를 수 있다. 구현은 설치된 `@google/genai`의 실제 API(현행 `models.generateContent` + `files.upload`)를 따르고, 프롬프트·스키마 의도만 가이드에서 가져온다.

### 3. Job 타입 확장

`AnalyzeRecordingJob = { recordingId: string; audioPath?: string }`.

`audioPath`는 **저장소 루트 기준 상대 경로**다 (worker 컨테이너는 저장소를 `/app`에 마운트하므로 컨테이너 안에서 그대로 해석됨. 예: `poc/data/clips/band_full/xxx.wav`).

- Producer: `POST /recordings/:id/analysis`의 optional JSON body `{ audioPath?: string }`를 받아 메시지에 포함.
- Consumer `handleMessage`:
  - `audioPath` 없음 → 기존 수신 로그 (변경 없음)
  - `audioPath` 있음 → `GeminiService.analyzeAudio(audioPath)` → `RecordingAnalysisResult`를 JSON 로그로 출력
  - 분석 throw 시 메시지 미삭제(기존 정책, visibility timeout 후 재전달)
- `handleMessage`가 async가 되므로 consumer의 처리 루프에서 await. WorkerModule에 GeminiService 등록 (AnalysisModule에도 provider로 등록해 두 모듈이 공유).

### 4. 환경 변수

`.env.example`의 기존 `GEMINI_API_KEY=`/`GEMINI_MODEL=gemini-3.6-flash` 사용. `GEMINI_TIMEOUT_MS`는 기본값이 있으므로 example에 추가하지 않는다. 실키는 사용자가 `.env`에 직접 입력한다 (커밋 금지, 모바일 앱에 노출 금지).

## 오류 처리

- `audioPath`가 있는데 `GEMINI_API_KEY` 미설정 → **consumer가 서비스 호출 전에 env를 확인**해 경고 로그만 남기고 정상 처리(삭제)한다 (키 없는 환경에서 무한 재전달 방지 — 설정 오류는 재시도로 해결되지 않음). GeminiService 자체는 키 없이 호출되면 throw하는 계약을 유지한다.
- 파일 없음/업로드 실패/타임아웃/검증 실패 → throw → 미삭제 → 재전달.
- Gemini 응답이 스키마와 다르면 검증 단계에서 throw (조용히 빈 배열 반환 금지).

## 테스트

- GeminiService 단위 테스트: SDK 클라이언트 mock — 업로드→ACTIVE 폴링→생성 호출 순서, 정상 파싱, 잘못된 응답(스키마 불일치) throw, FAILED 파일 상태 throw, 키 미설정 throw.
- Consumer 단위 테스트(기존 스펙 확장): audioPath 없는 메시지는 Gemini 미호출, 있는 메시지는 호출 후 삭제, 분석 throw 시 미삭제, 키 미설정 케이스는 삭제.
- Producer/Controller: body의 audioPath 전달 검증.
- 라이브 검증(수동): 키 입력 후 `poc/data`의 30초 wav로 `curl -X POST localhost:3001/recordings/live-1/analysis -H "Content-Type: application/json" -d '{"audioPath":"poc/data/..."}'` → worker 로그에서 TakeCandidate JSON 확인.

## 완료 조건

1. `pnpm test` 전체 통과 (신규 테스트 포함).
2. 라이브: 실제 wav 하나가 API→SQS→Worker→Gemini를 거쳐 worker 로그에 `RecordingAnalysisResult` JSON으로 출력된다.
3. 키가 없는 상태에서도 스택 전체가 기존과 동일하게 부팅·동작한다.
