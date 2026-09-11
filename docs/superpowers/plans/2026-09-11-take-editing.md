# Take 경계 편집·삭제 (스펙 B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 타임라인 뷰어에서 선택한 take의 시작/종료 경계를 핸들로 고쳐 저장하면 서버가 오디오를 다시 자르고 코멘트 시각을 맞추며, take를 지울 수 있다.

**Architecture:** `PATCH /takes/:id`는 DB(`startMs/endMs/version/audioStatus`)와 코멘트 `at_ms`만 바꾸고 기존 분석 큐에 `{ type: "recut" }` 잡을 넣는다. 워커의 `TakeRecutService`가 원본을 `-c copy`로 잘라 **새 키**에 올리고 `peaks.bin` 사이드카로 피크를 다시 계산한 뒤 `ready`로 바꾼다. 앱은 `useTimelineViewport`의 팬 `onBegin` hit-test로 핸들 모드를 정하고, 초안은 shared value로만 살다가 Save 한 번에 `PATCH`한다. 범위·겹침 규칙은 `@bandapp/types`의 순수 함수 하나를 서버·Mock·앱이 공유한다.

**Tech Stack:** NestJS 11 + drizzle(Postgres, 마이그레이션 0009), SQS(기존 `SQS_ANALYSIS_QUEUE_URL`), ffmpeg, vitest(단위 + 실 Postgres e2e), `@bandapp/types`·`@bandapp/api-client`(dist 소비), Expo SDK 57 / RN 0.86, react-native-reanimated 4.5 + react-native-worklets 0.10, react-native-gesture-handler 3.2 v3 훅, expo-router.

**Spec:** [docs/superpowers/specs/2026-09-11-take-editing-design.md](../specs/2026-09-11-take-editing-design.md)

## Global Constraints

- 코드 주석은 한국어, 커밋 제목은 영어 conventional commit. 커밋 트레일러 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` 필수.
- `@bandapp/types`·`@bandapp/api-client`는 `dist`로 소비된다 — 바꾸면 `pnpm --filter @bandapp/types build` / `pnpm --filter @bandapp/api-client build` 후에야 다른 패키지의 typecheck가 맞는다.
- 타입 확인: `pnpm --filter mobile typecheck` + `pnpm --filter @bandapp/api build`. spec 파일은 tsconfig에서 제외돼 타입 오류를 못 잡는다 — spec 코드는 그대로 옮겨 적는다.
- `pnpm --filter @bandapp/api lint`(oxlint): `new Array(n)` 금지, `Array.from<number>(...)` 제네릭 금지.
- 소스 파일은 CRLF일 수 있다 — 여러 줄 문자열로 패치하는 스크립트는 먼저 `\r\n → \n`으로 정규화한다(스펙 A 실행 때 두 번 걸렸다).
- 규칙 상수·오류 코드(스펙 §타입·API 계약): `MIN_TAKE_MS = 250`, 오류 코드 `session_not_ready`(409), `take_version_conflict`(409), `take_range_invalid`(400), `take_overlap`(400). 겹침 판정은 같은 세션에서 `index`가 바로 앞/뒤인 take 기준. 순서(`index`)는 절대 바뀌지 않는다. 삭제해도 남은 take의 `name`·`index`는 그대로.
- 코멘트 이동량은 `oldStartMs − newStartMs`(ms). 구간 밖으로 밀린 코멘트는 지우지도 자르지도 않는다.
- 재컷 결과 키는 `takes/{takeId}-v{version}.m4a`(`takeKey(bandId, sessionId, \`${takeId}-v${version}\`)`). 잡의 `version`이 현재와 다르면 아무것도 하지 않는다.
- 앱 상수: 핸들 터치 영역 `HANDLE_HIT_PX = 24`, edge auto pan `EDGE_PX = 24`, `EDGE_MAX_PX_PER_FRAME = 12`, 미리 듣기 end 핸들 `−2000ms`, 폴링 3초.
- 핸들·초안·Save/Cancel·삭제·상태 UI의 **모양**은 Claude Design 결과가 명세다(스펙 §디자인 브리프). Task 10의 레이아웃은 동작 검증용 잠정 조립이며, 디자인이 오면 그 화면대로 맞춘다. Task 1~9는 디자인과 무관하다.
- e2e는 docker compose `postgres`가 떠 있어야 한다. 웹 Mock 프리뷰는 8081이 다른 워크트리의 dev-client Metro라면 `CI=1 EXPO_PUBLIC_API_URL= pnpm --filter mobile exec expo start --web --port 8082`를 Bash 백그라운드로 띄우고 `navigate(url)`로 붙는다. 끝나면 8082 리스너를 `Stop-Process`로 죽인다(TaskStop이 자식을 못 죽인다).

---

### Task 1: 타입·스키마·마이그레이션 0009 — 컴파일 가능한 기준선

**Files:**
- Modify: `packages/types/src/take.ts`, `packages/types/src/analysis.ts`
- Create: `packages/types/src/take-rules.ts` (export만; 테스트는 Task 2)
- Modify: `packages/types/src/index.ts`
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/drizzle/0009_*.sql` + meta (drizzle-kit)
- Modify: `apps/api/src/takes/takes.service.ts` (`TAKE_WITH_COUNT`, `TakeRow`, `toTake`)
- Modify: `packages/api-client/src/mock/seed.ts` (`generateTakes`)
- Modify: `apps/api/test/takes.e2e-spec.ts` (첫 테스트의 `toEqual` 객체)

**Interfaces:**
- Produces: `TakeAudioStatus`, `Take.version: number`, `Take.audioStatus: TakeAudioStatus`, `UpdateTakeInput { startMs; endMs; version }`, `RecutTakeJob { type: "recut"; takeId; version }`, `QueueJob = AnalyzeSessionJob | RecutTakeJob`, `MIN_TAKE_MS = 250`, `TakeRangeError`, `Neighbors`, `checkTakeRange()`, `neighborsOf()` (`@bandapp/types`); drizzle `takeAudioStatus` enum, `takes.version/audioStatus/audioError`.

- [ ] **Step 1: 타입**

`packages/types/src/take.ts` — `Take`에 두 필드, 새 입력 타입:

```ts
export type TakeAudioStatus = "ready" | "updating" | "failed";

export interface Take {
  // ...기존 필드 (peaks까지)
  /** PATCH 낙관적 잠금용. 경계를 바꿀 때마다 +1 (2026-09-11 스펙 B 결정 4) */
  version: number;
  /** 재컷 진행 상태. updating이면 플레이어가 재생을 막는다 (결정 3) */
  audioStatus: TakeAudioStatus;
}

export interface UpdateTakeInput {
  startMs: number;
  endMs: number;
  /** 목록에서 본 값. 다르면 409 take_version_conflict */
  version: number;
}
```

`packages/types/src/analysis.ts` 끝에:

```ts
/** take 재컷 잡 — AnalyzeSessionJob과 같은 큐를 쓴다. type이 없으면 분석 잡이다 (스펙 B §타입·API 계약) */
export type RecutTakeJob = { type: "recut"; takeId: string; version: number };
export type QueueJob = AnalyzeSessionJob | RecutTakeJob;
```

`packages/types/src/take-rules.ts` (서버·Mock·앱이 공유하는 순수 규칙):

```ts
/** take 최소 길이 (스펙 B 결정 5) */
export const MIN_TAKE_MS = 250;

export type TakeRangeError = "take_range_invalid" | "take_overlap";

/** 같은 세션에서 index가 바로 앞인 take의 endMs, 바로 뒤인 take의 startMs. 없으면 null */
export interface Neighbors {
  prevEndMs: number | null;
  nextStartMs: number | null;
}

/** 경계 규칙 — 정수, 0 ≤ start, end ≤ 길이, 최소 길이, 이웃과 겹침 금지. 통과하면 null */
export function checkTakeRange(startMs: number, endMs: number, durationMs: number, neighbors: Neighbors): TakeRangeError | null {
  if (!Number.isInteger(startMs) || !Number.isInteger(endMs)) return "take_range_invalid";
  if (startMs < 0 || endMs > durationMs || endMs - startMs < MIN_TAKE_MS) return "take_range_invalid";
  if (neighbors.prevEndMs !== null && startMs < neighbors.prevEndMs) return "take_overlap";
  if (neighbors.nextStartMs !== null && endMs > neighbors.nextStartMs) return "take_overlap";
  return null;
}

/** 같은 세션 take 목록에서 index 기준 이웃을 찾는다. 대상 자신은 제외 */
export function neighborsOf(rows: ReadonlyArray<{ index: number; startMs: number; endMs: number }>, index: number): Neighbors {
  let prevEndMs: number | null = null;
  let nextStartMs: number | null = null;
  for (const r of rows) {
    if (r.index < index && (prevEndMs === null || r.endMs > prevEndMs)) prevEndMs = r.endMs;
    if (r.index > index && (nextStartMs === null || r.startMs < nextStartMs)) nextStartMs = r.startMs;
  }
  return { prevEndMs, nextStartMs };
}
```

`packages/types/src/index.ts`에 `export * from "./take-rules";` 추가.

Run: `pnpm --filter @bandapp/types build`
Expected: 오류 없음.

- [ ] **Step 2: 스키마·마이그레이션**

`apps/api/src/db/schema.ts` — enum 목록(`takeType` 아래)에:

```ts
export const takeAudioStatus = pgEnum("take_audio_status", ["ready", "updating", "failed"]);
```

`takes` 테이블, `peaks` 아래에:

```ts
    // 경계 편집 낙관적 잠금. PATCH마다 +1 (2026-09-11 스펙 B 결정 4)
    version: integer("version").notNull().default(1),
    // 재컷 진행 상태 — updating이면 앱이 재생을 막는다. 실패 사유는 audio_error (결정 3)
    audioStatus: takeAudioStatus("audio_status").notNull().default("ready"),
    audioError: text("audio_error"),
```

Run: `pnpm --filter @bandapp/api db:generate`
Expected: `apps/api/drizzle/0009_*.sql`에 `CREATE TYPE "public"."take_audio_status" AS ENUM('ready', 'updating', 'failed');`, `ALTER TABLE "takes" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;`, `ADD COLUMN "audio_status" "take_audio_status" DEFAULT 'ready' NOT NULL;`, `ADD COLUMN "audio_error" text;`.

- [ ] **Step 3: 서버 매퍼·Mock 시드·e2e 기대값**

`apps/api/src/takes/takes.service.ts`: `TAKE_WITH_COUNT`에 `version: takes.version, audioStatus: takes.audioStatus,` (`peaks` 아래), `TakeRow`에 `version: number; audioStatus: TakeAudioStatus;`(`import type { ..., TakeAudioStatus } from "@bandapp/types"`), `toTake`에 `version: row.version, audioStatus: row.audioStatus,`.

`packages/api-client/src/mock/seed.ts` `generateTakes`의 객체 리터럴 끝에 `, version: 1, audioStatus: "ready" as const`.

`apps/api/test/takes.e2e-spec.ts` 첫 테스트 `toEqual` 첫 객체에 `version: 1, audioStatus: "ready"` 추가.

- [ ] **Step 4: 빌드·테스트 확인**

Run: `pnpm --filter @bandapp/api build` / `pnpm --filter @bandapp/api-client build` / `pnpm --filter @bandapp/api-client test` / `pnpm --filter mobile typecheck` / `pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/takes.e2e-spec.ts`
Expected: 전부 통과.

- [ ] **Step 5: 커밋**

```bash
git add packages/types/src apps/api/src/db/schema.ts apps/api/drizzle apps/api/src/takes/takes.service.ts packages/api-client/src/mock/seed.ts apps/api/test/takes.e2e-spec.ts
git commit -m "feat: add take version/audioStatus, recut job type and shared range rules" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: 경계 규칙 단위 테스트

**Files:**
- Test: `apps/api/src/takes/take-rules.spec.ts`

**Interfaces:**
- Consumes: `checkTakeRange`, `neighborsOf`, `MIN_TAKE_MS`(Task 1).

- [ ] **Step 1: 테스트 작성**

