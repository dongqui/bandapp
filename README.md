# bandapp

밴드 합주 녹음을 자동으로 정리해 주는 앱. PRD와 설계 문서는 `docs/` 참고.

## 구조

- `apps/mobile` — Expo(React Native) 앱
- `apps/api` — NestJS API
- `apps/audio-worker` — Python 분석 워커 (JS 워크스페이스 밖, 자체 pyproject)
- `packages/types` — mobile ↔ api 공유 타입 (유일한 공유 지점)
- `packages/api-client` — API 클라이언트
- `packages/config` — 공유 tsconfig/prettier 프리셋
- `poc/` — Phase 0 오디오 세그멘테이션 실험 하네스 (독립)
- `infra/` — 인프라 정의 자리

## 시작하기

Node >=22, pnpm 10 필요.

```bash
pnpm install
pnpm build      # turbo run build
pnpm lint
pnpm test
```

audio-worker는 `apps/audio-worker/`에서 별도 설치:

```bash
python -m venv .venv
.venv/Scripts/python.exe -m pip install -e ".[dev]"
```

## 로컬 개발 환경

```bash
cp .env.example .env   # 최초 1회
docker compose up --build -d
```

- API: http://localhost:3000 (health: `GET /health`)
- 분석 파이프라인: 세션 생성(`POST /bands/:bandId/sessions`) → presigned multipart 업로드 → `POST /sessions/:id/upload/complete` → SQS → worker(R2 다운로드 → ffmpeg 청크 → Gemini → take 절단 → R2 업로드 → DB). `.env`에 `GEMINI_API_KEY`, `R2_*`, `DEV_LOGIN_SECRET`이 필요하다.
- 서버 전 구간 검증(Windows): PowerShell에서는 `$env:UPLOAD_FILE="poc/data/raw_sessions/IMG_2811.m4a"; $env:API_URL="http://localhost:3001"; $env:DEV_LOGIN_SECRET="<.env 값>"; pnpm --filter @bandapp/api upload-session` (API_URL은 호스트에 노출된 포트, `API_PORT`로 바뀌며 이 머신에서는 3001). bash라면 `UPLOAD_FILE=poc/data/raw_sessions/IMG_2811.m4a API_URL=http://localhost:3001 DEV_LOGIN_SECRET=<.env 값> pnpm --filter @bandapp/api upload-session`. → 업로드 진행률, 분석 대기, take 목록, 첫 take ffprobe 길이가 순서대로 찍힌다. 워커 로그는 `docker compose logs -f worker`.
- Dockerfile에 ffmpeg이 추가됐고 큐 visibility timeout이 바뀌었으니 기존 체크아웃은 `docker compose up --build -V`로 재빌드하고 localstack 볼륨도 새로 만든다 (`docker compose down -v` 후 up).
- 큐: LocalStack SQS (`recording-analysis`, `recording-analysis-python`, `recording-analysis-dlq`)
- 종료: `docker compose down`
- 의존성 추가/변경 후에는 `docker compose up --build -V`로 anonymous node_modules 볼륨을 재생성해야 반영된다. (auth/bands/invites 도입으로 drizzle-orm, pg, jose, @nestjs/throttler가 새로 추가됐으니 기존 체크아웃은 반드시 `-V`로 재빌드할 것)

### 녹음 업로드·분석 (모바일)

- 가져오기·녹음 모두 m4a만 다룬다. 업로드는 앱이 R2에 직접 하고(presigned multipart), 완료되면 워커가 분석한다.
- 새 네이티브 모듈(expo-audio, expo-document-picker, expo-file-system)이 들어갔으니 dev build를 다시 만들어야 한다: `pnpm --filter mobile ios` (맥).
- 서버 없이 UI만 볼 때는 `EXPO_PUBLIC_API_URL`을 비워 Mock으로 띄운다. Mock은 업로드 진행률만 흉내 내고 재생은 시뮬레이션이다.
- 웹 프리뷰(`pnpm --filter mobile dev`)에서 의미 있는 건 가져오기뿐이다. 녹음은 브라우저에서 webm이 나와 서버가 받는 m4a와 맞지 않으니 네이티브(dev build)에서만 쓴다.

### DB 마이그레이션

`api` 컨테이너는 기동 시 자동으로 `pnpm --filter @bandapp/api db:migrate`를 실행해 최신 스키마를 적용한다(drizzle migrate는 멱등이라 반복 실행해도 안전하다). 컨테이너를 띄우지 않고 호스트에서 직접 적용하려면:

```bash
pnpm --filter @bandapp/api db:migrate   # localhost:5432 대상
```
