# 모바일 디자인 시스템 + 페이지 구성 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Design "Rehearsal App" 프로토타입의 디자인을 apps/mobile(Expo)에 토큰 기반 디자인 시스템 + 재사용 컴포넌트 + 6개 페이지로 구현하고, API는 인터페이스 + Mock 구현체만 둔다.

**Architecture:** `packages/types`(도메인 타입) ← `packages/api-client`(`RehearsalApiClient` 인터페이스 + `MockApiClient`) ← `apps/mobile`. 모바일은 expo-router(라우트 파일은 얇은 re-export), `src/theme`(토큰·ThemeProvider), `src/ui`(도메인 무관 컴포넌트), `src/features/{sessions,recording,takes,band}`(화면+컴포넌트+훅 co-location), `src/api`(Provider), `src/lib`(유틸).

**Tech Stack:** Expo SDK 57 / RN 0.86 / React 19.2 / TypeScript 6 strict, expo-router, @expo-google-fonts/jetbrains-mono, expo-clipboard, vitest(로직 테스트), pnpm + turborepo.

**스펙:** `docs/superpowers/specs/2026-08-29-mobile-design-system-design.md`

## Global Constraints

- Expo SDK 57 — 코드 작성 전 https://docs.expo.dev/versions/v57.0.0/ 기준 확인 (apps/mobile/AGENTS.md 지시)
- Expo 패키지 설치는 반드시 `apps/mobile`에서 `npx expo install <pkg>` 사용 (SDK 호환 버전 고정)
- TypeScript strict. 색·폰트·간격·반경 hex/숫자 리터럴은 `src/theme/tokens.ts` 밖에서 금지 — 화면·컴포넌트는 항상 토큰 참조
- 디자인 원본 색상표·타이포 변형은 스펙의 "디자인 토큰" 표를 그대로 따른다
- 실제 오디오 녹음/재생/HTTP 없음 — 전부 모의 동작
- 커밋은 conventional commits 영문 (기존 히스토리 관례)
- 모든 UI 문구는 프로토타입 영문 카피 그대로 (예: "Record now", "Still finding takes…")

---

### Task 1: packages/types 도메인 타입

**Files:**
- Create: `packages/types/src/band.ts`
- Create: `packages/types/src/session.ts`
- Create: `packages/types/src/take.ts`
- Modify: `packages/types/src/index.ts` (현재 빈 export)

**Interfaces:**
- Consumes: 없음
- Produces: `Band { id; name; memberCount; inviteCode }`, `BandMember { id; name; role: MemberRole }`, `MemberRole = 'owner' | 'member'`, `SessionStatus = 'uploading' | 'analyzing' | 'failed' | 'ready'`, `Session { id; bandId; title; name?; status; startedAt(ISO, 로컬시각, Z 없음); durationSec; takeCount; commentCount }`, `Take { id; sessionId; index; name; durationSec; commentCount }`, `TakeComment { id; takeId; authorName; atSec; text }`

- [ ] **Step 1: 타입 파일 3개 작성**

`packages/types/src/band.ts`:

```ts
export type MemberRole = "owner" | "member";

export interface Band {
  id: string;
  name: string;
  memberCount: number;
  inviteCode: string;
}

export interface BandMember {
  id: string;
  name: string;
  role: MemberRole;
}
```

`packages/types/src/session.ts`:

```ts
export type SessionStatus = "uploading" | "analyzing" | "failed" | "ready";

export interface Session {
  id: string;
  bandId: string;
  /** 기본 표시명 (예: "Aug 27 Rehearsal") */
  title: string;
  /** 사용자가 붙인 이름 (예: "Full set run-through") */
  name?: string;
  status: SessionStatus;
  /** 로컬 시각 ISO 문자열, 타임존 접미사 없음 (예: "2026-08-27T19:03:00") */
  startedAt: string;
  durationSec: number;
  takeCount: number;
  /** 세션 내 전체 코멘트 수 (목록 meta 표시용) */
  commentCount: number;
}
```

`packages/types/src/take.ts`:

```ts
export interface Take {
  id: string;
  sessionId: string;
  /** 0부터 시작 */
  index: number;
  name: string;
  durationSec: number;
  commentCount: number;
}

export interface TakeComment {
  id: string;
  takeId: string;
  authorName: string;
  atSec: number;
  text: string;
}
```

- [ ] **Step 2: index.ts에서 re-export**

`packages/types/src/index.ts` 전체 교체:

```ts
export * from "./band";
export * from "./session";
export * from "./take";
```

- [ ] **Step 3: 빌드로 검증**

Run: `pnpm --filter @bandapp/types build`
Expected: 에러 없이 종료, `packages/types/dist/` 에 band/session/take d.ts 생성

- [ ] **Step 4: Commit**

```bash
git add packages/types
git commit -m "feat(types): add band, session, take domain types"
```

---

### Task 2: packages/api-client — 인터페이스 + MockApiClient (TDD)

**Files:**
- Create: `packages/api-client/src/client.ts`
- Create: `packages/api-client/src/mock/rand.ts`
- Create: `packages/api-client/src/mock/seed.ts`
- Create: `packages/api-client/src/mock/MockApiClient.ts`
- Create: `packages/api-client/src/mock/MockApiClient.test.ts`
- Modify: `packages/api-client/src/index.ts`, `packages/api-client/package.json`, `packages/api-client/tsconfig.json`

**Interfaces:**
- Consumes: Task 1의 모든 타입
- Produces:

```ts
interface CreateSessionInput { durationSec: number; source: "recording" | "import"; }
interface CreateCommentInput { atSec: number; text: string; }
interface RehearsalApiClient {
  bands: {
    list(): Promise<Band[]>;
    members(bandId: string): Promise<BandMember[]>;
    inviteLink(bandId: string): Promise<string>;
  };
  sessions: {
    list(bandId: string): Promise<Session[]>;   // startedAt 내림차순
    get(id: string): Promise<Session>;
    create(bandId: string, input: CreateSessionInput): Promise<Session>; // status 'analyzing'으로 반환, 지연 후 'ready' 전환
    retryAnalysis(id: string): Promise<Session>;
  };
  takes: { list(sessionId: string): Promise<Take[]>; };
  comments: {
    list(takeId: string): Promise<TakeComment[]>;  // atSec 오름차순
    create(takeId: string, input: CreateCommentInput): Promise<TakeComment>;
  };
  subscribe(listener: () => void): () => void;    // 상태 변경 통지, 반환값은 해제 함수
}
class MockApiClient implements RehearsalApiClient { constructor(opts?: { analysisDelayMs?: number }) } // 기본 4000ms
```

- 시드 데이터 (프로토타입과 동일): 밴드 `b1` "FRIDAY NIGHT" / inviteCode `X7K2F9` / 멤버 4명(Dongjin Kim owner, Minsu, Jihoon, Suhyun). 세션 5건 — `p1` 2026-08-29 18:47 4620s analyzing, `f1` 2026-08-28 15:30 4320s failed, `s1` 2026-08-27 19:03 8040s ready 7테이크 name "Full set run-through", `s2` 2026-08-20 20:11 6480s ready 5테이크, `s3` 2026-08-13 19:42 9060s ready 9테이크. 테이크 id는 `${sessionId}-t${index}`. 코멘트는 프로토타입 그대로 s1의 테이크 0/1/3/5, s2의 테이크 1/4에 시드.

- [ ] **Step 1: vitest 설치 및 스크립트 추가**

Run: `pnpm --filter @bandapp/api-client add -D vitest`

`packages/api-client/package.json` scripts에 추가:

```json
"test": "vitest run"
```

`packages/api-client/tsconfig.json`의 exclude에 테스트 제외 추가 (dist에 테스트가 들어가지 않도록):

```json
"exclude": ["dist", "**/*.test.ts"]
```

- [ ] **Step 2: 실패하는 테스트 작성**

`packages/api-client/src/mock/MockApiClient.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MockApiClient } from "./MockApiClient";

const BAND = "b1";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("MockApiClient", () => {
  it("lists seeded sessions newest first with statuses", async () => {
    const api = new MockApiClient();
    const sessions = await api.sessions.list(BAND);
    expect(sessions.map((s) => s.id)).toEqual(["p1", "f1", "s1", "s2", "s3"]);
    expect(sessions[0].status).toBe("analyzing");
    expect(sessions[1].status).toBe("failed");
    expect(sessions[2]).toMatchObject({
      status: "ready",
      name: "Full set run-through",
      takeCount: 7,
    });
  });

  it("lists takes with seeded comment counts", async () => {
    const api = new MockApiClient();
    const takes = await api.takes.list("s1");
    expect(takes).toHaveLength(7);
    expect(takes[0].commentCount).toBe(3);
    expect(takes[2].commentCount).toBe(0);
    const comments = await api.comments.list("s1-t0");
    expect(comments.map((c) => c.atSec)).toEqual([28, 133, 182]);
  });

  it("create returns analyzing session then transitions to ready", async () => {
    const api = new MockApiClient({ analysisDelayMs: 10 });
    const created = await api.sessions.create(BAND, {
      durationSec: 3600,
      source: "recording",
    });
    expect(created.status).toBe("analyzing");
    await wait(50);
    const ready = await api.sessions.get(created.id);
    expect(ready.status).toBe("ready");
    expect(ready.takeCount).toBeGreaterThan(0);
    const takes = await api.takes.list(created.id);
    expect(takes).toHaveLength(ready.takeCount);
  });

  it("retryAnalysis moves failed session to analyzing then ready", async () => {
    const api = new MockApiClient({ analysisDelayMs: 10 });
    const retried = await api.sessions.retryAnalysis("f1");
    expect(retried.status).toBe("analyzing");
    await wait(50);
    expect((await api.sessions.get("f1")).status).toBe("ready");
  });

  it("comments.create appends, bumps counts, notifies subscribers", async () => {
    const api = new MockApiClient();
    let notified = 0;
    const off = api.subscribe(() => notified++);
    await api.comments.create("s1-t2", { atSec: 42, text: "nice" });
    const takes = await api.takes.list("s1");
    expect(takes[2].commentCount).toBe(1);
    const session = await api.sessions.get("s1");
    expect(session.commentCount).toBe(8); // 시드 7 + 1
    expect(notified).toBeGreaterThan(0);
    off();
  });
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `pnpm --filter @bandapp/api-client exec vitest run` (사전에 `pnpm --filter @bandapp/types build` 필요)
Expected: FAIL — `MockApiClient` 모듈 없음

- [ ] **Step 4: 구현 — client.ts / rand.ts / seed.ts / MockApiClient.ts**

`packages/api-client/src/client.ts`:

```ts
import type { Band, BandMember, Session, Take, TakeComment } from "@bandapp/types";

export interface CreateSessionInput {
  durationSec: number;
  source: "recording" | "import";
}

export interface CreateCommentInput {
  atSec: number;
  text: string;
}

export interface RehearsalApiClient {
  bands: {
    list(): Promise<Band[]>;
    members(bandId: string): Promise<BandMember[]>;
    inviteLink(bandId: string): Promise<string>;
  };
  sessions: {
    list(bandId: string): Promise<Session[]>;
    get(id: string): Promise<Session>;
    create(bandId: string, input: CreateSessionInput): Promise<Session>;
    retryAnalysis(id: string): Promise<Session>;
  };
  takes: {
    list(sessionId: string): Promise<Take[]>;
  };
  comments: {
    list(takeId: string): Promise<TakeComment[]>;
    create(takeId: string, input: CreateCommentInput): Promise<TakeComment>;
  };
  /** 데이터 변경 통지. 반환값은 구독 해제 함수. */
  subscribe(listener: () => void): () => void;
}
```

`packages/api-client/src/mock/rand.ts`:

```ts
/** 프로토타입과 동일한 결정적 의사난수 (0..1) */
export function seededUnit(x: number): number {
  const s = Math.sin(x) * 43758.5453;
  return s - Math.floor(s);
}

export function seedOf(id: string): number {
  let n = 0;
  for (const c of id) n += c.charCodeAt(0);
  return n;
}
```

`packages/api-client/src/mock/seed.ts`:

```ts
import type { Band, BandMember, Session, Take, TakeComment } from "@bandapp/types";
import { seedOf, seededUnit } from "./rand";

export interface MockState {
  bands: Band[];
  members: Record<string, BandMember[]>;
  sessions: Session[];
  takes: Record<string, Take[]>; // sessionId -> takes
  comments: Record<string, TakeComment[]>; // takeId -> comments
}