```ts
import { checkTakeRange, MIN_TAKE_MS, neighborsOf } from "@bandapp/types";
import { describe, expect, it } from "vitest";

const D = 600_000;
const none = { prevEndMs: null, nextStartMs: null };

describe("checkTakeRange", () => {
  it("정상 범위는 null", () => {
    expect(checkTakeRange(10_000, 250_500, D, none)).toBeNull();
    expect(checkTakeRange(0, D, D, none)).toBeNull();
  });
  it("정수가 아니거나 범위 밖이면 take_range_invalid", () => {
    expect(checkTakeRange(1.5, 5000, D, none)).toBe("take_range_invalid");
    expect(checkTakeRange(-1, 5000, D, none)).toBe("take_range_invalid");
    expect(checkTakeRange(0, D + 1, D, none)).toBe("take_range_invalid");
  });
  it("최소 길이 250ms", () => {
    expect(checkTakeRange(1000, 1000 + MIN_TAKE_MS, D, none)).toBeNull();
    expect(checkTakeRange(1000, 1000 + MIN_TAKE_MS - 1, D, none)).toBe("take_range_invalid");
  });
  it("이웃과 겹치면 take_overlap — 경계에 딱 닿는 건 허용", () => {
    const n = { prevEndMs: 50_000, nextStartMs: 300_000 };
    expect(checkTakeRange(50_000, 300_000, D, n)).toBeNull();
    expect(checkTakeRange(49_999, 300_000, D, n)).toBe("take_overlap");
    expect(checkTakeRange(50_000, 300_001, D, n)).toBe("take_overlap");
  });
});

describe("neighborsOf", () => {
  const rows = [
    { index: 0, startMs: 10_000, endMs: 60_000 },
    { index: 1, startMs: 100_000, endMs: 200_000 },
    { index: 3, startMs: 400_000, endMs: 500_000 }, // index 2는 지워진 take (번호 유지)
  ];
  it("index 기준 앞 take의 end, 뒤 take의 start", () => {
    expect(neighborsOf(rows, 1)).toEqual({ prevEndMs: 60_000, nextStartMs: 400_000 });
    expect(neighborsOf(rows, 3)).toEqual({ prevEndMs: 200_000, nextStartMs: null });
    expect(neighborsOf(rows, 0)).toEqual({ prevEndMs: null, nextStartMs: 100_000 });
  });
  it("여러 앞 take 중 가장 늦은 end, 여러 뒤 take 중 가장 이른 start", () => {
    expect(neighborsOf(rows, 2)).toEqual({ prevEndMs: 200_000, nextStartMs: 400_000 });
  });
});
```

- [ ] **Step 2: 실행**

Run: `pnpm --filter @bandapp/api exec vitest run src/takes/take-rules.spec.ts`
Expected: PASS (규칙은 Task 1에서 구현됨 — 여기서 실패하면 규칙을 고친다, 테스트를 고치지 않는다).

- [ ] **Step 3: 커밋**

```bash
git add apps/api/src/takes/take-rules.spec.ts
git commit -m "test(api): cover take range and neighbor rules" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `AnalysisProducer.enqueueRecut`

**Files:**
- Modify: `apps/api/src/analysis/analysis.producer.ts`
- Test: `apps/api/src/analysis/analysis.producer.spec.ts`
- Modify: `apps/api/test/app-util.ts` (`FakeProducer`)

**Interfaces:**
- Produces: `enqueueRecut(takeId: string, version: number): Promise<void>` — 메시지 본문 `{ type: "recut", takeId, version }`. `FakeProducer.recuts: Array<{ takeId; version }>`.

- [ ] **Step 1: 실패하는 테스트**

`analysis.producer.spec.ts` 끝(describe 안)에:

```ts
  it("sends a recut job with type, takeId and version to the same queue", async () => {
    const send = vi.fn().mockResolvedValue({});
    const producer = new AnalysisProducer({ send } as unknown as SQSClient);

    await producer.enqueueRecut("t-1", 3);

    const command = send.mock.calls[0][0] as SendMessageCommand;
    expect(command.input.QueueUrl).toBe(queueUrl);
    expect(JSON.parse(command.input.MessageBody!)).toEqual({ type: "recut", takeId: "t-1", version: 3 });
  });
```

Run: `pnpm --filter @bandapp/api exec vitest run src/analysis/analysis.producer.spec.ts`
Expected: FAIL — `enqueueRecut is not a function`.

- [ ] **Step 2: 구현**

`analysis.producer.ts` 전체:

```ts
import { Inject, Injectable } from "@nestjs/common";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { AnalyzeSessionJob, RecutTakeJob } from "@bandapp/types";
import { SQS_CLIENT } from "../queue/queue.constants.js";

@Injectable()
export class AnalysisProducer {
  constructor(@Inject(SQS_CLIENT) private readonly sqs: SQSClient) {}

  async enqueueAnalysis(sessionId: string): Promise<void> {
    const job: AnalyzeSessionJob = { sessionId };
    await this.send(job);
  }

  /** take 재컷 잡 — 분석과 같은 큐를 쓴다 (2026-09-11 스펙 B 결정 3). 컨슈머가 type으로 분기한다 */
  async enqueueRecut(takeId: string, version: number): Promise<void> {
    const job: RecutTakeJob = { type: "recut", takeId, version };
    await this.send(job);
  }

  private async send(job: AnalyzeSessionJob | RecutTakeJob): Promise<void> {
    const queueUrl = process.env.SQS_ANALYSIS_QUEUE_URL;
    if (!queueUrl) {
      throw new Error("SQS_ANALYSIS_QUEUE_URL is not set");
    }
    await this.sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(job) }));
  }
}
```

`apps/api/test/app-util.ts` `FakeProducer`에 필드와 메서드 추가:

```ts
  recuts: Array<{ takeId: string; version: number }> = [];
  async enqueueRecut(takeId: string, version: number): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("sqs down");
    }
    this.recuts.push({ takeId, version });
  }
```

- [ ] **Step 3: 통과 확인·커밋**

Run: `pnpm --filter @bandapp/api exec vitest run src/analysis/analysis.producer.spec.ts` → PASS. `pnpm --filter @bandapp/api build` → OK.

```bash
git add apps/api/src/analysis/analysis.producer.ts apps/api/src/analysis/analysis.producer.spec.ts apps/api/test/app-util.ts
git commit -m "feat(api): enqueue take recut jobs on the analysis queue" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: 워커 `TakeRecutService` + `decodePeaksFile`

**Files:**
- Modify: `apps/api/src/worker/peaks.ts` (`decodePeaksFile`)
- Test: `apps/api/src/worker/peaks.spec.ts`
- Create: `apps/api/src/worker/take-recut.service.ts`
- Test: `apps/api/src/worker/take-recut.service.spec.ts`

**Interfaces:**
- Consumes: `takeKey`(session-mapper), `FfmpegRunner.cut`, `StorageService.downloadToFile/putFile/deleteObjects`, `slicePeaks`, `encodePeaksFile`(스펙 A).
- Produces: `decodePeaksFile(buf: Buffer): { peaksPerSec: number; hires: Uint8Array }`; `class TakeRecutService { constructor(db, storage, ffmpeg, tmpRoot = tmpdir()); run(takeId: string, version: number): Promise<void> }`, `takeRecutServiceProvider`.

- [ ] **Step 1: 실패하는 테스트 — 파서**

`peaks.spec.ts` 끝에:

```ts
describe("decodePeaksFile", () => {
  it("encodePeaksFile의 역이다", () => {
    const hires = Uint8Array.from([0, 7, 255, 128]);
    const out = decodePeaksFile(encodePeaksFile(hires, 50));
    expect(out.peaksPerSec).toBe(50);
    expect(Array.from(out.hires)).toEqual([0, 7, 255, 128]);
  });
  it("magic·version·peaksPerSec가 틀리면 throw", () => {
    const ok = encodePeaksFile(new Uint8Array(0), 50);
    const badMagic = Buffer.from(ok);
    badMagic.write("XXXX", 0, "ascii");
    expect(() => decodePeaksFile(badMagic)).toThrow(/magic/);
    const badVersion = Buffer.from(ok);
    badVersion.writeUInt8(9, 4);
    expect(() => decodePeaksFile(badVersion)).toThrow(/version/);
    const zero = Buffer.from(ok);
    zero.writeUInt16LE(0, 5);
    expect(() => decodePeaksFile(zero)).toThrow(/peaksPerSec/);
    expect(() => decodePeaksFile(Buffer.alloc(3))).toThrow(/short/);
  });
});
```

import 줄에 `decodePeaksFile` 추가. Run → FAIL.

- [ ] **Step 2: 파서 구현**

`peaks.ts` 끝에:

```ts
/** peaks.bin → 고해상도 피크. encodePeaksFile의 역. 형식이 다르면 throw (호출자가 peaks null로 내려간다) */
export function decodePeaksFile(buf: Buffer): { peaksPerSec: number; hires: Uint8Array } {
  if (buf.length < PEAKS_FILE_HEADER_BYTES) throw new Error("peaks file too short");
  const magic = buf.subarray(0, 4).toString("ascii");
  if (magic !== PEAKS_FILE_MAGIC) throw new Error(`bad peaks magic: ${magic}`);
  const version = buf.readUInt8(4);
  if (version !== PEAKS_FILE_VERSION) throw new Error(`unsupported peaks version: ${version}`);
  const peaksPerSec = buf.readUInt16LE(5);
  if (peaksPerSec === 0) throw new Error("peaksPerSec is 0");
  return { peaksPerSec, hires: new Uint8Array(buf.subarray(PEAKS_FILE_HEADER_BYTES)) };
}
```

Run → PASS.

- [ ] **Step 3: 실패하는 테스트 — 재컷 서비스**

`take-recut.service.spec.ts`:

