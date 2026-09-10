# 실제 파형 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 워커가 원본을 한 번 디코드해 세션·take별 128버킷 피크를 DB에 저장하고, 앱의 세 파형 화면(take 목록 행, take 플레이어, 원본 녹음 플레이어)이 시드 파형 대신 그 피크를 그린다.

**Architecture:** `FfmpegRunner.peaks()`가 원본을 8kHz 모노 s16le로 스트리밍 디코드하면 순수 모듈 `worker/peaks.ts`의 `PeakAccumulator`가 1/50초 창마다 피크를 쌓고, `slicePeaks()`가 구간을 잘라 128버킷으로 정규화한다. `takes.peaks`·`sessions.peaks`(`smallint[]`)에 저장하고 `Take.peaks`·`Session.peaks`(`number[] | null`)로 인라인 응답한다. 앱은 `lib/peaks.ts`의 `resamplePeaks()`로 바 개수에 맞춰 줄여 그리고, null이면 최소 높이 플레이스홀더를 그린다.

**Tech Stack:** NestJS 11 + drizzle-orm/Postgres (vitest 단위 + 실 Postgres e2e), ffmpeg(spawn 스트리밍), `@bandapp/types`(dist 소비 — 수정 후 `pnpm --filter @bandapp/types build` 필수), `packages/api-client`(HTTP/Mock), Expo/React Native (vitest 순수 함수 테스트, `tsc --noEmit`).

**Spec:** [docs/superpowers/specs/2026-09-10-real-waveform-design.md](../specs/2026-09-10-real-waveform-design.md)

## Global Constraints