export function generateTakes(sessionId: string, count: number): Take[] {
  const seed = seedOf(sessionId);
  return Array.from({ length: count }, (_, i) => ({
    id: `${sessionId}-t${i}`,
    sessionId,
    index: i,
    name: `Take ${i + 1}`,
    durationSec: 180 + Math.floor(seededUnit(seed * 91 + i * 17) * 150),
    commentCount: 0,
  }));
}

const session = (
  id: string,
  startedAt: string,
  durationSec: number,
  takeCount: number,
  status: Session["status"],
  name?: string,
): Session => ({
  id,
  bandId: "b1",
  title: titleFor(startedAt),
  name,
  status,
  startedAt,
  durationSec,
  takeCount,
  commentCount: 0,
});

function titleFor(startedAt: string): string {
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const d = new Date(startedAt);
  return `${MONTHS[d.getMonth()]} ${d.getDate()} Rehearsal`;
}

const SEED_COMMENTS: Record<string, Array<{ who: string; t: number; text: string }>> = {
  "s1-t0": [
    { who: "Suhyun", t: 28, text: "Drums a bit loud in the intro?" },
    { who: "Minsu", t: 133, text: "Rushing going into the chorus" },
    { who: "Jihoon", t: 182, text: "Guitar tone is great here" },
  ],
  "s1-t1": [{ who: "Jihoon", t: 95, text: "This one felt tight — keep this arrangement" }],
  "s1-t3": [
    { who: "Minsu", t: 62, text: "Bass and kick drifting apart here" },
    { who: "Suhyun", t: 201, text: "Nice ending" },
  ],
  "s1-t5": [{ who: "Dongjin", t: 148, text: "Best run of the night" }],
  "s2-t1": [
    { who: "Minsu", t: 88, text: "Second verse harmony works" },
    { who: "Jihoon", t: 190, text: "Bridge still shaky — slow it down next time" },
  ],
  "s2-t4": [
    { who: "Dongjin", t: 15, text: "Count-in was off" },
    { who: "Suhyun", t: 120, text: "Check tuning before this one" },
  ],
};

export function createSeedState(): MockState {
  const sessions = [
    session("p1", "2026-08-29T18:47:00", 4620, 0, "analyzing"),
    session("f1", "2026-08-28T15:30:00", 4320, 0, "failed"),
    session("s1", "2026-08-27T19:03:00", 8040, 7, "ready", "Full set run-through"),
    session("s2", "2026-08-20T20:11:00", 6480, 5, "ready"),
    session("s3", "2026-08-13T19:42:00", 9060, 9, "ready"),
  ];
  const takes: MockState["takes"] = {};
  for (const s of sessions) if (s.status === "ready") takes[s.id] = generateTakes(s.id, s.takeCount);
  // 프로토타입 고정값: s1 테이크 1·2번 길이
  takes["s1"][0].durationSec = 272;
  takes["s1"][1].durationSec = 268;

  const comments: MockState["comments"] = {};
  let cid = 0;
  for (const [takeId, rows] of Object.entries(SEED_COMMENTS)) {
    comments[takeId] = rows.map((r) => ({
      id: `c${cid++}`,
      takeId,
      authorName: r.who,
      atSec: r.t,
      text: r.text,
    }));
  }
  // commentCount 반영
  for (const list of Object.values(takes)) {
    for (const t of list) t.commentCount = comments[t.id]?.length ?? 0;
  }
  for (const s of sessions) {
    s.commentCount = (takes[s.id] ?? []).reduce((a, t) => a + t.commentCount, 0);
  }

  return {
    bands: [{ id: "b1", name: "FRIDAY NIGHT", memberCount: 4, inviteCode: "X7K2F9" }],
    members: {
      b1: [
        { id: "m1", name: "Dongjin Kim", role: "owner" },
        { id: "m2", name: "Minsu", role: "member" },
        { id: "m3", name: "Jihoon", role: "member" },
        { id: "m4", name: "Suhyun", role: "member" },
      ],
    },
    sessions,
    takes,
    comments,
  };
}
```

`packages/api-client/src/mock/MockApiClient.ts`:

```ts
import type { Band, BandMember, Session, Take, TakeComment } from "@bandapp/types";
import type { CreateCommentInput, CreateSessionInput, RehearsalApiClient } from "../client";
import { seededUnit } from "./rand";
import { createSeedState, generateTakes, type MockState } from "./seed";

export class MockApiClient implements RehearsalApiClient {
  private state: MockState = createSeedState();
  private listeners = new Set<() => void>();
  private analysisDelayMs: number;
  private nextId = 1;

  constructor(opts?: { analysisDelayMs?: number }) {
    this.analysisDelayMs = opts?.analysisDelayMs ?? 4000;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  private mustSession(id: string): Session {
    const s = this.state.sessions.find((x) => x.id === id);
    if (!s) throw new Error(`session not found: ${id}`);
    return s;
  }

  private scheduleAnalysis(sessionId: string) {
    setTimeout(() => {
      const s = this.state.sessions.find((x) => x.id === sessionId);
      if (!s || s.status !== "analyzing") return;
      const count = Math.max(1, Math.min(9, Math.round(s.durationSec / 900)));
      const takes = generateTakes(s.id, count);
      const base = Math.min(300, s.durationSec / count);
      takes.forEach((t, i) => {
        t.durationSec = Math.max(4, Math.round(base * (0.55 + 0.8 * seededUnit(i * 31 + 7))));
      });
      this.state.takes[s.id] = takes;
      s.status = "ready";
      s.takeCount = takes.length;
      this.emit();
    }, this.analysisDelayMs);
  }

  bands = {
    list: async (): Promise<Band[]> => [...this.state.bands],
    members: async (bandId: string): Promise<BandMember[]> => [...(this.state.members[bandId] ?? [])],
    inviteLink: async (bandId: string): Promise<string> => {
      const band = this.state.bands.find((b) => b.id === bandId);
      if (!band) throw new Error(`band not found: ${bandId}`);
      return `band.app/join/${band.inviteCode}`;
    },
  };

  sessions = {
    list: async (bandId: string): Promise<Session[]> =>
      this.state.sessions
        .filter((s) => s.bandId === bandId)
        .slice()
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    get: async (id: string): Promise<Session> => ({ ...this.mustSession(id) }),
    create: async (bandId: string, input: CreateSessionInput): Promise<Session> => {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const startedAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:00`;
      const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const s: Session = {
        id: `g${this.nextId++}`,
        bandId,
        title: `${MONTHS[now.getMonth()]} ${now.getDate()} Rehearsal`,
        status: "analyzing",
        startedAt,
        durationSec: Math.round(input.durationSec),
        takeCount: 0,
        commentCount: 0,
      };
      this.state.sessions.unshift(s);
      this.scheduleAnalysis(s.id);
      this.emit();
      return { ...s };
    },
    retryAnalysis: async (id: string): Promise<Session> => {
      const s = this.mustSession(id);
      s.status = "analyzing";
      this.scheduleAnalysis(s.id);
      this.emit();
      return { ...s };
    },
  };

  takes = {
    list: async (sessionId: string): Promise<Take[]> =>
      (this.state.takes[sessionId] ?? []).map((t) => ({ ...t })),
  };

  comments = {
    list: async (takeId: string): Promise<TakeComment[]> =>
      (this.state.comments[takeId] ?? []).slice().sort((a, b) => a.atSec - b.atSec),
    create: async (takeId: string, input: CreateCommentInput): Promise<TakeComment> => {
      const c: TakeComment = {
        id: `u${this.nextId++}`,
        takeId,
        authorName: "You",
        atSec: Math.floor(input.atSec),
        text: input.text,
      };
      (this.state.comments[takeId] ??= []).push(c);
      for (const takes of Object.values(this.state.takes)) {
        const take = takes.find((t) => t.id === takeId);
        if (take) {
          take.commentCount += 1;
          const s = this.state.sessions.find((x) => x.id === take.sessionId);
          if (s) s.commentCount += 1;
        }
      }
      this.emit();
      return { ...c };
    },
  };
}
```

`packages/api-client/src/index.ts` 전체 교체:

```ts
export * from "./client";
export { MockApiClient } from "./mock/MockApiClient";
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `pnpm --filter @bandapp/api-client exec vitest run`
Expected: 5 tests PASS

- [ ] **Step 6: 빌드 확인**

Run: `pnpm turbo build --filter @bandapp/api-client`
Expected: types → api-client 순서로 빌드 성공

- [ ] **Step 7: Commit**

```bash
git add packages/api-client pnpm-lock.yaml
git commit -m "feat(api-client): add RehearsalApiClient interface and MockApiClient with seed data"
```

---

### Task 3: 모바일 expo-router 부트스트랩

**Files:**
- Create: `apps/mobile/app/_layout.tsx`
- Create: `apps/mobile/app/index.tsx` (임시 자리표시 — Task 9에서 삭제)
- Modify: `apps/mobile/package.json`, `apps/mobile/app.json`, `apps/mobile/tsconfig.json`
- Delete: `apps/mobile/App.tsx`, `apps/mobile/index.ts`

**Interfaces:**
- Consumes: 없음 (theme은 Task 4에서 연결)
- Produces: `@/` → `apps/mobile/src/` path alias, expo-router 동작하는 앱 셸

- [ ] **Step 1: 의존성 설치**

`apps/mobile`에서 실행 (expo install이 SDK 57 호환 버전을 고정):

```bash
cd apps/mobile
npx expo install expo-router react-native-safe-area-context react-native-screens expo-linking expo-constants expo-font expo-clipboard
```

이어서 워크스페이스·폰트 의존성:

```bash
pnpm --filter mobile add "@bandapp/types@workspace:*" "@bandapp/api-client@workspace:*" @expo-google-fonts/jetbrains-mono
```

- [ ] **Step 2: 엔트리·앱 설정 변경**

`apps/mobile/package.json`: `"main": "index.ts"` → `"main": "expo-router/entry"`. 그 후 `App.tsx`, `index.ts` 삭제.

`apps/mobile/app.json` expo 객체에 추가/변경:

```json
"scheme": "bandapp",
"userInterfaceStyle": "dark",
"plugins": ["expo-router"]
```

`apps/mobile/tsconfig.json`:

```json
{
  "extends": "expo/tsconfig.base",
  "compilerOptions": {
    "strict": true,
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  }
}
```

- [ ] **Step 3: 루트 레이아웃 + 임시 인덱스**

`apps/mobile/app/_layout.tsx`:

```tsx
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

export default function RootLayout() {
  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: "#0B0C0E" }, // Task 4에서 토큰으로 교체
        }}
      />
    </>
  );
}
```

`apps/mobile/app/index.tsx`:

```tsx
import { Text, View } from "react-native";

export default function Placeholder() {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color: "#F2F3F5" }}>bandapp</Text>
    </View>
  );
}
```

- [ ] **Step 4: 타입체크 + 기동 확인**

Run: `pnpm --filter mobile typecheck`
Expected: 에러 없음

Run: `cd apps/mobile; npx expo start --web` (수 초 후 종료)
Expected: 번들 성공, 웹에서 "bandapp" 표시. 실패 시 로그 확인 후 수정.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile pnpm-lock.yaml
git commit -m "feat(mobile): bootstrap expo-router with root layout"
```

---

### Task 4: 디자인 토큰 + ThemeProvider

**Files:**
- Create: `apps/mobile/src/theme/tokens.ts`
- Create: `apps/mobile/src/theme/ThemeProvider.tsx`
- Create: `apps/mobile/src/theme/index.ts`
- Modify: `apps/mobile/app/_layout.tsx` (Provider + 폰트 로딩 연결)

**Interfaces:**
- Consumes: Task 3의 앱 셸
- Produces:

```ts
// tokens.ts
export const color: { bg; bgDeep; surface; surfaceSunken; surfaceRaised; toastBg;
  border; borderStrong; borderStronger; borderHover;
  text; textSecondary; textMuted; textFaint; recording; danger }; // 전부 string
export const accentOptions: readonly ["#5B9DFF", "#4ADE80", "#FFB454", "#FF5C5C"];
export const font: { mono; monoMedium; monoSemiBold }; // 폰트 패밀리명
export const space: { screenX: 24; sheetX: 16; sheetTop: 14; sheetBottom: 44 };
export const radius: { chipSm: 9; input: 10; row: 12; chipLg: 16; sheet: 20 };
export const type: Record<TypeVariant, TextStyle>;
export type TypeVariant = "titleXL" | "title" | "heading" | "itemTitle" | "sheetTitle"
  | "rowTitle" | "body" | "caption" | "small" | "monoLabel" | "monoMeta" | "monoTimer" | "monoAvatar";
// ThemeProvider.tsx
export interface Theme { colors: typeof color & { accent: string }; accent: string; setAccent(hex: string): void; }
export function ThemeProvider(props: { children: ReactNode }): JSX.Element;
export function useTheme(): Theme;
```