```ts
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../db/db.module.js";
import type { StorageService } from "../storage/storage.service.js";
import type { FfmpegRunner } from "./ffmpeg.js";
import { encodePeaksFile } from "./peaks.js";
import { TakeRecutService } from "./take-recut.service.js";

const MIN = 60_000;
const OLD_KEY = "bands/b/sessions/s/takes/t.m4a";
const PEAKS_KEY = "bands/b/sessions/s/peaks.bin";

/** 서비스가 쓰는 drizzle 표면만 흉내 낸다. update는 where의 version 조건 대신 opts.updateReturnsRows로 결과를 흉내 낸다 */
function fakeDb(take: { version: number; startMs: number; endMs: number; objectKey: string } | undefined, opts: { peaksKey?: string | null; updateReturnsRows?: boolean } = {}) {
  const state = { updates: [] as Array<Record<string, unknown>> };
  const db = {
    query: {
      takes: { findFirst: async () => (take ? { id: "t", sessionId: "s", ...take } : undefined) },
      sessions: { findFirst: async () => ({ id: "s", bandId: "b", peaksKey: opts.peaksKey ?? null }) },
      recordings: { findFirst: async () => ({ objectKey: "bands/b/sessions/s/original.m4a" }) },
    },
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            state.updates.push(v);
            return opts.updateReturnsRows === false ? [] : [{ id: "t" }];
          },
        }),
      }),
    }),
  };
  return { db: db as unknown as Db, state };
}

/** 10분 지점에서 0→255로 뛰는 계단 사이드카 — 슬라이스가 실제 startMs/endMs를 쓰는지 본다 */
function fakeStorage(opts: { failCutPut?: boolean } = {}) {
  const calls = { downloads: [] as string[], puts: [] as string[], deleted: [] as string[] };
  const storage = {
    downloadToFile: async (key: string, path: string) => {
      calls.downloads.push(key);
      if (key.endsWith("peaks.bin")) {
        const hires = Uint8Array.from({ length: 30 * 60 * 50 }, (_, i) => (i < 10 * 60 * 50 ? 0 : 255));
        writeFileSync(path, encodePeaksFile(hires, 50));
      }
    },
    putFile: async (key: string) => {
      if (opts.failCutPut) throw new Error("r2 down");
      calls.puts.push(key);
    },
    deleteObjects: async (keys: string[]) => {
      calls.deleted.push(...keys);
    },
  } as unknown as StorageService;
  return { storage, calls };
}

function fakeFfmpeg() {
  const cuts: Array<{ startMs: number; endMs: number; output: string }> = [];
  const ffmpeg: FfmpegRunner = {
    probeDurationMs: async () => 0,
    cut: async (_i, startMs, endMs, output) => {
      cuts.push({ startMs, endMs, output });
      writeFileSync(output, "fake m4a");
    },
    peaks: async () => new Uint8Array(0),
  };
  return { ffmpeg, cuts };
}

describe("TakeRecutService.run", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "recut-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("cuts to a new versioned key, slices peaks from the sidecar, marks ready and deletes the old key", async () => {
    const { db, state } = fakeDb({ version: 2, startMs: 12 * MIN, endMs: 15 * MIN, objectKey: OLD_KEY }, { peaksKey: PEAKS_KEY });
    const { storage, calls } = fakeStorage();
    const { ffmpeg, cuts } = fakeFfmpeg();
    await new TakeRecutService(db, storage, ffmpeg, tmp).run("t", 2);
    expect(calls.downloads).toEqual(["bands/b/sessions/s/original.m4a", PEAKS_KEY]);
    expect(cuts[0]).toMatchObject({ startMs: 12 * MIN, endMs: 15 * MIN });
    expect(calls.puts).toEqual(["bands/b/sessions/s/takes/t-v2.m4a"]);
    const done = state.updates.at(-1)!;
    expect(done).toMatchObject({ objectKey: "bands/b/sessions/s/takes/t-v2.m4a", audioStatus: "ready", audioError: null });
    const peaks = done.peaks as number[];
    expect(peaks).toHaveLength(128);
    expect(peaks.every((p) => p === 255)).toBe(true); // 12~15분은 계단 이후
    expect(calls.deleted).toEqual([OLD_KEY]);
    expect(existsSync(join(tmp))).toBe(true); // 임시 디렉터리 자체는 남지만 작업 폴더는 지워진다
  });

  it("stores null peaks when the session has no sidecar", async () => {
    const { db, state } = fakeDb({ version: 1, startMs: 0, endMs: MIN, objectKey: OLD_KEY }, { peaksKey: null });
    const { storage, calls } = fakeStorage();
    await new TakeRecutService(db, storage, fakeFfmpeg().ffmpeg, tmp).run("t", 1);
    expect(calls.downloads).toEqual(["bands/b/sessions/s/original.m4a"]);
    expect(state.updates.at(-1)).toMatchObject({ audioStatus: "ready", peaks: null });
  });

  it("skips a stale job whose version no longer matches", async () => {
    const { db, state } = fakeDb({ version: 3, startMs: 0, endMs: MIN, objectKey: OLD_KEY });
    const { storage, calls } = fakeStorage();
    await new TakeRecutService(db, storage, fakeFfmpeg().ffmpeg, tmp).run("t", 2);
    expect(calls.downloads).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  it("marks the take failed with the error when the cut upload fails", async () => {
    const { db, state } = fakeDb({ version: 1, startMs: 0, endMs: MIN, objectKey: OLD_KEY });
    const { storage, calls } = fakeStorage({ failCutPut: true });
    await new TakeRecutService(db, storage, fakeFfmpeg().ffmpeg, tmp).run("t", 1);
    expect(state.updates.at(-1)).toMatchObject({ audioStatus: "failed", audioError: "r2 down" });
    expect(calls.deleted).toEqual([]);
  });

  it("deletes the freshly uploaded object when a newer edit won the race", async () => {
    const { db } = fakeDb({ version: 1, startMs: 0, endMs: MIN, objectKey: OLD_KEY }, { updateReturnsRows: false });
    const { storage, calls } = fakeStorage();
    await new TakeRecutService(db, storage, fakeFfmpeg().ffmpeg, tmp).run("t", 1);
    expect(calls.deleted).toEqual(["bands/b/sessions/s/takes/t-v1.m4a"]);
  });

  it("does nothing when the take was deleted meanwhile", async () => {
    const { db, state } = fakeDb(undefined);
    const { storage, calls } = fakeStorage();
    await new TakeRecutService(db, storage, fakeFfmpeg().ffmpeg, tmp).run("t", 1);
    expect(calls.downloads).toEqual([]);
    expect(state.updates).toEqual([]);
  });
});
```

Run: `pnpm --filter @bandapp/api exec vitest run src/worker/take-recut.service.spec.ts` → FAIL (모듈 없음).

- [ ] **Step 4: 서비스 구현**

`take-recut.service.ts`:

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { PEAK_BUCKETS } from "@bandapp/types";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { recordings, sessions, takes } from "../db/schema.js";
import { takeKey } from "../sessions/session-mapper.js";
import { StorageService } from "../storage/storage.service.js";
import { ExecFfmpegRunner, type FfmpegRunner } from "./ffmpeg.js";
import { decodePeaksFile, slicePeaks } from "./peaks.js";

const TAKE_CONTENT_TYPE = "audio/mp4";

/**
 * take 경계가 바뀐 뒤 오디오를 다시 자른다 (2026-09-11 스펙 B §워커). 결과는 새 키(`{takeId}-v{version}`)에 올리고
 * 옛 키를 지운다 — 같은 키에 덮어쓰면 앱이 1시간 캐시한 presigned URL이 옛 파일을 가리킨다 (결정 9).
 * 피크는 원본을 디코드하지 않고 peaks.bin 사이드카를 잘라 계산한다 (결정 10).
 * 잡의 version이 현재와 다르면 이미 다음 편집이 덮어썼으므로 건너뛴다 (결정 11).
 */
export class TakeRecutService {
  private readonly logger = new Logger(TakeRecutService.name);

  constructor(
    private readonly db: Db,
    private readonly storage: StorageService,
    private readonly ffmpeg: FfmpegRunner,
    private readonly tmpRoot: string = tmpdir(),
  ) {}

