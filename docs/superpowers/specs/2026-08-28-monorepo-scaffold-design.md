# 모노레포 기본 구조 (뼈대) 설계

날짜: 2026-08-28
상태: 승인됨
근거 문서: Band Rehearsal App MVP PRD (§21 백엔드 아키텍처, §28 개발 우선순위 Phase 1)

## 목적

PRD Phase 1의 첫 단계로, 도메인 로직 없이 모노레포 뼈대만 세운다.
apps 3개(mobile, api, audio-worker)와 공유 packages가 한 번의 설치로
빌드·린트·실행되는 상태를 만든다.

## 범위

포함:

- pnpm 워크스페이스 + Turborepo 구성
- Expo(TypeScript, dev client 전제) 모바일 앱 셸
- NestJS API 셸 (헬스체크 1개 + PRD §21 모듈 폴더 선점)
- Python audio-worker 뼈대 (자체 pyproject, placeholder 엔트리)
- 공유 packages: types, api-client, config
- infra/ placeholder

제외 (다음 단계):

- DB 스키마·마이그레이션, 인증, R2 연동, 도메인 로직, CI

## 디렉토리 구조

```
bandapp/
├─ apps/
│  ├─ mobile/            # Expo(TypeScript) + dev client 전제. 빈 화면 1개.
│  ├─ api/               # NestJS. 헬스체크 + 빈 모듈 폴더.
│  └─ audio-worker/      # Python. 자체 pyproject, src 레이아웃.
├─ packages/
│  ├─ types/             # 공유 TS 타입 (지금은 빈 export)
│  ├─ api-client/        # API 클라이언트 자리 (빈 export)
│  └─ config/            # 공유 tsconfig / eslint / prettier 프리셋
├─ infra/                # placeholder + README
├─ docs/                 # 기존 유지
├─ poc/                  # 기존 그대로, 워크스페이스 미편입
├─ pnpm-workspace.yaml   # apps/*, packages/* (audio-worker 제외)
├─ turbo.json            # build / lint / test / dev 파이프라인
├─ .npmrc                # node-linker=hoisted
└─ package.json          # 루트: 스크립트와 turbo만
```

## 핵심 결정

1. **pnpm + Turborepo.** RN(Expo)과 NestJS 모두 공식 지원이 있고 설정이
   가볍다. Nx는 MVP 규모에 과하다고 판단.
2. **Expo + dev client.** 백그라운드 장시간 녹음 등 네이티브 모듈이
   필요해도 prebuild로 대응 가능하며, 빌드/업데이트 인프라를 얻는다.
3. **audio-worker는 JS 워크스페이스 밖.** Python 의존성은 pyproject로
   독립 관리한다. Turborepo 연결은 필요해질 때 커스텀 태스크로만 한다.
4. **NestJS 모듈 폴더 선점.** `auth/ users/ bands/ memberships/ sessions/
   recordings/ takes/ comments/ storage/ analysis/ notifications/ db/`를
   빈 모듈로 만들어 PRD 구조를 코드에 고정한다. 로직은 전부 비워둔다.
5. **`.npmrc`에 `node-linker=hoisted`.** pnpm 심링크 node_modules가
   RN/Metro와 충돌하는 사례가 있어 hoisted로 시작한다.
6. **packages/types가 유일한 공유 지점.** mobile ↔ api 간 DTO는 여기로만
   흐른다. api-client 구현 방식을 나중에 바꿔도 경계가 유지된다.
7. **poc/는 루트에 그대로.** Phase 0 실험 도구로 독립 유지하고,
   audio-worker는 빈 뼈대로 새로 시작해 검증된 코드만 이후 이식한다.

## 검증 기준 (완료 정의)

- `pnpm install` 1회로 전체 설치 성공
- `pnpm turbo build lint` 통과
- `apps/api` 실행 시 `GET /health` 200 응답
- `apps/mobile` `expo start` 기동 확인 (Windows 환경이라 네이티브 빌드
  검증은 범위 밖)
- `apps/audio-worker` `python -m` 엔트리 실행 확인