- 코드 주석은 한국어, 커밋 제목은 영어 conventional commit. 커밋 트레일러 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` 필수.
- `@bandapp/types`·`@bandapp/api-client`는 `dist`로 소비된다 — 타입을 바꾸면 `pnpm --filter @bandapp/types build`(api-client도 바꾸면 `pnpm --filter @bandapp/api-client build`) 후에야 다른 패키지의 typecheck가 맞는다.
- 피크 형식: 길이 `PEAK_BUCKETS = 128`, 값 0~255 정수, 객체 안 최댓값이 255 (전부 무음이면 전부 0). 고해상도 배열은 `PEAKS_PER_SEC = 50`, 디코드 샘플레이트 8000Hz.
- 피크 추출 실패는 세션을 failed로 만들지 않는다 — warn 로그 + `peaks: null`.
- 앱의 바 높이 공식은 지금 그대로 `Math.max(minPx, Math.round((0.12 + 0.88 * unit) * height))`. 바 개수·간격·색은 바꾸지 않는다.
- e2e는 로컬 Postgres(`localhost:5432`, docker compose `postgres`)가 떠 있어야 한다. 워크트리에서는 메인 체크아웃의 컨테이너를 그대로 쓴다.
- Bash 툴은 워크트리에서 복합 명령을 거부할 수 있다 — 한 번에 하나의 명령.

---

### Task 1: `takes.peaks`·`sessions.peaks` 컬럼과 마이그레이션 0007

**Files:**
- Modify: `apps/api/src/db/schema.ts` (import 목록, `sessions`, `takes`)
- Create: `apps/api/drizzle/0007_<drizzle가 붙인 이름>.sql` (drizzle-kit이 생성)
- Modify: `apps/api/drizzle/meta/_journal.json`, `apps/api/drizzle/meta/0007_snapshot.json` (drizzle-kit이 생성)

**Interfaces:**
- Produces: `takes.peaks: number[] | null`, `sessions.peaks: number[] | null` (drizzle `smallint().array()`), Task 2·4가 select/insert/update에 쓴다.

- [ ] **Step 1: 스키마에 컬럼 추가**

`apps/api/src/db/schema.ts`의 drizzle import에 `smallint`를 더한다:

```ts
import {
  type AnyPgColumn,
  bigint,
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
```

`sessions` 테이블의 `analysisModel` 뒤에:

```ts
  analysisModel: text("analysis_model"),
  // 원본 녹음 전체 피크 — 길이 128, 0~255. 워커가 ready로 바꿀 때 채운다. 옛 데이터·추출 실패면 null (2026-09-10 스펙 결정 1, 5)
  peaks: smallint("peaks").array(),
  ...timestamps,
```

`takes` 테이블의 `objectKey` 뒤에:

```ts
    objectKey: text("object_key").notNull(),
    // 원본 타임라인의 start_ms~end_ms 구간 피크 — 길이 128, 0~255. 추출 실패면 null (2026-09-10 스펙 결정 3, 5)
    peaks: smallint("peaks").array(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
```

- [ ] **Step 2: 마이그레이션 생성**

Run: `pnpm --filter @bandapp/api db:generate`
Expected: `apps/api/drizzle/0007_<name>.sql`이 생기고 내용이 다음 두 문장이다:

```sql
ALTER TABLE "sessions" ADD COLUMN "peaks" smallint[];--> statement-breakpoint
ALTER TABLE "takes" ADD COLUMN "peaks" smallint[];
```

다른 문장이 섞여 있으면 스키마 편집을 되돌아본다 (Step 1 외에는 아무것도 바꾸면 안 된다).

- [ ] **Step 3: e2e로 마이그레이션 적용 확인**

Run: `pnpm --filter @bandapp/api test:e2e`
Expected: 전부 PASS (global-setup이 `./drizzle`를 migrate한다). 로컬 Postgres가 없으면 `docker compose up -d postgres` 후 재시도.

- [ ] **Step 4: 커밋**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle
git commit -m "feat(api): add peaks columns to takes and sessions

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `Take.peaks`·`Session.peaks` 타입과 API 응답

**Files:**
- Create: `packages/types/src/peaks.ts`
- Modify: `packages/types/src/index.ts`, `packages/types/src/take.ts`, `packages/types/src/session.ts`
- Modify: `apps/api/src/takes/takes.service.ts` (`TAKE_WITH_COUNT`, `TakeRow`, `toTake`)
- Modify: `apps/api/src/sessions/session-mapper.ts` (`SessionRow`, `toSession`, `SESSION_WITH_COUNTS`)
- Modify: `packages/api-client/src/mock/seed.ts` (`generateTakes`, `session()` — 컴파일 유지용 `peaks: null`), `packages/api-client/src/mock/MockApiClient.ts` (`sessions.create` 리터럴)
- Test: `apps/api/test/takes.e2e-spec.ts`, `apps/api/test/sessions.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 1의 `takes.peaks`, `sessions.peaks`.
- Produces: `PEAK_BUCKETS = 128` (`@bandapp/types`), `Take.peaks: number[] | null`, `Session.peaks: number[] | null`. `TakeRow.peaks`, `SessionRow.peaks`. Task 4·5·6이 쓴다.

- [ ] **Step 1: 타입 추가**

`packages/types/src/peaks.ts` (새 파일):

```ts
/**
 * Take.peaks / Session.peaks 길이. 값은 0~255 정수이고 객체(take 하나, 또는 세션 전체) 안의 최댓값이 255다.
 * 완전 무음이면 전부 0 (2026-09-10 스펙 결정 2).
 */
export const PEAK_BUCKETS = 128;
```

`packages/types/src/index.ts`에 `export * from "./peaks";`를 `./invite` 다음 줄에 추가 (알파벳 순).

`packages/types/src/take.ts`의 `Take`에 `commentCount` 뒤:

```ts
  commentCount: number;
  /** 원본 타임라인의 startMs~endMs 구간 피크 (길이 PEAK_BUCKETS). 워커가 못 만들었거나 옛 데이터면 null */
  peaks: number[] | null;
}
```

`packages/types/src/session.ts`의 `Session`에 `commentCount` 뒤:

```ts
  commentCount: number;
  /** 원본 녹음 전체 피크 (길이 PEAK_BUCKETS). ready가 아니거나 옛 데이터면 null */
  peaks: number[] | null;
}
```

- [ ] **Step 2: types 빌드**

Run: `pnpm --filter @bandapp/types build`
Expected: 오류 없음.

- [ ] **Step 3: e2e 테스트를 먼저 고친다 (실패 확인)**

`apps/api/test/takes.e2e-spec.ts`의 `beforeEach` insert를 다음으로 바꾼다 (첫 take에 피크, 둘째는 null):

```ts
    await db.insert(takes).values([
      { sessionId, index: 1, name: "Take 2", startMs: 300_000, endMs: 420_000, type: "PARTIAL_PRACTICE", confidence: 0.6, objectKey: `bands/${bandId}/sessions/${sessionId}/takes/t2.m4a` },
      { sessionId, index: 0, name: "Take 1", startMs: 10_000, endMs: 250_500, type: "PERFORMANCE", confidence: 0.9, objectKey: `bands/${bandId}/sessions/${sessionId}/takes/t1.m4a`, peaks: SEED_PEAKS },
    ]);
```

파일 상단 `describe` 위에:

```ts
/** 길이 128, 0~254 — 워커가 저장한 피크가 그대로 돌아오는지 본다 */
const SEED_PEAKS = Array.from({ length: 128 }, (_, i) => i * 2);
```

첫 테스트의 기대값을 바꾼다:

```ts
    expect(res.body).toEqual([
      { id: first!.id, sessionId, index: 0, name: "Take 1", durationSec: 241, startMs: 10_000, endMs: 250_500, type: "PERFORMANCE", commentCount: 1, peaks: SEED_PEAKS },
      expect.objectContaining({ index: 1, name: "Take 2", durationSec: 120, commentCount: 0, peaks: null }),
    ]);
```

`apps/api/test/sessions.e2e-spec.ts`의 마지막 테스트("멤버는 다른 멤버가 만든 세션도 본다") 뒤에 추가:

```ts
  it("세션 응답은 peaks를 싣는다 — 새 세션은 null, 워커가 채운 값은 그대로", async () => {
    const { session } = await createSession();
    const fresh = await request(app.getHttpServer()).get(`/sessions/${session.id}`).set(auth(owner.accessToken)).expect(200);
    expect(fresh.body.peaks).toBeNull();
    const peaks = Array.from({ length: 128 }, (_, i) => 255 - i);
    await db.update(sessions).set({ peaks }).where(eq(sessions.id, session.id));
    const filled = await request(app.getHttpServer()).get(`/sessions/${session.id}`).set(auth(owner.accessToken)).expect(200);
    expect(filled.body.peaks).toEqual(peaks);
    const list = await request(app.getHttpServer()).get(`/bands/${bandId}/sessions`).set(auth(owner.accessToken)).expect(200);
    expect(list.body[0].peaks).toEqual(peaks);
  });
```

Run: `pnpm --filter @bandapp/api test:e2e -- takes sessions`
Expected: 위 세 단언이 FAIL (응답에 `peaks` 키가 없다).

- [ ] **Step 4: 서버 매퍼 구현**

`apps/api/src/takes/takes.service.ts`:

```ts
export const TAKE_WITH_COUNT = {
  id: takes.id,
  sessionId: takes.sessionId,
  index: takes.index,
  name: takes.name,
  startMs: takes.startMs,
  endMs: takes.endMs,
  type: takes.type,
  objectKey: takes.objectKey,
  peaks: takes.peaks,
  // (기존 commentCount 주석·서브쿼리 그대로)
  commentCount: sql<number>`(select count(*)::int from comments c where c.take_id = "takes"."id" and c.parent_id is null)`,
};

export interface TakeRow {
  id: string;
  sessionId: string;
  index: number;
  name: string;
  startMs: number;
  endMs: number;
  type: TakeCandidateType;
  objectKey: string;
  peaks: number[] | null;
  commentCount: number;
}

export function toTake(row: TakeRow): Take {
  return {
    id: row.id,
    sessionId: row.sessionId,
    index: row.index,
    name: row.name,
    durationSec: Math.round((row.endMs - row.startMs) / 1000),
    startMs: row.startMs,
    endMs: row.endMs,
    type: row.type,
    commentCount: row.commentCount,
    peaks: row.peaks ?? null,
  };
}
```

`apps/api/src/sessions/session-mapper.ts`: `SessionRow`에 `peaks: number[] | null;`을 `commentCount` 뒤에, `toSession`의 객체 리터럴에 `peaks: row.peaks ?? null,`을 `commentCount` 뒤에, `SESSION_WITH_COUNTS`에 `peaks: sessions.peaks,`를 `takeCount` 뒤에 추가한다.

- [ ] **Step 5: api-client Mock 컴파일 유지**

`packages/api-client/src/mock/seed.ts`의 `generateTakes` 반환 리터럴 끝에 `peaks: null`을, `session()` 헬퍼 리터럴 끝에 `peaks: null,`을 더한다 (Task 5가 진짜 값으로 바꾼다). `packages/api-client/src/mock/MockApiClient.ts`의 `sessions.create` 안 `const s: Session = { ... commentCount: 0, }`에 `peaks: null,`을 더한다.

- [ ] **Step 6: 검증**

Run: `pnpm --filter @bandapp/api test:e2e -- takes sessions`
Expected: PASS.
Run: `pnpm --filter @bandapp/api-client build` 다음 `pnpm typecheck`
Expected: 전 패키지 오류 없음 (모바일은 `Take`/`Session`을 읽기만 하므로 필수 필드 추가로 깨지지 않는다).
Run: `pnpm lint`
Expected: 새 경고 없음 (`session-analysis.service.spec.ts`의 기존 경고 1개는 무시).

- [ ] **Step 7: 커밋**

```bash
git add packages/types/src apps/api/src/takes/takes.service.ts apps/api/src/sessions/session-mapper.ts apps/api/test/takes.e2e-spec.ts apps/api/test/sessions.e2e-spec.ts packages/api-client/src/mock/seed.ts packages/api-client/src/mock/MockApiClient.ts
git commit -m "feat: expose peaks on Take and Session

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: 순수 피크 모듈 `worker/peaks.ts`

**Files:**
- Create: `apps/api/src/worker/peaks.ts`
- Test: `apps/api/src/worker/peaks.spec.ts`

**Interfaces:**
- Produces:
  - `export const PEAKS_PER_SEC = 50;`
  - `export class PeakAccumulator { constructor(samplesPerPeak: number); push(buf: Buffer): void; finish(): Uint8Array }`
  - `export function slicePeaks(hires: Uint8Array, peaksPerSec: number, startMs: number, endMs: number, buckets: number): number[]`
  - Task 4가 셋 다 쓴다.

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/src/worker/peaks.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PeakAccumulator, slicePeaks } from "./peaks.js";

/** s16le 버퍼 — ffmpeg stdout과 같은 바이트 순서 */
function pcm(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
  return buf;
}

describe("PeakAccumulator", () => {
  it("창마다 max|s|를 0~255로 환산하고 마지막 자투리 창도 포함한다", () => {
    const acc = new PeakAccumulator(2);
    acc.push(pcm([1000, -2000, 3000]));
    // 2000/32767*255 = 15.56 → 16, 3000 → 23.35 → 23
    expect(Array.from(acc.finish())).toEqual([16, 23]);
  });

  it("청크 경계에 걸린 홀수 바이트를 이월한다", () => {
    const acc = new PeakAccumulator(1);
    const bytes = pcm([32767, -32768]);
    acc.push(bytes.subarray(0, 1));
    acc.push(bytes.subarray(1, 3));
    acc.push(bytes.subarray(3));
    expect(Array.from(acc.finish())).toEqual([255, 255]);
  });

  it("아무것도 안 넣으면 빈 배열", () => {
    expect(new PeakAccumulator(4).finish()).toHaveLength(0);
  });

  it("6만 개 넘는 창도 쌓는다 (내부 버퍼 확장)", () => {
    const acc = new PeakAccumulator(1);
    acc.push(pcm(Array.from({ length: 70_000 }, () => 32767)));
    const out = acc.finish();
    expect(out).toHaveLength(70_000);
    expect(out[69_999]).toBe(255);
  });

  it("samplesPerPeak가 양의 정수가 아니면 throw", () => {
    expect(() => new PeakAccumulator(0)).toThrow();
    expect(() => new PeakAccumulator(1.5)).toThrow();
  });
});

describe("slicePeaks", () => {
  it("구간을 buckets개 창으로 나눠 창 안 max를 취하고 최댓값을 255로 정규화한다", () => {
    const hires = Uint8Array.from([10, 20, 30, 40]);
    // 초당 1개, 0~4초 → [max(10,20), max(30,40)] = [20,40] → [128, 255]
    expect(slicePeaks(hires, 1, 0, 4000, 2)).toEqual([128, 255]);
  });

  it("구간이 buckets보다 짧으면 같은 값이 반복된다", () => {
    const hires = Uint8Array.from([100, 200]);
    expect(slicePeaks(hires, 1, 0, 2000, 4)).toEqual([128, 128, 255, 255]);
  });

  it("범위를 배열 길이로 clamp한다", () => {
    const hires = Uint8Array.from([50, 100]);
    // 끝이 배열 밖 → 있는 만큼만
    expect(slicePeaks(hires, 1, 1000, 9000, 2)).toEqual([255, 255]);
    // 시작이 배열 밖 → 전부 0
    expect(slicePeaks(hires, 1, 5000, 9000, 3)).toEqual([0, 0, 0]);
  });

  it("무음은 정규화하지 않고 0을 유지하고, 빈 배열은 전부 0", () => {
    expect(slicePeaks(Uint8Array.from([0, 0, 0]), 1, 0, 3000, 3)).toEqual([0, 0, 0]);
    expect(slicePeaks(new Uint8Array(0), 50, 0, 1000, 4)).toEqual([0, 0, 0, 0]);
  });

  it("초당 50개 기준으로 ms를 인덱스로 바꾼다", () => {
    // 0~1초는 0, 1~2초는 255
    const hires = Uint8Array.from([...Array<number>(50).fill(0), ...Array<number>(50).fill(255)]);
    expect(slicePeaks(hires, 50, 0, 2000, 2)).toEqual([0, 255]);
    expect(slicePeaks(hires, 50, 1000, 2000, 2)).toEqual([255, 255]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/worker/peaks.spec.ts`
Expected: FAIL — `./peaks.js`를 찾지 못한다.

- [ ] **Step 3: 구현**

`apps/api/src/worker/peaks.ts`:

```ts
/**
 * 파형 피크 계산 — ffmpeg 없이 테스트하는 순수 모듈 (2026-09-10 스펙).
 * 워커는 원본을 한 번 s16le 모노로 디코드해 PeakAccumulator에 흘리고, 세션 전체와 take 구간을
 * slicePeaks로 잘라 PEAK_BUCKETS개로 줄인다.
 */

/** 고해상도 배열의 초당 피크 수. 3시간이면 54만 개(540KB). */
export const PEAKS_PER_SEC = 50;

const INT16_MAX = 32767;
const INITIAL_CAPACITY = 1 << 16;

/** s16le 모노 PCM 청크를 순서대로 받아 창(samplesPerPeak 샘플)마다 max|s|를 0~255로 쌓는다. */
export class PeakAccumulator {
  private buf = new Uint8Array(INITIAL_CAPACITY);
  private length = 0;
  private windowMax = 0;
  private windowCount = 0;
  /** 청크 경계에 걸린 샘플의 하위 바이트 (s16le는 하위 바이트가 먼저 온다) */
  private carry: number | null = null;

  constructor(private readonly samplesPerPeak: number) {
    if (!Number.isInteger(samplesPerPeak) || samplesPerPeak <= 0) {
      throw new Error(`samplesPerPeak must be a positive integer, got ${samplesPerPeak}`);
    }
  }

  push(chunk: Buffer): void {
    let i = 0;
    if (this.carry !== null && chunk.length > 0) {
      this.sample(Buffer.from([this.carry, chunk[0]!]).readInt16LE(0));
      this.carry = null;
      i = 1;
    }
    for (; i + 1 < chunk.length; i += 2) this.sample(chunk.readInt16LE(i));
    if (i < chunk.length) this.carry = chunk[i]!;
  }

  /** 마지막 자투리 창도 포함해 지금까지의 피크를 돌려준다. */
  finish(): Uint8Array {
    if (this.windowCount > 0) this.flush();
    return this.buf.slice(0, this.length);
  }

  private sample(s: number): void {
    const a = s < 0 ? -s : s;
    if (a > this.windowMax) this.windowMax = a;
    if (++this.windowCount === this.samplesPerPeak) this.flush();
  }

  private flush(): void {
    if (this.length === this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    // -32768의 절댓값은 INT16_MAX보다 1 크다 — 255를 넘지 않게 자른다
    this.buf[this.length++] = Math.min(255, Math.round((this.windowMax / INT16_MAX) * 255));
    this.windowMax = 0;
    this.windowCount = 0;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * hires의 [startMs, endMs) 구간을 buckets개 창으로 나눠 창 안 max를 취하고, 최댓값이 255가 되도록
 * 정규화한다. 범위는 배열 길이로 clamp하고, 구간이 buckets보다 짧으면 같은 값이 여러 버킷에 반복된다.
 * 범위가 비거나 전부 0이면 전부 0 (스펙 결정 2).
 */
export function slicePeaks(hires: Uint8Array, peaksPerSec: number, startMs: number, endMs: number, buckets: number): number[] {
  const out = new Array<number>(buckets).fill(0);
  const start = clamp(Math.floor((startMs / 1000) * peaksPerSec), 0, hires.length);
  const end = clamp(Math.ceil((endMs / 1000) * peaksPerSec), start, hires.length);
  const span = end - start;
  if (span === 0) return out;
  let max = 0;
  for (let b = 0; b < buckets; b++) {
    const from = start + Math.floor((b * span) / buckets);
    const to = Math.min(end, Math.max(from + 1, start + Math.floor(((b + 1) * span) / buckets)));
    let m = 0;
    for (let i = from; i < to; i++) if (hires[i]! > m) m = hires[i]!;
    out[b] = m;
    if (m > max) max = m;
  }
  if (max === 0) return out;
  return out.map((v) => Math.round((v / max) * 255));
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/worker/peaks.spec.ts`
Expected: 10개 PASS.

- [ ] **Step 5: 커밋**

```bash
git add apps/api/src/worker/peaks.ts apps/api/src/worker/peaks.spec.ts
git commit -m "feat(worker): peak accumulator and slicePeaks

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `FfmpegRunner.peaks()`와 워커 파이프라인 연결

**Files:**
- Modify: `apps/api/src/worker/ffmpeg.ts`
- Modify: `apps/api/src/worker/session-analysis.service.ts`
- Test: `apps/api/src/worker/session-analysis.service.spec.ts`

**Interfaces:**
- Consumes: Task 3의 `PEAKS_PER_SEC`, `PeakAccumulator`, `slicePeaks`; Task 2의 `PEAK_BUCKETS`; Task 1의 `peaks` 컬럼.
- Produces: `FfmpegRunner.peaks(input: string, peaksPerSec: number): Promise<Uint8Array>`. `takes` insert 행과 `sessions` ready update에 `peaks: number[] | null`.

- [ ] **Step 1: 스펙 테스트를 먼저 고친다 (실패 확인)**

`apps/api/src/worker/session-analysis.service.spec.ts`의 `fakeFfmpeg`를 바꾼다:

```ts
/**
 * 가짜 ffmpeg. peaks는 길이에 맞는 초당 50개 램프(i % 256)를 돌려준다 — 정규화 후 128버킷이 되는지만 본다.
 * peaksError를 주면 피크 추출만 실패한다 (컷·probe는 정상).
 */
function fakeFfmpeg(durationMs: number, peaksError?: Error) {
  const cuts: Array<{ startMs: number; endMs: number }> = [];
  const peaksCalls: number[] = [];
  const ffmpeg: FfmpegRunner = {
    probeDurationMs: async () => durationMs,
    cut: async (_i, startMs, endMs) => { cuts.push({ startMs, endMs }); },
    peaks: async (_i, peaksPerSec) => {
      peaksCalls.push(peaksPerSec);
      if (peaksError) throw peaksError;
      return Uint8Array.from({ length: Math.ceil((durationMs / 1000) * peaksPerSec) }, (_, i) => i % 256);
    },
  };
  return { ffmpeg, cuts, peaksCalls };
}
```

첫 테스트("downloads, chunks, analyzes, ...")의 마지막 단언 뒤에 추가:

```ts
    // take 행과 세션 update 모두 128버킷 피크를 싣는다 — 원본을 한 번만 디코드한다
    expect(peaksCalls).toEqual([50]);
    for (const t of state.insertedTakes) {
      const peaks = t.peaks as number[];
      expect(peaks).toHaveLength(128);
      expect(Math.max(...peaks)).toBe(255);
      expect(peaks.every((p) => Number.isInteger(p) && p >= 0 && p <= 255)).toBe(true);
    }
    expect((state.updates.at(-1)!.peaks as number[])).toHaveLength(128);
```

같은 테스트의 `const { ffmpeg, cuts } = fakeFfmpeg(45 * MIN);`를 `const { ffmpeg, cuts, peaksCalls } = fakeFfmpeg(45 * MIN);`로 바꾼다.

"retries a chunk once and succeeds" 테스트 뒤에 새 테스트 둘:

```ts
  it("stores null peaks and still marks the session ready when peak extraction fails", async () => {
    const { db, state } = fakeDb({ id: "s", bandId: "b", status: "analyzing" });
    const { storage } = fakeStorage();
    const { ffmpeg } = fakeFfmpeg(5 * MIN, new Error("ffmpeg peaks failed"));
    const analyzeFile = vi.fn().mockResolvedValue([{ startMs: 0, endMs: 30_000, type: "PERFORMANCE", confidence: 0.9 }]);
    await new SessionAnalysisService(db, storage, { analyzeFile } as unknown as GeminiService, ffmpeg, tmp, 0).run("s");
    expect(state.insertedTakes).toHaveLength(1);
    expect(state.insertedTakes[0]!.peaks).toBeNull();
    expect(state.updates.at(-1)).toMatchObject({ status: "ready", takeCount: 1, peaks: null });
  });

  it("does not decode peaks when Gemini fails", async () => {
    const { db } = fakeDb({ id: "s", bandId: "b", status: "analyzing" });
    const { storage } = fakeStorage();
    const { ffmpeg, peaksCalls } = fakeFfmpeg(5 * MIN);
    const analyzeFile = vi.fn().mockRejectedValue(new Error("gemini down"));
    await new SessionAnalysisService(db, storage, { analyzeFile } as unknown as GeminiService, ffmpeg, tmp, 0).run("s");
    expect(peaksCalls).toEqual([]);
  });
```

Run: `pnpm --filter @bandapp/api exec vitest run src/worker/session-analysis.service.spec.ts`
Expected: 타입 오류(`peaks`가 `FfmpegRunner`에 없음) 또는 단언 FAIL.

- [ ] **Step 2: `FfmpegRunner.peaks` 구현**

`apps/api/src/worker/ffmpeg.ts`:

```ts
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { PeakAccumulator } from "./peaks.js";

const execFileAsync = promisify(execFile);

// 멈춰버린 ffmpeg/ffprobe 프로세스가 heartbeat만 계속 갱신하며 워커를 영원히 붙잡지 않도록 상한을 둔다.
const FFPROBE_TIMEOUT_MS = 60_000;
const FFMPEG_CUT_TIMEOUT_MS = 10 * 60_000;
const FFMPEG_PEAKS_TIMEOUT_MS = 10 * 60_000;
/** 피크용 디코드 샘플레이트 — 파형 모양만 필요하니 낮춰서 디코드 시간과 파이프 양을 줄인다 */
const PEAKS_SAMPLE_RATE = 8000;

export interface FfmpegRunner {
  probeDurationMs(input: string): Promise<number>;
  /** 재인코딩 없이(`-c copy`) 구간을 잘라낸다. AAC는 프레임이 독립적이라 ~23ms 정밀도로 충분하다. */
  cut(input: string, startMs: number, endMs: number, output: string): Promise<void>;
  /** 전체를 모노 s16le로 디코드해 초당 peaksPerSec개의 피크(0~255)를 돌려준다 (2026-09-10 스펙 결정 3). */
  peaks(input: string, peaksPerSec: number): Promise<Uint8Array>;
}
```

`ExecFfmpegRunner` 클래스에 메서드 추가 (`cut` 뒤):

```ts
  peaks(input: string, peaksPerSec: number): Promise<Uint8Array> {
    const acc = new PeakAccumulator(Math.max(1, Math.round(PEAKS_SAMPLE_RATE / peaksPerSec)));
    return new Promise((resolve, reject) => {
      // stdout으로 raw PCM을 흘려 파일을 만들지 않는다 — 3시간이면 8kHz s16le로 86MB라 디스크에 두지 않는다.
      const child = spawn(
        this.ffmpegBin,
        ["-v", "error", "-i", input, "-vn", "-ac", "1", "-ar", String(PEAKS_SAMPLE_RATE), "-f", "s16le", "-"],
        { stdio: ["ignore", "pipe", "pipe"], timeout: FFMPEG_PEAKS_TIMEOUT_MS },
      );
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => acc.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (code === 0) resolve(acc.finish());
        else reject(new Error(`ffmpeg peaks failed for ${input} (code ${code}, signal ${signal}): ${stderr.trim()}`));
      });
    });
  }