  async run(takeId: string, version: number): Promise<void> {
    const take = await this.db.query.takes.findFirst({ where: eq(takes.id, takeId) });
    if (!take) {
      this.logger.warn(`take ${takeId} not found (deleted?), ignoring recut`);
      return;
    }
    if (take.version !== version) {
      this.logger.log(`take ${takeId}: recut v${version} is stale (now v${take.version}), skipping`);
      return;
    }
    const session = await this.db.query.sessions.findFirst({ where: eq(sessions.id, take.sessionId) });
    const recording = await this.db.query.recordings.findFirst({ where: eq(recordings.sessionId, take.sessionId) });
    if (!session || !recording) {
      await this.fail(takeId, version, "녹음 파일 정보가 없어요.");
      return;
    }

    const workDir = await mkdtemp(join(this.tmpRoot, `recut-${takeId}-`));
    const newKey = takeKey(session.bandId, session.id, `${takeId}-v${version}`);
    try {
      const original = join(workDir, "original.m4a");
      await this.storage.downloadToFile(recording.objectKey, original);
      const output = join(workDir, "take.m4a");
      await this.ffmpeg.cut(original, take.startMs, take.endMs, output);
      await this.storage.putFile(newKey, output, TAKE_CONTENT_TYPE);
      const peaks = await this.peaksFromSidecar(session.peaksKey, take.startMs, take.endMs, workDir);
      const updated = await this.db
        .update(takes)
        .set({ objectKey: newKey, peaks, audioStatus: "ready", audioError: null })
        .where(and(eq(takes.id, takeId), eq(takes.version, version)))
        .returning({ id: takes.id });
      if (updated.length === 0) {
        // 자르는 동안 다음 편집이 version을 올렸다 — 방금 올린 객체는 고아라 바로 지운다
        this.logger.log(`take ${takeId}: v${version} superseded during recut, discarding ${newKey}`);
        await this.storage.deleteObjects([newKey]).catch((err: unknown) => this.logger.warn(`orphan delete failed: ${String(err)}`));
        return;
      }
      if (take.objectKey !== newKey) {
        await this.storage.deleteObjects([take.objectKey]).catch((err: unknown) => this.logger.warn(`old take object delete failed: ${String(err)}`));
      }
      this.logger.log(`take ${takeId}: recut v${version} ready, peaks ${peaks ? "sliced" : "none"}`);
    } catch (err) {
      this.logger.error(`take ${takeId}: recut v${version} failed: ${String(err)}`);
      await this.fail(takeId, version, err instanceof Error ? err.message : String(err));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /** 사이드카가 없거나 못 읽으면 null — 파형은 장식이라 재컷을 막지 않는다 */
  private async peaksFromSidecar(peaksKey: string | null, startMs: number, endMs: number, workDir: string): Promise<number[] | null> {
    if (!peaksKey) return null;
    try {
      const path = join(workDir, "peaks.bin");
      await this.storage.downloadToFile(peaksKey, path);
      const { peaksPerSec, hires } = decodePeaksFile(await readFile(path));
      return slicePeaks(hires, peaksPerSec, startMs, endMs, PEAK_BUCKETS);
    } catch (err) {
      this.logger.warn(`peaks sidecar unusable, storing null: ${String(err)}`);
      return null;
    }
  }

  private async fail(takeId: string, version: number, message: string): Promise<void> {
    await this.db
      .update(takes)
      .set({ audioStatus: "failed", audioError: message.slice(0, 500) })
      .where(and(eq(takes.id, takeId), eq(takes.version, version)))
      .returning({ id: takes.id });
  }
}

export const takeRecutServiceProvider: Provider = {
  provide: TakeRecutService,
  useFactory: (db: Db, storage: StorageService) => new TakeRecutService(db, storage, new ExecFfmpegRunner()),
  inject: [DB, StorageService],
};
```

Run: `pnpm --filter @bandapp/api exec vitest run src/worker` → PASS. `pnpm --filter @bandapp/api build` → OK.

- [ ] **Step 5: 커밋**

```bash
git add apps/api/src/worker/peaks.ts apps/api/src/worker/peaks.spec.ts apps/api/src/worker/take-recut.service.ts apps/api/src/worker/take-recut.service.spec.ts
git commit -m "feat(worker): recut a take to a versioned key and reslice peaks from the sidecar" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: 컨슈머 분기와 워커 모듈

**Files:**
- Modify: `apps/api/src/worker/analysis.consumer.ts`
- Modify: `apps/api/src/worker/analysis.consumer.spec.ts`
- Modify: `apps/api/src/worker/worker.module.ts`

**Interfaces:**
- Consumes: `TakeRecutService`(Task 4), `QueueJob`(Task 1).
- Produces: `new AnalysisConsumer(sqs, analysis, recut, options?)` — 생성자에 `recut` 인자가 셋째로 들어간다.

- [ ] **Step 1: 실패하는 테스트**

`analysis.consumer.spec.ts`의 `makeConsumer`를 교체하고 테스트 하나 추가:

```ts
  function makeConsumer(
    send: ReturnType<typeof vi.fn>,
    run: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined),
    options: { heartbeatMs?: number; maxHeartbeats?: number } = { heartbeatMs: 10 },
    recutRun: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined),
  ) {
    const analysis = { run } as unknown as SessionAnalysisService;
    const recut = { run: recutRun } as unknown as TakeRecutService;
    return { consumer: new AnalysisConsumer({ send } as unknown as SQSClient, analysis, recut, options), run, recutRun };
  }
```

(`import type { TakeRecutService } from "./take-recut.service.js";` 추가.)

```ts
  it("dispatches recut jobs to TakeRecutService and analysis jobs to SessionAnalysisService", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Messages: [
          { Body: JSON.stringify({ type: "recut", takeId: "t-1", version: 4 }), ReceiptHandle: "rh-1" },
          { Body: JSON.stringify({ sessionId: "s-1" }), ReceiptHandle: "rh-2" },
        ],
      })
      .mockResolvedValue({});
    const { consumer, run, recutRun } = makeConsumer(send);

    await consumer.pollOnce();

    expect(recutRun).toHaveBeenCalledWith("t-1", 4);
    expect(run).toHaveBeenCalledWith("s-1");
  });

  it("does not delete a recut message without a numeric version", async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Messages: [{ Body: JSON.stringify({ type: "recut", takeId: "t-1" }), ReceiptHandle: "rh-1" }],
    });
    const { consumer, recutRun } = makeConsumer(send);
    await consumer.pollOnce();
    expect(recutRun).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });
```

Run: `pnpm --filter @bandapp/api exec vitest run src/worker/analysis.consumer.spec.ts` → FAIL (생성자 인자·분기 없음).

- [ ] **Step 2: 구현**

`analysis.consumer.ts`: import를 `import type { AnalyzeSessionJob, QueueJob } from "@bandapp/types";`, `import { TakeRecutService } from "./take-recut.service.js";`. 생성자:

```ts
  constructor(
    private readonly sqs: SQSClient,
    private readonly analysis: SessionAnalysisService,
    private readonly recut: TakeRecutService,
    { heartbeatMs = DEFAULT_HEARTBEAT_MS, maxHeartbeats = MAX_HEARTBEATS }: AnalysisConsumerOptions = {},
  ) {
```

`handleMessage`:

```ts
  private async handleMessage(message: Message): Promise<void> {
    const job = JSON.parse(message.Body ?? "") as QueueJob;
    // type이 있으면 재컷, 없으면 분석 — 같은 큐를 쓴다 (2026-09-11 스펙 B 결정 3)
    if ("type" in job && job.type === "recut") {
      if (typeof job.takeId !== "string" || typeof job.version !== "number") throw new Error("recut message has no takeId/version");
      this.logger.log(`received recut job: takeId=${job.takeId} v${job.version}`);
      await this.recut.run(job.takeId, job.version);
      return;
    }
    const analysis = job as AnalyzeSessionJob;
    if (typeof analysis.sessionId !== "string") throw new Error("message has no sessionId");
    this.logger.log(`received analysis job: sessionId=${analysis.sessionId}`);
    await this.analysis.run(analysis.sessionId);
  }
```

provider:

```ts
export const analysisConsumerProvider: Provider = {
  provide: AnalysisConsumer,
  useFactory: (sqs: SQSClient, analysis: SessionAnalysisService, recut: TakeRecutService) => new AnalysisConsumer(sqs, analysis, recut),
  inject: [SQS_CLIENT, SessionAnalysisService, TakeRecutService],
};
```

`worker.module.ts` providers에 `takeRecutServiceProvider` 추가(`import { takeRecutServiceProvider } from "./take-recut.service.js";`).

- [ ] **Step 3: 확인·커밋**

Run: `pnpm --filter @bandapp/api exec vitest run src/worker` → PASS. `pnpm --filter @bandapp/api build` → OK.

```bash
git add apps/api/src/worker/analysis.consumer.ts apps/api/src/worker/analysis.consumer.spec.ts apps/api/src/worker/worker.module.ts
git commit -m "feat(worker): dispatch recut jobs from the analysis consumer" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `PATCH /takes/:id`, `DELETE /takes/:id`

**Files:**
- Modify: `apps/api/src/takes/takes.service.ts`
- Modify: `apps/api/src/takes/takes.controller.ts`
- Modify: `apps/api/src/takes/takes.module.ts`
- Test: `apps/api/test/takes.e2e-spec.ts`

**Interfaces:**
- Consumes: `checkTakeRange`, `neighborsOf`(Task 1), `AnalysisProducer.enqueueRecut`(Task 3), `SessionsService.loadForMember`(SessionRow: `status`, `durationMs`).
- Produces: `TakesService.update(takeId, userId, input: UpdateTakeInput): Promise<Take>`, `TakesService.remove(takeId, userId): Promise<void>`; HTTP `PATCH /takes/:id` → `Take`, `DELETE /takes/:id` → 204.

- [ ] **Step 1: 실패하는 e2e 테스트**

`takes.e2e-spec.ts` — import에 `FakeProducer`를 더하고(`import { FakeProducer, FakeStorage, createTestApp, loginAs, providerUser } from "./app-util.js";`), `beforeEach`에서 `producer = new FakeProducer(); storage = new FakeStorage(); app = await createTestApp({ google: providerUser("owner-1"), storage, producer });`로 바꾼다(`let producer: FakeProducer; let storage: FakeStorage;` 선언). 파일 끝(describe 안)에:

```ts
  async function takeByIndex(index: number) {
    const [row] = await db.select().from(takes).where(eq(takes.index, index));
    return row!;
  }

  describe("PATCH /takes/:id", () => {
    it("경계를 바꾸면 version+1, updating, 코멘트 시각 이동, 재컷 잡 발행", async () => {
      const t1 = await takeByIndex(0); // 10_000 ~ 250_500
      await db.insert(comments).values({ sessionId, takeId: t1.id, authorId: owner.userId, atMs: 30_000, text: "x" });
      const res = await request(app.getHttpServer())
        .patch(`/takes/${t1.id}`)
        .set(auth(owner.accessToken))
        .send({ startMs: 20_000, endMs: 240_000, version: 1 })
        .expect(200);
      expect(res.body).toMatchObject({ id: t1.id, startMs: 20_000, endMs: 240_000, durationSec: 220, version: 2, audioStatus: "updating" });
      const [c] = await db.select().from(comments).where(eq(comments.takeId, t1.id));
      expect(c!.atMs).toBe(20_000); // 절대 시각 40s 유지: 30s − (20s − 10s)
      expect(producer.recuts).toEqual([{ takeId: t1.id, version: 2 }]);
    });

    it("version이 다르면 409 take_version_conflict", async () => {
      const t1 = await takeByIndex(0);
      const res = await request(app.getHttpServer()).patch(`/takes/${t1.id}`).set(auth(owner.accessToken)).send({ startMs: 20_000, endMs: 240_000, version: 5 }).expect(409);
      expect(res.body.code).toBe("take_version_conflict");
    });

    it("이웃과 겹치면 400 take_overlap, 범위 밖·짧으면 400 take_range_invalid", async () => {
      const t1 = await takeByIndex(0);
      const overlap = await request(app.getHttpServer()).patch(`/takes/${t1.id}`).set(auth(owner.accessToken)).send({ startMs: 10_000, endMs: 300_001, version: 1 }).expect(400);
      expect(overlap.body.code).toBe("take_overlap");
      const short = await request(app.getHttpServer()).patch(`/takes/${t1.id}`).set(auth(owner.accessToken)).send({ startMs: 10_000, endMs: 10_100, version: 1 }).expect(400);
      expect(short.body.code).toBe("take_range_invalid");
      const beyond = await request(app.getHttpServer()).patch(`/takes/${t1.id}`).set(auth(owner.accessToken)).send({ startMs: 10_000, endMs: 600_001, version: 1 }).expect(400);
      expect(beyond.body.code).toBe("take_range_invalid");
    });

    it("세션이 ready가 아니면 409 session_not_ready", async () => {
      await db.update(sessions).set({ status: "analyzing" }).where(eq(sessions.id, sessionId));
      const t1 = await takeByIndex(0);
      const res = await request(app.getHttpServer()).patch(`/takes/${t1.id}`).set(auth(owner.accessToken)).send({ startMs: 20_000, endMs: 240_000, version: 1 }).expect(409);
      expect(res.body.code).toBe("session_not_ready");
    });

    it("큐 발행이 실패하면 failed로 남는다", async () => {
      producer.failNext = true;
      const t1 = await takeByIndex(0);
      const res = await request(app.getHttpServer()).patch(`/takes/${t1.id}`).set(auth(owner.accessToken)).send({ startMs: 20_000, endMs: 240_000, version: 1 }).expect(200);
      expect(res.body).toMatchObject({ version: 2, audioStatus: "failed" });
    });

    it("비멤버는 403", async () => {
      const other = await createTestApp({ google: providerUser("stranger-1", "S"), storage: new FakeStorage() });
      const stranger = await loginAs(other);
      await other.close();
      const t1 = await takeByIndex(0);
      await request(app.getHttpServer()).patch(`/takes/${t1.id}`).set(auth(stranger.accessToken)).send({ startMs: 20_000, endMs: 240_000, version: 1 }).expect(403);
    });
  });

  describe("DELETE /takes/:id", () => {
    it("행·코멘트가 사라지고 takeCount가 줄고 객체가 지워진다", async () => {
      const t1 = await takeByIndex(0);
      await db.insert(comments).values({ sessionId, takeId: t1.id, authorId: owner.userId, atMs: 1000, text: "x" });
      await request(app.getHttpServer()).delete(`/takes/${t1.id}`).set(auth(owner.accessToken)).expect(204);
      expect(await db.select().from(takes).where(eq(takes.id, t1.id))).toEqual([]);
      expect(await db.select().from(comments).where(eq(comments.takeId, t1.id))).toEqual([]);
      const [s] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
      expect(s!.takeCount).toBe(1);
      expect(storage.deleted).toEqual([t1.objectKey]);
      // 남은 take의 이름·index는 그대로 (결정 6)
      const list = await request(app.getHttpServer()).get(`/sessions/${sessionId}/takes`).set(auth(owner.accessToken)).expect(200);
      expect(list.body.map((t: { index: number; name: string }) => [t.index, t.name])).toEqual([[1, "Take 2"]]);
      await request(app.getHttpServer()).get(`/takes/${t1.id}/audio`).set(auth(owner.accessToken)).expect(404);
    });

    it("세션이 ready가 아니면 409", async () => {
      await db.update(sessions).set({ status: "analyzing" }).where(eq(sessions.id, sessionId));
      const t1 = await takeByIndex(0);
      await request(app.getHttpServer()).delete(`/takes/${t1.id}`).set(auth(owner.accessToken)).expect(409);
    });
  });
```

`FakeStorage`에 `deleted: string[]`가 이미 있고 `deleteObjects`가 push하는지 `app-util.ts`에서 확인한다 — 없으면 `async deleteObjects(keys: string[]) { this.deleted.push(...keys); }`를 추가한다.

Run: `pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/takes.e2e-spec.ts` → 새 테스트 FAIL(404 라우트 없음).

- [ ] **Step 2: 서비스 구현**

`takes.service.ts` import 교체·추가:

```ts
import { BadRequestException, ConflictException, Logger, NotFoundException } from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import { checkTakeRange, neighborsOf, type AudioUrl, type Take, type TakeAudioStatus, type TakeCandidateType, type TakeRangeError, type UpdateTakeInput } from "@bandapp/types";
import { AnalysisProducer } from "../analysis/analysis.producer.js";
import { comments, sessions, takes } from "../db/schema.js";
import { type SessionRow } from "../sessions/session-mapper.js";
```

오류 문구 표(클래스 위):

```ts
const RANGE_MESSAGES: Record<TakeRangeError, string> = {
  take_range_invalid: "take 구간이 올바르지 않아요.",
  take_overlap: "옆 take와 겹칠 수 없어요.",
};
```

클래스: 생성자에 `private readonly producer: AnalysisProducer` 추가, `logger`, 메서드 세 개:

```ts
  private readonly logger = new Logger(TakesService.name);

  private async loadWithSession(takeId: string, userId: string): Promise<{ take: TakeRow; session: SessionRow }> {
    const [take] = await this.db.select(TAKE_WITH_COUNT).from(takes).where(eq(takes.id, takeId));
    if (!take) throw new NotFoundException("Take를 찾을 수 없어요.");
    const session = await this.sessions.loadForMember(take.sessionId, userId);
    return { take, session };
  }

  /**
   * 경계 변경 (2026-09-11 스펙 B). DB만 바꾸고 재컷은 워커 잡으로 넘긴다 (결정 3). 코멘트는 절대 시각을 보존하도록
   * at_ms를 함께 옮긴다 (결정 2). 같은 값을 다시 보내도 받는다 — 실패 재시도로 쓴다.
   */
  async update(takeId: string, userId: string, input: UpdateTakeInput): Promise<Take> {
    const { take, session } = await this.loadWithSession(takeId, userId);
    if (session.status !== "ready") throw new ConflictException({ message: "분석 중에는 take를 고칠 수 없어요.", code: "session_not_ready" });
    if (input.version !== take.version) throw new ConflictException({ message: "다른 멤버가 먼저 고쳤어요.", code: "take_version_conflict" });
    const siblings = await this.db.select({ index: takes.index, startMs: takes.startMs, endMs: takes.endMs }).from(takes).where(eq(takes.sessionId, take.sessionId));
    const error = checkTakeRange(input.startMs, input.endMs, session.durationMs ?? 0, neighborsOf(siblings, take.index));
    if (error) throw new BadRequestException({ message: RANGE_MESSAGES[error], code: error });

    const nextVersion = take.version + 1;
    const shiftMs = take.startMs - input.startMs;
    await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(takes)
        .set({ startMs: input.startMs, endMs: input.endMs, version: nextVersion, audioStatus: "updating", audioError: null })
        .where(and(eq(takes.id, takeId), eq(takes.version, input.version)))
        .returning({ id: takes.id });
      // 검사와 갱신 사이에 다른 요청이 먼저 갔다 — 같은 409로 알린다
      if (updated.length === 0) throw new ConflictException({ message: "다른 멤버가 먼저 고쳤어요.", code: "take_version_conflict" });
      if (shiftMs !== 0) await tx.update(comments).set({ atMs: sql`${comments.atMs} + ${shiftMs}` }).where(eq(comments.takeId, takeId));
    });

