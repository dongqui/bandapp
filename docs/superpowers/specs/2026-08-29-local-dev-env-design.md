# 로컬 개발 환경 구성 (인프라 기반) — 설계

- 날짜: 2026-08-29
- 브랜치: `feat/local-dev-env` (main 기준)
- 근거 문서: `band-app-dev-environment.md` (로컬 개발 환경 구성 가이드)
- 범위: **인프라 기반만.** Gemini SDK, R2/Storage, DB 스키마·마이그레이션, recording 상태 머신, mobile 연동은 이번 범위에서 제외한다.

## 목표

`docker compose up` 한 번으로 PostgreSQL + LocalStack(SQS) + NestJS API + NestJS Worker + Python Audio Worker가 기동되고, API에 분석 요청을 보내면 SQS를 거쳐 Worker가 메시지를 수신·로그하는 것까지 로컬에서 검증한다.

```text
POST /recordings/:id/analysis
        ↓
NestJS API ──> LocalStack SQS (recording-analysis) ──> NestJS Worker (log + delete)
                         (recording-analysis-python) ──> Python Worker (log + delete)
```

## 가이드 문서와의 차이 (적용 결정)

| 가이드 | 이 저장소 | 결정 |
|---|---|---|
| `apps/server` 신설 | `apps/api` 스캐폴드 존재 | `apps/api`를 그대로 사용, entry point만 분리 |
| `apps/audio-worker/src/main.py` | `src/audio_worker/__main__.py` 패키지 구조 존재 | 기존 패키지 구조 유지, `uv run python -m audio_worker`로 실행 |
| Python에 TF/librosa 등 포함 검토 | — | 이번에는 boto3만 추가 (YAGNI, 이미지 경량 유지) |
| Gemini/R2 연동 | — | 범위 제외. `.env.example`에 placeholder만 유지 |

## 구성 요소

### 1. Docker Compose (루트 `docker-compose.yml`)

- `postgres`: `postgres:17`, `band/band/band`, 5432 노출, `pg_isready` healthcheck, named volume.
- `localstack`: `SERVICES: sqs`, region `ap-northeast-2`, 4566 노출, init 스크립트 mount.
- `api`: `apps/api/Dockerfile` 빌드, `pnpm --filter @bandapp/api start:api:dev`, 3000 노출.
- `worker`: 같은 이미지, `pnpm --filter @bandapp/api start:worker:dev`. `container_name` 미지정 (수평 확장 대비).
- `audio-worker`: `apps/audio-worker/Dockerfile` 빌드, `uv run python -m audio_worker`.
- api/worker는 `.:/app` + `/app/node_modules` 익명 볼륨으로 소스 mount (watch 개발), `postgres` healthy + `localstack` started에 의존.
- `docker/localstack/init-aws.sh`: `recording-analysis`, `recording-analysis-python`, `recording-analysis-dlq` 큐 생성.

### 2. NestJS entry point 분리 (`apps/api`)

- `src/main.ts` → `src/api.main.ts` 개명 (HTTP 서버, 기존 `AppModule`).
- `src/worker.main.ts` 신설: `NestFactory.createApplicationContext(WorkerModule)` 후 SQS consumer 시작. HTTP 서버 없음.
- `package.json` 스크립트: `start:api:dev` / `start:worker:dev` (`nest start --watch --entryFile <name>`), 기존 `start:dev`는 `start:api:dev`의 alias로 유지.
- `nest-cli.json` entryFile 관련 설정 정합성 확인.

### 3. Queue 모듈 (`apps/api/src/queue`)

- `@aws-sdk/client-sqs` 의존성 추가.
- `SqsClient` provider: `SQS_ENDPOINT` 설정 시 LocalStack용 endpoint + dummy credential, 미설정 시 AWS 기본. 운영/로컬이 env만 다르고 코드는 동일해야 한다.
- 큐 URL은 `SQS_ANALYSIS_QUEUE_URL` / `SQS_PYTHON_ANALYSIS_QUEUE_URL` env로 주입.

### 4. Analysis producer / consumer

- Producer (`analysis` 모듈): `POST /recordings/:id/analysis` → `{ recordingId }` 메시지를 `recording-analysis` 큐에 발행 → `202 Accepted`. **DB 저장 없음** (recordings 테이블은 다음 단계).
- Consumer (`WorkerModule`): `recording-analysis` long-polling → 메시지 body 로그 → `DeleteMessage`. 처리 실패 시 삭제하지 않음 (visibility timeout 후 재수신). 종료 시그널에서 polling 루프 정리.

### 5. Python Worker (`apps/audio-worker`)

- `Dockerfile` 신설: `python:3.12-slim` + `ffmpeg`, `libsndfile1` + `uv`, `uv sync` 후 `python -m audio_worker`.
- `boto3` 의존성 추가. `recording-analysis-python` 큐 polling → 메시지 로그 → delete. env: `SQS_ENDPOINT`, `SQS_PYTHON_ANALYSIS_QUEUE_URL`, `AWS_REGION`.
- 분석 로직 없음 — 기동·수신 확인용 골격만.

### 6. 환경 변수

- `.env.example` 커밋: `DATABASE_URL`, `AWS_REGION`, dummy AWS credential, `SQS_ENDPOINT`, 큐 URL 2종, `GEMINI_API_KEY`/`GEMINI_MODEL`/R2 placeholder (빈 값).
- `.env`는 `.gitignore`에 포함 확인. compose는 `env_file: [.env]` 사용.

## 오류 처리

- Consumer는 메시지 처리 실패 시 DeleteMessage를 호출하지 않는다 (DLQ 연결은 다음 단계, 큐만 미리 생성).
- SQS 연결 실패 시 worker는 로그 후 재시도 (crash-loop 대신 backoff).
- API producer는 SQS 발행 실패 시 5xx 반환.

## 테스트

- Producer 단위 테스트: SQS client mock, 올바른 큐 URL·메시지 body로 `SendMessageCommand` 발행 검증, 202 응답.
- Consumer 단위 테스트: mock 메시지 수신 → 처리 → delete 호출 검증, 실패 시 delete 미호출 검증.
- Python: 기존 `test_smoke.py` 유지 + polling 함수 단위 테스트 (boto3 stub).
- 기존 `pnpm test` (vitest unit + e2e) 통과 유지.

## 수동 검증 (완료 조건)

1. `docker compose up --build` → 5개 서비스 기동, localstack 큐 3개 생성 로그 확인.
2. `curl -X POST localhost:3000/recordings/test-1/analysis` → 202, worker 로그에 `test-1` 출력.
3. `awslocal`(또는 AWS CLI + endpoint)로 `recording-analysis-python` 큐에 수동 발행 → audio-worker 로그 출력.
4. `docker compose down` 후 재기동 시 동일 동작.
