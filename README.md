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
- 분석 요청: `curl -X POST http://localhost:3000/recordings/<id>/analysis` (Gemini 분석은 body에 `{"audioPath":"poc/data/....wav"}` 추가, `.env`에 `GEMINI_API_KEY` 필요) → worker 컨테이너 로그로 수신/분석 결과 확인
- 큐: LocalStack SQS (`recording-analysis`, `recording-analysis-python`, `recording-analysis-dlq`)
- 종료: `docker compose down`
- 의존성 추가/변경 후에는 `docker compose up --build -V`로 anonymous node_modules 볼륨을 재생성해야 반영된다. (auth/bands/invites 도입으로 drizzle-orm, pg, jose, @nestjs/throttler가 새로 추가됐으니 기존 체크아웃은 반드시 `-V`로 재빌드할 것)

### DB 마이그레이션

`api` 컨테이너는 기동 시 자동으로 `pnpm --filter @bandapp/api db:migrate`를 실행해 최신 스키마를 적용한다(drizzle migrate는 멱등이라 반복 실행해도 안전하다). 컨테이너를 띄우지 않고 호스트에서 직접 적용하려면:

```bash
pnpm --filter @bandapp/api db:migrate   # localhost:5432 대상
```