- [ ] **Step 1: tokens.ts 작성**

`apps/mobile/src/theme/tokens.ts` (스펙의 디자인 토큰 표 그대로):

```ts
import type { TextStyle } from "react-native";

export const color = {
  bg: "#0B0C0E",
  bgDeep: "#08090A",
  surface: "#15171B",
  surfaceSunken: "#0F1114",
  surfaceRaised: "#1A1C20",
  toastBg: "#22252B",
  border: "#1D2025",
  borderStrong: "#23262B",
  borderStronger: "#2A2D33",
  borderHover: "#3A3E45",
  text: "#F2F3F5",
  textSecondary: "#C6CAD1",
  textMuted: "#8A8F98",
  textFaint: "#5A5F68",
  recording: "#FF4545",
  danger: "#E0736B",
} as const;

export const accentOptions = ["#5B9DFF", "#4ADE80", "#FFB454", "#FF5C5C"] as const;

export const font = {
  mono: "JetBrainsMono_400Regular",
  monoMedium: "JetBrainsMono_500Medium",
  monoSemiBold: "JetBrainsMono_600SemiBold",
} as const;

export const space = { screenX: 24, sheetX: 16, sheetTop: 14, sheetBottom: 44 } as const;

export const radius = { chipSm: 9, input: 10, row: 12, chipLg: 16, sheet: 20 } as const;

export type TypeVariant =
  | "titleXL" | "title" | "heading" | "itemTitle" | "sheetTitle" | "rowTitle"
  | "body" | "caption" | "small"
  | "monoLabel" | "monoMeta" | "monoTimer" | "monoAvatar";

export const type: Record<TypeVariant, TextStyle> = {
  titleXL: { fontSize: 32, fontWeight: "700", letterSpacing: -0.3, color: color.text },
  title: { fontSize: 26, fontWeight: "700", letterSpacing: -0.3, color: color.text },
  heading: { fontSize: 22, fontWeight: "700", color: color.text },
  itemTitle: { fontSize: 20, fontWeight: "600", letterSpacing: -0.2, color: color.text },
  sheetTitle: { fontSize: 17, fontWeight: "600", color: color.text },
  rowTitle: { fontSize: 15, fontWeight: "600", color: color.text },
  body: { fontSize: 14, color: color.textSecondary },
  caption: { fontSize: 13, color: color.textMuted },
  small: { fontSize: 12, color: color.textFaint },
  monoLabel: { fontFamily: font.mono, fontSize: 11, letterSpacing: 1.5, color: color.textFaint },
  monoMeta: { fontFamily: font.mono, fontSize: 12, color: color.textMuted },
  monoTimer: { fontFamily: font.monoMedium, fontSize: 52, letterSpacing: 1.5, color: color.text },
  monoAvatar: { fontFamily: font.mono, fontSize: 14, color: color.textSecondary },
};
```

- [ ] **Step 2: ThemeProvider.tsx + index.ts 작성**

`apps/mobile/src/theme/ThemeProvider.tsx`:

```tsx
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { accentOptions, color } from "./tokens";

export interface Theme {
  colors: typeof color & { accent: string };
  accent: string;
  setAccent: (hex: string) => void;
}

const ThemeContext = createContext<Theme | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [accent, setAccent] = useState<string>(accentOptions[0]);
  const value = useMemo<Theme>(
    () => ({ colors: { ...color, accent }, accent, setAccent }),
    [accent],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const t = useContext(ThemeContext);
  if (!t) throw new Error("useTheme must be used within ThemeProvider");
  return t;
}
```

`apps/mobile/src/theme/index.ts`:

```ts
export * from "./tokens";
export * from "./ThemeProvider";
```

- [ ] **Step 3: _layout.tsx에 Provider + 폰트 연결**

`apps/mobile/app/_layout.tsx` 전체 교체:

```tsx
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
  JetBrainsMono_600SemiBold,
  useFonts,
} from "@expo-google-fonts/jetbrains-mono";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ThemeProvider, color } from "@/theme";

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
    JetBrainsMono_600SemiBold,
  });
  if (!fontsLoaded) return null;
  return (
    <ThemeProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: color.bg },
        }}
      />
    </ThemeProvider>
  );
}
```

- [ ] **Step 4: 타입체크**

Run: `pnpm --filter mobile typecheck`
Expected: 에러 없음

- [ ] **Step 5: Commit**

```bash
git add apps/mobile
git commit -m "feat(mobile): add design tokens and ThemeProvider with swappable accent"
```

---

### Task 5: lib 유틸 (time, seed) — TDD

**Files:**
- Create: `apps/mobile/src/lib/time.ts`
- Create: `apps/mobile/src/lib/time.test.ts`
- Create: `apps/mobile/src/lib/seed.ts`
- Modify: `apps/mobile/package.json` (vitest)

**Interfaces:**
- Consumes: 없음 (순수 TS)
- Produces:

```ts
// time.ts — 전부 로컬시각 ISO(Z 없음) 입력
export function fmtClock(totalSec: number): string;        // 272 → "04:32", 8040 → "2:14:00"
export function fmtDuration(sec: number): string;          // 8040 → "2h 14m", 320 → "5m 20s", 45 → "45s"
export function startLabel(startedAtIso: string): string;  // "19:03"
export function clockRange(startedAtIso: string, durationSec: number): string; // "19:03 – 21:17"
export function dateLabel(startedAtIso: string): string;   // "AUG 27 · THU"
export function monthLabel(startedAtIso: string): string;  // "AUGUST 2026"
// seed.ts
export function seededUnit(x: number): number;             // 0..1 결정적
export function seedOf(id: string): number;
```

- [ ] **Step 1: vitest 설치**

```bash
pnpm --filter mobile add -D vitest
```

`apps/mobile/package.json` scripts에 추가: `"test": "vitest run src/lib"`
(src/lib만 — RN 컴포넌트는 vitest 대상 아님)

- [ ] **Step 2: 실패하는 테스트 작성**

`apps/mobile/src/lib/time.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { clockRange, dateLabel, fmtClock, fmtDuration, monthLabel, startLabel } from "./time";

describe("time", () => {
  it("fmtClock", () => {
    expect(fmtClock(0)).toBe("00:00");
    expect(fmtClock(272)).toBe("04:32");
    expect(fmtClock(8040)).toBe("2:14:00");
  });
  it("fmtDuration", () => {
    expect(fmtDuration(45)).toBe("45s");
    expect(fmtDuration(320)).toBe("5m 20s");
    expect(fmtDuration(8040)).toBe("2h 14m");
  });
  it("labels from local ISO", () => {
    expect(startLabel("2026-08-27T19:03:00")).toBe("19:03");
    expect(dateLabel("2026-08-27T19:03:00")).toBe("AUG 27 · THU");
    expect(monthLabel("2026-08-27T19:03:00")).toBe("AUGUST 2026");
    expect(clockRange("2026-08-27T19:03:00", 8040)).toBe("19:03 – 21:17");
  });
  it("clockRange wraps past midnight", () => {
    expect(clockRange("2026-08-27T23:30:00", 3600)).toBe("23:30 – 00:30");
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `pnpm --filter mobile exec vitest run src/lib`
Expected: FAIL — `./time` 모듈 없음

- [ ] **Step 4: 구현**

`apps/mobile/src/lib/time.ts`:

```ts
const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS_SHORT = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const MONTHS_LONG = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

export function fmtClock(totalSec: number): string {
  const t = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

export function startLabel(startedAtIso: string): string {
  const d = new Date(startedAtIso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function clockRange(startedAtIso: string, durationSec: number): string {
  const d = new Date(startedAtIso);
  const total = (d.getHours() * 60 + d.getMinutes() + Math.round(durationSec / 60)) % 1440;
  return `${startLabel(startedAtIso)} – ${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

export function dateLabel(startedAtIso: string): string {
  const d = new Date(startedAtIso);
  return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()} · ${WEEKDAYS[d.getDay()]}`;
}

export function monthLabel(startedAtIso: string): string {
  const d = new Date(startedAtIso);
  return `${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`;
}
```

`apps/mobile/src/lib/seed.ts` (프로토타입 웨이브폼용 결정적 난수 — api-client mock의 rand.ts와 같은 공식):

```ts
export function seededUnit(x: number): number {
  const s = Math.sin(x) * 43758.5453;
  return s - Math.floor(s);
}

export function seedOf(id: string): number {
  let n = 0;
  for (const c of id) n += c.charCodeAt(0);
  return n;
}
```

- [ ] **Step 5: 통과 확인 + 커밋**

Run: `pnpm --filter mobile exec vitest run src/lib`
Expected: 4 tests PASS

```bash
git add apps/mobile
git commit -m "feat(mobile): add time formatting and seeded random utils"
```

---

### Task 6: UI 기본 컴포넌트 (텍스트·서피스·소형)

**Files:**
- Create: `apps/mobile/src/ui/AppText.tsx`, `MonoLabel.tsx`, `PressableOpacity.tsx`, `Screen.tsx`, `Chip.tsx`, `Avatar.tsx`, `IconCircle.tsx`, `StatusDot.tsx`, `ProgressBar.tsx`
- Create: `apps/mobile/src/ui/index.ts`

**Interfaces:**
- Consumes: Task 4 theme (`useTheme`, `type`, `color`, `radius`, `space`, `font`), Task 5 없음
- Produces (모든 컴포넌트는 `@/ui`에서 named export):

```ts
AppText: { variant?: TypeVariant /* 기본 "body" */; color?: string; style?; children; numberOfLines? }
MonoLabel: { children; color?: string; style? }                  // monoLabel 변형 축약
PressableOpacity: PressableProps & { activeOpacity?: number }    // 기본 0.6
Screen: { children; style?; padTop?: boolean /* 기본 true: insets.top+8 패딩 */ }
Chip: { label: string; onPress?; size?: "sm" | "lg"; mono?: boolean; trailing?: ReactNode; style? }
Avatar: { label: string; size?: number /* 기본 40 */; dashed?: boolean }
IconCircle: { children; size?: number /* 기본 44 */ }
StatusDot: { color: string; size?: number /* 기본 6 */; pulse?: boolean /* 기본 true */ }
ProgressBar: { progress: number /* 0..1 */; width?: number /* 기본 240 */ }
```

- [ ] **Step 1: 텍스트·프레서블 구현**

`apps/mobile/src/ui/AppText.tsx`:

```tsx
import { Text, type TextProps } from "react-native";
import { type TypeVariant, type } from "@/theme";

interface Props extends TextProps {
  variant?: TypeVariant;
  color?: string;
}

export function AppText({ variant = "body", color, style, ...rest }: Props) {
  return <Text {...rest} style={[type[variant], color ? { color } : null, style]} />;
}
```

주의: `type`은 예약어와 겹치므로 import 충돌 시 `import { type as typeScale }`로 별칭.

`apps/mobile/src/ui/MonoLabel.tsx`:

```tsx
import type { StyleProp, TextStyle } from "react-native";
import { AppText } from "./AppText";

export function MonoLabel({
  children,
  color,
  style,
}: {
  children: React.ReactNode;
  color?: string;
  style?: StyleProp<TextStyle>;
}) {
  return (
    <AppText variant="monoLabel" color={color} style={style}>
      {children}
    </AppText>
  );
}
```

`apps/mobile/src/ui/PressableOpacity.tsx`:

```tsx
import { Pressable, type PressableProps } from "react-native";

interface Props extends PressableProps {
  activeOpacity?: number;
}

export function PressableOpacity({ activeOpacity = 0.6, style, ...rest }: Props) {
  return (
    <Pressable
      {...rest}
      style={(state) => [
        typeof style === "function" ? style(state) : style,
        state.pressed ? { opacity: activeOpacity } : null,
      ]}
    />
  );
}
```

- [ ] **Step 2: Screen·Chip·Avatar·IconCircle 구현**

`apps/mobile/src/ui/Screen.tsx`:

```tsx
import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "@/theme";

export function Screen({
  children,
  style,
  padTop = true,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  padTop?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  return (
    <View
      style={[
        { flex: 1, backgroundColor: colors.bg, paddingTop: padTop ? insets.top + 8 : 0 },
        style,
      ]}
    >
      {children}
    </View>
  );
}
```

참고: SafeAreaProvider는 Task 9에서 루트 레이아웃에 추가한다 (expo-router가 기본 제공하지 않는 경우). `react-native-safe-area-context`의 `SafeAreaProvider`로 `_layout.tsx`의 ThemeProvider 바깥을 감싼다 — Task 9 Step 1에 포함되어 있으나, 이 Task에서 typecheck만 하므로 지금은 불필요.

`apps/mobile/src/ui/Chip.tsx`:

```tsx
import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { radius, useTheme } from "@/theme";
import { AppText } from "./AppText";
import { PressableOpacity } from "./PressableOpacity";

export function Chip({
  label,
  onPress,
  size = "sm",
  mono = false,
  trailing,
  style,
}: {
  label: string;
  onPress?: () => void;
  size?: "sm" | "lg";
  mono?: boolean;
  trailing?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  const lg = size === "lg";
  return (
    <PressableOpacity
      onPress={onPress}
      disabled={!onPress}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          alignSelf: "flex-start",
          borderWidth: 1,
          borderColor: colors.borderStrong,
          borderRadius: lg ? radius.chipLg : radius.chipSm,
          paddingVertical: lg ? 7 : 9,
          paddingHorizontal: lg ? 12 : 14,
        },
        style,
      ]}
    >
      <AppText
        variant={mono ? "monoLabel" : "caption"}
        color={colors.textSecondary}
        style={mono ? { letterSpacing: 1.8 } : { fontSize: 13 }}
      >
        {label}
      </AppText>
      {trailing}
    </PressableOpacity>
  );
}
```

디자인 대응: 밴드 전환 칩(size "lg", mono, trailing ▼) / 액션 칩 "Original recording" 등(size "sm").

`apps/mobile/src/ui/Avatar.tsx`:

```tsx
import { View } from "react-native";
import { useTheme } from "@/theme";
import { AppText } from "./AppText";

export function Avatar({
  label,
  size = 40,
  dashed = false,
}: {
  label: string;
  size?: number;
  dashed?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: dashed ? undefined : colors.surfaceRaised,
        borderWidth: dashed ? 1 : 0,
        borderStyle: dashed ? "dashed" : undefined,
        borderColor: colors.borderStronger,
      }}
    >
      <AppText variant="monoAvatar" color={dashed ? colors.textMuted : colors.textSecondary}>
        {label}
      </AppText>
    </View>
  );
}
```

`apps/mobile/src/ui/IconCircle.tsx`:

```tsx
import type { ReactNode } from "react";
import { View } from "react-native";
import { useTheme } from "@/theme";