```

- [ ] **Step 3: 파이프라인 연결**

`apps/api/src/worker/session-analysis.service.ts` import에 추가:

```ts
import { PEAK_BUCKETS } from "@bandapp/types";
import { PEAKS_PER_SEC, slicePeaks } from "./peaks.js";
```

(`import type { TakeCandidate } from "@bandapp/types";`는 `import { PEAK_BUCKETS, type TakeCandidate } from "@bandapp/types";`로 합친다.)

`run()`에서 `const merged = mergeCandidates(candidates);` 바로 뒤:

```ts
      const merged = mergeCandidates(candidates);
      // Gemini가 끝난 뒤에 디코드한다 — 분석이 실패하면 디코드 비용을 쓰지 않는다 (스펙 결정 7)
      const hires = await this.extractPeaks(sessionId, original);
```

`rows.push({ ... objectKey: key, })`에 필드 추가:

```ts
          objectKey: key,
          peaks: hires ? slicePeaks(hires, PEAKS_PER_SEC, candidate.startMs, candidate.endMs, PEAK_BUCKETS) : null,
```

마무리 트랜잭션의 `.set({...})`에 `analysisModel: model,` 뒤:

```ts
            analysisModel: model,
            peaks: hires ? slicePeaks(hires, PEAKS_PER_SEC, 0, durationMs, PEAK_BUCKETS) : null,