    try {
      await this.producer.enqueueRecut(takeId, nextVersion);
    } catch (err) {
      // 큐 실패는 사용자가 Save를 다시 눌러 복구한다 — 세션 enqueue 실패와 같은 패턴
      this.logger.error(`failed to enqueue recut for take ${takeId}: ${String(err)}`);
      await this.db
        .update(takes)
        .set({ audioStatus: "failed", audioError: "재컷 요청을 보내지 못했어요." })
        .where(and(eq(takes.id, takeId), eq(takes.version, nextVersion)));
    }
    const [row] = await this.db.select(TAKE_WITH_COUNT).from(takes).where(eq(takes.id, takeId));
    return toTake(row!);
  }

  /** 삭제 (결정 1·6). 코멘트는 FK cascade. 남은 take의 name·index는 그대로. 객체 삭제 실패는 정리 배치(백로그)가 줍는다 */
  async remove(takeId: string, userId: string): Promise<void> {
    const { take, session } = await this.loadWithSession(takeId, userId);
    if (session.status !== "ready") throw new ConflictException({ message: "분석 중에는 take를 지울 수 없어요.", code: "session_not_ready" });
    await this.db.transaction(async (tx) => {
      await tx.delete(takes).where(eq(takes.id, takeId));
      await tx
        .update(sessions)
        .set({ takeCount: sql`greatest(${sessions.takeCount} - 1, 0)`, updatedAt: new Date() })
        .where(eq(sessions.id, take.sessionId));
    });
    await this.storage.deleteObjects([take.objectKey]).catch((err: unknown) => this.logger.warn(`take object delete failed for ${take.objectKey}: ${String(err)}`));
  }
```

provider:

```ts
export const takesServiceProvider: Provider = {
  provide: TakesService,
  useFactory: (db: Db, sessions: SessionsService, storage: StorageService, producer: AnalysisProducer) =>
    new TakesService(db, sessions, storage, producer),
  inject: [DB, SessionsService, StorageService, AnalysisProducer],
};
```

`takes.module.ts` imports에 `AnalysisModule` 추가(`import { AnalysisModule } from "../analysis/analysis.module.js";`).

- [ ] **Step 3: 컨트롤러**

`takes.controller.ts`:

```ts
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, UseGuards } from "@nestjs/common";
import type { AudioUrl, Take } from "@bandapp/types";
import { requireInteger, requireUuidParam } from "../common/validation.js";
```

메서드 추가:

```ts
  @Patch("takes/:id")
  update(@CurrentUserId() userId: string, @Param("id") id: string, @Body() body: unknown): Promise<Take> {
    requireUuidParam(id, "id");
    return this.takes.update(id, userId, {
      startMs: requireInteger(body, "startMs", { min: 0 }),
      endMs: requireInteger(body, "endMs", { min: 0 }),
      version: requireInteger(body, "version", { min: 1 }),
    });
  }

  @Delete("takes/:id")
  @HttpCode(204)
  async remove(@CurrentUserId() userId: string, @Param("id") id: string): Promise<void> {
    requireUuidParam(id, "id");
    await this.takes.remove(id, userId);
  }
```

- [ ] **Step 4: 확인·커밋**

Run: e2e takes → PASS. `pnpm --filter @bandapp/api lint` → 오류 0. `pnpm --filter @bandapp/api build` → OK. `pnpm --filter @bandapp/api test` 전체 → PASS.

```bash
git add apps/api/src/takes apps/api/test/takes.e2e-spec.ts apps/api/test/app-util.ts
git commit -m "feat(api): PATCH/DELETE takes with comment shift, version lock and recut job" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: api-client `takes.update` / `takes.remove`

**Files:**
- Modify: `packages/api-client/src/client.ts`, `packages/api-client/src/http/HttpApiClient.ts`, `packages/api-client/src/mock/MockApiClient.ts`
- Test: `packages/api-client/src/http/HttpApiClient.spec.ts`, `packages/api-client/src/mock/MockApiClient.spec.ts`

**Interfaces:**
- Produces: `api.takes.update(takeId, input: UpdateTakeInput): Promise<Take>`, `api.takes.remove(takeId): Promise<void>` — 둘 다 `emit()`. Mock은 1.5초 뒤 `ready`로 바꾸며 다시 `emit()`; `MockApiClient.recutDelayMs`(기본 1500)로 테스트가 0으로 줄인다.

- [ ] **Step 1: 실패하는 테스트**

`HttpApiClient.spec.ts` 끝에:

```ts
  it("takes.update는 PATCH /takes/:id, takes.remove는 DELETE — 둘 다 구독자에게 알린다", async () => {
    const tokens = memoryTokens({ accessToken: "a1", refreshToken: "r1" });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(json(200, { id: "t1", version: 2, audioStatus: "updating" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new HttpApiClient({ baseUrl: "https://api.test", tokens, fetchFn });
    const listener = vi.fn();
    client.subscribe(listener);
    const take = await client.takes.update("t1", { startMs: 1000, endMs: 5000, version: 1 });
    expect(take.version).toBe(2);
    expect(fetchFn).toHaveBeenCalledWith("https://api.test/takes/t1", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ startMs: 1000, endMs: 5000, version: 1 }) }));
    await client.takes.remove("t1");
    expect(fetchFn).toHaveBeenCalledWith("https://api.test/takes/t1", expect.objectContaining({ method: "DELETE" }));
    expect(listener).toHaveBeenCalledTimes(2);
  });
```

`MockApiClient.spec.ts` 끝에:

```ts
describe("MockApiClient takes 편집", () => {
  it("update는 경계·version을 바꾸고 코멘트 atSec을 옮기며 잠시 뒤 ready가 된다", async () => {
    const api = new MockApiClient();
    api.recutDelayMs = 0;
    const [t] = await api.takes.list("s1");
    await api.comments.create({ takeId: t!.id }, { atSec: 30, text: "hi" });
    const updated = await api.takes.update(t!.id, { startMs: t!.startMs + 10_000, endMs: t!.endMs, version: t!.version });
    expect(updated).toMatchObject({ startMs: t!.startMs + 10_000, version: t!.version + 1, audioStatus: "updating" });
    const [c] = await api.comments.list({ takeId: t!.id });
    expect(c!.atSec).toBe(20);
    await new Promise((r) => setTimeout(r, 5));
    const [after] = await api.takes.list("s1");
    expect(after!.audioStatus).toBe("ready");
  });
  it("version이 다르면 409 take_version_conflict, 겹치면 400 take_overlap", async () => {
    const api = new MockApiClient();
    const [a, b] = await api.takes.list("s1");
    await expect(api.takes.update(a!.id, { startMs: a!.startMs, endMs: a!.endMs, version: 99 })).rejects.toMatchObject({ status: 409, code: "take_version_conflict" });
    await expect(api.takes.update(a!.id, { startMs: a!.startMs, endMs: b!.startMs + 1, version: a!.version })).rejects.toMatchObject({ status: 400, code: "take_overlap" });
  });
  it("remove는 take와 코멘트를 지우고 takeCount를 줄이며 남은 이름은 그대로", async () => {
    const api = new MockApiClient();
    const before = await api.takes.list("s1");
    await api.comments.create({ takeId: before[0]!.id }, { atSec: 1, text: "x" });
    await api.takes.remove(before[0]!.id);
    const after = await api.takes.list("s1");
    expect(after).toHaveLength(before.length - 1);
    expect(after[0]!.name).toBe(before[1]!.name);
    expect(await api.comments.list({ takeId: before[0]!.id })).toEqual([]);
    const s = await api.sessions.get("s1");
    expect(s.takeCount).toBe(before.length - 1);
  });
});
```

Run: `pnpm --filter @bandapp/api-client test` → FAIL.

- [ ] **Step 2: 구현**

`client.ts` `takes`:

```ts
  takes: {
    list(sessionId: string): Promise<Take[]>;
    audioUrl(takeId: string): Promise<AudioUrl>;
    /** 경계 변경. 409 take_version_conflict / session_not_ready, 400 take_range_invalid / take_overlap. 응답은 audioStatus "updating" */
    update(takeId: string, input: UpdateTakeInput): Promise<Take>;
    /** 삭제. 코멘트도 함께 사라진다 */
    remove(takeId: string): Promise<void>;
  };
```

(`UpdateTakeInput`을 `@bandapp/types` import에 추가.)

`HttpApiClient.ts` `takes`:

```ts
    update: async (takeId: string, input: UpdateTakeInput): Promise<Take> => {
      const take = await this.request<Take>("PATCH", `/takes/${takeId}`, input);
      this.emit();
      return take;
    },
    remove: async (takeId: string): Promise<void> => {
      await this.request<void>("DELETE", `/takes/${takeId}`);
      this.emit();
    },
```

`MockApiClient.ts` — import에 `checkTakeRange, neighborsOf, type UpdateTakeInput` 추가, 클래스에 `recutDelayMs = 1500;` 필드, `takes`:

```ts
    update: async (takeId: string, input: UpdateTakeInput): Promise<Take> => {
      const take = this.findTake(takeId);
      if (!take) throw new ApiError(404, "Take를 찾을 수 없어요.");
      const session = this.mustSession(take.sessionId);
      if (session.status !== "ready") throw new ApiError(409, "분석 중에는 take를 고칠 수 없어요.", "session_not_ready");
      if (input.version !== take.version) throw new ApiError(409, "다른 멤버가 먼저 고쳤어요.", "take_version_conflict");
      const siblings = this.state.takes[take.sessionId] ?? [];
      const error = checkTakeRange(input.startMs, input.endMs, session.durationSec * 1000, neighborsOf(siblings, take.index));
      if (error) throw new ApiError(400, error === "take_overlap" ? "옆 take와 겹칠 수 없어요." : "take 구간이 올바르지 않아요.", error);
      // 코멘트는 절대 시각 보존 (스펙 B 결정 2) — Mock의 atSec은 초 단위라 반올림한다
      const shiftSec = Math.round((take.startMs - input.startMs) / 1000);
      for (const c of this.state.comments[commentKey({ takeId })] ?? []) c.atSec += shiftSec;
      take.startMs = input.startMs;
      take.endMs = input.endMs;
      take.durationSec = Math.round((input.endMs - input.startMs) / 1000);
      take.version += 1;
      take.audioStatus = "updating";
      const version = take.version;
      setTimeout(() => {
        if (take.version !== version) return; // 다음 편집이 덮어썼다
        take.audioStatus = "ready";
        take.peaks = fakePeaks(seedOf(take.id) + version);
        this.emit();
      }, this.recutDelayMs);
      this.emit();
      return { ...take };
    },
    remove: async (takeId: string): Promise<void> => {
      const take = this.findTake(takeId);
      if (!take) throw new ApiError(404, "Take를 찾을 수 없어요.");
      const session = this.mustSession(take.sessionId);
      if (session.status !== "ready") throw new ApiError(409, "분석 중에는 take를 지울 수 없어요.", "session_not_ready");
      const key = commentKey({ takeId });
      const topLevel = (this.state.comments[key] ?? []).filter((c) => c.parentId === null).length;
      delete this.state.comments[key];
      this.state.takes[take.sessionId] = (this.state.takes[take.sessionId] ?? []).filter((t) => t.id !== takeId);
      session.takeCount = Math.max(0, session.takeCount - 1);
      session.commentCount = Math.max(0, session.commentCount - topLevel);
      this.emit();
    },
```

`fakePeaks`·`seedOf`가 `seed.ts`에서 export되는지 확인한다(`seedOf`는 스펙 A 이전에 삭제됐을 수 있다 — 없으면 `fakePeaks(take.startMs + version)`로 쓴다).

- [ ] **Step 3: 확인·커밋**

Run: `pnpm --filter @bandapp/api-client test` → PASS. `pnpm --filter @bandapp/api-client build` → OK.

