# 모노레포 뼈대 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 도메인 로직 없이 pnpm + Turborepo 모노레포 뼈대(apps 3개 + packages 3개)를 한 번의 설치로 빌드·린트·실행되는 상태로 만든다.

**Architecture:** JS/TS 앱(mobile, api)과 공유 패키지는 pnpm 워크스페이스 + Turborepo로 묶고, Python audio-worker는 자체 pyproject로 워크스페이스 밖에서 독립 관리한다. mobile ↔ api 간 공유 지점은 `@bandapp/types` 하나로 고정한다.

**Tech Stack:** pnpm 10, Turborepo 2, Expo(TypeScript, blank 템플릿), NestJS(공식 CLI 스캐폴드), Python 3.11+ / setuptools / pytest

**스펙:** `docs/superpowers/specs/2026-08-28-monorepo-scaffold-design.md`

## Global Constraints

- Node `>=22`, 루트 `packageManager`는 `pnpm@10.12.1`로 고정
- 루트 `.npmrc`에 `node-linker=hoisted` (Expo/Metro 호환)
- 워크스페이스 글롭: `apps/*`, `packages/*` — `apps/audio-worker`는 package.json이 없으므로 자연 제외
- NestJS 선점 모듈 12개 이름 verbatim: `auth users bands memberships sessions recordings takes comments storage analysis notifications db`
- audio-worker는 `requires-python = ">=3.11"`, JS 도구와 무관하게 단독 설치/실행 가능해야 함
- `poc/`, `docs/` 기존 내용은 수정하지 않는다 (루트 README는 예외적으로 갱신)
- 커밋 메시지는 기존 관례대로 영어 conventional commits

---

### Task 1: 루트 워크스페이스 구성