```

`fail()` 위에 메서드 추가:

```ts
  /**
   * 파형은 재생 화면의 장식이지 분석 결과가 아니다 — 피크 추출이 실패해도 세션은 ready가 되고
   * peaks만 null로 남긴다 (스펙 결정 5). 앱은 null을 평평한 플레이스홀더로 그린다.
   */
  private async extractPeaks(sessionId: string, original: string): Promise<Uint8Array | null> {
    try {
      return await this.ffmpeg.peaks(original, PEAKS_PER_SEC);
    } catch (err) {
      this.logger.warn(`session ${sessionId}: peaks failed, storing null: ${String(err)}`);
      return null;
    }
  }
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/worker`
Expected: 전부 PASS (기존 8개 + 새 2개 + peaks.spec 10개).
Run: `pnpm --filter @bandapp/api typecheck` 다음 `pnpm --filter @bandapp/api lint`
Expected: 오류 없음.

- [ ] **Step 5: 커밋**

```bash
git add apps/api/src/worker/ffmpeg.ts apps/api/src/worker/session-analysis.service.ts apps/api/src/worker/session-analysis.service.spec.ts
git commit -m "feat(worker): extract session and take peaks from the original recording

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Mock 시드 피크

**Files:**
- Modify: `packages/api-client/src/mock/seed.ts`
- Modify: `packages/api-client/src/mock/MockApiClient.ts` (`scheduleAnalysis`)
- Test: `packages/api-client/src/mock/MockApiClient.test.ts`