```bash
git add packages/api-client/src
git commit -m "feat(api-client): add takes.update and takes.remove with mock recut simulation" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: `lib/timeline/edit.ts` — 초안 규칙 순수 함수

**Files:**
- Create: `apps/mobile/src/lib/timeline/edit.ts`
- Test: `apps/mobile/src/lib/timeline/edit.test.ts`

**Interfaces:**
- Consumes: `timeToX`, `Viewport`(스펙 A), `MIN_TAKE_MS`, `Neighbors`(Task 1).
- Produces (전부 `"worklet"`):
  ```ts
  HANDLE_HIT_PX = 24; EDGE_PX = 24; EDGE_MAX_PX_PER_FRAME = 12; PREVIEW_BEFORE_END_MS = 2000
  type Handle = "start" | "end"
  interface Draft { startMs: number; endMs: number }
  hitTestHandle(v, draft, xPx): Handle | null
  trimDraft(draft, handle, ms, neighbors, durationMs): Draft
  autoPanPxPerFrame(xPx, widthPx): number
  previewSeekMs(draft, handle): number
  shiftCommentAtSec(atSec, oldStartMs, newStartMs): number
  ```

- [ ] **Step 1: 실패하는 테스트**

```ts
import { describe, expect, it } from "vitest";
import { autoPanPxPerFrame, EDGE_MAX_PX_PER_FRAME, hitTestHandle, previewSeekMs, shiftCommentAtSec, trimDraft } from "./edit";

const v = { startMs: 0, msPerPx: 100, widthPx: 400 }; // 0~40s
const draft = { startMs: 10_000, endMs: 30_000 }; // x 100 ~ 300
const none = { prevEndMs: null, nextStartMs: null };

describe("hitTestHandle", () => {
  it("핸들 ±24px 안이면 그 핸들, 밖이면 null", () => {
    expect(hitTestHandle(v, draft, 100)).toBe("start");
    expect(hitTestHandle(v, draft, 123)).toBe("start");
    expect(hitTestHandle(v, draft, 125)).toBeNull();
    expect(hitTestHandle(v, draft, 290)).toBe("end");
    expect(hitTestHandle(v, draft, 200)).toBeNull();
  });
  it("둘 다 맞으면 가까운 쪽", () => {
    const tiny = { startMs: 10_000, endMs: 12_000 }; // x 100 ~ 120
    expect(hitTestHandle(v, tiny, 108)).toBe("start");
    expect(hitTestHandle(v, tiny, 113)).toBe("end");
  });
});

describe("trimDraft", () => {
  it("start는 [max(0, prevEnd), end − MIN], end는 [start + MIN, min(duration, nextStart)]", () => {
    expect(trimDraft(draft, "start", -5000, none, 60_000)).toEqual({ startMs: 0, endMs: 30_000 });
    expect(trimDraft(draft, "start", 29_900, none, 60_000)).toEqual({ startMs: 29_750, endMs: 30_000 });
    expect(trimDraft(draft, "end", 99_000, none, 60_000)).toEqual({ startMs: 10_000, endMs: 60_000 });
    expect(trimDraft(draft, "end", 10_100, none, 60_000)).toEqual({ startMs: 10_000, endMs: 10_250 });
  });
  it("이웃 경계에서 멈춘다", () => {
    const n = { prevEndMs: 8_000, nextStartMs: 35_000 };
    expect(trimDraft(draft, "start", 2_000, n, 60_000).startMs).toBe(8_000);
    expect(trimDraft(draft, "end", 50_000, n, 60_000).endMs).toBe(35_000);
  });
  it("정수 ms로 반올림한다", () => {
    expect(trimDraft(draft, "start", 12_345.6, none, 60_000).startMs).toBe(12_346);
  });
});

describe("autoPanPxPerFrame", () => {
  it("가장자리 24px 밖은 0, 안쪽은 넘친 만큼 비례, 끝에서 최대", () => {
    expect(autoPanPxPerFrame(200, 400)).toBe(0);
    expect(autoPanPxPerFrame(24, 400)).toBe(0);
    expect(autoPanPxPerFrame(12, 400)).toBeCloseTo(-EDGE_MAX_PX_PER_FRAME / 2);
    expect(autoPanPxPerFrame(0, 400)).toBe(-EDGE_MAX_PX_PER_FRAME);
    expect(autoPanPxPerFrame(400, 400)).toBe(EDGE_MAX_PX_PER_FRAME);
    expect(autoPanPxPerFrame(-10, 400)).toBe(-EDGE_MAX_PX_PER_FRAME);
  });
});

describe("previewSeekMs / shiftCommentAtSec", () => {
  it("start 핸들은 start, end 핸들은 end − 2s (start 아래로는 안 감)", () => {
    expect(previewSeekMs(draft, "start")).toBe(10_000);
    expect(previewSeekMs(draft, "end")).toBe(28_000);
    expect(previewSeekMs({ startMs: 10_000, endMs: 11_000 }, "end")).toBe(10_000);
  });
  it("코멘트는 절대 시각 유지", () => {
    expect(shiftCommentAtSec(30, 10_000, 20_000)).toBe(20);
    expect(shiftCommentAtSec(5, 10_000, 20_000)).toBe(-5);
  });
});
```

Run: `pnpm --filter mobile exec vitest run src/lib/timeline/edit.test.ts` → FAIL.

- [ ] **Step 2: 구현**

```ts
import { MIN_TAKE_MS, type Neighbors } from "@bandapp/types";
import { timeToX, type Viewport } from "./viewport";

/** 핸들 좌우 터치 영역 (스펙 B 결정 8) */
export const HANDLE_HIT_PX = 24;
/** edge auto pan이 시작되는 가장자리 폭 */
export const EDGE_PX = 24;
/** 가장자리 끝에서의 auto pan 속도 (px/frame) */
export const EDGE_MAX_PX_PER_FRAME = 12;
/** end 핸들을 놓았을 때 미리 듣기 시작점 — 끝나기 2초 전 */
export const PREVIEW_BEFORE_END_MS = 2000;

export type Handle = "start" | "end";

export interface Draft {
  startMs: number;
  endMs: number;
}

/** 손가락 x가 어느 핸들 위인지. 둘 다 맞으면 가까운 쪽 */
export function hitTestHandle(v: Viewport, draft: Draft, xPx: number): Handle | null {
  "worklet";
  const ds = Math.abs(timeToX(v, draft.startMs) - xPx);
  const de = Math.abs(timeToX(v, draft.endMs) - xPx);
  const hitS = ds <= HANDLE_HIT_PX;
  const hitE = de <= HANDLE_HIT_PX;
  if (hitS && hitE) return ds <= de ? "start" : "end";
  if (hitS) return "start";
  if (hitE) return "end";
  return null;
}

/** 한 핸들을 ms로 옮기되 최소 길이·이웃·녹음 범위에서 멈춘다 (결정 5). 정수 ms로 반올림 */
export function trimDraft(draft: Draft, handle: Handle, ms: number, neighbors: Neighbors, durationMs: number): Draft {
  "worklet";
  const t = Math.round(ms);
  if (handle === "start") {
    const lo = Math.max(0, neighbors.prevEndMs ?? 0);
    const hi = draft.endMs - MIN_TAKE_MS;
    return { startMs: Math.min(hi, Math.max(lo, t)), endMs: draft.endMs };
  }
  const lo = draft.startMs + MIN_TAKE_MS;
  const hi = Math.min(durationMs, neighbors.nextStartMs ?? durationMs);
  return { startMs: draft.startMs, endMs: Math.max(lo, Math.min(hi, t)) };
}

/** 손가락이 가장자리 안에 있으면 viewport가 그쪽으로 흐르는 속도. 음수 = 왼쪽(과거) */
export function autoPanPxPerFrame(xPx: number, widthPx: number): number {
  "worklet";
  if (xPx < EDGE_PX) return -Math.min(1, (EDGE_PX - xPx) / EDGE_PX) * EDGE_MAX_PX_PER_FRAME;
  if (xPx > widthPx - EDGE_PX) return Math.min(1, (xPx - (widthPx - EDGE_PX)) / EDGE_PX) * EDGE_MAX_PX_PER_FRAME;
  return 0;
}

/** 핸들을 놓은 뒤 미리 듣기 위치 */
export function previewSeekMs(draft: Draft, handle: Handle): number {
  "worklet";
  return handle === "start" ? draft.startMs : Math.max(draft.startMs, draft.endMs - PREVIEW_BEFORE_END_MS);
}

/** 코멘트 atSec(take 상대, 초)를 start 이동에 맞춰 옮긴다 — 절대 시각 보존 (결정 2) */
export function shiftCommentAtSec(atSec: number, oldStartMs: number, newStartMs: number): number {
  "worklet";
  return atSec + (oldStartMs - newStartMs) / 1000;
}
```

Run → PASS. Commit:

```bash
git add apps/mobile/src/lib/timeline/edit.ts apps/mobile/src/lib/timeline/edit.test.ts
git commit -m "feat(mobile): add take draft trimming, handle hit-test and edge auto-pan math" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: `useTakeDraft` + `useTimelineViewport` 핸들 모드

**Files:**
- Create: `apps/mobile/src/features/timeline/useTakeDraft.ts`
- Modify: `apps/mobile/src/features/timeline/useTimelineViewport.ts`

**Interfaces:**
- Consumes: Task 8 함수, `neighborsOf`(Task 1), `panViewport`·`xToTime`(스펙 A).
- Produces:
  ```ts
  interface TakeDraftState {
    draft: SharedValue<Draft | null>; neighbors: SharedValue<Neighbors>;
    original: Draft | null; dirty: boolean;            // React 미러
    begin(take: Take, siblings: Take[]): void; reset(): void; clear(): void;
    current(): Draft | null;                            // JS 읽기
  }
  useTakeDraft(): TakeDraftState
  type EditMode = "handle-start" | "handle-end" | null
  interface EditingBindings { draft: SharedValue<Draft | null>; neighbors: SharedValue<Neighbors>; onHandleRelease(handle: Handle, draft: Draft): void }
  useTimelineViewport(durationMs, onTap, editing?: EditingBindings): TimelineViewportState & { editMode: SharedValue<EditMode> }
  ```

- [ ] **Step 1: `useTakeDraft`**

```ts
import { neighborsOf, type Neighbors, type Take } from "@bandapp/types";
import { useCallback, useState } from "react";
import { useAnimatedReaction, useSharedValue, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import type { Draft } from "@/lib/timeline/edit";

export interface TakeDraftState {
  /** 핸들 드래그가 매 프레임 바꾸는 초안. null이면 편집 중 아님 */
  draft: SharedValue<Draft | null>;
  neighbors: SharedValue<Neighbors>;
  /** 선택한 take의 저장된 경계 — Cancel이 되돌리는 값 */
  original: Draft | null;
  /** 초안이 저장된 값과 다른가 (React 미러) */
  dirty: boolean;
  begin: (take: Take, siblings: Take[]) => void;
  /** Cancel — 초안을 저장된 값으로 */
  reset: () => void;
  /** 선택 해제 */
  clear: () => void;
  /** JS에서 초안 읽기 (Save) */
  current: () => Draft | null;
}

/** 초안은 shared value로만 살고(스펙 B 결정 7) React는 dirty 여부만 안다 */
export function useTakeDraft(): TakeDraftState {
  const draft = useSharedValue<Draft | null>(null);
  const neighbors = useSharedValue<Neighbors>({ prevEndMs: null, nextStartMs: null });
  const [original, setOriginal] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);

  useAnimatedReaction(
    () => draft.value,
    (d, prev) => {
      if (d === prev) return;
      const changed = d !== null && original !== null && (d.startMs !== original.startMs || d.endMs !== original.endMs);
      scheduleOnRN(setDirty, changed);
    },
    [original],
  );

  const begin = useCallback(
    (take: Take, siblings: Take[]) => {
      const o = { startMs: take.startMs, endMs: take.endMs };
      setOriginal(o);
      setDirty(false);
      neighbors.value = neighborsOf(siblings, take.index);
      draft.value = o;
    },
    [draft, neighbors],
  );
  const reset = useCallback(() => {
    if (original) draft.value = { ...original };
    setDirty(false);
  }, [draft, original]);
  const clear = useCallback(() => {
    draft.value = null;
    setOriginal(null);
    setDirty(false);
  }, [draft]);
  const current = useCallback(() => draft.value, [draft]);

  return { draft, neighbors, original, dirty, begin, reset, clear, current };
}
```

- [ ] **Step 2: `useTimelineViewport` 확장**