**Files:**
- Create: `pnpm-workspace.yaml`, `turbo.json`, `.npmrc`, `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: 없음
- Produces: 이후 모든 태스크가 사용하는 워크스페이스. 루트 스크립트 `pnpm build` / `pnpm lint` / `pnpm test`(각각 `turbo run <task>`).

- [ ] **Step 1: 루트 설정 파일 4개 작성**

`package.json`:

```json
{
  "name": "bandapp",
  "private": true,
  "engines": {
    "node": ">=22"
  },
  "packageManager": "pnpm@10.12.1",
  "scripts": {
    "build": "turbo run build",
    "lint": "turbo run lint",
    "test": "turbo run test",
    "dev": "turbo run dev"
  },
  "devDependencies": {
    "turbo": "^2.5.0"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`.npmrc`:

```
node-linker=hoisted
```

`turbo.json`:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "lint": {},
    "test": {
      "dependsOn": ["^build"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    }
  }
}
```

- [ ] **Step 2: .gitignore 갱신**

기존 내용 확인 후(현재 15바이트짜리 파일) 아래 항목이 포함되도록 덮어쓴다. poc가 쓰던 기존 라인은 유지한다:

```
node_modules/
dist/
.turbo/
.expo/
.venv/
__pycache__/
*.tsbuildinfo
.DS_Store
```

- [ ] **Step 3: 설치 및 no-op 빌드 검증**

Run: `pnpm install` 후 `pnpm build`
Expected: 설치 성공, turbo가 "No tasks were executed"(패키지 0개)로 정상 종료(exit 0)

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-workspace.yaml .npmrc turbo.json .gitignore pnpm-lock.yaml
git commit -m "chore: set up pnpm + turborepo workspace root"
```

---

### Task 2: 공유 패키지 3종 (config, types, api-client)

**Files:**
- Create: `packages/config/package.json`, `packages/config/tsconfig.base.json`, `packages/config/prettier.config.cjs`
- Create: `packages/types/package.json`, `packages/types/tsconfig.json`, `packages/types/src/index.ts`
- Create: `packages/api-client/package.json`, `packages/api-client/tsconfig.json`, `packages/api-client/src/index.ts`

**Interfaces:**
- Consumes: Task 1의 워크스페이스
- Produces:
  - `@bandapp/config/tsconfig.base.json` — TS 패키지가 extends 하는 베이스
  - `@bandapp/config/prettier` — prettier 프리셋
  - `@bandapp/types`의 `export interface HealthStatus { status: "ok" }` — Task 3(api)과 api-client가 사용
  - `@bandapp/api-client`의 `getHealth(baseUrl: string): Promise<HealthStatus>`

- [ ] **Step 1: packages/config 작성**

`packages/config/package.json`:

```json
{
  "name": "@bandapp/config",
  "version": "0.0.0",
  "private": true,
  "exports": {
    "./tsconfig.base.json": "./tsconfig.base.json",
    "./prettier": "./prettier.config.cjs"
  }
}
```

`packages/config/tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

`packages/config/prettier.config.cjs`:

```js
module.exports = {
  printWidth: 100,
  singleQuote: false,
  trailingComma: "all",
};
```

- [ ] **Step 2: packages/types 작성**

`packages/types/package.json`:

```json
{
  "name": "@bandapp/types",
  "version": "0.0.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json"
  },
  "devDependencies": {
    "@bandapp/config": "workspace:*",
    "typescript": "^5.6.0"
  }
}
```

`packages/types/tsconfig.json`:

```json
{
  "extends": "@bandapp/config/tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

`packages/types/src/index.ts`:

```ts
export interface HealthStatus {
  status: "ok";
}
```

- [ ] **Step 3: packages/api-client 작성**

`packages/api-client/package.json`:

```json
{
  "name": "@bandapp/api-client",
  "version": "0.0.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@bandapp/types": "workspace:*"
  },
  "devDependencies": {
    "@bandapp/config": "workspace:*",
    "typescript": "^5.6.0"
  }
}
```

`packages/api-client/tsconfig.json`:

```json
{
  "extends": "@bandapp/config/tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

`packages/api-client/src/index.ts`:

```ts
import type { HealthStatus } from "@bandapp/types";

export async function getHealth(baseUrl: string): Promise<HealthStatus> {
  const res = await fetch(`${baseUrl}/health`);
  if (!res.ok) {
    throw new Error(`health check failed: ${res.status}`);
  }
  return (await res.json()) as HealthStatus;
}
```

- [ ] **Step 4: 설치 및 빌드 검증**

Run: `pnpm install` 후 `pnpm build`
Expected: `@bandapp/types` → `@bandapp/api-client` 순서로 tsc 빌드 2건 성공, 각 패키지에 `dist/index.js`와 `dist/index.d.ts` 생성

- [ ] **Step 5: Commit**

```bash
git add packages pnpm-lock.yaml
git commit -m "feat: add shared packages (config, types, api-client)"
```

---

### Task 3: apps/api — NestJS 셸 + 헬스체크 + 모듈 선점

**Files:**
- Create: `apps/api/` (NestJS CLI 스캐폴드 전체)
- Create: `apps/api/src/health/health.module.ts`, `apps/api/src/health/health.controller.ts`, `apps/api/src/health/health.controller.spec.ts`
- Create: 선점 모듈 12개 — `apps/api/src/<name>/<name>.module.ts` (`auth users bands memberships sessions recordings takes comments storage analysis notifications db`)
- Modify: `apps/api/src/app.module.ts`, `apps/api/test/app.e2e-spec.ts`, `apps/api/package.json`
- Delete: `apps/api/src/app.controller.ts`, `apps/api/src/app.controller.spec.ts`, `apps/api/src/app.service.ts`

**Interfaces:**
- Consumes: `@bandapp/types`의 `HealthStatus` (타입 전용 import — 런타임 의존 없음)
- Produces: `GET /health` → `200 { "status": "ok" }`. 이후 Phase에서 채워질 12개 빈 모듈.

- [ ] **Step 1: NestJS 스캐폴드 생성**

리포 루트에서:

```bash
pnpm dlx @nestjs/cli@latest new api --directory apps/api --package-manager pnpm --skip-git --skip-install
```

생성 후 `apps/api/package.json`의 `"name"`을 `"@bandapp/api"`로 바꾸고 `devDependencies`에 `"@bandapp/types": "workspace:*"`를 추가한다. 그 다음 루트에서 `pnpm install`.

- [ ] **Step 2: 실패하는 e2e 테스트 작성**

`apps/api/test/app.e2e-spec.ts`의 기존 `/ (GET)` 테스트를 다음으로 교체:

```ts
import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import * as request from "supertest";
import { AppModule } from "./../src/app.module";

describe("AppController (e2e)", () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it("/health (GET)", () => {
    return request(app.getHttpServer())
      .get("/health")
      .expect(200)
      .expect({ status: "ok" });
  });
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `pnpm --filter @bandapp/api run test:e2e`
Expected: FAIL — `/health`가 404

- [ ] **Step 4: 헬스 모듈 구현**

`apps/api/src/health/health.controller.ts`:

```ts
import { Controller, Get } from "@nestjs/common";
import type { HealthStatus } from "@bandapp/types";

@Controller("health")
export class HealthController {
  @Get()
  getHealth(): HealthStatus {
    return { status: "ok" };
  }
}
```

`apps/api/src/health/health.controller.spec.ts`:

```ts
import { HealthController } from "./health.controller";

describe("HealthController", () => {
  it("returns ok", () => {
    expect(new HealthController().getHealth()).toEqual({ status: "ok" });
  });
});
```

`apps/api/src/health/health.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";

@Module({
  controllers: [HealthController],
})
export class HealthModule {}
```

- [ ] **Step 5: 선점 모듈 12개 생성**

각 이름(`auth users bands memberships sessions recordings takes comments storage analysis notifications db`)에 대해 `apps/api/src/<name>/<name>.module.ts` 생성. 클래스명은 PascalCase + `Module`. 예시 (`auth`):

```ts
import { Module } from "@nestjs/common";

@Module({})
export class AuthModule {}
```

나머지 11개도 동일 패턴: `UsersModule`, `BandsModule`, `MembershipsModule`, `SessionsModule`, `RecordingsModule`, `TakesModule`, `CommentsModule`, `StorageModule`, `AnalysisModule`, `NotificationsModule`, `DbModule`.

- [ ] **Step 6: AppModule 정리**

`apps/api/src/app.controller.ts`, `app.controller.spec.ts`, `app.service.ts`를 삭제하고 `apps/api/src/app.module.ts`를 다음으로 교체:

```ts
import { Module } from "@nestjs/common";
import { HealthModule } from "./health/health.module";
import { AuthModule } from "./auth/auth.module";
import { UsersModule } from "./users/users.module";
import { BandsModule } from "./bands/bands.module";
import { MembershipsModule } from "./memberships/memberships.module";
import { SessionsModule } from "./sessions/sessions.module";
import { RecordingsModule } from "./recordings/recordings.module";
import { TakesModule } from "./takes/takes.module";
import { CommentsModule } from "./comments/comments.module";
import { StorageModule } from "./storage/storage.module";
import { AnalysisModule } from "./analysis/analysis.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { DbModule } from "./db/db.module";

@Module({
  imports: [
    HealthModule,
    AuthModule,
    UsersModule,
    BandsModule,
    MembershipsModule,
    SessionsModule,
    RecordingsModule,
    TakesModule,
    CommentsModule,
    StorageModule,
    AnalysisModule,
    NotificationsModule,
    DbModule,
  ],
})
export class AppModule {}
```

- [ ] **Step 7: 테스트 통과 확인**

Run: `pnpm --filter @bandapp/api run test` 그리고 `pnpm --filter @bandapp/api run test:e2e`
Expected: 둘 다 PASS (`@bandapp/types`는 `import type`이라 미빌드여도 무방하나, 실패 시 `pnpm --filter @bandapp/types run build` 후 재시도)

- [ ] **Step 8: 빌드·린트 확인**

Run: `pnpm build` 그리고 `pnpm lint`
Expected: api 포함 전체 성공 (Nest 스캐폴드의 기본 lint 스크립트 사용)

- [ ] **Step 9: Commit**

```bash
git add apps/api pnpm-lock.yaml
git commit -m "feat(api): scaffold nestjs shell with health check and domain module stubs"
```

---

### Task 4: apps/mobile — Expo 셸

**Files:**
- Create: `apps/mobile/` (create-expo-app blank-typescript 스캐폴드 전체)
- Modify: `apps/mobile/App.tsx`, `apps/mobile/package.json`, `apps/mobile/app.json`

**Interfaces:**
- Consumes: Task 1의 워크스페이스 (`.npmrc`의 hoisted 링커 전제)
- Produces: `pnpm --filter mobile exec tsc --noEmit`이 통과하는 Expo TS 앱. 화면 1개.

- [ ] **Step 1: Expo 스캐폴드 생성**

리포 루트에서:

```bash
pnpm dlx create-expo-app@latest apps/mobile --template blank-typescript --no-install
```

`apps/mobile/package.json`에 `"typecheck": "tsc --noEmit"` 스크립트를 추가한다 (`name`은 스캐폴드가 정한 `mobile` 유지). `apps/mobile/app.json`의 `name`/`slug`를 `bandapp`으로 맞춘다. 그 다음 루트에서 `pnpm install`.

- [ ] **Step 2: App.tsx 최소 화면으로 교체**

```tsx
import { StatusBar } from "expo-status-bar";
import { StyleSheet, Text, View } from "react-native";

export default function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>bandapp</Text>
      <StatusBar style="light" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#111214",
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    color: "#e8e8e8",
    fontSize: 24,
  },
});
```

- [ ] **Step 3: 타입체크 검증**

Run: `pnpm --filter mobile run typecheck`
Expected: 에러 0건으로 종료

- [ ] **Step 4: 기동 검증**

Run: `pnpm --filter mobile exec expo start` (수 초 내 Metro 배너 뜨는 것 확인 후 Ctrl+C)
Expected: Metro 번들러가 에러 없이 기동. Windows 환경이므로 네이티브 빌드 검증은 범위 밖(스펙 명시).

- [ ] **Step 5: Commit**

```bash
git add apps/mobile pnpm-lock.yaml
git commit -m "feat(mobile): scaffold expo typescript shell"
```

---

### Task 5: apps/audio-worker — Python 뼈대

**Files:**
- Create: `apps/audio-worker/pyproject.toml`
- Create: `apps/audio-worker/src/audio_worker/__init__.py`, `apps/audio-worker/src/audio_worker/__main__.py`
- Test: `apps/audio-worker/tests/test_smoke.py`

**Interfaces:**
- Consumes: 없음 (JS 워크스페이스와 완전 독립)
- Produces: `python -m audio_worker` 실행 가능한 패키지. `audio_worker.__version__: str`, `audio_worker.__main__.main() -> int`.

- [ ] **Step 1: 패키지 메타데이터와 소스 작성**

`apps/audio-worker/pyproject.toml`:

```toml
[project]
name = "bandapp-audio-worker"
version = "0.0.1"
description = "밴드 합주 녹음 분석 워커 (뼈대)"
requires-python = ">=3.11"
dependencies = []

[project.optional-dependencies]
dev = ["pytest>=8"]

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
where = ["src"]
```

`apps/audio-worker/src/audio_worker/__init__.py`:

```python
__version__ = "0.0.1"
```

`apps/audio-worker/src/audio_worker/__main__.py`:

```python
from audio_worker import __version__


def main() -> int:
    print(f"bandapp audio-worker {__version__} (scaffold; no job loop yet)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 2: 실패하는 테스트 작성**

`apps/audio-worker/tests/test_smoke.py`:

```python
from audio_worker import __version__
from audio_worker.__main__ import main


def test_version_is_set():
    assert __version__ == "0.0.1"


def test_main_returns_zero(capsys):
    assert main() == 0
    assert "audio-worker" in capsys.readouterr().out
```

- [ ] **Step 3: venv 생성·설치 전 테스트 실패 확인**

`apps/audio-worker` 디렉토리에서:

```bash
python -m venv .venv
.venv/Scripts/python.exe -m pip install -e ".[dev]"
```

설치 **전**에 `python -m pytest tests`를 시스템 파이썬으로 실행하면 `ModuleNotFoundError: audio_worker`로 실패하는 것을 확인해도 좋지만, 핵심 검증은 설치 후 단계다.

- [ ] **Step 4: 테스트·실행 검증**

`apps/audio-worker`에서:

Run: `.venv/Scripts/python.exe -m pytest tests -v`
Expected: 2건 PASS

Run: `.venv/Scripts/python.exe -m audio_worker`
Expected: `bandapp audio-worker 0.0.1 ...` 출력 후 exit 0

- [ ] **Step 5: Commit**

```bash
git add apps/audio-worker
git commit -m "feat(worker): scaffold python audio worker package"
```

---

### Task 6: infra placeholder, 루트 README, 최종 통합 검증

**Files:**
- Create: `infra/README.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 1–5 전부
- Produces: 스펙의 완료 정의 전체 충족 확인

- [ ] **Step 1: infra placeholder 작성**

`infra/README.md`:

```markdown
# infra

배포/인프라 정의 자리. MVP Phase 1 이후 R2, PostgreSQL, 배포 구성이 여기에 들어온다.
아직 내용 없음.
```

- [ ] **Step 2: 루트 README 갱신**

`README.md`를 다음으로 교체:

```markdown
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

​```bash
pnpm install
pnpm build      # turbo run build
pnpm lint
pnpm test
​```

audio-worker는 `apps/audio-worker/`에서 별도 설치:

​```bash
python -m venv .venv
.venv/Scripts/python.exe -m pip install -e ".[dev]"
​```
```

(위 코드펜스의 제로폭 문자는 실제 파일에는 넣지 말 것 — 일반 ``` 사용)

- [ ] **Step 3: 완료 정의 전체 검증**

리포 루트에서 순서대로:

1. `pnpm install` → 성공
2. `pnpm build` 그리고 `pnpm lint` → 전체 통과
3. `pnpm --filter @bandapp/api run start` 기동 후 다른 셸에서 `curl http://localhost:3000/health` → `{"status":"ok"}` 확인, 서버 종료
4. `pnpm --filter mobile run typecheck` → 통과
5. `apps/audio-worker`에서 `.venv/Scripts/python.exe -m audio_worker` → exit 0

Expected: 5개 항목 전부 성공. 하나라도 실패하면 해당 태스크로 돌아가 수정.

- [ ] **Step 4: Commit**

```bash
git add infra README.md
git commit -m "docs: add infra placeholder and monorepo readme"
```