export function IconCircle({ children, size = 44 }: { children: ReactNode; size?: number }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: 1,
        borderColor: colors.borderStronger,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {children}
    </View>
  );
}
```

- [ ] **Step 3: StatusDot·ProgressBar 구현**

`apps/mobile/src/ui/StatusDot.tsx` (프로토타입 recpulse 1.4~1.6s 대응):

```tsx
import { useEffect, useRef } from "react";
import { Animated, Easing } from "react-native";

export function StatusDot({
  color,
  size = 6,
  pulse = true,
}: {
  color: string;
  size?: number;
  pulse?: boolean;
}) {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!pulse) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.25, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, opacity]);
  return (
    <Animated.View
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity }}
    />
  );
}
```

`apps/mobile/src/ui/ProgressBar.tsx`:

```tsx
import { View } from "react-native";
import { useTheme } from "@/theme";

export function ProgressBar({ progress, width = 240 }: { progress: number; width?: number }) {
  const { colors } = useTheme();
  const pct = Math.max(0, Math.min(1, progress)) * 100;
  return (
    <View style={{ width, height: 4, borderRadius: 2, backgroundColor: colors.toastBg, overflow: "hidden" }}>
      <View style={{ width: `${pct}%`, height: "100%", borderRadius: 2, backgroundColor: colors.accent }} />
    </View>
  );
}
```

`apps/mobile/src/ui/index.ts`:

```ts
export * from "./AppText";
export * from "./MonoLabel";
export * from "./PressableOpacity";
export * from "./Screen";
export * from "./Chip";
export * from "./Avatar";
export * from "./IconCircle";
export * from "./StatusDot";
export * from "./ProgressBar";
```

- [ ] **Step 4: 타입체크 + 커밋**

Run: `pnpm --filter mobile typecheck`
Expected: 에러 없음

```bash
git add apps/mobile/src/ui
git commit -m "feat(mobile): add core ui primitives (text, chip, avatar, dots, progress)"
```

---

### Task 7: UI 오버레이·웨이브폼 컴포넌트

**Files:**
- Create: `apps/mobile/src/ui/BottomSheet.tsx`, `SheetActionRow.tsx`, `Toast.tsx`, `Fab.tsx`, `TabBar.tsx`, `StaticWaveform.tsx`, `LiveWaveform.tsx`, `PlayerWaveform.tsx`
- Modify: `apps/mobile/src/ui/index.ts` (export 추가)

**Interfaces:**
- Consumes: Task 4 theme, Task 5 `seededUnit`/`seedOf`, Task 6 primitives
- Produces:

```ts
BottomSheet: { visible: boolean; onClose(): void; title?: string; subtitle?: string; children }
SheetActionRow: { icon: ReactNode; title: string; subtitle?: string; onPress(): void; trailing?: ReactNode }
ToastProvider: { children }   // _layout에서 감쌈
useToast(): { show(message: string): void }   // 1.8초 후 자동 제거
Fab: { onPress(): void }      // 60px accent 원, "+"
TabBar: { active: "sessions" | "band"; onPressSessions(): void; onPressBand(): void; onPressFab(): void }
StaticWaveform: { seed: number; bars?: number /*36*/; height?: number /*26*/; color?: string /*borderHover*/ }
LiveWaveform: { bars?: number /*34*/; height?: number /*72*/ }
PlayerWaveform: { seed: number; durationSec: number; positionSec: number; markers?: number[] /*atSec*/; onSeek(sec: number): void; height?: number /*88*/ }
```

- [ ] **Step 1: BottomSheet + SheetActionRow**

`apps/mobile/src/ui/BottomSheet.tsx` (프로토타입: 딤 배경 + 상단 라운드 20 + 핸들 36×4):

```tsx
import type { ReactNode } from "react";
import { Modal, Pressable, View } from "react-native";
import { radius, space, useTheme } from "@/theme";
import { AppText } from "./AppText";

export function BottomSheet({
  visible,
  onClose,
  title,
  subtitle,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)" }} onPress={onClose} />
      <View
        style={{
          backgroundColor: colors.surface,
          borderTopLeftRadius: radius.sheet,
          borderTopRightRadius: radius.sheet,
          paddingTop: space.sheetTop,
          paddingHorizontal: space.sheetX,
          paddingBottom: space.sheetBottom,
        }}
      >
        <View
          style={{
            width: 36,
            height: 4,
            borderRadius: 2,
            backgroundColor: colors.borderStronger,
            alignSelf: "center",
            marginBottom: 18,
          }}
        />
        {title ? (
          <AppText variant="sheetTitle" style={{ paddingHorizontal: 8, paddingBottom: subtitle ? 0 : 12 }}>
            {title}
          </AppText>
        ) : null}
        {subtitle ? (
          <AppText variant="caption" style={{ paddingHorizontal: 8, paddingTop: 4, paddingBottom: 12 }}>
            {subtitle}
          </AppText>
        ) : null}
        {children}
      </View>
    </Modal>
  );
}
```

`apps/mobile/src/ui/SheetActionRow.tsx`:

```tsx
import type { ReactNode } from "react";
import { View } from "react-native";
import { radius, useTheme } from "@/theme";
import { AppText } from "./AppText";
import { PressableOpacity } from "./PressableOpacity";

export function SheetActionRow({
  icon,
  title,
  subtitle,
  onPress,
  trailing,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  onPress: () => void;
  trailing?: ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <PressableOpacity
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        paddingVertical: 14,
        paddingHorizontal: 12,
        borderRadius: radius.row,
      }}
    >
      {icon}
      <View style={{ flex: 1 }}>
        <AppText variant="rowTitle">{title}</AppText>
        {subtitle ? (
          <AppText variant="caption" style={{ marginTop: 2 }}>
            {subtitle}
          </AppText>
        ) : null}
      </View>
      {trailing ?? null}
    </PressableOpacity>
  );
}
```

- [ ] **Step 2: Toast (Provider + Hook)**

`apps/mobile/src/ui/Toast.tsx`:

```tsx
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { View } from "react-native";
import { radius, useTheme } from "@/theme";
import { AppText } from "./AppText";

const ToastContext = createContext<{ show: (message: string) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { colors } = useTheme();
  const show = useCallback((msg: string) => {
    if (timer.current) clearTimeout(timer.current);
    setMessage(msg);
    timer.current = setTimeout(() => setMessage(""), 1800);
  }, []);
  const value = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      {message ? (
        <View
          pointerEvents="none"
          style={{ position: "absolute", left: 0, right: 0, bottom: 112, alignItems: "center", zIndex: 40 }}
        >
          <View
            style={{
              backgroundColor: colors.toastBg,
              borderRadius: radius.input,
              paddingVertical: 10,
              paddingHorizontal: 16,
            }}
          >
            <AppText variant="caption" color="#E8EAEE">
              {message}
            </AppText>
          </View>
        </View>
      ) : null}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const t = useContext(ToastContext);
  if (!t) throw new Error("useToast must be used within ToastProvider");
  return t;
}
```

참고: `#E8EAEE`는 토스트 전용 텍스트 색 — tokens.ts `color`에 `toastText: "#E8EAEE"`를 추가하고 여기서 `colors.toastText`를 쓴다 (Global Constraints의 토큰 규칙 준수).

- [ ] **Step 3: Fab + TabBar**

`apps/mobile/src/ui/Fab.tsx`:

```tsx
import { useTheme } from "@/theme";
import { AppText } from "./AppText";
import { PressableOpacity } from "./PressableOpacity";

export function Fab({ onPress }: { onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <PressableOpacity
      onPress={onPress}
      style={{
        width: 60,
        height: 60,
        borderRadius: 30,
        backgroundColor: colors.accent,
        alignItems: "center",
        justifyContent: "center",
        shadowColor: "#000",
        shadowOpacity: 0.45,
        shadowRadius: 18,
        shadowOffset: { width: 0, height: 4 },
        elevation: 8,
      }}
    >
      <AppText style={{ color: colors.bg, fontSize: 28, fontWeight: "300", lineHeight: 32 }}>+</AppText>
    </PressableOpacity>
  );
}
```

`apps/mobile/src/ui/TabBar.tsx` (프로토타입: 3열 그리드, 중앙 FAB가 바 위로 돌출 + 노치 원):

```tsx
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { font, useTheme } from "@/theme";
import { AppText } from "./AppText";
import { Fab } from "./Fab";
import { PressableOpacity } from "./PressableOpacity";

export function TabBar({
  active,
  onPressSessions,
  onPressBand,
  onPressFab,
}: {
  active: "sessions" | "band";
  onPressSessions: () => void;
  onPressBand: () => void;
  onPressFab: () => void;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const label = (text: string, isActive: boolean, onPress: () => void) => (
    <PressableOpacity onPress={onPress} style={{ padding: 12 }}>
      <AppText
        style={{
          fontFamily: font.mono,
          fontSize: 11,
          letterSpacing: 1.5,
          color: isActive ? colors.text : colors.textFaint,
        }}
      >
        {text}
      </AppText>
    </PressableOpacity>
  );
  return (
    <View
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        paddingTop: 12,
        paddingBottom: insets.bottom + 16,
        flexDirection: "row",
        alignItems: "center",
        borderTopWidth: 1,
        borderTopColor: colors.surfaceRaised,
        backgroundColor: "rgba(11,12,14,0.92)",
      }}
    >
      <View style={{ flex: 1, alignItems: "center" }}>{label("SESSIONS", active === "sessions", onPressSessions)}</View>
      <View style={{ width: 84, height: 54, alignItems: "center" }}>
        <View
          style={{
            position: "absolute",
            top: -42,
            width: 84,
            height: 84,
            borderRadius: 42,
            backgroundColor: colors.bg,
            borderWidth: 1,
            borderColor: colors.surfaceRaised,
          }}
        />
        <View style={{ position: "absolute", top: -30 }}>
          <Fab onPress={onPressFab} />
        </View>
      </View>
      <View style={{ flex: 1, alignItems: "center" }}>{label("BAND", active === "band", onPressBand)}</View>
    </View>
  );
}
```

참고: `rgba(11,12,14,0.92)`는 탭바 전용 반투명 배경 — tokens.ts `color`에 `tabBarBg: "rgba(11,12,14,0.92)"` 추가 후 `colors.tabBarBg` 사용.

- [ ] **Step 4: 웨이브폼 3종**

`apps/mobile/src/ui/StaticWaveform.tsx`:

```tsx
import { View } from "react-native";
import { seededUnit } from "@/lib/seed";
import { useTheme } from "@/theme";

export function StaticWaveform({
  seed,
  bars = 36,
  height = 26,
  color,
}: {
  seed: number;
  bars?: number;
  height?: number;
  color?: string;
}) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 2, height }}>
      {Array.from({ length: bars }, (_, i) => (
        <View
          key={i}
          style={{
            width: 2,
            borderRadius: 1,
            backgroundColor: color ?? colors.borderHover,
            height: Math.max(2, Math.round((0.12 + 0.88 * seededUnit(seed * 97 + i * 13)) * height)),
          }}
        />
      ))}
    </View>
  );
}
```

`apps/mobile/src/ui/LiveWaveform.tsx` (프로토타입 wavebar: 막대별 다른 주기·위상으로 scaleY 반복):

```tsx
import { useEffect, useRef } from "react";
import { Animated, Easing, View } from "react-native";
import { seededUnit } from "@/lib/seed";
import { useTheme } from "@/theme";

function Bar({ index, height }: { index: number; height: number }) {
  const { colors } = useTheme();
  const scale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const duration = (0.4 + seededUnit(index * 3.1) * 0.5) * 1000;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(scale, { toValue: 0.2, duration, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(scale, { toValue: 1, duration, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    const delay = setTimeout(() => loop.start(), seededUnit(index * 5.7) * 500);
    return () => {
      clearTimeout(delay);
      loop.stop();
    };
  }, [index, scale]);
  const barHeight = Math.round(14 + seededUnit(index * 7.3 + 2) * 56);
  return (
    <Animated.View
      style={{
        width: 3,
        borderRadius: 1.5,
        backgroundColor: colors.textSecondary,
        height: (barHeight / 72) * height,
        transform: [{ scaleY: scale }],
      }}
    />
  );
}

export function LiveWaveform({ bars = 34, height = 72 }: { bars?: number; height?: number }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 3, height }}>
      {Array.from({ length: bars }, (_, i) => (
        <Bar key={i} index={i} height={height} />
      ))}
    </View>
  );
}
```

`apps/mobile/src/ui/PlayerWaveform.tsx` (진행 색상 + 코멘트 마커 + 탭 시킹):

```tsx
import { View, type LayoutChangeEvent, type GestureResponderEvent } from "react-native";
import { useRef } from "react";
import { seededUnit } from "@/lib/seed";
import { useTheme } from "@/theme";

export function PlayerWaveform({
  seed,
  durationSec,
  positionSec,
  markers = [],
  onSeek,
  height = 88,
}: {
  seed: number;
  durationSec: number;
  positionSec: number;
  markers?: number[];
  onSeek: (sec: number) => void;
  height?: number;
}) {
  const { colors } = useTheme();
  const width = useRef(1);
  const bars = 64;
  const frac = durationSec ? positionSec / durationSec : 0;
  const onLayout = (e: LayoutChangeEvent) => {
    width.current = e.nativeEvent.layout.width;
  };
  const onPress = (e: GestureResponderEvent) => {
    const f = Math.max(0, Math.min(1, e.nativeEvent.locationX / width.current));
    onSeek(f * durationSec);
  };
  return (
    <View
      onLayout={onLayout}
      onStartShouldSetResponder={() => true}
      onResponderRelease={onPress}
      style={{ width: "100%", height: height + 12, justifyContent: "flex-end" }}
    >
      {markers.map((sec, i) => (
        <View
          key={`m${i}`}
          style={{
            position: "absolute",
            top: 0,
            left: `${(sec / durationSec) * 100}%`,
            width: 6,
            height: 6,
            borderRadius: 3,
            marginLeft: -3,
            backgroundColor: colors.accent,
          }}
        />
      ))}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 2, height }}>
        {Array.from({ length: bars }, (_, i) => (
          <View
            key={i}
            style={{
              flex: 1,
              borderRadius: 1,
              backgroundColor: i / bars <= frac ? colors.accent : colors.borderStronger,
              height: Math.max(3, Math.round((0.12 + 0.88 * seededUnit(seed * 97 + i * 13)) * height)),
            }}
          />
        ))}
      </View>
    </View>
  );
}
```

- [ ] **Step 5: tokens 추가 + index 갱신 + 타입체크**

`apps/mobile/src/theme/tokens.ts`의 `color`에 추가: `toastText: "#E8EAEE"`, `tabBarBg: "rgba(11,12,14,0.92)"`. Toast.tsx와 TabBar.tsx에서 리터럴 대신 토큰 사용으로 교체.

`apps/mobile/src/ui/index.ts`에 export 추가:

```ts
export * from "./BottomSheet";
export * from "./SheetActionRow";
export * from "./Toast";
export * from "./Fab";
export * from "./TabBar";
export * from "./StaticWaveform";
export * from "./LiveWaveform";
export * from "./PlayerWaveform";
```

Run: `pnpm --filter mobile typecheck`
Expected: 에러 없음

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src
git commit -m "feat(mobile): add overlay, tab bar, and waveform ui components"
```

---

### Task 8: ApiProvider + 데이터 훅

**Files:**
- Create: `apps/mobile/src/api/ApiProvider.tsx`
- Create: `apps/mobile/src/api/useApiData.ts`
- Create: `apps/mobile/src/api/index.ts`

**Interfaces:**
- Consumes: `RehearsalApiClient`, `MockApiClient` (Task 2)
- Produces:

```ts
ApiProvider: { client?: RehearsalApiClient /* 기본 new MockApiClient() */; children }
useApi(): RehearsalApiClient
useApiData<T>(load: (api: RehearsalApiClient) => Promise<T>, deps: unknown[]): { data: T | undefined; reload(): void }
// useApiData는 client.subscribe로 변경 통지를 받아 자동 reload한다
```

- [ ] **Step 1: 구현**

`apps/mobile/src/api/ApiProvider.tsx`:

```tsx
import { MockApiClient, type RehearsalApiClient } from "@bandapp/api-client";
import { createContext, useContext, useRef, type ReactNode } from "react";

const ApiContext = createContext<RehearsalApiClient | null>(null);

export function ApiProvider({
  client,
  children,
}: {
  client?: RehearsalApiClient;
  children: ReactNode;
}) {
  const defaultClient = useRef<RehearsalApiClient | null>(null);
  if (!client && !defaultClient.current) defaultClient.current = new MockApiClient();
  return (
    <ApiContext.Provider value={client ?? defaultClient.current}>{children}</ApiContext.Provider>
  );
}

export function useApi(): RehearsalApiClient {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi must be used within ApiProvider");
  return api;
}
```

`apps/mobile/src/api/useApiData.ts`:

```ts
import type { RehearsalApiClient } from "@bandapp/api-client";
import { useCallback, useEffect, useState } from "react";
import { useApi } from "./ApiProvider";

export function useApiData<T>(
  load: (api: RehearsalApiClient) => Promise<T>,
  deps: unknown[],
): { data: T | undefined; reload: () => void } {
  const api = useApi();
  const [data, setData] = useState<T | undefined>(undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const loadCb = useCallback(load, deps);
  const reload = useCallback(() => {
    let cancelled = false;
    loadCb(api).then((d) => {
      if (!cancelled) setData(d);
    });
    return () => {
      cancelled = true;
    };
  }, [api, loadCb]);
  useEffect(() => {
    const cancel = reload();
    const off = api.subscribe(() => reload());
    return () => {
      cancel();
      off();
    };
  }, [api, reload]);
  return { data, reload };
}
```

`apps/mobile/src/api/index.ts`:

```ts
export * from "./ApiProvider";
export * from "./useApiData";
```

- [ ] **Step 2: 타입체크 + 커밋**

Run: `pnpm --filter mobile typecheck`
Expected: 에러 없음

```bash
git add apps/mobile/src/api
git commit -m "feat(mobile): add ApiProvider and subscription-aware data hook"
```

---

### Task 9: Sessions 화면 + 탭 레이아웃

**Files:**
- Modify: `apps/mobile/app/_layout.tsx` (SafeAreaProvider·ApiProvider·ToastProvider 연결)
- Create: `apps/mobile/app/(tabs)/_layout.tsx`, `apps/mobile/app/(tabs)/index.tsx`, `apps/mobile/app/(tabs)/band.tsx` (임시 — Task 10에서 본체 연결)
- Delete: `apps/mobile/app/index.tsx` (Task 3의 자리표시 — `(tabs)/index.tsx`와 `/` 충돌)
- Create: `apps/mobile/src/features/sessions/SessionsScreen.tsx`, `SessionRow.tsx`, `NewSessionSheet.tsx`, `useSessions.ts`
- Create: `apps/mobile/src/features/band/useCurrentBand.ts`, `BandSwitchSheet.tsx` (band 도메인이지만 Sessions 화면이 소비 — 이 Task에서 생성)

**Interfaces:**
- Consumes: Task 6~8 전부, `fmtDuration`/`dateLabel`/`startLabel`/`monthLabel` (Task 5)
- Produces:

```ts
SessionsScreen(): JSX.Element                       // default export 아님, named
SessionRow: { session: Session; onPress(): void }
NewSessionSheet: { visible: boolean; onClose(): void }
useSessions(bandId: string | undefined): { data: Session[] | undefined; reload(): void }
useCurrentBand(): { band: Band | undefined }        // mock은 단일 밴드 — 첫 밴드 반환
BandSwitchSheet: { visible: boolean; onClose(): void }
```

- [ ] **Step 1: 루트 레이아웃에 Provider 연결**

`apps/mobile/app/_layout.tsx`의 return 부분을 다음 구조로 교체 (폰트 로딩 코드는 유지):

```tsx
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ApiProvider } from "@/api";
import { ToastProvider } from "@/ui";
// 기존 import 유지

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ApiProvider>
          <ToastProvider>
            <StatusBar style="light" />
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: color.bg },
              }}
            />
          </ToastProvider>
        </ApiProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
```

- [ ] **Step 2: band 도메인 선행 파일 2개**

`apps/mobile/src/features/band/useCurrentBand.ts`:

```ts
import { useApiData } from "@/api";

export function useCurrentBand() {
  const { data } = useApiData((api) => api.bands.list(), []);
  return { band: data?.[0] };
}
```

`apps/mobile/src/features/band/BandSwitchSheet.tsx`:

```tsx
import { View } from "react-native";
import { useTheme } from "@/theme";
import { AppText, Avatar, BottomSheet, SheetActionRow } from "@/ui";
import { useToast } from "@/ui";
import { useCurrentBand } from "./useCurrentBand";

export function BandSwitchSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { band } = useCurrentBand();
  const { colors } = useTheme();
  const toast = useToast();
  if (!band) return null;
  return (
    <BottomSheet visible={visible} onClose={onClose} title="Switch band">
      <SheetActionRow
        icon={<Avatar label={band.name[0]} size={44} />}
        title={band.name}
        subtitle={`${band.memberCount} members`}
        onPress={onClose}
        trailing={<AppText style={{ fontSize: 16, color: colors.accent }}>✓</AppText>}
      />
      <SheetActionRow
        icon={<Avatar label="+" size={44} dashed />}
        title="Create or join a band"
        onPress={() => {
          onClose();
          toast.show("Not in this prototype");
        }}
      />
      <View style={{ height: 0 }} />
    </BottomSheet>
  );
}
```

- [ ] **Step 3: sessions 피처 파일 4개**

`apps/mobile/src/features/sessions/useSessions.ts`:

```ts
import { useApiData } from "@/api";

export function useSessions(bandId: string | undefined) {
  return useApiData(async (api) => (bandId ? api.sessions.list(bandId) : []), [bandId]);
}
```

`apps/mobile/src/features/sessions/SessionRow.tsx`:

```tsx
import type { Session } from "@bandapp/types";
import { View } from "react-native";
import { dateLabel, fmtDuration, startLabel } from "@/lib/time";
import { useTheme } from "@/theme";
import { AppText, PressableOpacity, StatusDot } from "@/ui";