import 추가: `import { useFrameCallback } from "react-native-reanimated";`(기존 import에 합친다), `import { autoPanPxPerFrame, hitTestHandle, trimDraft, type Draft, type Handle } from "@/lib/timeline/edit";`, `import type { Neighbors } from "@bandapp/types";`, `xToTime`을 viewport import에 추가.

타입:

```ts
export type EditMode = "handle-start" | "handle-end" | null;

export interface EditingBindings {
  draft: SharedValue<Draft | null>;
  neighbors: SharedValue<Neighbors>;
  /** 핸들을 놓았을 때 (JS) — 미리 듣기 seek */
  onHandleRelease: (handle: Handle, draft: Draft) => void;
}

export interface TimelineViewportState {
  // ...기존
  /** 핸들 드래그 중이면 어느 핸들인지 (스펙 B 결정 8) */
  editMode: SharedValue<EditMode>;
}
```

시그니처 `export function useTimelineViewport(durationMs: number, onTap: (xPx: number, yPx: number) => void, editing?: EditingBindings): TimelineViewportState`. 본문에 shared value 두 개: `const editMode = useSharedValue<EditMode>(null); const fingerX = useSharedValue(0);`.

핸들 모드에서 초안을 손가락 위치로 옮기는 worklet 헬퍼(훅 안, 팬 위에):

```ts
  const moveHandleTo = (mode: EditMode, xPx: number) => {
    "worklet";
    if (!editing || !mode) return;
    const d = editing.draft.value;
    if (!d) return;
    const v = { startMs: startMs.value, msPerPx: msPerPx.value, widthPx: widthPx.value };
    const handle: Handle = mode === "handle-start" ? "start" : "end";
    editing.draft.value = trimDraft(d, handle, xToTime(v, xPx), editing.neighbors.value, durationMs);
  };
```

팬 콜백 교체:

```ts
    onBegin: (e) => {
      "worklet";
      follow.value = false;
      const d = editing?.draft.value ?? null;
      const v = { startMs: startMs.value, msPerPx: msPerPx.value, widthPx: widthPx.value };
      const hit = d ? hitTestHandle(v, d, e.x) : null;
      if (hit) {
        editMode.value = hit === "start" ? "handle-start" : "handle-end";
        fingerX.value = e.x;
        activeGesture.value = "pan";
        return;
      }
      editMode.value = null;
      activeGesture.value = "pan";
    },
    onUpdate: (e) => {
      "worklet";
      if (editMode.value) {
        fingerX.value = e.x;
        moveHandleTo(editMode.value, e.x);
        return;
      }
      const v = panViewport({ startMs: startMs.value, msPerPx: msPerPx.value, widthPx: widthPx.value }, e.changeX, durationMs);
      startMs.value = v.startMs;
      const o = pinchOrigin.value;
      if (o) pinchOrigin.value = { startMs: o.startMs - e.changeX * o.msPerPx, msPerPx: o.msPerPx, widthPx: o.widthPx };
    },
    onFinalize: () => {
      "worklet";
      const mode = editMode.value;
      editMode.value = null;
      activeGesture.value = null;
      if (mode && editing) {
        const d = editing.draft.value;
        if (d) scheduleOnRN(editing.onHandleRelease, mode === "handle-start" ? "start" : "end", d);
      }
    },
```

핀치 `onUpdate` 첫 줄에 `if (editMode.value) return;`(핸들 잡은 동안 두 번째 손가락은 무시). 핀치 `onBegin`도 `if (editMode.value) return;`.

edge auto pan — 훅 안에:

```ts
  // 핸들을 잡은 채 가장자리에 닿으면 viewport가 그쪽으로 흐르고 핸들은 손가락 아래 시각을 따라간다 (초안 20절)
  useFrameCallback(() => {
    const mode = editMode.value;
    if (!mode || !editing) return;
    const dx = autoPanPxPerFrame(fingerX.value, widthPx.value);
    if (dx === 0) return;
    const v = panViewport({ startMs: startMs.value, msPerPx: msPerPx.value, widthPx: widthPx.value }, -dx, durationMs);
    startMs.value = v.startMs;
    moveHandleTo(mode, fingerX.value);
  });
```

반환 객체에 `editMode` 추가.

- [ ] **Step 3: 타입 확인·커밋**

Run: `pnpm --filter mobile typecheck` → OK (기존 호출 `useTimelineViewport(durationMs, onTap)`은 `editing` 생략으로 그대로 맞는다).

```bash
git add apps/mobile/src/features/timeline/useTakeDraft.ts apps/mobile/src/features/timeline/useTimelineViewport.ts
git commit -m "feat(mobile): add take draft state and handle-drag mode with edge auto-pan" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: 화면 — 핸들, Save/Cancel, 삭제, 상태 표시, 폴링

> **디자인 블로커.** 핸들·초안 구간·Save/Cancel·삭제·updating/failed 상태·확인 다이얼로그의 모양은 Claude Design "Timeline" 화면 갱신분이 명세다(스펙 B §디자인 브리프). 아래는 기존 컴포넌트(`ConfirmDialog`, `BottomSheet`+`SheetRow`, 스펙 A 카드)만으로 동작을 검증하는 잠정 조립이다. 디자인이 오면 JSX만 맞춘다 — 훅·규칙·API는 그대로다.

**Files:**
- Create: `apps/mobile/src/features/timeline/TakeHandles.tsx`
- Create: `apps/mobile/src/features/timeline/TakeActionSheet.tsx`
- Create: `apps/mobile/src/features/takes/useTakesPolling.ts`
- Modify: `apps/mobile/src/features/timeline/TimelineScreen.tsx`
- Modify: `apps/mobile/src/features/timeline/TakeLane.tsx` (선택 필이 초안을 따라감)
- Modify: `apps/mobile/src/features/takes/TakeRow.tsx`, `apps/mobile/src/features/takes/TakePlayerScreen.tsx`, `apps/mobile/src/features/takes/SessionDetailScreen.tsx`

**Interfaces:**
- Consumes: Task 7·8·9 전부, `ConfirmDialog({ visible, title, body, primary: { label, danger?, onPress }, cancelLabel, onCancel, busy })`, `BottomSheet`/`SheetRow`, `useNavigation`(expo-router)의 `beforeRemove`.
- Produces: `TakeHandles({ vp, draft })`, `TakeActionSheet({ take, onClose, onDelete })`, `useTakesPolling(takes, reload)`.

- [ ] **Step 1: 핸들 오버레이**

`TakeHandles.tsx` — 파형 위에 겹치는 초안 구간(accent 12%)과 두 핸들 선(3px, 터치는 hit-test가 맡으므로 시각만):

```tsx
import { View } from "react-native";
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import type { Draft } from "@/lib/timeline/edit";
import { timeToX } from "@/lib/timeline/viewport";
import { useTheme } from "@/theme";
import { WAVE_H } from "./WaveformCanvas";
import type { TimelineViewportState } from "./useTimelineViewport";

/** 선택 take의 초안 구간 + start/end 핸들. 시각만 그린다 — 터치는 useTimelineViewport의 hit-test가 맡는다 (스펙 B 결정 8) */
export function TakeHandles({ vp, draft }: { vp: TimelineViewportState; draft: SharedValue<Draft | null> }) {
  const { colors } = useTheme();
  const view = () => {
    "worklet";
    return { startMs: vp.startMs.value, msPerPx: vp.msPerPx.value, widthPx: vp.widthPx.value };
  };
  const region = useAnimatedStyle(() => {
    const d = draft.value;
    if (!d) return { opacity: 0, transform: [{ translateX: 0 }], width: 0 };
    const v = view();
    const x0 = Math.max(0, timeToX(v, d.startMs));
    const x1 = Math.min(v.widthPx, timeToX(v, d.endMs));
    return { opacity: x1 > x0 ? 1 : 0, transform: [{ translateX: x0 }], width: Math.max(0, x1 - x0) };
  });
  const handle = (which: "start" | "end") =>
    useAnimatedStyle(() => {
      const d = draft.value;
      if (!d) return { opacity: 0, transform: [{ translateX: 0 }] };
      const v = view();
      const x = timeToX(v, which === "start" ? d.startMs : d.endMs);
      const on = x >= -2 && x <= v.widthPx + 2;
      const active = vp.editMode.value === (which === "start" ? "handle-start" : "handle-end");
      return { opacity: on ? 1 : 0, transform: [{ translateX: x - 1.5 }, { scaleX: active ? 1.6 : 1 }] };
    });
  const startStyle = handle("start");
  const endStyle = handle("end");
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: 0, height: WAVE_H }}>
      <Animated.View style={[{ position: "absolute", top: 0, height: WAVE_H, backgroundColor: colors.accent, opacity: 0.12 }, region]} />
      <Animated.View style={[{ position: "absolute", top: 0, width: 3, height: WAVE_H, backgroundColor: colors.accent, borderRadius: 1.5 }, startStyle]} />
      <Animated.View style={[{ position: "absolute", top: 0, width: 3, height: WAVE_H, backgroundColor: colors.accent, borderRadius: 1.5 }, endStyle]} />
    </View>
  );
}
```

(`handle()`이 훅을 함수 안에서 부르는 형태라 lint가 걸리면 두 `useAnimatedStyle`로 펼친다 — 호출 순서가 고정이라 동작은 같다.)

`TakeLane.tsx`의 `TakePill`에 `draft?: SharedValue<Draft | null>` prop을 더해, `selected && draft?.value`면 take 대신 초안 경계로 x0/x1을 계산한다. `TakeLane`이 `draft`를 받아 선택 필에만 넘긴다.

- [ ] **Step 2: 액션 시트·폴링**

`TakeActionSheet.tsx`:

```tsx
import type { Take } from "@bandapp/types";
import { AppText, BottomSheet, SheetRow } from "@/ui";
import { View } from "react-native";
import { useTheme } from "@/theme";

/** 선택 카드의 "···" — 지금은 Delete take 하나 (스펙 B). take가 null이면 닫힌 상태 */
export function TakeActionSheet({ take, onClose, onDelete }: { take: Take | null; onClose: () => void; onDelete: (take: Take) => void }) {
  const { colors } = useTheme();
  return (
    <BottomSheet visible={take !== null} onClose={onClose}>
      {take ? (
        <>
          <View style={{ paddingHorizontal: 12, paddingBottom: 10, marginBottom: 8, borderBottomWidth: 1, borderBottomColor: colors.border }}>
            <AppText variant="caption" numberOfLines={1}>{take.name}</AppText>
          </View>
          <SheetRow title="Delete take" danger onPress={() => onDelete(take)} />
        </>
      ) : null}
    </BottomSheet>
  );
}
```

`apps/mobile/src/features/takes/useTakesPolling.ts`:

```ts
import type { Take } from "@bandapp/types";
import { useEffect } from "react";

const POLL_MS = 3000;

/** 재컷 중(updating)인 take가 하나라도 있으면 3초마다 목록을 다시 읽는다 (스펙 B §상태 전파). 없어지면 멈춘다 */
export function useTakesPolling(takes: Take[] | undefined, reload: () => void): void {
  const updating = (takes ?? []).some((t) => t.audioStatus === "updating");
  useEffect(() => {
    if (!updating) return;
    const t = setInterval(reload, POLL_MS);
    return () => clearInterval(t);
  }, [updating, reload]);
}
```

- [ ] **Step 3: 타임라인 화면 연결**

`TimelineScreen.tsx` 변경점(기존 구조 유지):

```tsx
import { useNavigation } from "expo-router";
import { ApiError } from "@bandapp/api-client";
import { useApi } from "@/api";
import { previewSeekMs, type Draft, type Handle } from "@/lib/timeline/edit";
import { ConfirmDialog } from "@/ui";
import { TakeActionSheet } from "./TakeActionSheet";
import { TakeHandles } from "./TakeHandles";
import { useTakeDraft } from "./useTakeDraft";
import { useTakesPolling } from "@/features/takes/useTakesPolling";
```

훅·상태:

```tsx
  const api = useApi();
  const navigation = useNavigation();
  const { data: takes, reload: reloadTakes } = useTakes(id);
  useTakesPolling(takes, reloadTakes);
  const draftState = useTakeDraft();
  const [saving, setSaving] = useState(false);
  const [actionTake, setActionTake] = useState<Take | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Take | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** 초안을 버릴지 묻는 중 — 확인하면 실행할 동작 */
  const [pendingDiscard, setPendingDiscard] = useState<(() => void) | null>(null);

  const onHandleRelease = useCallback((handle: Handle, d: Draft) => clock.seekTo(previewSeekMs(d, handle)), [clock]);
  const vp = useTimelineViewport(durationMs, onTap, { draft: draftState.draft, neighbors: draftState.neighbors, onHandleRelease });