**Interfaces:**
- Consumes: Task 2의 `PEAK_BUCKETS`, `Take.peaks`, `Session.peaks`.
- Produces: `export function fakePeaks(seed: number): number[]` (`seed.ts`). Mock의 시드 take·ready 세션·분석 완료 세션에 피크가 들어 있고 `s1`의 마지막 take는 null.

- [ ] **Step 1: 실패하는 테스트 작성**

`packages/api-client/src/mock/MockApiClient.test.ts`의 "lists takes with seeded comment counts" 테스트 뒤에 추가:

```ts
  it("seeded takes and ready sessions carry 128-bucket peaks, and s1's last take is null (placeholder preview)", async () => {
    const api = new MockApiClient();
    const takes = await api.takes.list("s1");
    const first = takes[0]!.peaks!;
    expect(first).toHaveLength(128);
    expect(Math.max(...first)).toBe(255);
    expect(first.every((p) => Number.isInteger(p) && p >= 0 && p <= 255)).toBe(true);
    expect(takes.at(-1)!.peaks).toBeNull();
    const sessions = await api.sessions.list(BAND);
    expect(sessions.find((s) => s.id === "s1")!.peaks).toHaveLength(128);
    expect(sessions.find((s) => s.id === "p1")!.peaks).toBeNull();
  });
```