export function SessionRow({ session, onPress }: { session: Session; onPress: () => void }) {
  const { colors } = useTheme();
  const s = session;
  const ready = s.status === "ready";
  const primary = ready ? (s.name ?? `${s.takeCount} Takes`) : fmtDuration(s.durationSec);
  const commentLabel = s.commentCount
    ? `${s.commentCount} ${s.commentCount === 1 ? "comment" : "comments"}`
    : "No comments yet";
  const meta = `${s.name ? `${s.takeCount} Takes · ` : ""}${fmtDuration(s.durationSec)} · ${commentLabel}`;
  return (
    <PressableOpacity
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingVertical: 19,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      }}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 8 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
          <AppText variant="monoLabel" color={colors.textMuted} style={{ letterSpacing: 1.3 }}>
            {dateLabel(s.startedAt)}
          </AppText>
          <AppText variant="monoLabel" color={colors.textFaint} style={{ letterSpacing: 0 }}>
            {startLabel(s.startedAt)}
          </AppText>
        </View>
        <AppText variant="itemTitle">{primary}</AppText>
        {s.status === "analyzing" || s.status === "uploading" ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <StatusDot color={colors.accent} />
            <AppText variant="caption" color={colors.accent}>
              {s.status === "uploading" ? "Uploading…" : "Finding takes…"}
            </AppText>
          </View>
        ) : s.status === "failed" ? (
          <AppText variant="caption" color={colors.danger}>
            Couldn’t analyze this recording — tap to retry
          </AppText>
        ) : (
          <AppText variant="caption">{meta}</AppText>
        )}
      </View>
      <AppText style={{ color: colors.borderHover, fontSize: 20, lineHeight: 22 }}>›</AppText>
    </PressableOpacity>
  );
}
```

`apps/mobile/src/features/sessions/NewSessionSheet.tsx`:

```tsx
import { useRouter } from "expo-router";
import { View } from "react-native";
import { font, useTheme } from "@/theme";
import { AppText, BottomSheet, IconCircle, SheetActionRow } from "@/ui";

export function NewSessionSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const router = useRouter();
  const { colors } = useTheme();
  return (
    <BottomSheet visible={visible} onClose={onClose} title="New session">
      <SheetActionRow
        icon={
          <IconCircle>
            <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: colors.recording }} />
          </IconCircle>
        }
        title="Record now"
        subtitle="Start recording this rehearsal"
        onPress={() => {
          onClose();
          router.push("/record");
        }}
      />
      <SheetActionRow
        icon={
          <IconCircle>
            <AppText style={{ fontFamily: font.mono, fontSize: 16, color: colors.textSecondary }}>↓</AppText>
          </IconCircle>
        }
        title="Import a recording"
        subtitle="Find the takes in an existing recording"
        onPress={() => {
          onClose();
          router.push({ pathname: "/processing", params: { durationSec: "6720", source: "import" } });
        }}
      />
    </BottomSheet>
  );
}
```

`apps/mobile/src/features/sessions/SessionsScreen.tsx`:

```tsx
import type { Session } from "@bandapp/types";
import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { SectionList, View } from "react-native";
import { useApi } from "@/api";
import { BandSwitchSheet } from "@/features/band/BandSwitchSheet";
import { useCurrentBand } from "@/features/band/useCurrentBand";
import { monthLabel } from "@/lib/time";
import { space, useTheme } from "@/theme";
import { AppText, Chip, MonoLabel, Screen, useToast } from "@/ui";
import { SessionRow } from "./SessionRow";
import { useSessions } from "./useSessions";

export function SessionsScreen() {
  const { band } = useCurrentBand();
  const { data: sessions } = useSessions(band?.id);
  const [bandsOpen, setBandsOpen] = useState(false);
  const router = useRouter();
  const api = useApi();
  const toast = useToast();
  const { colors } = useTheme();

  const sections = useMemo(() => {
    const groups = new Map<string, Session[]>();
    for (const s of sessions ?? []) {
      const key = monthLabel(s.startedAt);
      const list = groups.get(key) ?? [];
      list.push(s);
      groups.set(key, list);
    }
    return [...groups.entries()].map(([title, data]) => ({ title, data }));
  }, [sessions]);

  const onRowPress = (s: Session) => {
    if (s.status === "ready") router.push(`/session/${s.id}`);
    else if (s.status === "failed") void api.sessions.retryAnalysis(s.id);
    else toast.show("Still finding takes…");
  };

  return (
    <Screen>
      <View style={{ paddingHorizontal: space.screenX, paddingBottom: 10, gap: 8 }}>
        <Chip
          size="lg"
          mono
          label={band?.name ?? ""}
          trailing={<AppText style={{ fontSize: 8, color: colors.textFaint }}>▼</AppText>}
          onPress={() => setBandsOpen(true)}
        />
        <AppText variant="titleXL">Sessions</AppText>
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(s) => s.id}
        contentContainerStyle={{ paddingHorizontal: space.screenX, paddingBottom: 160 }}
        renderSectionHeader={({ section }) => (
          <MonoLabel style={{ paddingTop: 14, paddingBottom: 4 }}>{section.title}</MonoLabel>
        )}
        renderItem={({ item }) => <SessionRow session={item} onPress={() => onRowPress(item)} />}
        stickySectionHeadersEnabled={false}
      />
      <BandSwitchSheet visible={bandsOpen} onClose={() => setBandsOpen(false)} />
    </Screen>
  );
}
```

- [ ] **Step 4: 탭 라우트 구성**

`apps/mobile/app/index.tsx` 삭제 (경로 `/` 충돌 방지).

`apps/mobile/app/(tabs)/_layout.tsx`:

```tsx
import { Tabs, usePathname, useRouter } from "expo-router";
import { useState } from "react";
import { NewSessionSheet } from "@/features/sessions/NewSessionSheet";
import { color } from "@/theme";
import { TabBar } from "@/ui";

export default function TabsLayout() {
  const [sheetOpen, setSheetOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  return (
    <>
      <Tabs
        screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: color.bg } }}
        tabBar={() => (
          <TabBar
            active={pathname.startsWith("/band") ? "band" : "sessions"}
            onPressSessions={() => router.navigate("/")}
            onPressBand={() => router.navigate("/band")}
            onPressFab={() => setSheetOpen(true)}
          />
        )}
      >
        <Tabs.Screen name="index" />
        <Tabs.Screen name="band" />
      </Tabs>
      <NewSessionSheet visible={sheetOpen} onClose={() => setSheetOpen(false)} />
    </>
  );
}
```

주의: SDK 57의 expo-router Tabs에서 `sceneStyle` 미지원 시 https://docs.expo.dev/versions/v57.0.0/ 의 Tabs 옵션 확인 후 동등 옵션 사용.

`apps/mobile/app/(tabs)/index.tsx`:

```tsx
export { SessionsScreen as default } from "@/features/sessions/SessionsScreen";
```

`apps/mobile/app/(tabs)/band.tsx` (임시 — Task 10에서 교체):

```tsx
import { Screen, AppText } from "@/ui";

export default function BandPlaceholder() {
  return (
    <Screen>
      <AppText variant="title">Band</AppText>
    </Screen>
  );
}
```

- [ ] **Step 5: 검증 + 커밋**

Run: `pnpm --filter mobile typecheck`
Expected: 에러 없음

Run: `cd apps/mobile; npx expo start --web`
Expected: Sessions 목록 렌더 — 밴드 칩 "FRIDAY NIGHT", AUGUST 2026 헤더, 5개 행(analyzing 펄스 점 / failed 빨간 문구 / ready 메타), 탭바 + FAB → New session 시트, 밴드 칩 → Switch band 시트

```bash
git add apps/mobile
git commit -m "feat(mobile): add sessions screen with tab layout and sheets"
```

---

### Task 10: Band 화면

**Files:**
- Create: `apps/mobile/src/features/band/BandScreen.tsx`, `MemberRow.tsx`, `InviteSheet.tsx`
- Modify: `apps/mobile/app/(tabs)/band.tsx` (자리표시 → re-export)

**Interfaces:**
- Consumes: Task 6~9 (`useCurrentBand`, ui, theme, `useApiData`), expo-clipboard
- Produces:

```ts
BandScreen(): JSX.Element
MemberRow: { member: BandMember }
InviteSheet: { visible: boolean; onClose(): void; bandId: string }
```

- [ ] **Step 1: MemberRow + InviteSheet**

`apps/mobile/src/features/band/MemberRow.tsx`:

```tsx
import type { BandMember } from "@bandapp/types";
import { View } from "react-native";
import { useTheme } from "@/theme";
import { AppText, Avatar, MonoLabel } from "@/ui";

export function MemberRow({ member }: { member: BandMember }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        paddingVertical: 15,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      }}
    >
      <Avatar label={member.name[0]} />
      <AppText style={{ flex: 1, fontSize: 15, color: colors.text }}>{member.name}</AppText>
      <MonoLabel style={{ letterSpacing: 1.1 }}>{member.role.toUpperCase()}</MonoLabel>
    </View>
  );
}
```

`apps/mobile/src/features/band/InviteSheet.tsx`:

```tsx
import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { View } from "react-native";
import { useApiData } from "@/api";
import { font, radius, useTheme } from "@/theme";
import { AppText, BottomSheet, PressableOpacity } from "@/ui";