```

take 선택(`selectTake`)은 초안이 dirty면 먼저 묻는다:

```tsx
  const applySelect = useCallback(
    (t: Take) => {
      setSelectedTakeId(t.id);
      draftState.begin(t, takeList);
      vp.follow.value = false;
      vp.setViewport(fitRange(vp.snapshot().widthPx, t.startMs, t.endMs, FIT_PAD, durationMs));
    },
    [draftState, takeList, vp, durationMs],
  );
  const selectTake = useCallback(
    (t: Take) => {
      if (t.id === selectedTakeId) return;
      if (draftState.dirty) setPendingDiscard(() => () => applySelect(t));
      else applySelect(t);
    },
    [selectedTakeId, draftState.dirty, applySelect],
  );
```

뒤로 가기 가로채기:

```tsx
  useEffect(() => {
    if (!draftState.dirty) return;
    const off = navigation.addListener("beforeRemove", (e) => {
      e.preventDefault();
      setPendingDiscard(() => () => navigation.dispatch(e.data.action));
    });
    return off;
  }, [navigation, draftState.dirty]);
```

목록이 새로고침되면(폴링·저장 후) 선택 take의 최신 값으로 `original`을 맞추되 dirty 초안은 유지:

```tsx
  useEffect(() => {
    if (!selectedTake) return;
    if (!draftState.dirty) draftState.begin(selectedTake, takeList);
  }, [selectedTake?.version, selectedTake?.audioStatus]); // eslint-disable-line react-hooks/exhaustive-deps
```

(`selectedTake`가 목록에서 사라졌으면 — 다른 멤버가 지웠으면 — `setSelectedTakeId(null); draftState.clear();`도 같은 effect에서.)

Save / Cancel / Delete:

```tsx
  const save = async () => {
    const d = draftState.current();
    if (!selectedTake || !d || saving) return;
    setSaving(true);
    try {
      await api.takes.update(selectedTake.id, { startMs: d.startMs, endMs: d.endMs, version: selectedTake.version });
      toast.show("Saved — updating audio…");
      reloadTakes();
    } catch (err) {
      if (err instanceof ApiError && err.code === "take_version_conflict") {
        toast.show("Someone else changed this take");
        draftState.clear();
        setSelectedTakeId(null);
        reloadTakes();
      } else if (err instanceof ApiError && (err.code === "take_overlap" || err.code === "take_range_invalid")) {
        toast.show(err.code === "take_overlap" ? "Can’t overlap the next take" : "Invalid take range");
      } else {
        toast.show("Something went wrong");
      }
    } finally {
      setSaving(false);
    }
  };
  const doDelete = () => {
    const t = confirmDelete;
    if (!t || deleting) return;
    setDeleting(true);
    void api.takes
      .remove(t.id)
      .then(() => {
        toast.show("Take deleted");
        if (selectedTakeId === t.id) {
          setSelectedTakeId(null);
          draftState.clear();
        }
        reloadTakes();
      })
      .catch(() => toast.show("Something went wrong"))
      .finally(() => {
        setDeleting(false);
        setConfirmDelete(null);
      });
  };
```

JSX: `WaveformCanvas` 바로 뒤(같은 `View` 안, GestureDetector 밖)에 `<TakeHandles vp={vp} draft={draftState.draft} />`. `TakeLane`에 `draft={draftState.draft}`. 선택 카드를:

```tsx
      {selectedTake ? (
        <View style={{ /* 기존 카드 스타일 */ }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <AppText variant="rowTitle">{selectedTake.name}</AppText>
            <AppText style={{ fontFamily: font.mono, fontSize: 11, color: colors.textMuted, marginTop: 5 }}>
              {selectedTake.audioStatus === "updating"
                ? "Updating audio…"
                : selectedTake.audioStatus === "failed"
                  ? "Audio update failed"
                  : `${fmtClock(selectedTake.startMs / 1000)} – ${fmtClock(selectedTake.endMs / 1000)} · ${fmtClock(selectedTake.durationSec)}`}
            </AppText>
          </View>
          {draftState.dirty ? (
            <>
              <Chip label="Cancel" onPress={draftState.reset} />
              <Chip label={saving ? "Saving…" : "Save"} onPress={saving ? undefined : () => void save()} />
            </>
          ) : selectedTake.audioStatus === "failed" ? (
            <Chip label="Retry" onPress={() => void save()} />
          ) : (
            <>
              <PressableOpacity onPress={() => setActionTake(selectedTake)} hitSlop={8} style={{ paddingHorizontal: 6 }}>
                <AppText style={{ fontSize: 18, lineHeight: 20, color: colors.textMuted }}>···</AppText>
              </PressableOpacity>
              <PressableOpacity onPress={() => router.push(`/session/${session.id}/take/${selectedTake.id}`)} style={{ /* 기존 Open take 스타일 */ }}>
                <AppText style={{ fontSize: 13, fontWeight: "600", color: colors.bg }}>Open take</AppText>
              </PressableOpacity>
            </>
          )}
        </View>
      ) : null}
```

(`Chip`을 `@/ui` import에 추가. "Retry"는 `draftState.current()`가 저장된 값 그대로라 같은 값 PATCH가 된다.)

화면 끝(디버그 오버레이 앞)에:

```tsx
      <TakeActionSheet take={actionTake} onClose={() => setActionTake(null)} onDelete={(t) => { setActionTake(null); setConfirmDelete(t); }} />
      {confirmDelete ? (
        <ConfirmDialog
          visible
          title={`Delete ${confirmDelete.name}?`}
          body={confirmDelete.commentCount > 0 ? `${confirmDelete.commentCount} ${confirmDelete.commentCount === 1 ? "comment" : "comments"} on this take will be deleted too.` : "The audio for this take will be removed for everyone in the band."}
          primary={{ label: "Delete take", danger: true, onPress: doDelete }}
          cancelLabel="Cancel"
          onCancel={() => (deleting ? undefined : setConfirmDelete(null))}
          busy={deleting}
        />
      ) : null}
      {pendingDiscard ? (
        <ConfirmDialog
          visible
          title="Discard changes?"
          body="Your edits to this take haven’t been saved."
          primary={{ label: "Discard", danger: true, onPress: () => { const go = pendingDiscard; setPendingDiscard(null); draftState.reset(); go(); } }}
          cancelLabel="Keep editing"
          onCancel={() => setPendingDiscard(null)}
        />
      ) : null}
```

- [ ] **Step 4: 목록 행·플레이어·세션 상세 칩**

`TakeRow.tsx`: `StaticWaveform` 자리를

```tsx
        <View style={{ marginTop: 10 }}>
          {take.audioStatus === "ready" ? (
            <StaticWaveform peaks={take.peaks} />
          ) : (
            <AppText variant="small" color={take.audioStatus === "failed" ? colors.textMuted : colors.textFaint}>
              {take.audioStatus === "failed" ? "Audio update failed" : "Updating audio…"}
            </AppText>
          )}
        </View>
```

`TakePlayerScreen.tsx`: `take` memo의 take 분기에 `audioStatus: t.audioStatus`를 더하고(원본은 `"ready" as const`), 재생 버튼 `PressableOpacity`에 `disabled={take.audioStatus !== "ready"}`와 `style` opacity 0.4, 클럭 아래에 `updating`이면 "Updating audio…", `failed`면 "Audio update failed — retry from the timeline" 캡션. 마커 clamp: `markers={threads.map((t) => Math.min(Math.max(0, t.comment.atSec), take.durationSec))}` (스펙 B 결정 2).

`SessionDetailScreen.tsx`: `useTakesPolling(takes, reload)` 추가(`const { data: takes, reload } = useTakes(id);`), 칩 라벨을 `"Edit takes"`로(주석도 "디자인대로 Edit takes — 타임라인에서 편집·삭제 (2026-09-11 스펙 B)").

- [ ] **Step 5: 타입 확인·웹 프리뷰**

Run: `pnpm --filter mobile typecheck` → OK.

웹 Mock 프리뷰(8082, Global Constraints 참고) `/session/s1/timeline`, 모바일 뷰포트:
1. take 필 탭 → 핸들 두 개 + 반투명 구간이 보인다. 핸들 근처(±24px)에서 드래그 → 초안이 바뀌고 Save/Cancel이 뜬다. 핸들 밖에서 드래그 → 팬.
2. 핸들을 화면 오른쪽 끝까지 끌고 있으면 viewport가 흐른다(auto pan). 놓으면 클럭이 미리 듣기 위치로 간다.
3. Cancel → 원래 값. Save → "Updating audio…" → 1.5초 뒤 "start – end · dur"로 돌아오고 오버뷰 마커가 바뀐다.
4. 초안 dirty 상태에서 다른 take 탭 → "Discard changes?"; 뒤로 → 같은 다이얼로그.
5. ··· → Delete take → 다이얼로그(코멘트 있으면 수 표시) → 목록에서 사라지고 남은 이름 유지.
6. 콘솔 오류 없음.

- [ ] **Step 6: 커밋**

```bash
git add apps/mobile/src/features/timeline apps/mobile/src/features/takes
git commit -m "feat(mobile): edit take boundaries with handles, save/cancel, delete and recut status" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: 문서, 전체 검증, 기기 검증

**Files:**
- Modify: `README.md`, `docs/backlog.md`

- [ ] **Step 1: README·백로그**

README의 API 목록/파이프라인 문장에 `PATCH /takes/:id`(경계 변경 → 재컷 잡), `DELETE /takes/:id`를 한 줄 더한다. `docs/backlog.md`: "Take 경계 편집 (스펙 B)" 항목을 지우고 "## 분석"에 남긴다:

```
- **take 추가·분할·병합, 이름 변경.** 경계 편집·삭제([2026-09-11 스펙 B](superpowers/specs/2026-09-11-take-editing-design.md)) 다음 단계. 번호/이름 재배치 결정이 따라온다.
- **재컷 스위퍼.** `takes.audio_status = updating`에 1시간 이상 머문 take를 failed로 돌린다 (워커가 죽고 DLQ까지 소진된 경우).
```

"## 재생·피드백"에 `- **playhead 스크럽.** 핸들을 잡고 끄는 seek. 탭 seek + ±1초로 충분해 미뤘다.`, "## 운영"의 세션 삭제 정리 항목에 "take 객체 키가 `{takeId}-v{n}.m4a` 패턴도 있다"를 붙인다.

- [ ] **Step 2: 전체 검증**

`pnpm --filter @bandapp/types build` → `pnpm --filter @bandapp/api-client build && pnpm --filter @bandapp/api-client test` → `pnpm --filter @bandapp/api lint && pnpm --filter @bandapp/api build && pnpm --filter @bandapp/api test` → `pnpm --filter mobile typecheck && pnpm --filter mobile test`. 전부 통과해야 한다.

- [ ] **Step 3: 커밋**

```bash
git add README.md docs/backlog.md
git commit -m "docs: record take editing endpoints and follow-ups" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 4: 기기 검증 (dev build, 사람이 수행)**

gesture-handler가 스펙 A에서 직접 의존성이 됐으므로 dev client를 다시 빌드한다. 실제 세션에서:
1. 핸들 잡은 채 두 번째 손가락 → 핀치가 무시되고 핸들만 움직인다.
2. 핸들을 가장자리로 → auto pan 속도가 가장자리에 가까울수록 빨라지고 핸들 시각이 손가락을 따른다.
3. 핸들 드래그 중 전화·앱 전환 → 돌아왔을 때 `editMode`가 풀려 있다(디버그 오버레이 gesture `-`).
4. Save → 워커가 재컷 → 3초 폴링으로 ready, take 플레이어에서 새 구간이 재생된다. 코멘트 마커가 절대 시각을 유지한다.
5. 두 기기에서 같은 take 편집 → 늦은 쪽이 409 토스트.
6. 스펙 A 미검증 항목(핀치 focal 고정, 핀치→팬 전환, 백그라운드 복귀 재동기화, 3시간 세션 60fps).

결과를 스펙 B 파일 끝 "기기 검증 기록" 절에 날짜와 함께 남긴다.
