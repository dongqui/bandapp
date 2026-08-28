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