"retryAnalysis moves failed session to analyzing then ready" 테스트 안, ready를 확인하는 단언 뒤에 추가 (기존 단언은 그대로):

```ts
    const ready = await api.sessions.get("f1");
    expect(ready.peaks).toHaveLength(128);
    const takes = await api.takes.list("f1");
    expect(takes.every((t) => t.peaks?.length === 128)).toBe(true);
```

Run: `pnpm --filter @bandapp/api-client test`
Expected: 새 단언 FAIL (`peaks`가 null).

- [ ] **Step 2: 구현**

`packages/api-client/src/mock/seed.ts` 상단 import를 바꾼다:

```ts
import { PEAK_BUCKETS, type Band, type BandMember, type CommentTarget, type Session, type Take, type TakeComment } from "@bandapp/types";
import { seedOf, seededUnit } from "./rand";
```

`generateTakes` 위에 추가:

```ts
/** 결정적 가짜 피크 — 길이 PEAK_BUCKETS, 0~255, 최댓값 255 (워커 출력과 같은 형식) */
export function fakePeaks(seed: number): number[] {
  const raw = Array.from({ length: PEAK_BUCKETS }, (_, i) => 0.15 + 0.85 * seededUnit(seed * 97 + i * 13));
  const max = Math.max(...raw);
  return raw.map((v) => Math.round((v / max) * 255));
}
```

`generateTakes`의 리터럴에서 `peaks: null`을 `peaks: fakePeaks(seed * 7 + i)`로 바꾼다.

`session()` 헬퍼의 `peaks: null,`을 `peaks: status === "ready" ? fakePeaks(seedOf(id)) : null,`로 바꾼다.

`createSeedState`에서 s1 take 길이를 고치는 블록에 한 줄 추가:

```ts
      if (s.id === "s1" && sessionTakes.length > 1) {
        sessionTakes[0]!.durationSec = 272;
        sessionTakes[1]!.durationSec = 268;
        // 옛 데이터·추출 실패 상태를 프리뷰에서 본다 — 평평한 플레이스홀더 (2026-09-10 스펙 결정 6)
        sessionTakes.at(-1)!.peaks = null;
      }
```

`packages/api-client/src/mock/MockApiClient.ts`: import를 `import { commentKey, createSeedState, fakePeaks, generateTakes, type MockState } from "./seed";`로 바꾸고, `scheduleAnalysis`의 `s.status = "ready";` 앞에:

```ts
      // 워커가 ready로 바꿀 때 세션 피크도 채우는 것을 흉내 낸다 (take는 generateTakes가 채운다)
      s.peaks = fakePeaks(s.id.length * 31 + s.durationSec);
      s.status = "ready";
```

- [ ] **Step 3: 통과 확인**

Run: `pnpm --filter @bandapp/api-client test`
Expected: 전부 PASS.
Run: `pnpm --filter @bandapp/api-client build`
Expected: 오류 없음 (모바일이 dist를 읽는다).

- [ ] **Step 4: 커밋**

```bash
git add packages/api-client/src/mock/seed.ts packages/api-client/src/mock/MockApiClient.ts packages/api-client/src/mock/MockApiClient.test.ts
git commit -m "feat(api-client): seed fake peaks in the mock client

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: 모바일 — 피크로 파형 그리기

**Files:**
- Create: `apps/mobile/src/lib/peaks.ts`
- Test: `apps/mobile/src/lib/peaks.test.ts`
- Modify: `apps/mobile/src/ui/StaticWaveform.tsx`, `apps/mobile/src/ui/PlayerWaveform.tsx`
- Modify: `apps/mobile/src/features/takes/TakeRow.tsx`, `apps/mobile/src/features/takes/TakePlayerScreen.tsx`
- Modify: `apps/mobile/src/lib/seed.ts` (`seedOf` 삭제)

**Interfaces:**
- Consumes: Task 2의 `Take.peaks`, `Session.peaks`; Task 5의 Mock 피크(프리뷰).
- Produces: `resamplePeaks(peaks: number[] | null, bars: number): number[]` (0~1), `barHeight(unit: number, height: number, minPx: number): number`. `StaticWaveform`/`PlayerWaveform`의 `seed` prop이 `peaks: number[] | null`로 바뀐다.

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/mobile/src/lib/peaks.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { barHeight, resamplePeaks } from "./peaks";

describe("resamplePeaks", () => {
  it("창 안 max를 0~1로 돌려준다", () => {
    expect(resamplePeaks([0, 255, 51, 102], 2)).toEqual([1, 0.4]);
  });
  it("bars가 입력보다 많으면 값이 반복된다", () => {
    expect(resamplePeaks([255, 0], 4)).toEqual([1, 1, 0, 0]);
  });
  it("null·빈 배열은 전부 0 (플레이스홀더)", () => {
    expect(resamplePeaks(null, 3)).toEqual([0, 0, 0]);
    expect(resamplePeaks([], 2)).toEqual([0, 0]);
  });
  it("128개를 36·64개로 줄여도 길이가 맞다", () => {
    const peaks = Array.from({ length: 128 }, (_, i) => i * 2);
    expect(resamplePeaks(peaks, 36)).toHaveLength(36);
    expect(resamplePeaks(peaks, 64)).toHaveLength(64);
    expect(resamplePeaks(peaks, 64).at(-1)).toBe(254 / 255);
  });
});

describe("barHeight", () => {
  it("지금까지의 공식과 같다 — 12% 바닥, 88% 스케일, 최소 픽셀", () => {
    expect(barHeight(0, 26, 2)).toBe(3);
    expect(barHeight(1, 26, 2)).toBe(26);
    expect(barHeight(0, 88, 3)).toBe(11);
    expect(barHeight(0.5, 88, 3)).toBe(49);
    expect(barHeight(0, 10, 3)).toBe(3);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter mobile exec vitest run src/lib/peaks.test.ts`
Expected: FAIL — `./peaks` 없음.

- [ ] **Step 3: 헬퍼 구현**

`apps/mobile/src/lib/peaks.ts`:

```ts
/**
 * 서버 피크(길이 PEAK_BUCKETS, 0~255)를 화면 바 개수에 맞춰 줄인다 (2026-09-10 스펙).
 * 창 안 max를 취해 봉우리를 살리고, null이면 전부 0 → 모든 바가 최소 높이 = 평평한 플레이스홀더.
 */
export function resamplePeaks(peaks: number[] | null, bars: number): number[] {
  const out = new Array<number>(bars).fill(0);
  if (!peaks || peaks.length === 0) return out;
  const n = peaks.length;
  for (let b = 0; b < bars; b++) {
    const from = Math.floor((b * n) / bars);
    const to = Math.min(n, Math.max(from + 1, Math.floor(((b + 1) * n) / bars)));
    let m = 0;
    for (let i = from; i < to; i++) if (peaks[i]! > m) m = peaks[i]!;
    out[b] = m / 255;
  }
  return out;
}

/** 바 높이 — 시드 파형 때와 같은 공식. 표시 곡선을 바꾸고 싶으면 여기 한 곳만 고친다. */
export function barHeight(unit: number, height: number, minPx: number): number {
  return Math.max(minPx, Math.round((0.12 + 0.88 * unit) * height));
}
```

Run: `pnpm --filter mobile exec vitest run src/lib/peaks.test.ts`
Expected: PASS.

- [ ] **Step 4: 컴포넌트 교체**

`apps/mobile/src/ui/StaticWaveform.tsx` 전체:

```tsx
import { useMemo } from "react";
import { View } from "react-native";
import { barHeight, resamplePeaks } from "@/lib/peaks";
import { useTheme } from "@/theme";

/** take 목록 행의 정적 파형. peaks가 null이면 평평한 플레이스홀더 (2026-09-10 스펙 결정 6). */
export function StaticWaveform({
  peaks,
  bars = 36,
  height = 26,
  color,
}: {
  peaks: number[] | null;
  bars?: number;
  height?: number;
  color?: string;
}) {
  const { colors } = useTheme();
  const units = useMemo(() => resamplePeaks(peaks, bars), [peaks, bars]);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 2, height }}>
      {units.map((u, i) => (
        <View
          key={i}
          style={{
            width: 2,
            borderRadius: 1,
            backgroundColor: color ?? colors.borderHover,
            height: barHeight(u, height, 2),
          }}
        />
      ))}
    </View>
  );
}
```