export function InviteSheet({
  visible,
  onClose,
  bandId,
}: {
  visible: boolean;
  onClose: () => void;
  bandId: string;
}) {
  const { colors } = useTheme();
  const [copied, setCopied] = useState(false);
  const { data: link } = useApiData((api) => api.bands.inviteLink(bandId), [bandId]);
  const copy = async () => {
    if (!link) return;
    await Clipboard.setStringAsync(`https://${link}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="Invite your band"
      subtitle="Send a link to invite members."
    >
      <View
        style={{
          marginTop: 6,
          marginHorizontal: 4,
          backgroundColor: colors.surfaceSunken,
          borderWidth: 1,
          borderColor: colors.borderStrong,
          borderRadius: radius.input,
          paddingVertical: 13,
          paddingHorizontal: 14,
        }}
      >
        <AppText style={{ fontFamily: font.mono, fontSize: 13, color: colors.textSecondary }}>
          {link ?? ""}
        </AppText>
      </View>
      <PressableOpacity
        onPress={copy}
        style={{
          marginTop: 12,
          marginHorizontal: 4,
          backgroundColor: colors.accent,
          borderRadius: radius.input,
          paddingVertical: 13,
          alignItems: "center",
        }}
      >
        <AppText style={{ fontSize: 14, fontWeight: "600", color: colors.bg }}>
          {copied ? "Copied" : "Copy link"}
        </AppText>
      </PressableOpacity>
    </BottomSheet>
  );
}
```

- [ ] **Step 2: BandScreen + 라우트 연결**

`apps/mobile/src/features/band/BandScreen.tsx`:

```tsx
import { useState } from "react";
import { FlatList, View } from "react-native";
import { useApiData } from "@/api";
import { radius, space, useTheme } from "@/theme";
import { AppText, MonoLabel, PressableOpacity, Screen } from "@/ui";
import { InviteSheet } from "./InviteSheet";
import { MemberRow } from "./MemberRow";
import { useCurrentBand } from "./useCurrentBand";

export function BandScreen() {
  const { band } = useCurrentBand();
  const { data: members } = useApiData(
    async (api) => (band ? api.bands.members(band.id) : []),
    [band?.id],
  );
  const [inviteOpen, setInviteOpen] = useState(false);
  const { colors } = useTheme();
  return (
    <Screen>
      <View style={{ paddingHorizontal: space.screenX, paddingBottom: 10, gap: 8 }}>
        <MonoLabel color={colors.textMuted} style={{ letterSpacing: 1.8 }}>
          YOUR BAND
        </MonoLabel>
        <AppText variant="titleXL">{band?.name ?? ""}</AppText>
        <MonoLabel>{`MEMBERS · ${band?.memberCount ?? 0}`}</MonoLabel>
      </View>
      <FlatList
        data={members ?? []}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ paddingHorizontal: space.screenX, paddingBottom: 160 }}
        renderItem={({ item }) => <MemberRow member={item} />}
        ListFooterComponent={
          <PressableOpacity
            onPress={() => setInviteOpen(true)}
            style={{
              marginTop: 20,
              borderWidth: 1,
              borderColor: colors.borderStrong,
              borderRadius: radius.input,
              padding: 14,
              alignItems: "center",
            }}
          >
            <AppText style={{ fontSize: 14, color: colors.accent }}>+ Invite member</AppText>
          </PressableOpacity>
        }
      />
      {band ? (
        <InviteSheet visible={inviteOpen} onClose={() => setInviteOpen(false)} bandId={band.id} />
      ) : null}
    </Screen>
  );
}
```

`apps/mobile/app/(tabs)/band.tsx` 전체 교체:

```tsx
export { BandScreen as default } from "@/features/band/BandScreen";
```

- [ ] **Step 3: 검증 + 커밋**

Run: `pnpm --filter mobile typecheck`
Expected: 에러 없음

Run: `cd apps/mobile; npx expo start --web` → BAND 탭
Expected: YOUR BAND / FRIDAY NIGHT / MEMBERS · 4, 멤버 4명(OWNER/MEMBER), + Invite member → 시트(링크 `band.app/join/X7K2F9`, Copy link → "Copied" 1.6초)

```bash
git add apps/mobile
git commit -m "feat(mobile): add band screen with members and invite sheet"
```

---

### Task 11: Recording + Processing 화면

**Files:**
- Create: `apps/mobile/src/features/recording/useRecordingTimer.ts`, `RecordingScreen.tsx`, `ProcessingScreen.tsx`
- Create: `apps/mobile/app/record.tsx`, `apps/mobile/app/processing.tsx`

**Interfaces:**
- Consumes: Task 5~9 (`fmtClock`, `fmtDuration`, ui, `useApi`, `useApiData`, `useCurrentBand`)
- Produces:

```ts
useRecordingTimer(): { seconds: number }              // 마운트 시 시작, 200ms 간격
RecordingScreen(): JSX.Element
ProcessingScreen(): JSX.Element                       // 쿼리: durationSec(string), source("recording"|"import")
// 라우트: /record, /processing?durationSec=..&source=..
```

- [ ] **Step 1: useRecordingTimer**

`apps/mobile/src/features/recording/useRecordingTimer.ts`:

```ts
import { useEffect, useState } from "react";

export function useRecordingTimer() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const t = setInterval(() => setSeconds((Date.now() - started) / 1000), 200);
    return () => clearInterval(t);
  }, []);
  return { seconds };
}
```

- [ ] **Step 2: RecordingScreen + 라우트**

`apps/mobile/src/features/recording/RecordingScreen.tsx`:

```tsx
import { useRouter } from "expo-router";
import { View } from "react-native";
import { fmtClock } from "@/lib/time";
import { radius, useTheme } from "@/theme";
import { AppText, Chip, LiveWaveform, MonoLabel, PressableOpacity, Screen, StatusDot, useToast } from "@/ui";
import { useRecordingTimer } from "./useRecordingTimer";

export function RecordingScreen() {
  const { seconds } = useRecordingTimer();
  const router = useRouter();
  const toast = useToast();
  const { colors } = useTheme();
  const stop = () => {
    const durationSec = String(Math.max(8, Math.floor(seconds)));
    router.replace({ pathname: "/processing", params: { durationSec, source: "recording" } });
  };
  return (
    <Screen>
      <MonoLabel style={{ textAlign: "center", letterSpacing: 2, paddingTop: 8 }}>REHEARSAL</MonoLabel>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 30 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <StatusDot color={colors.recording} size={10} />
          <MonoLabel color={colors.recording} style={{ fontSize: 12, letterSpacing: 2.4 }}>
            REC
          </MonoLabel>
        </View>
        <AppText variant="monoTimer">{fmtClock(seconds)}</AppText>
        <LiveWaveform />
        <Chip
          label="+ MARK"
          mono
          style={{ borderRadius: radius.chipLg + 4, paddingVertical: 10, paddingHorizontal: 22, marginTop: 6 }}
          onPress={() => toast.show(`Marked at ${fmtClock(seconds)}`)}
        />
      </View>
      <View style={{ alignItems: "center", gap: 10, paddingBottom: 60 }}>
        <PressableOpacity
          onPress={stop}
          style={{
            width: 72,
            height: 72,
            borderRadius: 36,
            borderWidth: 1,
            borderColor: colors.borderStronger,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <View style={{ width: 22, height: 22, borderRadius: 4, backgroundColor: colors.recording }} />
        </PressableOpacity>
        <AppText variant="small">Stop</AppText>
      </View>
    </Screen>
  );
}
```

`apps/mobile/app/record.tsx`:

```tsx
export { RecordingScreen as default } from "@/features/recording/RecordingScreen";
```

- [ ] **Step 3: ProcessingScreen + 라우트**

`apps/mobile/src/features/recording/ProcessingScreen.tsx`:

```tsx
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useApi, useApiData } from "@/api";
import { useCurrentBand } from "@/features/band/useCurrentBand";
import { fmtDuration } from "@/lib/time";
import { space, useTheme } from "@/theme";
import { AppText, MonoLabel, ProgressBar, Screen } from "@/ui";

const ANALYSIS_MS = 4500;

export function ProcessingScreen() {
  const { durationSec: durParam, source } = useLocalSearchParams<{
    durationSec: string;
    source: "recording" | "import";
  }>();
  const durationSec = Number(durParam ?? 0);
  const api = useApi();
  const router = useRouter();
  const { band } = useCurrentBand();
  const { colors } = useTheme();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const startedRef = useRef(false);

  useEffect(() => {
    if (!band || startedRef.current) return;
    startedRef.current = true;
    void api.sessions
      .create(band.id, { durationSec, source: source ?? "recording" })
      .then((s) => setSessionId(s.id));
  }, [api, band, durationSec, source]);

  useEffect(() => {
    const t = setInterval(() => {
      setProgress((p) => Math.min(0.95, p + 200 / ANALYSIS_MS));
    }, 200);
    return () => clearInterval(t);
  }, []);

  const { data: session } = useApiData(
    async (a) => (sessionId ? a.sessions.get(sessionId) : undefined),
    [sessionId],
  );
  const done = session?.status === "ready";

  useEffect(() => {
    if (!done || !sessionId) return;
    setProgress(1);
    const t = setTimeout(() => router.replace(`/session/${sessionId}`), 1100);
    return () => clearTimeout(t);
  }, [done, sessionId, router]);

  const phase = done
    ? `${session?.takeCount ?? 0} Takes found`
    : progress < 0.3
      ? "Preparing the recording…"
      : progress < 0.78
        ? "Finding the parts you played…"
        : "Organizing takes…";

  return (
    <Screen>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 18, paddingHorizontal: 40 }}>
        <AppText variant="heading" style={{ textAlign: "center" }}>
          Organizing your rehearsal
        </AppText>
        <MonoLabel color={colors.textMuted} style={{ fontSize: 12, letterSpacing: 0 }}>
          {`${fmtDuration(durationSec)} recording`}
        </MonoLabel>
        <ProgressBar progress={progress} />
        <AppText variant="caption" color={done ? colors.accent : colors.textMuted} style={{ minHeight: 18 }}>
          {phase}
        </AppText>
      </View>
      <AppText
        variant="small"
        style={{ textAlign: "center", paddingHorizontal: space.screenX + 16, paddingBottom: 64, lineHeight: 18 }}
      >
        You can close the app — your takes will be ready when you're back.
      </AppText>
    </Screen>
  );
}
```

`apps/mobile/app/processing.tsx`:

```tsx
export { ProcessingScreen as default } from "@/features/recording/ProcessingScreen";
```

- [ ] **Step 4: 검증 + 커밋**

Run: `pnpm --filter mobile typecheck`
Expected: 에러 없음

Run: `cd apps/mobile; npx expo start --web` → FAB → Record now
Expected: REC 펄스 + 타이머 진행 + 웨이브 애니메이션, + MARK → 토스트, Stop → Processing 진행 바 → 4.5초 후 "N Takes found" → Session Detail 이동(주의: Detail 라우트는 Task 12에서 생성 — 이 시점엔 unmatched route 화면이 정상)

```bash
git add apps/mobile
git commit -m "feat(mobile): add recording and processing screens with simulated flow"
```

---

### Task 12: Session Detail + Take Feedback 화면

**Files:**
- Create: `apps/mobile/src/features/takes/useSession.ts`, `useTakes.ts`, `useComments.ts`, `usePlayback.ts`
- Create: `apps/mobile/src/features/takes/SessionDetailScreen.tsx`, `TakeRow.tsx`, `TakePlayerScreen.tsx`, `CommentRow.tsx`, `CommentInput.tsx`
- Create: `apps/mobile/app/session/[id]/index.tsx`, `apps/mobile/app/session/[id]/take/[takeId].tsx`

**Interfaces:**
- Consumes: Task 5~9 전부 (`seedOf`, `fmtClock`, `fmtDuration`, `clockRange`, PlayerWaveform, StaticWaveform 등)
- Produces:

```ts
useSession(id: string | undefined): { data: Session | undefined }
useTakes(sessionId: string | undefined): { data: Take[] | undefined }
useComments(takeId: string | undefined): { data: TakeComment[] | undefined }
usePlayback(durationSec: number): { positionSec: number; playing: boolean; toggle(): void; seekTo(sec: number, autoplay?: boolean): void }
SessionDetailScreen / TakePlayerScreen / TakeRow { take; onPress } / CommentRow { comment; onPress } / CommentInput { placeholder: string; onSubmit(text: string): void }
// 라우트 규칙: /session/[id], /session/[id]/take/[takeId]. takeId가 "orig"이면
// 세션 원본 녹음을 의사 테이크로 표시하고 코멘트 키는 `${sessionId}-orig`.
```

- [ ] **Step 1: 훅 4개**

`apps/mobile/src/features/takes/useSession.ts`:

```ts
import { useApiData } from "@/api";

export function useSession(id: string | undefined) {
  return useApiData(async (api) => (id ? api.sessions.get(id) : undefined), [id]);
}
```

`apps/mobile/src/features/takes/useTakes.ts`:

```ts
import { useApiData } from "@/api";

export function useTakes(sessionId: string | undefined) {
  return useApiData(async (api) => (sessionId ? api.takes.list(sessionId) : []), [sessionId]);
}
```

`apps/mobile/src/features/takes/useComments.ts`:

```ts
import { useApiData } from "@/api";

export function useComments(takeId: string | undefined) {
  return useApiData(async (api) => (takeId ? api.comments.list(takeId) : []), [takeId]);
}
```

`apps/mobile/src/features/takes/usePlayback.ts`:

```ts
import { useEffect, useRef, useState } from "react";

export function usePlayback(durationSec: number) {
  const [positionSec, setPositionSec] = useState(0);
  const [playing, setPlaying] = useState(false);
  const posRef = useRef(0);
  posRef.current = positionSec;

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      const next = posRef.current + 0.2;
      if (next >= durationSec) {
        setPositionSec(durationSec);
        setPlaying(false);
      } else {
        setPositionSec(next);
      }
    }, 200);
    return () => clearInterval(t);
  }, [playing, durationSec]);

  const toggle = () => {
    setPlaying((p) => {
      if (!p && posRef.current >= durationSec) setPositionSec(0);
      return !p;
    });
  };
  const seekTo = (sec: number, autoplay = false) => {
    setPositionSec(Math.max(0, Math.min(durationSec, sec)));
    if (autoplay) setPlaying(true);
  };
  return { positionSec, playing, toggle, seekTo };
}
```

- [ ] **Step 2: TakeRow + Detail 화면 + 라우트**

`apps/mobile/src/features/takes/TakeRow.tsx`:

```tsx
import type { Take } from "@bandapp/types";
import { View } from "react-native";
import { seedOf } from "@/lib/seed";
import { fmtClock } from "@/lib/time";
import { useTheme } from "@/theme";
import { AppText, PressableOpacity, StaticWaveform } from "@/ui";

export function TakeRow({ take, onPress }: { take: Take; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <PressableOpacity
      onPress={onPress}
      style={{
        flexDirection: "row",
        gap: 14,
        paddingVertical: 18,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      }}
    >
      <AppText variant="monoMeta" color={colors.textFaint} style={{ paddingTop: 4 }}>
        {String(take.index + 1).padStart(2, "0")}
      </AppText>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
          <AppText variant="rowTitle" style={{ fontSize: 16 }}>
            {take.name}
          </AppText>
          <AppText variant="monoMeta">{fmtClock(take.durationSec)}</AppText>
        </View>
        <View style={{ marginTop: 10 }}>
          <StaticWaveform seed={seedOf(take.id)} />
        </View>
        {take.commentCount > 0 ? (
          <AppText variant="small" color={colors.accent} style={{ marginTop: 9 }}>
            {`${take.commentCount} ${take.commentCount === 1 ? "comment" : "comments"}`}
          </AppText>
        ) : null}
      </View>
    </PressableOpacity>
  );
}
```

`apps/mobile/src/features/takes/SessionDetailScreen.tsx`:

```tsx
import { useLocalSearchParams, useRouter } from "expo-router";
import { FlatList, View } from "react-native";
import { clockRange, fmtDuration } from "@/lib/time";
import { space, useTheme } from "@/theme";
import { AppText, Chip, PressableOpacity, Screen, useToast } from "@/ui";
import { TakeRow } from "./TakeRow";
import { useSession } from "./useSession";
import { useTakes } from "./useTakes";

export function SessionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: session } = useSession(id);
  const { data: takes } = useTakes(id);
  const router = useRouter();
  const toast = useToast();
  const { colors } = useTheme();
  if (!session) return <Screen>{null}</Screen>;
  return (
    <Screen>
      <View style={{ paddingHorizontal: space.sheetX, paddingBottom: 4 }}>
        <PressableOpacity
          onPress={() => router.back()}
          style={{ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", padding: 8 }}
        >
          <AppText style={{ fontSize: 18, lineHeight: 20, color: colors.textMuted }}>‹</AppText>
          <AppText variant="body" color={colors.textMuted}>
            Sessions
          </AppText>
        </PressableOpacity>
      </View>
      <View style={{ paddingHorizontal: space.screenX, paddingTop: 6, paddingBottom: 14, gap: 8 }}>
        <AppText variant="title">{session.name ?? session.title}</AppText>
        <AppText variant="monoMeta">{clockRange(session.startedAt, session.durationSec)}</AppText>
        <AppText variant="caption" color={colors.textSecondary}>
          {`${fmtDuration(session.durationSec)} · ${session.takeCount} Takes`}
        </AppText>
      </View>
      <View style={{ flexDirection: "row", gap: 10, paddingHorizontal: space.screenX, paddingBottom: 6 }}>
        <Chip label="Original recording" onPress={() => router.push(`/session/${session.id}/take/orig`)} />
        <Chip label="Edit takes" onPress={() => toast.show("Take editing is not in this prototype")} />
      </View>
      <FlatList
        data={takes ?? []}
        keyExtractor={(t) => t.id}
        contentContainerStyle={{ paddingHorizontal: space.screenX, paddingTop: 6, paddingBottom: 48 }}
        renderItem={({ item }) => (
          <TakeRow take={item} onPress={() => router.push(`/session/${session.id}/take/${item.id}`)} />
        )}
      />
    </Screen>
  );
}
```

`apps/mobile/app/session/[id]/index.tsx`:

```tsx
export { SessionDetailScreen as default } from "@/features/takes/SessionDetailScreen";
```

- [ ] **Step 3: CommentRow + CommentInput**

`apps/mobile/src/features/takes/CommentRow.tsx`:

```tsx
import type { TakeComment } from "@bandapp/types";
import { View } from "react-native";
import { fmtClock } from "@/lib/time";
import { useTheme } from "@/theme";
import { AppText, PressableOpacity } from "@/ui";

export function CommentRow({ comment, onPress }: { comment: TakeComment; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <PressableOpacity
      onPress={onPress}
      style={{ paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.border }}
    >
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
        <AppText variant="caption" color={colors.text} style={{ fontWeight: "600" }}>
          {comment.authorName}
        </AppText>
        <AppText variant="monoMeta" color={colors.accent}>
          {fmtClock(comment.atSec)}
        </AppText>
      </View>
      <AppText variant="body" style={{ marginTop: 5, lineHeight: 20 }}>
        {comment.text}
      </AppText>
    </PressableOpacity>
  );
}
```

`apps/mobile/src/features/takes/CommentInput.tsx`:

```tsx
import { useState } from "react";
import { TextInput, View } from "react-native";
import { radius, space, useTheme } from "@/theme";
import { AppText, PressableOpacity } from "@/ui";

export function CommentInput({
  placeholder,
  onSubmit,
}: {
  placeholder: string;
  onSubmit: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const { colors } = useTheme();
  const send = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setText("");
  };
  return (
    <View
      style={{
        flexDirection: "row",
        gap: 10,
        paddingHorizontal: space.sheetX,
        paddingTop: 12,
        paddingBottom: 30,
        borderTopWidth: 1,
        borderTopColor: colors.surfaceRaised,
        backgroundColor: colors.bg,
      }}
    >
      <TextInput
        value={text}
        onChangeText={setText}
        onSubmitEditing={send}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        style={{
          flex: 1,
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.borderStrong,
          borderRadius: radius.input,
          paddingVertical: 11,
          paddingHorizontal: 14,
          color: colors.text,
          fontSize: 14,
        }}
      />
      <PressableOpacity
        onPress={send}
        style={{
          width: 42,
          height: 42,
          borderRadius: 21,
          backgroundColor: colors.accent,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <AppText style={{ fontSize: 18, color: colors.bg }}>↑</AppText>
      </PressableOpacity>
    </View>
  );
}
```

- [ ] **Step 4: TakePlayerScreen + 라우트**

`apps/mobile/src/features/takes/TakePlayerScreen.tsx`:

```tsx
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMemo } from "react";
import { FlatList, KeyboardAvoidingView, Platform, View } from "react-native";
import { useApi } from "@/api";
import { seedOf } from "@/lib/seed";
import { fmtClock, fmtDuration } from "@/lib/time";
import { space, useTheme } from "@/theme";
import { AppText, MonoLabel, PlayerWaveform, PressableOpacity, Screen } from "@/ui";
import { CommentInput } from "./CommentInput";
import { CommentRow } from "./CommentRow";
import { useComments } from "./useComments";
import { usePlayback } from "./usePlayback";
import { useSession } from "./useSession";
import { useTakes } from "./useTakes";

export function TakePlayerScreen() {
  const { id, takeId } = useLocalSearchParams<{ id: string; takeId: string }>();
  const { data: session } = useSession(id);
  const { data: takes } = useTakes(id);
  const router = useRouter();
  const api = useApi();
  const { colors } = useTheme();

  const isOriginal = takeId === "orig";
  const take = useMemo(() => {
    if (!session) return undefined;
    if (isOriginal) {
      return { name: "Original recording", durationSec: session.durationSec, commentKey: `${session.id}-orig` };
    }
    const t = (takes ?? []).find((x) => x.id === takeId);
    return t ? { name: t.name, durationSec: t.durationSec, commentKey: t.id } : undefined;
  }, [session, takes, takeId, isOriginal]);

  const { data: comments, reload } = useComments(take?.commentKey);
  const playback = usePlayback(take?.durationSec ?? 0);

  if (!session || !take) return <Screen>{null}</Screen>;
  const sub = `${session.title} · ${isOriginal ? fmtDuration(take.durationSec) : fmtClock(take.durationSec)}`;

  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <View style={{ paddingHorizontal: space.sheetX }}>
          <PressableOpacity
            onPress={() => router.back()}
            style={{ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", padding: 8 }}
          >
            <AppText style={{ fontSize: 18, lineHeight: 20, color: colors.textMuted }}>‹</AppText>
            <AppText variant="body" color={colors.textMuted}>
              Session
            </AppText>
          </PressableOpacity>
        </View>
        <View style={{ paddingHorizontal: space.screenX, paddingTop: 4, paddingBottom: 10 }}>
          <AppText variant="heading">{take.name}</AppText>
          <AppText variant="caption" style={{ marginTop: 4 }}>
            {sub}
          </AppText>
        </View>
        <View style={{ paddingHorizontal: space.screenX, paddingTop: 18, paddingBottom: 8, alignItems: "center", gap: 16 }}>
          <PlayerWaveform
            seed={seedOf(take.commentKey)}
            durationSec={take.durationSec}
            positionSec={playback.positionSec}
            markers={(comments ?? []).map((c) => c.atSec)}
            onSeek={(sec) => playback.seekTo(sec)}
          />
          <AppText variant="monoMeta">{`${fmtClock(playback.positionSec)} / ${fmtClock(take.durationSec)}`}</AppText>
          <PressableOpacity
            onPress={playback.toggle}
            style={{
              width: 60,
              height: 60,
              borderRadius: 30,
              borderWidth: 1,
              borderColor: playback.playing ? colors.accent : colors.borderStronger,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {playback.playing ? (
              <View style={{ flexDirection: "row", gap: 5 }}>
                <View style={{ width: 5, height: 18, backgroundColor: colors.text, borderRadius: 1 }} />
                <View style={{ width: 5, height: 18, backgroundColor: colors.text, borderRadius: 1 }} />
              </View>
            ) : (
              <View
                style={{
                  width: 0,
                  height: 0,
                  borderTopWidth: 10,
                  borderBottomWidth: 10,
                  borderLeftWidth: 16,
                  borderTopColor: "transparent",
                  borderBottomColor: "transparent",
                  borderLeftColor: colors.text,
                  marginLeft: 4,
                }}
              />
            )}
          </PressableOpacity>
        </View>
        <FlatList
          data={comments ?? []}
          keyExtractor={(c) => c.id}
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: space.screenX, paddingTop: 10, paddingBottom: 16 }}
          ListHeaderComponent={<MonoLabel style={{ paddingTop: 8, paddingBottom: 2 }}>FEEDBACK</MonoLabel>}
          ListEmptyComponent={
            <AppText variant="caption" color={colors.textFaint} style={{ paddingVertical: 18 }}>
              No feedback yet. Say something at the right moment — it lands on the timeline.
            </AppText>
          }
          renderItem={({ item }) => (
            <CommentRow comment={item} onPress={() => playback.seekTo(Math.max(0, item.atSec - 5), true)} />
          )}
        />
        <CommentInput
          placeholder={`Leave feedback at ${fmtClock(playback.positionSec)}…`}
          onSubmit={(text) => {
            void api.comments
              .create(take.commentKey, { atSec: Math.floor(playback.positionSec), text })
              .then(() => reload());
          }}
        />
      </KeyboardAvoidingView>
    </Screen>
  );
}
```

`apps/mobile/app/session/[id]/take/[takeId].tsx`:

```tsx
export { TakePlayerScreen as default } from "@/features/takes/TakePlayerScreen";
```

- [ ] **Step 5: 검증 + 커밋**

Run: `pnpm --filter mobile typecheck`
Expected: 에러 없음

Run: `cd apps/mobile; npx expo start --web`
Expected: Sessions → "Full set run-through" → Detail(테이크 7개, Take 1에 "3 comments") → Take 1 → 플레이어(마커 3개, 재생 시 진행, 코멘트 탭 → 시점 이동+재생, 입력 → "You" 코멘트 추가·마커 갱신). Original recording 칩 → 원본 플레이어(빈 피드백 문구).

```bash
git add apps/mobile
git commit -m "feat(mobile): add session detail and take feedback screens"
```

---

### Task 13: 최종 검증

**Files:**
- Modify: 발견된 문제 수정분만

**Interfaces:**
- Consumes: 전체
- Produces: 스펙 "테스트·검증" 기준 충족 확인

- [ ] **Step 1: 전체 테스트·빌드·타입체크**

Run 순서대로, 모두 통과 확인:

```bash
pnpm turbo build lint
pnpm --filter @bandapp/api-client exec vitest run
pnpm --filter mobile exec vitest run src/lib
pnpm --filter mobile typecheck
```

Expected: 전부 성공. turbo `test` 태스크도 걸리는지 확인: `pnpm turbo test` (types는 test 스크립트 없음 — 통과로 간주됨).

- [ ] **Step 2: 전체 플로우 눈 확인 (expo web)**

`cd apps/mobile; npx expo start --web` 후 체크리스트:

- [ ] Sessions: 상태 3종(analyzing 펄스·failed 문구·ready 메타), 월 헤더, 밴드 칩·시트
- [ ] failed 행 탭 → analyzing 전환 → 4초 후 ready로 목록 갱신
- [ ] FAB → Record now → 타이머·웨이브·MARK 토스트 → Stop → Processing → 새 세션 Detail 도착
- [ ] FAB → Import → Processing(1h 52m recording) → Detail
- [ ] Detail → Take → 재생/시킹/코멘트 작성 → Detail 복귀 시 코멘트 수 갱신
- [ ] Band 탭: 멤버 4명, Invite 시트 링크 복사
- [ ] JetBrains Mono가 라벨·타이머에 적용됐는지 확인

문제 발견 시 superpowers:systematic-debugging으로 수정 후 재확인.

- [ ] **Step 3: Commit (수정분 있으면)**

```bash
git add -A
git commit -m "fix(mobile): polish issues found in final verification"
```

---

## Self-Review 결과

- 스펙 커버리지: 토큰/ThemeProvider(T4), ui 컴포넌트(T6·T7), features 4개 도메인(T9~T12), expo-router 페이지(T3·T9~T12), types(T1), api-client 인터페이스+Mock(T2), 폰트(T3·T4), 검증(T13) — 스펙의 "화면 플로우" 6개 모두 대응. 스펙의 `useRecordingTimer`·`usePlayback` 등 훅 명명 일치.
- 타입 일관성: `RehearsalApiClient` 시그니처는 T2 정의를 T8~T12가 동일 사용. `TypeVariant`·토큰 키는 T4 정의 기준. `commentKey` 규칙(orig)은 T12 Interfaces에 명시.
- 알려진 주의점: SDK 57 API 차이(Tabs `sceneStyle` 등)는 각 Task에 문서 확인 지침 포함. `AppText`의 `type` import 충돌 시 별칭 사용 지침 포함.