`apps/mobile/src/ui/PlayerWaveform.tsx`: import에서 `seededUnit`을 지우고 `import { useMemo, useRef } from "react";`, `import { barHeight, resamplePeaks } from "@/lib/peaks";`로 바꾼다. props의 `seed: number;`를 `/** null이면 평평한 플레이스홀더 */ peaks: number[] | null;`로 바꾸고 구조분해도 `seed` → `peaks`. `const bars = 64;` 뒤에 `const units = useMemo(() => resamplePeaks(peaks, bars), [peaks, bars]);`를 두고, 바 렌더를 다음으로 바꾼다:

```tsx
      <View pointerEvents="none" style={{ flexDirection: "row", alignItems: "center", gap: 2, height }}>
        {units.map((u, i) => (
          <View
            key={i}
            style={{
              flex: 1,
              borderRadius: 1,
              backgroundColor: i / bars <= frac ? colors.accent : colors.borderStronger,
              height: barHeight(u, height, 3),
            }}
          />
        ))}
      </View>
```

- [ ] **Step 5: 화면 연결과 `seedOf` 삭제**

`apps/mobile/src/features/takes/TakeRow.tsx`: `import { seedOf } from "@/lib/seed";` 삭제, `<StaticWaveform seed={seedOf(take.id)} />` → `<StaticWaveform peaks={take.peaks} />`.

`apps/mobile/src/features/takes/TakePlayerScreen.tsx`: `import { seedOf } from "@/lib/seed";` 삭제. `take` memo를 다음으로:

```tsx
  const take = useMemo(() => {
    if (!session) return undefined;
    if (isOriginal) {
      return { id: "orig", name: "Original recording", durationSec: session.durationSec, peaks: session.peaks };
    }
    const t = (takes ?? []).find((x) => x.id === takeId);
    return t ? { id: t.id, name: t.name, durationSec: t.durationSec, peaks: t.peaks } : undefined;
  }, [session, takes, takeId, isOriginal]);
```

`<PlayerWaveform seed={seedOf(isOriginal ? \`${session.id}-orig\` : take.id)}` → `<PlayerWaveform peaks={take.peaks}`.

`apps/mobile/src/lib/seed.ts`에서 `seedOf` 함수를 지운다 (`seededUnit`은 `LiveWaveform`·`LoginScreen`이 쓴다). `grep -rn "seedOf" apps/mobile/src`가 아무것도 찾지 않아야 한다.

- [ ] **Step 6: 검증**

Run: `pnpm --filter mobile typecheck`
Expected: 오류 없음.
Run: `pnpm --filter mobile test`
Expected: 전부 PASS.
Run: `pnpm lint`
Expected: 새 경고 없음.

웹 프리뷰(Mock)로 확인: `.claude/launch.json`의 `mobile-web-mock`(메인 체크아웃) 또는 워크트리에서 `CI=1 EXPO_PUBLIC_API_URL= pnpm --filter mobile exec expo start --web --port 8082`. 세션 s1 → take 목록 행 7개 중 앞 6개는 들쭉날쭉한 파형, 마지막 take는 평평한 바. Take 1 플레이어와 "Original recording" 플레이어 모두 파형이 그려지고 seek이 되는지 본다. 스크린샷을 남긴다.

- [ ] **Step 7: 커밋**

```bash
git add apps/mobile/src/lib/peaks.ts apps/mobile/src/lib/peaks.test.ts apps/mobile/src/lib/seed.ts apps/mobile/src/ui/StaticWaveform.tsx apps/mobile/src/ui/PlayerWaveform.tsx apps/mobile/src/features/takes/TakeRow.tsx apps/mobile/src/features/takes/TakePlayerScreen.tsx
git commit -m "feat(mobile): draw take and session waveforms from real peaks

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: 문서

**Files:**
- Modify: `README.md` (분석 파이프라인 줄)
- Modify: `docs/backlog.md` ("재생·피드백" 절)

- [ ] **Step 1: README**

`README.md`의 "분석 파이프라인:" 줄에서 `worker(R2 다운로드 → ffmpeg 청크 → Gemini → take 절단 → R2 업로드 → DB)`를 `worker(R2 다운로드 → ffmpeg 청크 → Gemini → 피크 추출(원본 1회 디코드) → take 절단 → R2 업로드 → DB)`로 바꾼다.

- [ ] **Step 2: 백로그**

`docs/backlog.md` "## 재생·피드백"에서 `- **실제 파형.** 워커가 take별 피크 배열을 만들어 저장하고 앱이 그린다. 지금은 시드 기반 가짜 파형.` 줄을 지우고, 그 자리에:

```markdown
- **녹음 중 라이브 파형 실제 미터링.** `LiveWaveform`은 아직 시드 애니메이션이다. expo-audio metering 값으로 그리려면 기기 검증이 필요하다 ([2026-09-10 스펙](superpowers/specs/2026-09-10-real-waveform-design.md) 범위 제외).
- **파형 표시 곡선 튜닝.** 선형 진폭을 그대로 그린다. 조용한 구간이 너무 낮아 보이면 `apps/mobile/src/lib/peaks.ts`의 `barHeight` 한 곳에서 sqrt 등으로 바꾼다.
- **기존 세션 피크 백필.** 2026-09-10 이전에 분석된 세션은 `peaks`가 null이라 평평한 플레이스홀더로 보인다. 필요해지면 Gemini 없이 R2 원본만 내려받아 `slicePeaks`로 채우는 일회성 스크립트를 만든다. 지금은 retry로 재분석한다.
```

- [ ] **Step 3: 커밋**

```bash
git add README.md docs/backlog.md
git commit -m "docs: describe peak extraction and update backlog

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## 완료 기준

- `pnpm test --force`, `pnpm typecheck`, `pnpm lint`, `pnpm build` 전부 통과 (기존 oxlint 경고 1개 제외).
- 웹 프리뷰(Mock)에서 take 목록·take 플레이어·원본 녹음 플레이어가 피크 파형을 그리고, s1 마지막 take는 평평한 플레이스홀더.
- `grep -rn "seedOf" apps/mobile/src` 결과 없음.
