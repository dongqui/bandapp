# 오디오 업로드 → 분석 → Take → 코멘트 (서버 + 공유 패키지) 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 모바일이 m4a를 R2에 직접 올리면 워커가 Gemini로 연주 구간을 찾아 Take 파일을 잘라 두고, 멤버가 Take에 코멘트를 남기는 서버 전 구간을 실제 R2·Gemini로 검증한다.

**Architecture:** NestJS API가 presigned multipart 업로드를 발급·완료하고 SQS에 `{ sessionId }`를 발행한다. NestJS 워커가 R2에서 원본을 받아 ffmpeg으로 20분 청크를 잘라 Gemini에 보내고, 병합한 Take를 ffmpeg으로 잘라 R2에 올린 뒤 DB에 저장한다. `packages/types`가 계약을, `packages/api-client`가 HTTP 구현과 업로드 오케스트레이터를 갖는다.

**Tech Stack:** NestJS 12, Drizzle ORM + PostgreSQL 17, `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`(R2), `@aws-sdk/client-sqs`(LocalStack), `@google/genai`, ffmpeg/ffprobe(child_process), vitest, supertest.

**스펙:** [docs/superpowers/specs/2026-09-04-upload-analysis-takes-feedback-design.md](../specs/2026-09-04-upload-analysis-takes-feedback-design.md)

**모바일 플랜:** [2026-09-04-upload-analysis-mobile.md](2026-09-04-upload-analysis-mobile.md) — 이 플랜이 끝난 뒤 실행한다.

## Global Constraints

- 모든 서버 코드는 ESM이며 상대 import에 `.js` 접미사를 붙인다 (`import { x } from "./y.js"`).
- 검증은 hand-rolled: `apps/api/src/common/validation.ts`의 헬퍼 + `BadRequestException`. class-validator/zod 도입 금지.
- 서비스는 `@Injectable` 대신 `export const xServiceProvider: Provider = { provide, useFactory, inject }` 관례를 따른다.
- env는 `process.env` 직접 읽기. 필수 env가 비어 있으면 **호출 시점**에 throw (부팅은 가능해야 한다).
- DB를 만지는 테스트는 `apps/api/test/*.e2e-spec.ts` (localhost:5432, `truncateAll`), 순수 로직은 `*.spec.ts`.
- 와이어 단위: `durationSec`/`atSec`는 초, `startMs`/`endMs`는 ms. DB는 전부 ms.
- 파트 크기 10MB(`10 * 1024 * 1024`), presigned URL 유효 3600초, 청크 20분/겹침 30초, 최소 Take 길이 20초.
- R2 버킷 `taken-rehearsal-dev`, 엔드포인트 `https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, region `auto`.
- 사용자에게 보이는 오류 메시지는 한국어, `~해요` 체.
- 커밋 메시지는 영어 conventional commit, 본문 끝에 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- 테스트 실행: `pnpm --filter @bandapp/api test:e2e`는 docker postgres가 떠 있어야 한다 (`docker compose up -d postgres`).

## 파일 구조

```
packages/types/src/session.ts            Session, SessionStatus, CreateSessionInput, 업로드 계약 타입
packages/types/src/take.ts               Take(+startMs/endMs/type), TakeComment(+authorId/parentId/createdAt)
packages/types/src/analysis.ts           TakeCandidate 유지, AnalyzeSessionJob 추가, RecordingAnalysisResult 삭제

apps/api/src/db/schema.ts                sessions/recordings/takes/comments + enum 3종 + auth_provider DEV
apps/api/drizzle/0004_*.sql              drizzle-kit generate 산출물
apps/api/src/common/validation.ts        requireInteger/optionalInteger/requireOneOf/requireIsoDate 추가
apps/api/src/storage/storage.service.ts  StorageService(abstract) + R2StorageService
apps/api/src/storage/storage.module.ts   provider 등록·export
apps/api/src/analysis/analysis.producer.ts  enqueueAnalysis(sessionId)
apps/api/src/analysis/analysis.module.ts    controller 제거, producer export
apps/api/src/analysis/chunking.ts        planChunks, mergeCandidates (순수)
apps/api/src/analysis/gemini.service.ts  analyzeFile(absPath), files.delete
apps/api/src/sessions/sessions.service.ts   생성/목록/조회/업로드/완료/재시도/원본 URL
apps/api/src/sessions/sessions.controller.ts  /bands/:bandId/sessions, /sessions/:id/*
apps/api/src/sessions/session-mapper.ts  DB row → Session, titleFor
apps/api/src/takes/takes.service.ts      목록, 오디오 URL, 접근 검증
apps/api/src/takes/takes.controller.ts   /sessions/:id/takes, /takes/:id/audio
apps/api/src/comments/comments.service.ts, comments.controller.ts
apps/api/src/auth/auth.controller.ts     POST /auth/dev
apps/api/src/auth/auth.service.ts        loginWithDev
apps/api/src/worker/ffmpeg.ts            FfmpegRunner + ExecFfmpegRunner
apps/api/src/worker/session-analysis.service.ts  파이프라인
apps/api/src/worker/analysis.consumer.ts  { sessionId } 처리, visibility heartbeat
apps/api/scripts/upload-session.ts       Windows 라이브 검증 스크립트
apps/api/test/app-util.ts                storage/producer 오버라이드
apps/api/test/db-util.ts                 truncateAll에 새 테이블
apps/api/Dockerfile, docker/localstack/init-aws.sh, .env.example, README.md
packages/api-client/src/upload.ts        uploadRecording (순수)
packages/api-client/src/client.ts        인터페이스 확장
packages/api-client/src/http/HttpApiClient.ts   sessions/takes/comments 실구현
packages/api-client/src/mock/MockApiClient.ts   새 메서드 구현
docs/backlog.md                          이월 항목
```

---

### Task 1: 공유 타입 계약

**Files:**
- Modify: `packages/types/src/session.ts`
- Modify: `packages/types/src/take.ts`
- Modify: `packages/types/src/analysis.ts`

**Interfaces:**
- Produces: 아래 타입 전부. 이후 모든 task가 `@bandapp/types`에서 import한다.

- [ ] **Step 1: session.ts 교체**

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
  /** ISO 8601, 오프셋 포함 (예: "2026-09-04T19:03:00.000Z"). 표시 시각은 클라이언트가 로컬로 변환한다. */
  startedAt: string;
  /** 워커가 측정하기 전(가져오기)에는 0 */
  durationSec: number;
  takeCount: number;
  /** 세션 내 전체 코멘트 수 (목록 meta 표시용) */
  commentCount: number;
}

export type RecordingContentType = "audio/mp4" | "audio/x-m4a";

export interface CreateSessionInput {
  /** ISO 8601, 오프셋 포함. 서버가 날짜 부분으로 title을 만든다. */
  startedAt: string;
  /** 녹음은 알고 있고, 가져오기는 모른다 (워커가 측정). */
  durationMs?: number;
  sizeBytes: number;
  contentType: RecordingContentType;
  source: "recording" | "import";
}

export interface CreateSessionResult {
  session: Session;
  upload: { partSize: number; partCount: number };
}

export interface UploadPartUrl {
  partNumber: number;
  url: string;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

export interface UploadStatus {
  partSize: number;
  partCount: number;
  uploadedParts: UploadedPart[];
}

export interface AudioUrl {
  url: string;
  expiresAt: string;
}
```

- [ ] **Step 2: take.ts 교체**

```ts
import type { TakeCandidateType } from "./analysis";

export interface Take {
  id: string;
  sessionId: string;
  /** 0부터 시작 */
  index: number;
  name: string;
  durationSec: number;
  /** 원본 녹음 기준 구간 */
  startMs: number;
  endMs: number;
  type: TakeCandidateType;
  commentCount: number;
}

export interface TakeComment {
  id: string;
  takeId: string;
  authorId: string;
  authorName: string;
  /** 대댓글용. 이번 범위에서는 항상 null */
  parentId: string | null;
  atSec: number;
  text: string;
  createdAt: string;
}

export interface CreateCommentInput {
  atSec: number;
  text: string;
}
```

- [ ] **Step 3: analysis.ts 교체**

```ts
export type TakeCandidateType = "PERFORMANCE" | "PARTIAL_PRACTICE";

/** AI 분석이 추출한 연주 구간 후보. 사용자가 수정 가능한 초안이다. */
export interface TakeCandidate {
  startMs: number;
  endMs: number;
  type: TakeCandidateType;
  /** 0..1 */
  confidence: number;
}

/** SQS recording-analysis 큐 메시지 본문 */
export interface AnalyzeSessionJob {
  sessionId: string;
}
```

- [ ] **Step 4: 빌드해서 타입 오류 확인**

Run: `pnpm --filter @bandapp/types build`
Expected: 성공. (`RecordingAnalysisResult`를 쓰던 `apps/api/src/worker/analysis.consumer.ts`와 `CreateSessionInput`을 정의하던 `packages/api-client/src/client.ts`는 뒤 task에서 고친다 — 지금 `pnpm build` 전체는 실패해도 된다.)

- [ ] **Step 5: Commit**

```bash
git add packages/types/src
git commit -m "feat(types): define session upload, take, and comment contracts"
```

---

### Task 2: DB 스키마와 마이그레이션

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/drizzle/0004_*.sql` (drizzle-kit이 이름을 짓는다)
- Modify: `apps/api/test/db-util.ts`
- Test: `apps/api/test/db.e2e-spec.ts` (기존 파일에 케이스 추가)

**Interfaces:**
- Produces: `sessions`, `recordings`, `takes`, `comments` 테이블 객체, `sessionStatus`/`uploadStatus`/`takeType` enum, `AuthProviderName` 타입.

- [ ] **Step 1: 실패하는 e2e 테스트 추가**

`apps/api/test/db.e2e-spec.ts` 끝에 추가 (파일 상단 import에 `sessions, recordings, takes, comments, bands, users`를 더한다):

```ts
  it("sessions → recordings → takes → comments 체인을 삽입하고 cascade로 지운다", async () => {
    const [user] = await db.insert(users).values({ displayName: "D" }).returning();
    const [band] = await db.insert(bands).values({ name: "B" }).returning();
    const [session] = await db
      .insert(sessions)
      .values({ bandId: band!.id, createdBy: user!.id, title: "Sep 4 Rehearsal", status: "uploading", startedAt: new Date() })
      .returning();
    await db.insert(recordings).values({
      sessionId: session!.id,
      objectKey: `bands/${band!.id}/sessions/${session!.id}/original.m4a`,
      contentType: "audio/mp4",
      sizeBytes: 64_277_703,
      uploadId: "u1",
      partSize: 10 * 1024 * 1024,
      partCount: 7,
      uploadStatus: "pending",
    });
    const [take] = await db
      .insert(takes)
      .values({ sessionId: session!.id, index: 0, name: "Take 1", startMs: 1000, endMs: 61000, type: "PERFORMANCE", confidence: 0.9, objectKey: "k" })
      .returning();
    const [parent] = await db
      .insert(comments)
      .values({ takeId: take!.id, authorId: user!.id, atMs: 5000, text: "hi" })
      .returning();
    await db.insert(comments).values({ takeId: take!.id, authorId: user!.id, parentId: parent!.id, atMs: 5000, text: "reply" });

    await db.delete(sessions).where(eq(sessions.id, session!.id));
    expect(await db.select().from(comments)).toHaveLength(0);
    expect(await db.select().from(takes)).toHaveLength(0);
    expect(await db.select().from(recordings)).toHaveLength(0);
  });
```

- [ ] **Step 2: 실행해서 실패 확인**

Run: `pnpm --filter @bandapp/api test:e2e -- test/db.e2e-spec.ts`
Expected: FAIL — `sessions` export 없음.

- [ ] **Step 3: schema.ts에 enum·테이블 추가**

`authProvider`를 바꾸고, 파일 끝에 테이블을 더한다. import에 `bigint, real, index, type AnyPgColumn`을 추가한다.

```ts
export const authProvider = pgEnum("auth_provider", ["GOOGLE", "APPLE", "DEV"]);
export type AuthProviderName = (typeof authProvider.enumValues)[number];

// @bandapp/types의 SessionStatus / TakeCandidateType과 값을 일치시킨다
export const sessionStatus = pgEnum("session_status", ["uploading", "analyzing", "failed", "ready"]);
export const uploadStatus = pgEnum("upload_status", ["pending", "completed", "aborted"]);
export const takeType = pgEnum("take_type", ["PERFORMANCE", "PARTIAL_PRACTICE"]);
```

```ts
export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  bandId: uuid("band_id")
    .notNull()
    .references(() => bands.id, { onDelete: "cascade" }),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  title: text("title").notNull(),
  name: text("name"),
  status: sessionStatus("status").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  // 가져오기는 클라이언트가 길이를 모른다 — 워커가 ffprobe로 채운다
  durationMs: integer("duration_ms"),
  takeCount: integer("take_count").notNull().default(0),
  analysisError: text("analysis_error"),
  analysisModel: text("analysis_model"),
  ...timestamps,
});

// 세션과 1:1. 저장 객체와 업로드 상태의 수명주기가 세션과 달라 테이블을 나눈다 (스펙 결정 5)
export const recordings = pgTable("recordings", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .unique()
    .references(() => sessions.id, { onDelete: "cascade" }),
  objectKey: text("object_key").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  uploadId: text("upload_id"),
  partSize: integer("part_size").notNull(),
  partCount: integer("part_count").notNull(),
  uploadStatus: uploadStatus("upload_status").notNull().default("pending"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const takes = pgTable(
  "takes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    index: integer("index").notNull(),
    name: text("name").notNull(),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    type: takeType("type").notNull(),
    confidence: real("confidence").notNull(),
    objectKey: text("object_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("takes_session_index_uq").on(t.sessionId, t.index)],
);

export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    takeId: uuid("take_id")
      .notNull()
      .references(() => takes.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    // 대댓글 자리 (스펙 결정 6). 이번 범위에서는 항상 null
    parentId: uuid("parent_id").references((): AnyPgColumn => comments.id, { onDelete: "cascade" }),
    atMs: integer("at_ms").notNull(),
    text: text("text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("comments_take_at_idx").on(t.takeId, t.atMs)],
);
```

- [ ] **Step 4: 마이그레이션 생성 및 확인**

Run: `pnpm --filter @bandapp/api db:generate`
Expected: `apps/api/drizzle/0004_<name>.sql` 생성. 내용에 `ALTER TYPE "public"."auth_provider" ADD VALUE 'DEV'`, `CREATE TYPE ... session_status/upload_status/take_type`, `CREATE TABLE sessions/recordings/takes/comments`가 있는지 `cat`으로 확인한다.

- [ ] **Step 5: truncateAll 갱신**

`apps/api/test/db-util.ts`:

```ts
export async function truncateAll(db: Db): Promise<void> {
  await db.execute(
    sql`TRUNCATE comments, takes, recordings, sessions, band_invites, band_members, bands, auth_sessions, user_identities, users CASCADE`,
  );
}
```

- [ ] **Step 6: 마이그레이션 적용 후 테스트 통과 확인**

Run: `pnpm --filter @bandapp/api test:e2e -- test/db.e2e-spec.ts`
Expected: PASS (global-setup이 `drizzle/`의 새 마이그레이션을 적용한다).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle apps/api/test/db-util.ts apps/api/test/db.e2e-spec.ts
git commit -m "feat(api): add sessions, recordings, takes, and comments tables"
```

---

### Task 3: 검증 헬퍼 확장

**Files:**
- Modify: `apps/api/src/common/validation.ts`
- Create: `apps/api/src/common/validation.spec.ts`

**Interfaces:**
- Produces: `requireInteger(body, field, { min, max })`, `optionalInteger(body, field, { min, max })`, `requireOneOf(body, field, values)`, `requireIsoDate(body, field)`, `requireNumber(body, field, { min, max })`.

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/src/common/validation.spec.ts`:

```ts
import { BadRequestException } from "@nestjs/common";
import {
  optionalInteger,
  requireInteger,
  requireIsoDate,
  requireNumber,
  requireOneOf,
} from "./validation.js";

describe("requireInteger", () => {
  it("returns the integer within range", () => {
    expect(requireInteger({ n: 5 }, "n", { min: 1, max: 10 })).toBe(5);
  });
  it.each([
    ["missing", {}],
    ["string", { n: "5" }],
    ["float", { n: 5.5 }],
    ["below min", { n: 0 }],
    ["above max", { n: 11 }],
  ])("rejects %s", (_label, body) => {
    expect(() => requireInteger(body, "n", { min: 1, max: 10 })).toThrow(BadRequestException);
  });
});

describe("optionalInteger", () => {
  it("returns undefined when missing or null", () => {
    expect(optionalInteger({}, "n", { min: 0 })).toBeUndefined();
    expect(optionalInteger({ n: null }, "n", { min: 0 })).toBeUndefined();
  });
  it("validates when present", () => {
    expect(optionalInteger({ n: 3 }, "n", { min: 0 })).toBe(3);
    expect(() => optionalInteger({ n: -1 }, "n", { min: 0 })).toThrow(BadRequestException);
  });
});

describe("requireNumber", () => {
  it("accepts floats in range and rejects NaN", () => {
    expect(requireNumber({ x: 1.5 }, "x", { min: 0, max: 2 })).toBe(1.5);
    expect(() => requireNumber({ x: Number.NaN }, "x", { min: 0 })).toThrow(BadRequestException);
    expect(() => requireNumber({ x: 3 }, "x", { min: 0, max: 2 })).toThrow(BadRequestException);
  });
});

describe("requireOneOf", () => {
  it("returns the matching literal", () => {
    expect(requireOneOf({ s: "import" }, "s", ["recording", "import"] as const)).toBe("import");
  });
  it("rejects other values", () => {
    expect(() => requireOneOf({ s: "x" }, "s", ["recording", "import"] as const)).toThrow(
      BadRequestException,
    );
  });
});

describe("requireIsoDate", () => {
  it("accepts ISO 8601 with offset and returns the string", () => {
    expect(requireIsoDate({ d: "2026-09-04T19:03:00+09:00" }, "d")).toBe("2026-09-04T19:03:00+09:00");
    expect(requireIsoDate({ d: "2026-09-04T10:03:00.000Z" }, "d")).toBe("2026-09-04T10:03:00.000Z");
  });
  it.each([
    ["no offset", "2026-09-04T19:03:00"],
    ["date only", "2026-09-04"],
    ["garbage", "yesterday"],
    ["impossible date", "2026-13-40T00:00:00Z"],
  ])("rejects %s", (_label, d) => {
    expect(() => requireIsoDate({ d }, "d")).toThrow(BadRequestException);
  });
});
```

- [ ] **Step 2: 실행해서 실패 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/common/validation.spec.ts`
Expected: FAIL — export 없음.

- [ ] **Step 3: 구현 추가**

`apps/api/src/common/validation.ts` 끝에:

```ts
interface Range {
  min?: number;
  max?: number;
}

function field(body: unknown, name: string): unknown {
  return (body as Record<string, unknown> | null | undefined)?.[name];
}

function inRange(value: number, name: string, range: Range): number {
  if (range.min !== undefined && value < range.min) {
    throw new BadRequestException(`${name} must be >= ${range.min}`);
  }
  if (range.max !== undefined && value > range.max) {
    throw new BadRequestException(`${name} must be <= ${range.max}`);
  }
  return value;
}

export function requireNumber(body: unknown, name: string, range: Range = {}): number {
  const value = field(body, name);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BadRequestException(`${name} must be a number`);
  }
  return inRange(value, name, range);
}

export function requireInteger(body: unknown, name: string, range: Range = {}): number {
  const value = field(body, name);
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new BadRequestException(`${name} must be an integer`);
  }
  return inRange(value, name, range);
}

export function optionalInteger(body: unknown, name: string, range: Range = {}): number | undefined {
  const value = field(body, name);
  if (value === undefined || value === null) return undefined;
  return requireInteger(body, name, range);
}

export function requireOneOf<const T extends readonly string[]>(
  body: unknown,
  name: string,
  values: T,
): T[number] {
  const value = field(body, name);
  if (typeof value !== "string" || !values.includes(value)) {
    throw new BadRequestException(`${name} must be one of ${values.join(", ")}`);
  }
  return value;
}

const ISO_WITH_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** 오프셋이 붙은 ISO 8601만 받는다 — 서버가 클라이언트의 로컬 날짜를 알아야 title을 만든다 (스펙 결정 14). */
export function requireIsoDate(body: unknown, name: string): string {
  const value = field(body, name);
  if (typeof value !== "string" || !ISO_WITH_OFFSET_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new BadRequestException(`${name} must be an ISO 8601 date-time with offset`);
  }
  return value;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/common/validation.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/common
git commit -m "feat(api): add numeric, enum, and ISO date validation helpers"
```

---

### Task 4: StorageService (R2)

**Files:**
- Create: `apps/api/src/storage/storage.service.ts`
- Create: `apps/api/src/storage/storage.service.spec.ts`
- Modify: `apps/api/src/storage/storage.module.ts`
- Modify: `apps/api/package.json` (의존성 추가)

**Interfaces:**
- Produces:

```ts
export abstract class StorageService {
  abstract createMultipartUpload(key: string, contentType: string): Promise<{ uploadId: string }>;
  abstract presignUploadPart(key: string, uploadId: string, partNumber: number, expiresSec: number): Promise<string>;
  abstract listParts(key: string, uploadId: string): Promise<UploadedPart[]>;
  abstract completeMultipartUpload(key: string, uploadId: string, parts: UploadedPart[]): Promise<void>;
  abstract abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  abstract presignGet(key: string, expiresSec: number): Promise<string>;
  abstract downloadToFile(key: string, path: string): Promise<void>;
  abstract putFile(key: string, path: string, contentType: string): Promise<void>;
  abstract deleteObjects(keys: string[]): Promise<void>;
}
```
  `UploadedPart`는 `@bandapp/types`. 모듈 토큰은 `StorageService` 클래스 자체 (e2e에서 `overrideProvider(StorageService)`).

- [ ] **Step 1: 의존성 설치**

Run: `pnpm --filter @bandapp/api add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`
Expected: `apps/api/package.json` dependencies에 두 패키지 추가.

- [ ] **Step 2: 실패하는 단위 테스트 작성**

`apps/api/src/storage/storage.service.spec.ts`:

```ts
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListPartsCommand,
  UploadPartCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { R2StorageService, r2ClientConfig } from "./storage.service.js";

function makeService(send: ReturnType<typeof vi.fn>, presign = vi.fn().mockResolvedValue("https://signed")) {
  process.env.R2_BUCKET = "taken-rehearsal-dev";
  const client = { send } as unknown as S3Client;
  return { service: new R2StorageService(() => client, presign), presign };
}

afterEach(() => {
  delete process.env.R2_BUCKET;
  delete process.env.R2_ACCOUNT_ID;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_ENDPOINT;
});

describe("r2ClientConfig", () => {
  it("derives the endpoint from the account id and disables checksum injection", () => {
    const config = r2ClientConfig({
      R2_ACCOUNT_ID: "acct",
      R2_ACCESS_KEY_ID: "k",
      R2_SECRET_ACCESS_KEY: "s",
    } as NodeJS.ProcessEnv);
    expect(config.endpoint).toBe("https://acct.r2.cloudflarestorage.com");
    expect(config.region).toBe("auto");
    expect(config.requestChecksumCalculation).toBe("WHEN_REQUIRED");
    expect(config.responseChecksumValidation).toBe("WHEN_REQUIRED");
  });
  it("prefers R2_ENDPOINT when set", () => {
    const config = r2ClientConfig({
      R2_ACCOUNT_ID: "acct",
      R2_ACCESS_KEY_ID: "k",
      R2_SECRET_ACCESS_KEY: "s",
      R2_ENDPOINT: "http://localhost:9000",
    } as NodeJS.ProcessEnv);
    expect(config.endpoint).toBe("http://localhost:9000");
  });
  it("throws when credentials are missing", () => {
    expect(() => r2ClientConfig({} as NodeJS.ProcessEnv)).toThrow("R2_ACCOUNT_ID");
  });
});

describe("R2StorageService", () => {
  it("createMultipartUpload returns the UploadId", async () => {
    const send = vi.fn().mockResolvedValue({ UploadId: "up-1" });
    const { service } = makeService(send);
    await expect(service.createMultipartUpload("k", "audio/mp4")).resolves.toEqual({ uploadId: "up-1" });
    const cmd = send.mock.calls[0]![0] as CreateMultipartUploadCommand;
    expect(cmd.input).toEqual({ Bucket: "taken-rehearsal-dev", Key: "k", ContentType: "audio/mp4" });
  });

  it("presignUploadPart signs an UploadPartCommand with the given expiry", async () => {
    const { service, presign } = makeService(vi.fn());
    await expect(service.presignUploadPart("k", "up-1", 3, 3600)).resolves.toBe("https://signed");
    const [, cmd, opts] = presign.mock.calls[0]!;
    expect(cmd).toBeInstanceOf(UploadPartCommand);
    expect((cmd as UploadPartCommand).input).toEqual({ Bucket: "taken-rehearsal-dev", Key: "k", UploadId: "up-1", PartNumber: 3 });
    expect(opts).toEqual({ expiresIn: 3600 });
  });

  it("listParts follows pagination and strips quotes from ETags", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Parts: [{ PartNumber: 1, ETag: '"e1"' }], IsTruncated: true, NextPartNumberMarker: 1 })
      .mockResolvedValueOnce({ Parts: [{ PartNumber: 2, ETag: '"e2"' }], IsTruncated: false });
    const { service } = makeService(send);
    await expect(service.listParts("k", "up-1")).resolves.toEqual([
      { partNumber: 1, etag: "e1" },
      { partNumber: 2, etag: "e2" },
    ]);
    const second = send.mock.calls[1]![0] as ListPartsCommand;
    expect(second.input.PartNumberMarker).toBe("1");
  });

  it("completeMultipartUpload sends parts sorted by number", async () => {
    const send = vi.fn().mockResolvedValue({});
    const { service } = makeService(send);
    await service.completeMultipartUpload("k", "up-1", [
      { partNumber: 2, etag: "e2" },
      { partNumber: 1, etag: "e1" },
    ]);
    const cmd = send.mock.calls[0]![0] as CompleteMultipartUploadCommand;
    expect(cmd.input.MultipartUpload).toEqual({
      Parts: [
        { PartNumber: 1, ETag: "e1" },
        { PartNumber: 2, ETag: "e2" },
      ],
    });
  });

  it("presignGet signs a GetObjectCommand", async () => {
    const { service, presign } = makeService(vi.fn());
    await service.presignGet("k", 60);
    expect(presign.mock.calls[0]![1]).toBeInstanceOf(GetObjectCommand);
  });

  it("deleteObjects is a no-op for an empty list and batches otherwise", async () => {
    const send = vi.fn().mockResolvedValue({});
    const { service } = makeService(send);
    await service.deleteObjects([]);
    expect(send).not.toHaveBeenCalled();
    await service.deleteObjects(["a", "b"]);
    const cmd = send.mock.calls[0]![0] as DeleteObjectsCommand;
    expect(cmd.input.Delete).toEqual({ Objects: [{ Key: "a" }, { Key: "b" }], Quiet: true });
  });
});
```

- [ ] **Step 3: 실행해서 실패 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/storage/storage.service.spec.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 4: 구현**

`apps/api/src/storage/storage.service.ts`:

```ts
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { Provider } from "@nestjs/common";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { UploadedPart } from "@bandapp/types";

export abstract class StorageService {
  abstract createMultipartUpload(key: string, contentType: string): Promise<{ uploadId: string }>;
  abstract presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresSec: number,
  ): Promise<string>;
  abstract listParts(key: string, uploadId: string): Promise<UploadedPart[]>;
  abstract completeMultipartUpload(key: string, uploadId: string, parts: UploadedPart[]): Promise<void>;
  abstract abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  abstract presignGet(key: string, expiresSec: number): Promise<string>;
  abstract downloadToFile(key: string, path: string): Promise<void>;
  abstract putFile(key: string, path: string, contentType: string): Promise<void>;
  abstract deleteObjects(keys: string[]): Promise<void>;
}

/**
 * R2는 S3 호환이지만 최신 AWS SDK가 기본으로 붙이는 CRC 체크섬 헤더를 거부한다.
 * 두 옵션을 WHEN_REQUIRED로 내리면 presigned PUT과 PutObject가 R2에서 그대로 동작한다.
 */
export function r2ClientConfig(env: NodeJS.ProcessEnv): S3ClientConfig & { endpoint: string } {
  const accountId = env.R2_ACCOUNT_ID;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY must be set");
  }
  return {
    region: "auto",
    endpoint: env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  };
}

type Presign = typeof getSignedUrl;

export class R2StorageService extends StorageService {
  private client: S3Client | null = null;

  constructor(
    private readonly createClient: () => S3Client = () => new S3Client(r2ClientConfig(process.env)),
    private readonly presign: Presign = getSignedUrl,
  ) {
    super();
  }

  private get s3(): S3Client {
    this.client ??= this.createClient();
    return this.client;
  }

  private get bucket(): string {
    const bucket = process.env.R2_BUCKET;
    if (!bucket) throw new Error("R2_BUCKET is not set");
    return bucket;
  }

  async createMultipartUpload(key: string, contentType: string): Promise<{ uploadId: string }> {
    const res = await this.s3.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
    );
    if (!res.UploadId) throw new Error("CreateMultipartUpload returned no UploadId");
    return { uploadId: res.UploadId };
  }

  presignUploadPart(key: string, uploadId: string, partNumber: number, expiresSec: number): Promise<string> {
    return this.presign(
      this.s3,
      new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
      { expiresIn: expiresSec },
    );
  }

  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    do {
      const res = await this.s3.send(
        new ListPartsCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }),
      );
      for (const p of res.Parts ?? []) {
        if (p.PartNumber !== undefined && p.ETag) parts.push({ partNumber: p.PartNumber, etag: stripQuotes(p.ETag) });
      }
      marker = res.IsTruncated && res.NextPartNumberMarker !== undefined ? String(res.NextPartNumberMarker) : undefined;
    } while (marker);
    return parts;
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: UploadedPart[]): Promise<void> {
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    await this.s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: sorted.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.s3.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }));
  }

  presignGet(key: string, expiresSec: number): Promise<string> {
    return this.presign(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresSec,
    });
  }

  async downloadToFile(key: string, path: string): Promise<void> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`GetObject returned no body for ${key}`);
    await pipeline(res.Body as Readable, createWriteStream(path));
  }

  async putFile(key: string, path: string, contentType: string): Promise<void> {
    const { size } = await stat(path);
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(path),
        ContentLength: size,
        ContentType: contentType,
      }),
    );
  }

  async deleteObjects(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
  }
}

function stripQuotes(etag: string): string {
  return etag.replace(/^"|"$/g, "");
}

export const storageServiceProvider: Provider = {
  provide: StorageService,
  useFactory: () => new R2StorageService(),
};
```

`apps/api/src/storage/storage.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { StorageService, storageServiceProvider } from "./storage.service.js";

@Module({
  providers: [storageServiceProvider],
  exports: [StorageService],
})
export class StorageModule {}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/storage/storage.service.spec.ts`
Expected: PASS. `S3ClientConfig`에 `requestChecksumCalculation`이 없다는 타입 오류가 나면 SDK가 오래된 것이다 — `pnpm --filter @bandapp/api add @aws-sdk/client-s3@latest`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/storage apps/api/package.json pnpm-lock.yaml
git commit -m "feat(api): add R2 storage service with multipart and presign support"
```

---

### Task 5: 분석 큐 메시지를 `{ sessionId }`로 바꾸고 Gemini를 절대 경로 기반으로

**Files:**
- Modify: `apps/api/src/analysis/analysis.producer.ts`, `analysis.producer.spec.ts`
- Delete: `apps/api/src/analysis/analysis.controller.ts`, `analysis.controller.spec.ts`
- Modify: `apps/api/src/analysis/analysis.module.ts`
- Modify: `apps/api/src/analysis/gemini.service.ts`, `gemini.service.spec.ts`
- Modify: `apps/api/src/worker/analysis.consumer.ts`, `analysis.consumer.spec.ts` (컴파일만 맞춘다 — 실제 처리는 Task 11)

**Interfaces:**
- Produces: `AnalysisProducer.enqueueAnalysis(sessionId: string): Promise<void>` (메시지 본문 `AnalyzeSessionJob`), `GeminiService.analyzeFile(absolutePath: string): Promise<TakeCandidate[]>`, `GenAiClient.files.delete?`.

- [ ] **Step 1: producer 테스트 갱신**

`apps/api/src/analysis/analysis.producer.spec.ts`를 열어 `enqueueAnalysis("rec_1", ...)` 호출과 `{ recordingId }` 기대값을 전부 `enqueueAnalysis("s-1")` / `{ sessionId: "s-1" }`로 바꾼다. `audioPath` 케이스는 삭제한다.

- [ ] **Step 2: producer 구현**

```ts
import { Inject, Injectable } from "@nestjs/common";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { AnalyzeSessionJob } from "@bandapp/types";
import { SQS_CLIENT } from "../queue/queue.constants.js";

@Injectable()
export class AnalysisProducer {
  constructor(@Inject(SQS_CLIENT) private readonly sqs: SQSClient) {}

  async enqueueAnalysis(sessionId: string): Promise<void> {
    const queueUrl = process.env.SQS_ANALYSIS_QUEUE_URL;
    if (!queueUrl) {
      throw new Error("SQS_ANALYSIS_QUEUE_URL is not set");
    }
    const job: AnalyzeSessionJob = { sessionId };
    await this.sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(job) }));
  }
}
```

- [ ] **Step 3: 컨트롤러 삭제, 모듈 정리**

`git rm apps/api/src/analysis/analysis.controller.ts apps/api/src/analysis/analysis.controller.spec.ts`

`apps/api/src/analysis/analysis.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { QueueModule } from "../queue/queue.module.js";
import { AnalysisProducer } from "./analysis.producer.js";
import { geminiServiceProvider } from "./gemini.service.js";

@Module({
  imports: [QueueModule],
  providers: [AnalysisProducer, geminiServiceProvider],
  exports: [AnalysisProducer, geminiServiceProvider],
})
export class AnalysisModule {}
```

- [ ] **Step 4: Gemini 서비스 — 경로 해석 제거, analyzeFile, 파일 삭제**

`gemini.service.ts`에서 `findWorkspaceRoot`, `resolveAudioPath`와 관련 import(`existsSync`, `dirname`, `isAbsolute`, `join`, `resolve`, `sep`, `fileURLToPath`)를 지운다. `GenAiClient`에 `delete`를 더한다:

```ts
export interface GenAiClient {
  files: {
    upload(params: { file: string; config?: { mimeType?: string } }): Promise<{ name?: string; uri?: string; mimeType?: string; state?: string }>;
    get(params: { name: string }): Promise<{ state?: string; uri?: string; mimeType?: string }>;
    delete(params: { name: string }): Promise<unknown>;
  };
  models: {
    generateContent(params: unknown): Promise<{ text?: string }>;
  };
}
```

`analyzeAudio` → `analyzeFile`로 이름을 바꾸고, `doAnalyze`는 절대 경로를 그대로 쓴다. 분석이 끝나면(성공·실패 모두) Gemini 업로드 파일을 지운다 — 실패는 경고만:

```ts
  async analyzeFile(filePath: string): Promise<TakeCandidate[]> {
    const timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS ?? 300000);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`gemini analysis timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      return await Promise.race([this.doAnalyze(filePath, Date.now() + timeoutMs), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async doAnalyze(filePath: string, deadline: number): Promise<TakeCandidate[]> {
    const client = this.createClient();
    const model = process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;

    const uploaded = await client.files.upload({ file: filePath, config: { mimeType: audioMimeType(filePath) } });
    try {
      const active = await this.waitForActive(client, uploaded, deadline);
      this.logger.log(`analyzing ${filePath} with ${model}`);
      const response = await client.models.generateContent({
        model,
        contents: createUserContent([ANALYSIS_PROMPT, createPartFromUri(active.uri as string, active.mimeType as string)]),
        config: { responseMimeType: "application/json", responseSchema: TAKES_SCHEMA },
      });
      if (!response.text) throw new Error("gemini returned an empty response");
      return parseTakes(response.text);
    } finally {
      if (uploaded.name) {
        // Files API 저장소는 48시간 뒤 자동 삭제되지만, 청크마다 하나씩 남기면 한도(20GB)를 먹는다
        await client.files.delete({ name: uploaded.name }).catch((err: unknown) => {
          this.logger.warn(`failed to delete gemini file ${uploaded.name}: ${String(err)}`);
        });
      }
    }
  }
```

`gemini.service.spec.ts`: `resolveAudioPath` describe 블록과 import를 삭제. `analyzeAudio` → `analyzeFile`, 테스트 경로를 절대 경로(`"/tmp/a.wav"`)로. `makeClient`에 `delete: vi.fn().mockResolvedValue({})`를 추가하고, 케이스 하나를 더한다:

```ts
  it("deletes the uploaded file after analysis, even when generation fails", async () => {
    process.env.GEMINI_API_KEY = "k";
    const client = makeClient({ generateContent: vi.fn().mockRejectedValue(new Error("boom")) });
    const service = new GeminiService(() => client, 0);
    await expect(service.analyzeFile("/tmp/a.wav")).rejects.toThrow("boom");
    expect(client.files.delete).toHaveBeenCalledWith({ name: "files/abc" });
  });
```

- [ ] **Step 5: consumer를 컴파일만 되게 임시 정리**

`apps/api/src/worker/analysis.consumer.ts`의 `handleMessage`를 아래로 바꾼다 (Task 11에서 실제 처리로 교체):

```ts
  private async handleMessage(message: Message): Promise<void> {
    const job = JSON.parse(message.Body ?? "") as AnalyzeSessionJob;
    this.logger.log(`received analysis job: sessionId=${job.sessionId}`);
  }
```

import를 `import type { AnalyzeSessionJob } from "@bandapp/types";`로 바꾸고 `RecordingAnalysisResult`, `DEFAULT_GEMINI_MODEL` import를 지운다. `analysis.consumer.spec.ts`에서 `audioPath`가 들어간 4개 케이스(`does not call gemini...`, `analyzes and deletes...`, `leaves the message when analysis fails`, `skips analysis but deletes...`)를 삭제하고 남은 케이스의 `{ recordingId: "rec_1" }`를 `{ sessionId: "s-1" }`로 바꾼다.

- [ ] **Step 6: 단위 테스트 전체 통과 확인**

Run: `pnpm --filter @bandapp/types build && pnpm --filter @bandapp/api exec vitest run`
Expected: PASS (e2e 제외).

- [ ] **Step 7: Commit**

```bash
git add -A apps/api/src/analysis apps/api/src/worker
git commit -m "refactor(api): queue analysis by session id and analyze absolute paths"
```

---

### Task 6: dev 로그인

**Files:**
- Modify: `apps/api/src/users/users.service.ts` (provider 타입 확장)
- Modify: `apps/api/src/auth/auth.service.ts`, `auth.controller.ts`
- Create: `apps/api/test/dev-login.e2e-spec.ts`
- Modify: `apps/api/vitest.config.e2e.ts` (env에 `DEV_LOGIN_SECRET`)

**Interfaces:**
- Produces: `POST /auth/dev { secret, displayName? } → LoginResponse`. e2e·스크립트가 쓴다.

- [ ] **Step 1: 실패하는 e2e 작성**

`apps/api/test/dev-login.e2e-spec.ts`:

```ts
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "./app-util.js";
import { createTestDb, truncateAll } from "./db-util.js";

describe("POST /auth/dev", () => {
  const db = createTestDb();
  let app: INestApplication;
  const originalEnv = process.env.NODE_ENV;

  beforeEach(async () => {
    await truncateAll(db);
    process.env.DEV_LOGIN_SECRET = "e2e-dev-secret";
    app = await createTestApp();
  });
  afterEach(async () => {
    process.env.NODE_ENV = originalEnv;
    process.env.DEV_LOGIN_SECRET = "e2e-dev-secret";
    await app.close();
  });

  it("올바른 secret이면 로그인되고 같은 이름은 같은 사용자다", async () => {
    const first = await request(app.getHttpServer())
      .post("/auth/dev")
      .send({ secret: "e2e-dev-secret", displayName: "Dongjin" })
      .expect(201);
    expect(first.body.user.displayName).toBe("Dongjin");
    expect(first.body.isNewUser).toBe(true);
    const again = await request(app.getHttpServer())
      .post("/auth/dev")
      .send({ secret: "e2e-dev-secret", displayName: "Dongjin" })
      .expect(201);
    expect(again.body.user.id).toBe(first.body.user.id);
    expect(again.body.isNewUser).toBe(false);
    await request(app.getHttpServer())
      .get("/me")
      .set({ authorization: `Bearer ${again.body.accessToken}` })
      .expect(200);
  });

  it("secret이 틀리면 401", async () => {
    await request(app.getHttpServer()).post("/auth/dev").send({ secret: "nope" }).expect(401);
  });

  it("DEV_LOGIN_SECRET이 없으면 404", async () => {
    delete process.env.DEV_LOGIN_SECRET;
    await request(app.getHttpServer()).post("/auth/dev").send({ secret: "e2e-dev-secret" }).expect(404);
  });

  it("production이면 404", async () => {
    process.env.NODE_ENV = "production";
    await request(app.getHttpServer()).post("/auth/dev").send({ secret: "e2e-dev-secret" }).expect(404);
  });
});
```

- [ ] **Step 2: 실행해서 실패 확인**

Run: `pnpm --filter @bandapp/api test:e2e -- test/dev-login.e2e-spec.ts`
Expected: FAIL — 404 (라우트 없음) 또는 401 기대 불일치.

- [ ] **Step 3: UsersService provider 타입 확장**

`users.service.ts`에서 `"GOOGLE" | "APPLE"`로 적힌 파라미터 타입 4곳(`findOrCreateByIdentity`, `findByIdentity`, `hasProviderRefreshToken`, `saveProviderRefreshToken`)을 `AuthProviderName`으로 바꾼다. import: `import { authSessions, bandMembers, bands, userIdentities, users, type AuthProviderName } from "../db/schema.js";`

- [ ] **Step 4: AuthService.loginWithDev**

`auth.service.ts`에 추가 (import에 `NotFoundException`, `timingSafeEqual` from `node:crypto`):

```ts
  /**
   * Windows에서는 Google/Apple 로그인 없이 서버를 끝까지 검증할 수 없다 (스펙 결정 10).
   * DEV_LOGIN_SECRET이 있고 production이 아닐 때만 열린다. 없으면 라우트가 없는 것처럼 404.
   */
  async loginWithDev(input: { secret: string; displayName?: string }): Promise<LoginResponse> {
    const expected = process.env.DEV_LOGIN_SECRET;
    if (!expected || process.env.NODE_ENV === "production") throw new NotFoundException();
    const a = Buffer.from(input.secret);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException("로그인에 실패했어요. 다시 시도해 주세요.");
    }
    const displayName = input.displayName ?? "dev";
    return this.login("DEV", {
      subject: displayName,
      email: null,
      emailVerified: null,
      displayName,
      profileImageUrl: null,
    });
  }
```

`private async login(provider: "GOOGLE" | "APPLE", ...)`의 타입을 `AuthProviderName`으로 바꾼다 (`import type { AuthProviderName } from "../db/schema.js"`).

`auth.controller.ts`:

```ts
  @Post("dev")
  dev(@Body() body: unknown): Promise<LoginResponse> {
    return this.auth.loginWithDev({
      secret: requireString(body, "secret"),
      displayName: optionalString(body, "displayName"),
    });
  }
```

- [ ] **Step 5: e2e env 기본값**

`vitest.config.e2e.ts`의 `env`에 `DEV_LOGIN_SECRET: 'e2e-dev-secret',`를 추가한다.

- [ ] **Step 6: 테스트 통과 확인**

Run: `pnpm --filter @bandapp/api test:e2e -- test/dev-login.e2e-spec.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/users apps/api/src/auth apps/api/test/dev-login.e2e-spec.ts apps/api/vitest.config.e2e.ts
git commit -m "feat(api): add a secret-gated dev login for local verification"
```

---

### Task 7: 세션 생성·조회·업로드 API

**Files:**
- Create: `apps/api/src/sessions/session-mapper.ts`, `session-mapper.spec.ts`
- Create: `apps/api/src/sessions/sessions.service.ts`
- Create: `apps/api/src/sessions/sessions.controller.ts`
- Modify: `apps/api/src/sessions/sessions.module.ts`
- Modify: `apps/api/test/app-util.ts` (storage/producer 오버라이드)
- Create: `apps/api/test/sessions.e2e-spec.ts`

**Interfaces:**
- Consumes: `StorageService`(Task 4), `AnalysisProducer.enqueueAnalysis(sessionId)`(Task 5), `MembershipsService.assertMember`.
- Produces:
  - `titleFor(startedAtIso: string): string`, `toSession(row: SessionRow): Session`, `SESSION_WITH_COUNTS` select 컬럼 (Task 8·11이 재사용)
  - `SessionsService`: `create(bandId, userId, input)`, `list(bandId, userId)`, `get(id, userId)`, `partUrls(id, userId, partNumbers)`, `uploadStatus(id, userId)`, `completeUpload(id, userId, parts)`, `retry(id, userId)`, `audioUrl(id, userId)`, `loadForMember(id, userId)` (takes/comments가 재사용)
  - `originalKey(bandId, sessionId)`, `takeKey(bandId, sessionId, takeId)` (`session-mapper.ts`)
  - `createTestApp({ storage?, producer? })` — 기본은 `FakeStorage`, `FakeProducer` (`test/app-util.ts`에서 export)

- [ ] **Step 1: mapper 단위 테스트**

`apps/api/src/sessions/session-mapper.spec.ts`:

```ts
import { originalKey, takeKey, titleFor, toSession } from "./session-mapper.js";

describe("titleFor", () => {
  it("uses the client's local date from the offset string", () => {
    expect(titleFor("2026-09-04T00:30:00+09:00")).toBe("Sep 4 Rehearsal");
    // 같은 순간이지만 UTC로 적으면 전날이다 — 문자열의 날짜 부분을 그대로 믿는다
    expect(titleFor("2026-09-03T15:30:00.000Z")).toBe("Sep 3 Rehearsal");
  });
});

describe("toSession", () => {
  it("maps ms to seconds and null name to undefined", () => {
    const session = toSession({
      id: "s1",
      bandId: "b1",
      title: "Sep 4 Rehearsal",
      name: null,
      status: "ready",
      startedAt: new Date("2026-09-04T10:00:00Z"),
      durationMs: 2716601,
      takeCount: 3,
      commentCount: 2,
    });
    expect(session).toEqual({
      id: "s1",
      bandId: "b1",
      title: "Sep 4 Rehearsal",
      status: "ready",
      startedAt: "2026-09-04T10:00:00.000Z",
      durationSec: 2717,
      takeCount: 3,
      commentCount: 2,
    });
    expect("name" in session).toBe(false);
  });
  it("reports 0 seconds while duration is unknown", () => {
    expect(toSession({ id: "s", bandId: "b", title: "t", name: "N", status: "uploading", startedAt: new Date(), durationMs: null, takeCount: 0, commentCount: 0 }).durationSec).toBe(0);
  });
});

describe("object keys", () => {
  it("nest under band and session", () => {
    expect(originalKey("b", "s")).toBe("bands/b/sessions/s/original.m4a");
    expect(takeKey("b", "s", "t")).toBe("bands/b/sessions/s/takes/t.m4a");
  });
});
```

- [ ] **Step 2: 실행해서 실패 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/sessions/session-mapper.spec.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: mapper 구현**

`apps/api/src/sessions/session-mapper.ts`:

```ts
import { sql } from "drizzle-orm";
import type { Session, SessionStatus } from "@bandapp/types";
import { sessions } from "../db/schema.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 클라이언트가 보낸 오프셋 문자열의 날짜 부분이 곧 사용자의 로컬 날짜다 — 서버 타임존으로 다시 계산하지 않는다. */
export function titleFor(startedAtIso: string): string {
  const month = Number(startedAtIso.slice(5, 7));
  const day = Number(startedAtIso.slice(8, 10));
  return `${MONTHS[month - 1]} ${day} Rehearsal`;
}

export interface SessionRow {
  id: string;
  bandId: string;
  title: string;
  name: string | null;
  status: SessionStatus;
  startedAt: Date;
  durationMs: number | null;
  takeCount: number;
  commentCount: number;
}

export function toSession(row: SessionRow): Session {
  const session: Session = {
    id: row.id,
    bandId: row.bandId,
    title: row.title,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    durationSec: Math.round((row.durationMs ?? 0) / 1000),
    takeCount: row.takeCount,
    commentCount: row.commentCount,
  };
  if (row.name !== null) session.name = row.name;
  return session;
}

/** 세션 목록·단건 조회가 공유하는 select 컬럼. commentCount는 takes를 거쳐 집계한다. */
export const SESSION_WITH_COUNTS = {
  id: sessions.id,
  bandId: sessions.bandId,
  title: sessions.title,
  name: sessions.name,
  status: sessions.status,
  startedAt: sessions.startedAt,
  durationMs: sessions.durationMs,
  takeCount: sessions.takeCount,
  commentCount: sql<number>`(select count(*)::int from comments c join takes t on t.id = c.take_id where t.session_id = ${sessions.id})`,
};

export function originalKey(bandId: string, sessionId: string): string {
  return `bands/${bandId}/sessions/${sessionId}/original.m4a`;
}

export function takeKey(bandId: string, sessionId: string, takeId: string): string {
  return `bands/${bandId}/sessions/${sessionId}/takes/${takeId}.m4a`;
}
```

- [ ] **Step 4: mapper 테스트 통과 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/sessions/session-mapper.spec.ts`
Expected: PASS

- [ ] **Step 5: 테스트 하네스에 storage/producer 오버라이드 추가**

`apps/api/test/app-util.ts`에 추가:

```ts
import type { UploadedPart } from "@bandapp/types";
import { AnalysisProducer } from "../src/analysis/analysis.producer.js";
import { StorageService } from "../src/storage/storage.service.js";

/** R2를 흉내 낸다 — 호출 기록만 남기고 파트는 listParts로 되돌려준다. */
export class FakeStorage extends StorageService {
  uploads = new Map<string, { key: string; contentType: string; parts: UploadedPart[]; completed: boolean }>();
  put: Array<{ key: string; path: string }> = [];
  deleted: string[] = [];
  downloads: Array<{ key: string; path: string }> = [];
  private seq = 0;

  async createMultipartUpload(key: string, contentType: string) {
    const uploadId = `upload-${++this.seq}`;
    this.uploads.set(uploadId, { key, contentType, parts: [], completed: false });
    return { uploadId };
  }
  async presignUploadPart(key: string, uploadId: string, partNumber: number) {
    return `https://fake.r2/${key}?uploadId=${uploadId}&partNumber=${partNumber}`;
  }
  async listParts(_key: string, uploadId: string) {
    return [...(this.uploads.get(uploadId)?.parts ?? [])];
  }
  async completeMultipartUpload(_key: string, uploadId: string, parts: UploadedPart[]) {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw new Error("NoSuchUpload");
    upload.parts = parts;
    upload.completed = true;
  }
  async abortMultipartUpload(_key: string, uploadId: string) {
    this.uploads.delete(uploadId);
  }
  async presignGet(key: string) {
    return `https://fake.r2/${key}?signed`;
  }
  async downloadToFile(key: string, path: string) {
    this.downloads.push({ key, path });
  }
  async putFile(key: string, path: string) {
    this.put.push({ key, path });
  }
  async deleteObjects(keys: string[]) {
    this.deleted.push(...keys);
  }
}

export class FakeProducer {
  enqueued: string[] = [];
  failNext = false;
  async enqueueAnalysis(sessionId: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("sqs down");
    }
    this.enqueued.push(sessionId);
  }
}
```

`createTestApp`의 overrides 타입에 `storage?: StorageService; producer?: FakeProducer;`를 더하고 builder 체인에:

```ts
    .overrideProvider(StorageService)
    .useValue(overrides?.storage ?? new FakeStorage())
    .overrideProvider(AnalysisProducer)
    .useValue(overrides?.producer ?? new FakeProducer())
```

- [ ] **Step 6: 실패하는 sessions e2e 작성**

`apps/api/test/sessions.e2e-spec.ts`:

```ts
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bandMembers, recordings, sessions } from "../src/db/schema.js";
import { FakeProducer, FakeStorage, createTestApp, loginAs, providerUser } from "./app-util.js";
import { createTestDb, truncateAll } from "./db-util.js";

const MB = 1024 * 1024;

describe("sessions API", () => {
  const db = createTestDb();
  let app: INestApplication;
  let storage: FakeStorage;
  let producer: FakeProducer;
  let owner: { accessToken: string; userId: string };
  let bandId: string;

  beforeEach(async () => {
    await truncateAll(db);
    storage = new FakeStorage();
    producer = new FakeProducer();
    app = await createTestApp({ google: providerUser("owner-1"), storage, producer });
    owner = await loginAs(app);
    const band = await request(app.getHttpServer()).post("/bands").set(auth(owner.accessToken)).send({ name: "B" }).expect(201);
    bandId = band.body.id;
  });
  afterEach(() => app.close());

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const createInput = (overrides: Record<string, unknown> = {}) => ({
    startedAt: "2026-09-04T19:03:00+09:00",
    durationMs: 2_716_601,
    sizeBytes: 25 * MB,
    contentType: "audio/mp4",
    source: "recording",
    ...overrides,
  });

  async function createSession(token = owner.accessToken, body = createInput()) {
    const res = await request(app.getHttpServer()).post(`/bands/${bandId}/sessions`).set(auth(token)).send(body).expect(201);
    return res.body as { session: { id: string; status: string; title: string; durationSec: number }; upload: { partSize: number; partCount: number } };
  }

  async function stranger() {
    const other = await createTestApp({ google: providerUser("stranger-1", "S"), storage, producer });
    const login = await loginAs(other);
    await other.close();
    return login;
  }

  it("세션을 만들면 uploading 상태와 파트 정보를 돌려주고 multipart 업로드를 연다", async () => {
    const { session, upload } = await createSession();
    expect(session).toMatchObject({ status: "uploading", title: "Sep 4 Rehearsal", durationSec: 2717, takeCount: 0, commentCount: 0 });
    expect(upload).toEqual({ partSize: 10 * MB, partCount: 3 });
    const [rec] = await db.select().from(recordings).where(eq(recordings.sessionId, session.id));
    expect(rec).toMatchObject({ uploadId: "upload-1", partCount: 3, uploadStatus: "pending", objectKey: `bands/${bandId}/sessions/${session.id}/original.m4a` });
    expect(storage.uploads.get("upload-1")?.contentType).toBe("audio/mp4");
  });

  it("가져오기는 durationMs 없이 만들 수 있고 durationSec은 0이다", async () => {
    const { session } = await createSession(owner.accessToken, createInput({ durationMs: undefined, source: "import" }));
    expect(session.durationSec).toBe(0);
  });

  it.each([
    ["sizeBytes 0", { sizeBytes: 0 }],
    ["2GB 초과", { sizeBytes: 3 * 1024 * MB }],
    ["오프셋 없는 startedAt", { startedAt: "2026-09-04T19:03:00" }],
    ["지원하지 않는 contentType", { contentType: "audio/wav" }],
    ["알 수 없는 source", { source: "youtube" }],
  ])("잘못된 입력은 400: %s", async (_label, overrides) => {
    await request(app.getHttpServer()).post(`/bands/${bandId}/sessions`).set(auth(owner.accessToken)).send(createInput(overrides)).expect(400);
  });

  it("비멤버는 세션을 만들 수도 볼 수도 없다 (403)", async () => {
    const { session } = await createSession();
    const other = await stranger();
    await request(app.getHttpServer()).post(`/bands/${bandId}/sessions`).set(auth(other.accessToken)).send(createInput()).expect(403);
    await request(app.getHttpServer()).get(`/bands/${bandId}/sessions`).set(auth(other.accessToken)).expect(403);
    await request(app.getHttpServer()).get(`/sessions/${session.id}`).set(auth(other.accessToken)).expect(403);
  });

  it("없는 세션은 404", async () => {
    await request(app.getHttpServer()).get("/sessions/00000000-0000-0000-0000-000000000000").set(auth(owner.accessToken)).expect(404);
    await request(app.getHttpServer()).get("/sessions/not-a-uuid").set(auth(owner.accessToken)).expect(400);
  });

  it("파트 URL은 범위 안의 번호에만 발급된다", async () => {
    const { session } = await createSession();
    const res = await request(app.getHttpServer())
      .post(`/sessions/${session.id}/upload/parts`)
      .set(auth(owner.accessToken))
      .send({ partNumbers: [1, 3] })
      .expect(200);
    expect(res.body).toEqual([
      { partNumber: 1, url: expect.stringContaining("partNumber=1") },
      { partNumber: 3, url: expect.stringContaining("partNumber=3") },
    ]);
    await request(app.getHttpServer()).post(`/sessions/${session.id}/upload/parts`).set(auth(owner.accessToken)).send({ partNumbers: [4] }).expect(400);
    await request(app.getHttpServer()).post(`/sessions/${session.id}/upload/parts`).set(auth(owner.accessToken)).send({ partNumbers: [] }).expect(400);
  });

  it("업로드 상태는 이미 올라간 파트를 돌려준다", async () => {
    const { session } = await createSession();
    storage.uploads.get("upload-1")!.parts.push({ partNumber: 1, etag: "e1" });
    const res = await request(app.getHttpServer()).get(`/sessions/${session.id}/upload`).set(auth(owner.accessToken)).expect(200);
    expect(res.body).toEqual({ partSize: 10 * MB, partCount: 3, uploadedParts: [{ partNumber: 1, etag: "e1" }] });
  });

  it("완료하면 analyzing이 되고 분석 큐에 발행된다", async () => {
    const { session } = await createSession();
    const parts = [1, 2, 3].map((partNumber) => ({ partNumber, etag: `e${partNumber}` }));
    const res = await request(app.getHttpServer()).post(`/sessions/${session.id}/upload/complete`).set(auth(owner.accessToken)).send({ parts }).expect(200);
    expect(res.body.status).toBe("analyzing");
    expect(storage.uploads.get("upload-1")?.completed).toBe(true);
    expect(producer.enqueued).toEqual([session.id]);
    const [rec] = await db.select().from(recordings).where(eq(recordings.sessionId, session.id));
    expect(rec?.uploadStatus).toBe("completed");
    expect(rec?.completedAt).not.toBeNull();
  });

  it("파트 수가 맞지 않으면 400이고 상태는 그대로다", async () => {
    const { session } = await createSession();
    await request(app.getHttpServer()).post(`/sessions/${session.id}/upload/complete`).set(auth(owner.accessToken)).send({ parts: [{ partNumber: 1, etag: "e1" }] }).expect(400);
    const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id));
    expect(row?.status).toBe("uploading");
  });

  it("큐 발행이 실패하면 failed로 남고 retry로 다시 발행할 수 있다", async () => {
    const { session } = await createSession();
    producer.failNext = true;
    const parts = [1, 2, 3].map((partNumber) => ({ partNumber, etag: `e${partNumber}` }));
    const res = await request(app.getHttpServer()).post(`/sessions/${session.id}/upload/complete`).set(auth(owner.accessToken)).send({ parts }).expect(200);
    expect(res.body.status).toBe("failed");
    const retried = await request(app.getHttpServer()).post(`/sessions/${session.id}/retry`).set(auth(owner.accessToken)).expect(200);
    expect(retried.body.status).toBe("analyzing");
    expect(producer.enqueued).toEqual([session.id]);
  });

  it("uploading이 아닌 세션에 파트를 요청하거나, failed가 아닌 세션을 retry하면 409", async () => {
    const { session } = await createSession();
    await request(app.getHttpServer()).post(`/sessions/${session.id}/retry`).set(auth(owner.accessToken)).expect(409);
    const parts = [1, 2, 3].map((partNumber) => ({ partNumber, etag: `e${partNumber}` }));
    await request(app.getHttpServer()).post(`/sessions/${session.id}/upload/complete`).set(auth(owner.accessToken)).send({ parts }).expect(200);
    await request(app.getHttpServer()).post(`/sessions/${session.id}/upload/parts`).set(auth(owner.accessToken)).send({ partNumbers: [1] }).expect(409);
    await request(app.getHttpServer()).post(`/sessions/${session.id}/upload/complete`).set(auth(owner.accessToken)).send({ parts }).expect(409);
  });

  it("목록은 밴드의 세션을 최근 순으로 준다", async () => {
    await createSession(owner.accessToken, createInput({ startedAt: "2026-09-01T10:00:00+09:00" }));
    await createSession(owner.accessToken, createInput({ startedAt: "2026-09-04T10:00:00+09:00" }));
    const res = await request(app.getHttpServer()).get(`/bands/${bandId}/sessions`).set(auth(owner.accessToken)).expect(200);
    expect(res.body.map((s: { title: string }) => s.title)).toEqual(["Sep 4 Rehearsal", "Sep 1 Rehearsal"]);
  });

  it("원본 오디오 URL은 업로드가 끝난 뒤에만 준다", async () => {
    const { session } = await createSession();
    await request(app.getHttpServer()).get(`/sessions/${session.id}/audio`).set(auth(owner.accessToken)).expect(409);
    const parts = [1, 2, 3].map((partNumber) => ({ partNumber, etag: `e${partNumber}` }));
    await request(app.getHttpServer()).post(`/sessions/${session.id}/upload/complete`).set(auth(owner.accessToken)).send({ parts }).expect(200);
    const res = await request(app.getHttpServer()).get(`/sessions/${session.id}/audio`).set(auth(owner.accessToken)).expect(200);
    expect(res.body).toEqual({ url: expect.stringContaining("original.m4a"), expiresAt: expect.any(String) });
  });

  it("멤버는 다른 멤버가 만든 세션도 본다", async () => {
    const { session } = await createSession();
    const member = await stranger();
    await db.insert(bandMembers).values({ bandId, userId: member.userId, role: "member" });
    await request(app.getHttpServer()).get(`/sessions/${session.id}`).set(auth(member.accessToken)).expect(200);
  });
});
```

- [ ] **Step 7: 실행해서 실패 확인**

Run: `pnpm --filter @bandapp/api test:e2e -- test/sessions.e2e-spec.ts`
Expected: FAIL — 404 (라우트 없음).

- [ ] **Step 8: SessionsService 구현**

`apps/api/src/sessions/sessions.service.ts`:

```ts
import { BadRequestException, ConflictException, Logger, NotFoundException } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import type {
  AudioUrl,
  CreateSessionInput,
  CreateSessionResult,
  Session,
  UploadPartUrl,
  UploadStatus,
  UploadedPart,
} from "@bandapp/types";
import { AnalysisProducer } from "../analysis/analysis.producer.js";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { recordings, sessions } from "../db/schema.js";
import { MembershipsService } from "../memberships/memberships.service.js";
import { StorageService } from "../storage/storage.service.js";
import { SESSION_WITH_COUNTS, originalKey, titleFor, toSession, type SessionRow } from "./session-mapper.js";

export const PART_SIZE = 10 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
export const PRESIGN_EXPIRES_SEC = 3600;
const MAX_PART_URLS_PER_REQUEST = 100;

export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    private readonly db: Db,
    private readonly memberships: MembershipsService,
    private readonly storage: StorageService,
    private readonly producer: AnalysisProducer,
  ) {}

  async create(bandId: string, userId: string, input: CreateSessionInput): Promise<CreateSessionResult> {
    await this.memberships.assertMember(bandId, userId);
    const partCount = Math.ceil(input.sizeBytes / PART_SIZE);
    const [inserted] = await this.db
      .insert(sessions)
      .values({
        bandId,
        createdBy: userId,
        title: titleFor(input.startedAt),
        status: "uploading",
        startedAt: new Date(input.startedAt),
        durationMs: input.durationMs ?? null,
      })
      .returning({ id: sessions.id });
    if (!inserted) throw new Error("failed to insert session");
    const key = originalKey(bandId, inserted.id);
    const { uploadId } = await this.storage.createMultipartUpload(key, input.contentType);
    await this.db.insert(recordings).values({
      sessionId: inserted.id,
      objectKey: key,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      uploadId,
      partSize: PART_SIZE,
      partCount,
    });
    const session = await this.getRow(inserted.id);
    return { session: toSession(session), upload: { partSize: PART_SIZE, partCount } };
  }

  async list(bandId: string, userId: string): Promise<Session[]> {
    await this.memberships.assertMember(bandId, userId);
    const rows = await this.db
      .select(SESSION_WITH_COUNTS)
      .from(sessions)
      .where(eq(sessions.bandId, bandId))
      .orderBy(desc(sessions.startedAt));
    return rows.map(toSession);
  }

  async get(id: string, userId: string): Promise<Session> {
    return toSession(await this.loadForMember(id, userId));
  }

  /** 세션 스코프 엔드포인트의 공통 진입점 — 없으면 404, 밴드 멤버가 아니면 403. takes/comments도 쓴다. */
  async loadForMember(id: string, userId: string): Promise<SessionRow> {
    const row = await this.getRow(id);
    await this.memberships.assertMember(row.bandId, userId);
    return row;
  }

  async partUrls(id: string, userId: string, partNumbers: number[]): Promise<UploadPartUrl[]> {
    const session = await this.loadForMember(id, userId);
    if (session.status !== "uploading") throw new ConflictException("이미 업로드가 끝난 세션이에요.");
    const rec = await this.recordingOf(id);
    if (partNumbers.length === 0 || partNumbers.length > MAX_PART_URLS_PER_REQUEST) {
      throw new BadRequestException(`partNumbers must contain 1-${MAX_PART_URLS_PER_REQUEST} entries`);
    }
    for (const n of partNumbers) {
      if (!Number.isInteger(n) || n < 1 || n > rec.partCount) {
        throw new BadRequestException(`partNumbers must be within 1..${rec.partCount}`);
      }
    }
    return Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await this.storage.presignUploadPart(rec.objectKey, rec.uploadId!, partNumber, PRESIGN_EXPIRES_SEC),
      })),
    );
  }

  async uploadStatus(id: string, userId: string): Promise<UploadStatus> {
    await this.loadForMember(id, userId);
    const rec = await this.recordingOf(id);
    const uploadedParts = rec.uploadStatus === "pending" ? await this.storage.listParts(rec.objectKey, rec.uploadId!) : [];
    return { partSize: rec.partSize, partCount: rec.partCount, uploadedParts };
  }

  async completeUpload(id: string, userId: string, parts: UploadedPart[]): Promise<Session> {
    const session = await this.loadForMember(id, userId);
    if (session.status !== "uploading") throw new ConflictException("이미 업로드가 끝난 세션이에요.");
    const rec = await this.recordingOf(id);
    const numbers = new Set(parts.map((p) => p.partNumber));
    if (parts.length !== rec.partCount || numbers.size !== rec.partCount) {
      throw new BadRequestException(`parts must contain exactly ${rec.partCount} distinct entries`);
    }
    await this.storage.completeMultipartUpload(rec.objectKey, rec.uploadId!, parts);
    await this.db.transaction(async (tx) => {
      await tx
        .update(recordings)
        .set({ uploadStatus: "completed", completedAt: new Date() })
        .where(eq(recordings.id, rec.id));
      await tx.update(sessions).set({ status: "analyzing", updatedAt: new Date() }).where(eq(sessions.id, id));
    });
    await this.enqueue(id);
    return toSession(await this.getRow(id));
  }

  async retry(id: string, userId: string): Promise<Session> {
    const session = await this.loadForMember(id, userId);
    if (session.status !== "failed") throw new ConflictException("실패한 세션만 다시 시도할 수 있어요.");
    await this.db
      .update(sessions)
      .set({ status: "analyzing", analysisError: null, updatedAt: new Date() })
      .where(eq(sessions.id, id));
    await this.enqueue(id);
    return toSession(await this.getRow(id));
  }

  async audioUrl(id: string, userId: string): Promise<AudioUrl> {
    const session = await this.loadForMember(id, userId);
    if (session.status === "uploading") throw new ConflictException("아직 업로드 중인 세션이에요.");
    const rec = await this.recordingOf(id);
    return {
      url: await this.storage.presignGet(rec.objectKey, PRESIGN_EXPIRES_SEC),
      expiresAt: new Date(Date.now() + PRESIGN_EXPIRES_SEC * 1000).toISOString(),
    };
  }

  /** 큐 발행 실패는 사용자가 retry로 복구한다 — 세션을 failed로 남기고 삼킨다 (스펙 오류 처리 표). */
  private async enqueue(id: string): Promise<void> {
    try {
      await this.producer.enqueueAnalysis(id);
    } catch (err) {
      this.logger.error(`failed to enqueue analysis for session ${id}: ${String(err)}`);
      await this.db
        .update(sessions)
        .set({ status: "failed", analysisError: "분석 요청을 보내지 못했어요.", updatedAt: new Date() })
        .where(eq(sessions.id, id));
    }
  }

  private async getRow(id: string): Promise<SessionRow> {
    const [row] = await this.db.select(SESSION_WITH_COUNTS).from(sessions).where(eq(sessions.id, id));
    if (!row) throw new NotFoundException("세션을 찾을 수 없어요.");
    return row;
  }

  private async recordingOf(sessionId: string) {
    const rec = await this.db.query.recordings.findFirst({ where: eq(recordings.sessionId, sessionId) });
    if (!rec) throw new NotFoundException("녹음을 찾을 수 없어요.");
    return rec;
  }
}

export const sessionsServiceProvider: Provider = {
  provide: SessionsService,
  useFactory: (db: Db, memberships: MembershipsService, storage: StorageService, producer: AnalysisProducer) =>
    new SessionsService(db, memberships, storage, producer),
  inject: [DB, MembershipsService, StorageService, AnalysisProducer],
};
```

- [ ] **Step 9: 컨트롤러와 모듈**

`apps/api/src/sessions/sessions.controller.ts`:

```ts
import { BadRequestException, Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import type { AudioUrl, CreateSessionResult, Session, UploadPartUrl, UploadStatus, UploadedPart } from "@bandapp/types";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUserId } from "../auth/current-user-id.decorator.js";
import { optionalInteger, requireInteger, requireIsoDate, requireOneOf, requireString, requireUuidParam } from "../common/validation.js";
import { MAX_UPLOAD_BYTES, SessionsService } from "./sessions.service.js";

const CONTENT_TYPES = ["audio/mp4", "audio/x-m4a"] as const;
const SOURCES = ["recording", "import"] as const;

@Controller("bands")
@UseGuards(AuthGuard)
export class BandSessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Post(":bandId/sessions")
  create(@CurrentUserId() userId: string, @Param("bandId") bandId: string, @Body() body: unknown): Promise<CreateSessionResult> {
    requireUuidParam(bandId, "bandId");
    return this.sessions.create(bandId, userId, {
      startedAt: requireIsoDate(body, "startedAt"),
      durationMs: optionalInteger(body, "durationMs", { min: 1 }),
      sizeBytes: requireInteger(body, "sizeBytes", { min: 1, max: MAX_UPLOAD_BYTES }),
      contentType: requireOneOf(body, "contentType", CONTENT_TYPES),
      source: requireOneOf(body, "source", SOURCES),
    });
  }

  @Get(":bandId/sessions")
  list(@CurrentUserId() userId: string, @Param("bandId") bandId: string): Promise<Session[]> {
    requireUuidParam(bandId, "bandId");
    return this.sessions.list(bandId, userId);
  }
}

@Controller("sessions")
@UseGuards(AuthGuard)
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get(":id")
  get(@CurrentUserId() userId: string, @Param("id") id: string): Promise<Session> {
    requireUuidParam(id, "id");
    return this.sessions.get(id, userId);
  }

  @Post(":id/upload/parts")
  partUrls(@CurrentUserId() userId: string, @Param("id") id: string, @Body() body: unknown): Promise<UploadPartUrl[]> {
    requireUuidParam(id, "id");
    const partNumbers = (body as { partNumbers?: unknown } | null)?.partNumbers;
    if (!Array.isArray(partNumbers)) throw new BadRequestException("partNumbers must be an array");
    return this.sessions.partUrls(id, userId, partNumbers as number[]);
  }

  @Get(":id/upload")
  uploadStatus(@CurrentUserId() userId: string, @Param("id") id: string): Promise<UploadStatus> {
    requireUuidParam(id, "id");
    return this.sessions.uploadStatus(id, userId);
  }

  @Post(":id/upload/complete")
  complete(@CurrentUserId() userId: string, @Param("id") id: string, @Body() body: unknown): Promise<Session> {
    requireUuidParam(id, "id");
    const raw = (body as { parts?: unknown } | null)?.parts;
    if (!Array.isArray(raw)) throw new BadRequestException("parts must be an array");
    const parts: UploadedPart[] = raw.map((p, i) => ({
      partNumber: requireInteger(p, "partNumber", { min: 1 }),
      etag: requireString(p, "etag"),
    }));
    return this.sessions.completeUpload(id, userId, parts);
  }

  @Post(":id/retry")
  retry(@CurrentUserId() userId: string, @Param("id") id: string): Promise<Session> {
    requireUuidParam(id, "id");
    return this.sessions.retry(id, userId);
  }

  @Get(":id/audio")
  audio(@CurrentUserId() userId: string, @Param("id") id: string): Promise<AudioUrl> {
    requireUuidParam(id, "id");
    return this.sessions.audioUrl(id, userId);
  }
}
```

(`@Post`는 기본 201이라 `partUrls`, `complete`, `retry`에 `@HttpCode(200)`을 붙인다 — import에 `HttpCode` 추가. `create`만 201.)

`apps/api/src/sessions/sessions.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { AnalysisModule } from "../analysis/analysis.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { DbModule } from "../db/db.module.js";
import { MembershipsModule } from "../memberships/memberships.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { BandSessionsController, SessionsController } from "./sessions.controller.js";
import { sessionsServiceProvider } from "./sessions.service.js";

@Module({
  imports: [DbModule, AuthModule, MembershipsModule, StorageModule, AnalysisModule],
  controllers: [BandSessionsController, SessionsController],
  providers: [sessionsServiceProvider],
  exports: [sessionsServiceProvider],
})
export class SessionsModule {}
```

`MembershipsModule`이 `MembershipsService`를 export하는지 확인한다 (`apps/api/src/memberships/memberships.module.ts`). BandsModule이 이미 그렇게 쓰고 있으므로 export돼 있다.

- [ ] **Step 10: e2e 통과 확인**

Run: `pnpm --filter @bandapp/api test:e2e -- test/sessions.e2e-spec.ts`
Expected: PASS. 라우트 순서 문제(`/bands/:bandId/sessions`가 BandsController의 `:bandId/members`와 충돌하지 않는지)는 경로가 다르므로 없다.

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/sessions apps/api/test/app-util.ts apps/api/test/sessions.e2e-spec.ts
git commit -m "feat(api): create sessions with presigned multipart upload and analysis hand-off"
```

---

### Task 8: Take 목록·오디오 URL API

**Files:**
- Create: `apps/api/src/takes/takes.service.ts`, `takes.controller.ts`
- Modify: `apps/api/src/takes/takes.module.ts`
- Create: `apps/api/test/takes.e2e-spec.ts`

**Interfaces:**
- Consumes: `SessionsService.loadForMember`, `StorageService.presignGet`, `PRESIGN_EXPIRES_SEC`.
- Produces: `TakesService.list(sessionId, userId): Promise<Take[]>`, `TakesService.audioUrl(takeId, userId): Promise<AudioUrl>`, `TakesService.loadForMember(takeId, userId): Promise<TakeRow>` (comments가 재사용), `toTake(row): Take`, `TAKE_WITH_COUNT` select 컬럼.

- [ ] **Step 1: 실패하는 e2e 작성**

`apps/api/test/takes.e2e-spec.ts`:

```ts
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { comments, sessions, takes } from "../src/db/schema.js";
import { FakeStorage, createTestApp, loginAs, providerUser } from "./app-util.js";
import { createTestDb, truncateAll } from "./db-util.js";

describe("takes API", () => {
  const db = createTestDb();
  let app: INestApplication;
  let owner: { accessToken: string; userId: string };
  let bandId: string;
  let sessionId: string;

  beforeEach(async () => {
    await truncateAll(db);
    app = await createTestApp({ google: providerUser("owner-1"), storage: new FakeStorage() });
    owner = await loginAs(app);
    const band = await request(app.getHttpServer()).post("/bands").set(auth(owner.accessToken)).send({ name: "B" }).expect(201);
    bandId = band.body.id;
    const [s] = await db
      .insert(sessions)
      .values({ bandId, createdBy: owner.userId, title: "Sep 4 Rehearsal", status: "ready", startedAt: new Date(), durationMs: 600_000, takeCount: 2 })
      .returning();
    sessionId = s!.id;
    await db.insert(takes).values([
      { sessionId, index: 1, name: "Take 2", startMs: 300_000, endMs: 420_000, type: "PARTIAL_PRACTICE", confidence: 0.6, objectKey: `bands/${bandId}/sessions/${sessionId}/takes/t2.m4a` },
      { sessionId, index: 0, name: "Take 1", startMs: 10_000, endMs: 250_500, type: "PERFORMANCE", confidence: 0.9, objectKey: `bands/${bandId}/sessions/${sessionId}/takes/t1.m4a` },
    ]);
  });
  afterEach(() => app.close());

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  it("세션의 take를 index 순으로 commentCount와 함께 준다", async () => {
    const [first] = await db.select().from(takes).where(eq(takes.index, 0));
    await db.insert(comments).values({ takeId: first!.id, authorId: owner.userId, atMs: 1000, text: "x" });
    const res = await request(app.getHttpServer()).get(`/sessions/${sessionId}/takes`).set(auth(owner.accessToken)).expect(200);
    expect(res.body).toEqual([
      { id: first!.id, sessionId, index: 0, name: "Take 1", durationSec: 241, startMs: 10_000, endMs: 250_500, type: "PERFORMANCE", commentCount: 1 },
      expect.objectContaining({ index: 1, name: "Take 2", durationSec: 120, commentCount: 0 }),
    ]);
  });

  it("take 오디오 URL은 take 객체 키로 서명된다", async () => {
    const [first] = await db.select().from(takes).where(eq(takes.index, 0));
    const res = await request(app.getHttpServer()).get(`/takes/${first!.id}/audio`).set(auth(owner.accessToken)).expect(200);
    expect(res.body.url).toContain("/takes/t1.m4a");
  });

  it("비멤버는 403, 없는 take는 404", async () => {
    const other = await createTestApp({ google: providerUser("stranger-1", "S"), storage: new FakeStorage() });
    const stranger = await loginAs(other);
    await other.close();
    await request(app.getHttpServer()).get(`/sessions/${sessionId}/takes`).set(auth(stranger.accessToken)).expect(403);
    const [first] = await db.select().from(takes).where(eq(takes.index, 0));
    await request(app.getHttpServer()).get(`/takes/${first!.id}/audio`).set(auth(stranger.accessToken)).expect(403);
    await request(app.getHttpServer()).get("/takes/00000000-0000-0000-0000-000000000000/audio").set(auth(owner.accessToken)).expect(404);
  });
});
```

파일 상단에 `import { eq } from "drizzle-orm";`를 추가한다.

- [ ] **Step 2: 실행해서 실패 확인**

Run: `pnpm --filter @bandapp/api test:e2e -- test/takes.e2e-spec.ts`
Expected: FAIL — 404.

- [ ] **Step 3: 서비스·컨트롤러·모듈 구현**

`apps/api/src/takes/takes.service.ts`:

```ts
import { NotFoundException } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { asc, eq, sql } from "drizzle-orm";
import type { AudioUrl, Take, TakeCandidateType } from "@bandapp/types";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { takes } from "../db/schema.js";
import { MembershipsService } from "../memberships/memberships.service.js";
import { PRESIGN_EXPIRES_SEC, SessionsService } from "../sessions/sessions.service.js";
import { StorageService } from "../storage/storage.service.js";

export const TAKE_WITH_COUNT = {
  id: takes.id,
  sessionId: takes.sessionId,
  index: takes.index,
  name: takes.name,
  startMs: takes.startMs,
  endMs: takes.endMs,
  type: takes.type,
  objectKey: takes.objectKey,
  commentCount: sql<number>`(select count(*)::int from comments c where c.take_id = ${takes.id})`,
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
  };
}

export class TakesService {
  constructor(
    private readonly db: Db,
    private readonly sessions: SessionsService,
    private readonly memberships: MembershipsService,
    private readonly storage: StorageService,
  ) {}

  async list(sessionId: string, userId: string): Promise<Take[]> {
    await this.sessions.loadForMember(sessionId, userId);
    const rows = await this.db.select(TAKE_WITH_COUNT).from(takes).where(eq(takes.sessionId, sessionId)).orderBy(asc(takes.index));
    return rows.map(toTake);
  }

  /** take → 세션 → 밴드 멤버십 순으로 검증한다. 없으면 404, 멤버가 아니면 403. */
  async loadForMember(takeId: string, userId: string): Promise<TakeRow> {
    const [row] = await this.db.select(TAKE_WITH_COUNT).from(takes).where(eq(takes.id, takeId));
    if (!row) throw new NotFoundException("Take를 찾을 수 없어요.");
    const session = await this.sessions.loadForMember(row.sessionId, userId);
    await this.memberships.assertMember(session.bandId, userId);
    return row;
  }

  async audioUrl(takeId: string, userId: string): Promise<AudioUrl> {
    const take = await this.loadForMember(takeId, userId);
    return {
      url: await this.storage.presignGet(take.objectKey, PRESIGN_EXPIRES_SEC),
      expiresAt: new Date(Date.now() + PRESIGN_EXPIRES_SEC * 1000).toISOString(),
    };
  }
}

export const takesServiceProvider: Provider = {
  provide: TakesService,
  useFactory: (db: Db, sessions: SessionsService, memberships: MembershipsService, storage: StorageService) =>
    new TakesService(db, sessions, memberships, storage),
  inject: [DB, SessionsService, MembershipsService, StorageService],
};
```

(`loadForMember` 안의 `assertMember`는 `sessions.loadForMember`가 이미 했으므로 중복이다 — 지운다. `memberships` 의존성도 함께 지운다.)

`apps/api/src/takes/takes.controller.ts`:

```ts
import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import type { AudioUrl, Take } from "@bandapp/types";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUserId } from "../auth/current-user-id.decorator.js";
import { requireUuidParam } from "../common/validation.js";
import { TakesService } from "./takes.service.js";

@Controller()
@UseGuards(AuthGuard)
export class TakesController {
  constructor(private readonly takes: TakesService) {}

  @Get("sessions/:id/takes")
  list(@CurrentUserId() userId: string, @Param("id") id: string): Promise<Take[]> {
    requireUuidParam(id, "id");
    return this.takes.list(id, userId);
  }

  @Get("takes/:id/audio")
  audio(@CurrentUserId() userId: string, @Param("id") id: string): Promise<AudioUrl> {
    requireUuidParam(id, "id");
    return this.takes.audioUrl(id, userId);
  }
}
```

`apps/api/src/takes/takes.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { DbModule } from "../db/db.module.js";
import { SessionsModule } from "../sessions/sessions.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { TakesController } from "./takes.controller.js";
import { takesServiceProvider } from "./takes.service.js";

@Module({
  imports: [DbModule, AuthModule, SessionsModule, StorageModule],
  controllers: [TakesController],
  providers: [takesServiceProvider],
  exports: [takesServiceProvider],
})
export class TakesModule {}
```

- [ ] **Step 4: e2e 통과 확인**

Run: `pnpm --filter @bandapp/api test:e2e -- test/takes.e2e-spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/takes apps/api/test/takes.e2e-spec.ts
git commit -m "feat(api): list takes and sign take audio URLs"
```

---

### Task 9: 코멘트 API

**Files:**
- Create: `apps/api/src/comments/comments.service.ts`, `comments.controller.ts`
- Modify: `apps/api/src/comments/comments.module.ts`
- Create: `apps/api/test/comments.e2e-spec.ts`

**Interfaces:**
- Consumes: `TakesService.loadForMember(takeId, userId)` (Task 8).
- Produces: `CommentsService.list(takeId, userId): Promise<TakeComment[]>`, `create(takeId, userId, input: CreateCommentInput): Promise<TakeComment>`.

- [ ] **Step 1: 실패하는 e2e 작성**

`apps/api/test/comments.e2e-spec.ts`:

```ts
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bandMembers, sessions, takes } from "../src/db/schema.js";
import { FakeStorage, createTestApp, loginAs, providerUser } from "./app-util.js";
import { createTestDb, truncateAll } from "./db-util.js";

describe("comments API", () => {
  const db = createTestDb();
  let app: INestApplication;
  let owner: { accessToken: string; userId: string };
  let bandId: string;
  let takeId: string;

  beforeEach(async () => {
    await truncateAll(db);
    app = await createTestApp({ google: providerUser("owner-1"), storage: new FakeStorage() });
    owner = await loginAs(app);
    const band = await request(app.getHttpServer()).post("/bands").set(auth(owner.accessToken)).send({ name: "B" }).expect(201);
    bandId = band.body.id;
    const [s] = await db
      .insert(sessions)
      .values({ bandId, createdBy: owner.userId, title: "t", status: "ready", startedAt: new Date(), durationMs: 600_000, takeCount: 1 })
      .returning();
    const [t] = await db
      .insert(takes)
      .values({ sessionId: s!.id, index: 0, name: "Take 1", startMs: 0, endMs: 240_000, type: "PERFORMANCE", confidence: 0.9, objectKey: "k" })
      .returning();
    takeId = t!.id;
  });
  afterEach(() => app.close());

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  it("코멘트를 남기면 작성자 이름과 함께 돌아오고 목록은 시점 순이다", async () => {
    const later = await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ atSec: 120.7, text: "Rushing here" }).expect(201);
    expect(later.body).toEqual({
      id: expect.any(String),
      takeId,
      authorId: owner.userId,
      authorName: "Dongjin",
      parentId: null,
      atSec: 120.7,
      text: "Rushing here",
      createdAt: expect.any(String),
    });
    await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send({ atSec: 5, text: "Count-in" }).expect(201);
    const res = await request(app.getHttpServer()).get(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).expect(200);
    expect(res.body.map((c: { text: string }) => c.text)).toEqual(["Count-in", "Rushing here"]);
    const takesRes = await request(app.getHttpServer()).get(`/sessions/${(await db.select().from(takes).where(eq(takes.id, takeId)))[0]!.sessionId}/takes`).set(auth(owner.accessToken)).expect(200);
    expect(takesRes.body[0].commentCount).toBe(2);
  });

  it.each([
    ["빈 텍스트", { atSec: 1, text: "   " }],
    ["500자 초과", { atSec: 1, text: "a".repeat(501) }],
    ["음수 시점", { atSec: -1, text: "x" }],
    ["take 길이 초과", { atSec: 241, text: "x" }],
    ["문자열 시점", { atSec: "1", text: "x" }],
  ])("잘못된 입력은 400: %s", async (_label, body) => {
    await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).send(body).expect(400);
  });

  it("다른 멤버의 코멘트도 보이고, 비멤버는 403", async () => {
    const other = await createTestApp({ google: providerUser("member-1", "Minsoo"), storage: new FakeStorage() });
    const member = await loginAs(other);
    await other.close();
    await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(member.accessToken)).send({ atSec: 1, text: "x" }).expect(403);
    await db.insert(bandMembers).values({ bandId, userId: member.userId, role: "member" });
    await request(app.getHttpServer()).post(`/takes/${takeId}/comments`).set(auth(member.accessToken)).send({ atSec: 1, text: "from minsoo" }).expect(201);
    const res = await request(app.getHttpServer()).get(`/takes/${takeId}/comments`).set(auth(owner.accessToken)).expect(200);
    expect(res.body[0]).toMatchObject({ authorName: "Minsoo", text: "from minsoo" });
  });
});
```

- [ ] **Step 2: 실행해서 실패 확인**

Run: `pnpm --filter @bandapp/api test:e2e -- test/comments.e2e-spec.ts`
Expected: FAIL — 404.

- [ ] **Step 3: 구현**

`apps/api/src/comments/comments.service.ts`:

```ts
import { BadRequestException } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import type { CreateCommentInput, TakeComment } from "@bandapp/types";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { comments, users } from "../db/schema.js";
import { TakesService } from "../takes/takes.service.js";

const COMMENT_COLUMNS = {
  id: comments.id,
  takeId: comments.takeId,
  authorId: comments.authorId,
  authorName: users.displayName,
  parentId: comments.parentId,
  atMs: comments.atMs,
  text: comments.text,
  createdAt: comments.createdAt,
};

type CommentRow = {
  id: string;
  takeId: string;
  authorId: string;
  authorName: string | null;
  parentId: string | null;
  atMs: number;
  text: string;
  createdAt: Date;
};

function toComment(row: CommentRow): TakeComment {
  return {
    id: row.id,
    takeId: row.takeId,
    authorId: row.authorId,
    authorName: row.authorName ?? "탈퇴한 멤버",
    parentId: row.parentId,
    atSec: row.atMs / 1000,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
  };
}

export class CommentsService {
  constructor(
    private readonly db: Db,
    private readonly takes: TakesService,
  ) {}

  async list(takeId: string, userId: string): Promise<TakeComment[]> {
    await this.takes.loadForMember(takeId, userId);
    const rows = await this.db
      .select(COMMENT_COLUMNS)
      .from(comments)
      .innerJoin(users, eq(users.id, comments.authorId))
      .where(eq(comments.takeId, takeId))
      .orderBy(asc(comments.atMs), asc(comments.createdAt));
    return rows.map(toComment);
  }

  async create(takeId: string, userId: string, input: CreateCommentInput): Promise<TakeComment> {
    const take = await this.takes.loadForMember(takeId, userId);
    const text = input.text.trim();
    if (text.length === 0 || text.length > 500) throw new BadRequestException("text must be 1-500 characters");
    const atMs = Math.round(input.atSec * 1000);
    if (atMs > take.endMs - take.startMs) throw new BadRequestException("atSec is beyond the take length");
    const [inserted] = await this.db.insert(comments).values({ takeId, authorId: userId, atMs, text }).returning({ id: comments.id });
    if (!inserted) throw new Error("failed to insert comment");
    const [row] = await this.db
      .select(COMMENT_COLUMNS)
      .from(comments)
      .innerJoin(users, eq(users.id, comments.authorId))
      .where(eq(comments.id, inserted.id));
    if (!row) throw new Error("comment vanished after insert");
    return toComment(row);
  }
}

export const commentsServiceProvider: Provider = {
  provide: CommentsService,
  useFactory: (db: Db, takes: TakesService) => new CommentsService(db, takes),
  inject: [DB, TakesService],
};
```

`apps/api/src/comments/comments.controller.ts`:

```ts
import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import type { TakeComment } from "@bandapp/types";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUserId } from "../auth/current-user-id.decorator.js";
import { requireNumber, requireString, requireUuidParam } from "../common/validation.js";
import { CommentsService } from "./comments.service.js";

@Controller("takes")
@UseGuards(AuthGuard)
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get(":id/comments")
  list(@CurrentUserId() userId: string, @Param("id") id: string): Promise<TakeComment[]> {
    requireUuidParam(id, "id");
    return this.comments.list(id, userId);
  }

  @Post(":id/comments")
  create(@CurrentUserId() userId: string, @Param("id") id: string, @Body() body: unknown): Promise<TakeComment> {
    requireUuidParam(id, "id");
    return this.comments.create(id, userId, {
      atSec: requireNumber(body, "atSec", { min: 0 }),
      text: requireString(body, "text"),
    });
  }
}
```

`apps/api/src/comments/comments.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { DbModule } from "../db/db.module.js";
import { TakesModule } from "../takes/takes.module.js";
import { CommentsController } from "./comments.controller.js";
import { commentsServiceProvider } from "./comments.service.js";

@Module({
  imports: [DbModule, AuthModule, TakesModule],
  controllers: [CommentsController],
  providers: [commentsServiceProvider],
})
export class CommentsModule {}
```

- [ ] **Step 4: e2e 통과 확인**

Run: `pnpm --filter @bandapp/api test:e2e -- test/comments.e2e-spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/comments apps/api/test/comments.e2e-spec.ts
git commit -m "feat(api): add timestamped comments on takes"
```

---

### Task 10: 청크 계획과 후보 병합 (순수 함수)

**Files:**
- Create: `apps/api/src/analysis/chunking.ts`, `chunking.spec.ts`

**Interfaces:**
- Produces:

```ts
export interface Chunk { index: number; startMs: number; endMs: number }
export interface ChunkOptions { chunkMs: number; overlapMs: number }
export const DEFAULT_CHUNKING: ChunkOptions; // { chunkMs: 20 * 60_000, overlapMs: 30_000 }
export function planChunks(durationMs: number, opts?: ChunkOptions): Chunk[];
export interface MergeOptions { minDurationMs: number }
export function mergeCandidates(candidates: TakeCandidate[], opts?: MergeOptions): TakeCandidate[];
```
  `planChunks`가 스펙 결정 2의 유일한 끼움 지점이다 — 검출기 전처리는 이 함수를 "후보 구간 목록"을 내는 것으로 교체한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/src/analysis/chunking.spec.ts`:

```ts
import { DEFAULT_CHUNKING, mergeCandidates, planChunks } from "./chunking.js";

const MIN = 60_000;

describe("planChunks", () => {
  it("returns a single chunk when the audio fits in one", () => {
    expect(planChunks(15 * MIN)).toEqual([{ index: 0, startMs: 0, endMs: 15 * MIN }]);
    expect(planChunks(20 * MIN)).toEqual([{ index: 0, startMs: 0, endMs: 20 * MIN }]);
  });

  it("overlaps neighbouring chunks by overlapMs on both sides, clamped to the file", () => {
    expect(planChunks(45 * MIN + 17_000)).toEqual([
      { index: 0, startMs: 0, endMs: 20 * MIN + 30_000 },
      { index: 1, startMs: 20 * MIN - 30_000, endMs: 40 * MIN + 30_000 },
      { index: 2, startMs: 40 * MIN - 30_000, endMs: 45 * MIN + 17_000 },
    ]);
  });

  it("honours custom options", () => {
    expect(planChunks(10_000, { chunkMs: 4_000, overlapMs: 1_000 })).toEqual([
      { index: 0, startMs: 0, endMs: 5_000 },
      { index: 1, startMs: 3_000, endMs: 9_000 },
      { index: 2, startMs: 7_000, endMs: 10_000 },
    ]);
  });

  it("rejects non-positive durations", () => {
    expect(() => planChunks(0)).toThrow();
  });

  it("exposes the spec defaults", () => {
    expect(DEFAULT_CHUNKING).toEqual({ chunkMs: 20 * MIN, overlapMs: 30_000 });
  });
});

describe("mergeCandidates", () => {
  const take = (startMs: number, endMs: number, type: "PERFORMANCE" | "PARTIAL_PRACTICE" = "PERFORMANCE", confidence = 0.9) => ({ startMs, endMs, type, confidence });

  it("merges overlapping and touching candidates into one", () => {
    expect(mergeCandidates([take(0, 100_000), take(90_000, 200_000), take(200_000, 260_000)])).toEqual([take(0, 260_000)]);
  });

  it("keeps separated candidates apart and sorts by start", () => {
    expect(mergeCandidates([take(300_000, 400_000), take(0, 100_000)])).toEqual([take(0, 100_000), take(300_000, 400_000)]);
  });

  it("prefers PERFORMANCE and the max confidence when merging", () => {
    expect(mergeCandidates([take(0, 60_000, "PARTIAL_PRACTICE", 0.4), take(50_000, 120_000, "PERFORMANCE", 0.7)])).toEqual([take(0, 120_000, "PERFORMANCE", 0.7)]);
  });

  it("drops candidates shorter than minDurationMs after merging", () => {
    expect(mergeCandidates([take(0, 15_000), take(100_000, 130_000)])).toEqual([take(100_000, 130_000)]);
    expect(mergeCandidates([take(0, 15_000), take(14_000, 25_000)])).toEqual([take(0, 25_000)]);
  });

  it("returns an empty list for no candidates", () => {
    expect(mergeCandidates([])).toEqual([]);
  });
});
```

- [ ] **Step 2: 실행해서 실패 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/analysis/chunking.spec.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현**

`apps/api/src/analysis/chunking.ts`:

```ts
import type { TakeCandidate } from "@bandapp/types";

export interface Chunk {
  index: number;
  startMs: number;
  endMs: number;
}

export interface ChunkOptions {
  chunkMs: number;
  overlapMs: number;
}

export const DEFAULT_CHUNKING: ChunkOptions = { chunkMs: 20 * 60_000, overlapMs: 30_000 };

/**
 * 고정 길이 청크 + 앞뒤 겹침 (스펙 결정 2). 청크 i의 본체는 [i*chunkMs, (i+1)*chunkMs)이고
 * 양쪽으로 overlapMs만큼 넓혀 파일 범위로 자른다. 검출기 전처리가 들어오면 이 함수가
 * "후보 구간 목록"을 내는 것으로 바뀐다 — 파이프라인의 다른 부분은 그대로다.
 */
export function planChunks(durationMs: number, opts: ChunkOptions = DEFAULT_CHUNKING): Chunk[] {
  if (!(durationMs > 0)) throw new Error(`durationMs must be positive, got ${durationMs}`);
  const count = Math.max(1, Math.ceil(durationMs / opts.chunkMs));
  return Array.from({ length: count }, (_, index) => ({
    index,
    startMs: Math.max(0, index * opts.chunkMs - opts.overlapMs),
    endMs: Math.min(durationMs, (index + 1) * opts.chunkMs + opts.overlapMs),
  }));
}

export interface MergeOptions {
  minDurationMs: number;
}

export const DEFAULT_MERGE: MergeOptions = { minDurationMs: 20_000 };

/**
 * 겹치거나 맞닿는 후보만 합친다 — 겹침 구간에서 같은 연주가 양쪽 청크에 잡힌 경우가 대상이다.
 * 떨어진 구간의 gap-merge는 하지 않는다 (Gemini 프롬프트가 이미 담당한다고 본다).
 */
export function mergeCandidates(candidates: TakeCandidate[], opts: MergeOptions = DEFAULT_MERGE): TakeCandidate[] {
  const sorted = [...candidates].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged: TakeCandidate[] = [];
  for (const c of sorted) {
    const last = merged[merged.length - 1];
    if (last && c.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, c.endMs);
      last.type = last.type === "PERFORMANCE" || c.type === "PERFORMANCE" ? "PERFORMANCE" : "PARTIAL_PRACTICE";
      last.confidence = Math.max(last.confidence, c.confidence);
    } else {
      merged.push({ ...c });
    }
  }
  return merged.filter((t) => t.endMs - t.startMs >= opts.minDurationMs);
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/analysis/chunking.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/analysis/chunking.ts apps/api/src/analysis/chunking.spec.ts
git commit -m "feat(api): plan overlapping analysis chunks and merge take candidates"
```

---

### Task 11: 워커 파이프라인 (ffmpeg, SessionAnalysisService, consumer, 인프라)

**Files:**
- Create: `apps/api/src/worker/ffmpeg.ts`
- Create: `apps/api/src/worker/session-analysis.service.ts`, `session-analysis.service.spec.ts`
- Modify: `apps/api/src/worker/analysis.consumer.ts`, `analysis.consumer.spec.ts`
- Modify: `apps/api/src/worker/worker.module.ts`
- Modify: `apps/api/Dockerfile`, `docker/localstack/init-aws.sh`

**Interfaces:**
- Consumes: `StorageService`, `GeminiService.analyzeFile`, `planChunks`, `mergeCandidates`, `takeKey`, `originalKey`.
- Produces:

```ts
export interface FfmpegRunner {
  probeDurationMs(input: string): Promise<number>;
  cut(input: string, startMs: number, endMs: number, output: string): Promise<void>;
}
export class ExecFfmpegRunner implements FfmpegRunner {}
export class SessionAnalysisService {
  constructor(db: Db, storage: StorageService, gemini: GeminiService, ffmpeg: FfmpegRunner, tmpRoot?: string);
  /** 파이프라인 오류는 세션 failed로 기록하고 삼킨다. DB 자체 오류만 throw한다. */
  run(sessionId: string): Promise<void>;
}
```

- [ ] **Step 1: ffmpeg 실행기**

`apps/api/src/worker/ffmpeg.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface FfmpegRunner {
  probeDurationMs(input: string): Promise<number>;
  /** 재인코딩 없이(`-c copy`) 구간을 잘라낸다. AAC는 프레임이 독립적이라 ~23ms 정밀도로 충분하다. */
  cut(input: string, startMs: number, endMs: number, output: string): Promise<void>;
}

export class ExecFfmpegRunner implements FfmpegRunner {
  constructor(
    private readonly ffmpegBin = process.env.FFMPEG_BIN ?? "ffmpeg",
    private readonly ffprobeBin = process.env.FFPROBE_BIN ?? "ffprobe",
  ) {}

  async probeDurationMs(input: string): Promise<number> {
    const { stdout } = await execFileAsync(this.ffprobeBin, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "csv=p=0",
      input,
    ]);
    const seconds = Number(stdout.trim());
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`ffprobe returned no duration for ${input}: ${stdout}`);
    return Math.round(seconds * 1000);
  }

  async cut(input: string, startMs: number, endMs: number, output: string): Promise<void> {
    // -ss를 -i 앞에 두면 입력 seek이라 빠르고, 길이는 -t(구간 길이)로 준다.
    // -to는 -ss 뒤에서 기준점이 달라져 헷갈리므로 쓰지 않는다.
    await execFileAsync(this.ffmpegBin, [
      "-v", "error",
      "-y",
      "-ss", (startMs / 1000).toFixed(3),
      "-t", ((endMs - startMs) / 1000).toFixed(3),
      "-i", input,
      "-vn",
      "-c", "copy",
      "-movflags", "+faststart",
      output,
    ]);
  }
}
```

- [ ] **Step 2: 실패하는 SessionAnalysisService 테스트 작성**

`apps/api/src/worker/session-analysis.service.spec.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TakeCandidate } from "@bandapp/types";
import type { GeminiService } from "../analysis/gemini.service.js";
import type { Db } from "../db/db.module.js";
import type { StorageService } from "../storage/storage.service.js";
import type { FfmpegRunner } from "./ffmpeg.js";
import { SessionAnalysisService } from "./session-analysis.service.js";

const MIN = 60_000;

/** drizzle 대신 이 서비스가 쓰는 최소 표면만 흉내 낸다. */
function fakeDb(session: { id: string; bandId: string; status: string } | undefined, recording = { objectKey: "bands/b/sessions/s/original.m4a" }) {
  const state = {
    session,
    updates: [] as Array<Record<string, unknown>>,
    insertedTakes: [] as Array<Record<string, unknown>>,
    deletedTakes: 0,
    existingTakes: [{ objectKey: "bands/b/sessions/s/takes/old.m4a" }],
  };
  const db = {
    query: {
      sessions: { findFirst: async () => state.session },
      recordings: { findFirst: async () => recording },
      takes: { findMany: async () => state.existingTakes },
    },
    update: () => ({ set: (v: Record<string, unknown>) => ({ where: async () => { state.updates.push(v); } }) }),
    delete: () => ({ where: async () => { state.deletedTakes += 1; } }),
    insert: () => ({ values: async (rows: Record<string, unknown>[]) => { state.insertedTakes.push(...rows); } }),
    transaction: async (fn: (tx: unknown) => Promise<void>) => fn(db),
  };
  return { db: db as unknown as Db, state };
}

function fakeStorage() {
  const calls = { downloads: [] as string[], puts: [] as string[], deleted: [] as string[] };
  const storage = {
    downloadToFile: async (key: string) => { calls.downloads.push(key); },
    putFile: async (key: string) => { calls.puts.push(key); },
    deleteObjects: async (keys: string[]) => { calls.deleted.push(...keys); },
  } as unknown as StorageService;
  return { storage, calls };
}

function fakeFfmpeg(durationMs: number) {
  const cuts: Array<{ startMs: number; endMs: number }> = [];
  const ffmpeg: FfmpegRunner = {
    probeDurationMs: async () => durationMs,
    cut: async (_i, startMs, endMs) => { cuts.push({ startMs, endMs }); },
  };
  return { ffmpeg, cuts };
}

describe("SessionAnalysisService.run", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "bandapp-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("downloads, chunks, analyzes, merges, cuts takes, uploads them, and marks the session ready", async () => {
    const { db, state } = fakeDb({ id: "s", bandId: "b", status: "analyzing" });
    const { storage, calls } = fakeStorage();
    const { ffmpeg, cuts } = fakeFfmpeg(45 * MIN);
    // 청크 0: 0..20:30, 청크 1: 19:30..40:30, 청크 2: 39:30..45:00
    const perChunk: TakeCandidate[][] = [
      [{ startMs: 1 * MIN, endMs: 5 * MIN, type: "PERFORMANCE", confidence: 0.9 }, { startMs: 19 * MIN, endMs: 20 * MIN + 30_000, type: "PERFORMANCE", confidence: 0.8 }],
      [{ startMs: 0, endMs: 2 * MIN, type: "PERFORMANCE", confidence: 0.85 }, { startMs: 10 * MIN, endMs: 10 * MIN + 10_000, type: "PARTIAL_PRACTICE", confidence: 0.5 }],
      [],
    ];
    const analyzeFile = vi.fn().mockImplementation(async () => perChunk.shift() ?? []);
    const gemini = { analyzeFile } as unknown as GeminiService;

    await new SessionAnalysisService(db, storage, gemini, ffmpeg, tmp).run("s");

    expect(calls.downloads).toEqual(["bands/b/sessions/s/original.m4a"]);
    expect(calls.deleted).toEqual(["bands/b/sessions/s/takes/old.m4a"]);
    expect(state.deletedTakes).toBe(1);
    expect(analyzeFile).toHaveBeenCalledTimes(3);
    // 청크 절단 3회 + take 절단 2회
    expect(cuts.slice(0, 3)).toEqual([
      { startMs: 0, endMs: 20 * MIN + 30_000 },
      { startMs: 20 * MIN - 30_000, endMs: 40 * MIN + 30_000 },
      { startMs: 40 * MIN - 30_000, endMs: 45 * MIN },
    ]);
    // 청크 1의 [0, 2분]은 오프셋 19:30을 더해 [19:30, 21:30]이 되고 청크 0의 [19:00, 20:30]과 겹쳐 하나로 합쳐진다.
    // 청크 1의 10초짜리 PARTIAL_PRACTICE는 최소 길이 미만이라 버려진다.
    expect(state.insertedTakes.map((t) => [t.index, t.name, t.startMs, t.endMs, t.type])).toEqual([
      [0, "Take 1", 1 * MIN, 5 * MIN, "PERFORMANCE"],
      [1, "Take 2", 19 * MIN, 21 * MIN + 30_000, "PERFORMANCE"],
    ]);
    expect(cuts.slice(3)).toEqual([
      { startMs: 1 * MIN, endMs: 5 * MIN },
      { startMs: 19 * MIN, endMs: 21 * MIN + 30_000 },
    ]);
    expect(calls.puts).toHaveLength(2);
    expect(calls.puts[0]).toMatch(/^bands\/b\/sessions\/s\/takes\/.+\.m4a$/);
    expect(state.updates.at(-1)).toMatchObject({ status: "ready", takeCount: 2, durationMs: 45 * MIN });
  });

  it("retries a chunk once and succeeds", async () => {
    const { db, state } = fakeDb({ id: "s", bandId: "b", status: "analyzing" });
    const { storage } = fakeStorage();
    const { ffmpeg } = fakeFfmpeg(5 * MIN);
    const analyzeFile = vi.fn().mockRejectedValueOnce(new Error("503")).mockResolvedValueOnce([]);
    await new SessionAnalysisService(db, storage, { analyzeFile } as unknown as GeminiService, ffmpeg, tmp).run("s");
    expect(analyzeFile).toHaveBeenCalledTimes(2);
    expect(state.updates.at(-1)).toMatchObject({ status: "ready", takeCount: 0 });
  });

  it("marks the session failed with the error when a chunk fails twice", async () => {
    const { db, state } = fakeDb({ id: "s", bandId: "b", status: "analyzing" });
    const { storage } = fakeStorage();
    const { ffmpeg } = fakeFfmpeg(5 * MIN);
    const analyzeFile = vi.fn().mockRejectedValue(new Error("gemini down"));
    await new SessionAnalysisService(db, storage, { analyzeFile } as unknown as GeminiService, ffmpeg, tmp).run("s");
    expect(analyzeFile).toHaveBeenCalledTimes(2);
    expect(state.updates.at(-1)).toMatchObject({ status: "failed", analysisError: expect.stringContaining("gemini down") });
  });

  it("ignores sessions that are not analyzing", async () => {
    const { db, state } = fakeDb({ id: "s", bandId: "b", status: "ready" });
    const { storage, calls } = fakeStorage();
    const analyzeFile = vi.fn();
    await new SessionAnalysisService(db, storage, { analyzeFile } as unknown as GeminiService, fakeFfmpeg(MIN).ffmpeg, tmp).run("s");
    expect(calls.downloads).toEqual([]);
    expect(analyzeFile).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });

  it("ignores unknown sessions", async () => {
    const { db } = fakeDb(undefined);
    const { storage, calls } = fakeStorage();
    await new SessionAnalysisService(db, storage, { analyzeFile: vi.fn() } as unknown as GeminiService, fakeFfmpeg(MIN).ffmpeg, tmp).run("nope");
    expect(calls.downloads).toEqual([]);
  });
});
```

- [ ] **Step 3: 실행해서 실패 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/worker/session-analysis.service.spec.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 4: SessionAnalysisService 구현**

`apps/api/src/worker/session-analysis.service.ts`:

```ts
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { TakeCandidate } from "@bandapp/types";
import { mergeCandidates, planChunks, type Chunk } from "../analysis/chunking.js";
import { DEFAULT_GEMINI_MODEL, GeminiService } from "../analysis/gemini.service.js";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { recordings, sessions, takes } from "../db/schema.js";
import { takeKey } from "../sessions/session-mapper.js";
import { StorageService } from "../storage/storage.service.js";
import { ExecFfmpegRunner, type FfmpegRunner } from "./ffmpeg.js";

const CHUNK_ATTEMPTS = 2;
const TAKE_CONTENT_TYPE = "audio/mp4";

export class SessionAnalysisService {
  private readonly logger = new Logger(SessionAnalysisService.name);

  constructor(
    private readonly db: Db,
    private readonly storage: StorageService,
    private readonly gemini: GeminiService,
    private readonly ffmpeg: FfmpegRunner,
    private readonly tmpRoot: string = tmpdir(),
  ) {}

  /**
   * 파이프라인 오류는 세션을 failed로 기록하고 삼킨다 — consumer가 메시지를 지운다 (스펙 결정 7).
   * DB 읽기 자체가 실패하면 throw해서 메시지를 남긴다 (재전달로 복구될 수 있는 오류).
   */
  async run(sessionId: string): Promise<void> {
    const session = await this.db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) });
    if (!session) {
      this.logger.warn(`session ${sessionId} not found, ignoring`);
      return;
    }
    if (session.status !== "analyzing") {
      this.logger.warn(`session ${sessionId} is ${session.status}, ignoring`);
      return;
    }
    const recording = await this.db.query.recordings.findFirst({ where: eq(recordings.sessionId, sessionId) });
    if (!recording) {
      await this.fail(sessionId, "녹음 파일 정보가 없어요.");
      return;
    }

    const workDir = await mkdtemp(join(this.tmpRoot, `session-${sessionId}-`));
    try {
      await this.resetTakes(sessionId);

      const original = join(workDir, "original.m4a");
      await this.storage.downloadToFile(recording.objectKey, original);
      const durationMs = await this.ffmpeg.probeDurationMs(original);
      await this.db.update(sessions).set({ durationMs, updatedAt: new Date() }).where(eq(sessions.id, sessionId));

      const chunks = planChunks(durationMs);
      const candidates: TakeCandidate[] = [];
      for (const chunk of chunks) {
        candidates.push(...(await this.analyzeChunk(original, chunk, workDir)));
      }
      const merged = mergeCandidates(candidates);

      const rows = [];
      for (const [index, candidate] of merged.entries()) {
        const takeId = randomUUID();
        const key = takeKey(session.bandId, sessionId, takeId);
        const output = join(workDir, `take-${index}.m4a`);
        await this.ffmpeg.cut(original, candidate.startMs, candidate.endMs, output);
        await this.storage.putFile(key, output, TAKE_CONTENT_TYPE);
        rows.push({
          id: takeId,
          sessionId,
          index,
          name: `Take ${index + 1}`,
          startMs: candidate.startMs,
          endMs: candidate.endMs,
          type: candidate.type,
          confidence: candidate.confidence,
          objectKey: key,
        });
      }

      await this.db.transaction(async (tx) => {
        if (rows.length > 0) await tx.insert(takes).values(rows);
        await tx
          .update(sessions)
          .set({
            status: "ready",
            takeCount: rows.length,
            durationMs,
            analysisError: null,
            analysisModel: process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL,
            updatedAt: new Date(),
          })
          .where(eq(sessions.id, sessionId));
      });
      this.logger.log(`session ${sessionId}: ${rows.length} takes from ${chunks.length} chunks`);
    } catch (err) {
      this.logger.error(`session ${sessionId} analysis failed: ${String(err)}`);
      await this.fail(sessionId, err instanceof Error ? err.message : String(err));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /** 재시도 멱등성 (스펙 결정 9): 이전 실행이 남긴 take 행과 R2 객체를 지운다. */
  private async resetTakes(sessionId: string): Promise<void> {
    const existing = await this.db.query.takes.findMany({ where: eq(takes.sessionId, sessionId) });
    if (existing.length === 0) return;
    await this.storage.deleteObjects(existing.map((t) => t.objectKey));
    await this.db.delete(takes).where(eq(takes.sessionId, sessionId));
  }

  private async analyzeChunk(original: string, chunk: Chunk, workDir: string): Promise<TakeCandidate[]> {
    const path = join(workDir, `chunk-${chunk.index}.m4a`);
    await this.ffmpeg.cut(original, chunk.startMs, chunk.endMs, path);
    let lastError: unknown;
    for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt++) {
      try {
        const found = await this.gemini.analyzeFile(path);
        return found.map((c) => ({ ...c, startMs: c.startMs + chunk.startMs, endMs: c.endMs + chunk.startMs }));
      } catch (err) {
        lastError = err;
        this.logger.warn(`chunk ${chunk.index} attempt ${attempt} failed: ${String(err)}`);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async fail(sessionId: string, message: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ status: "failed", analysisError: message.slice(0, 500), updatedAt: new Date() })
      .where(eq(sessions.id, sessionId));
  }
}

export const sessionAnalysisServiceProvider: Provider = {
  provide: SessionAnalysisService,
  useFactory: (db: Db, storage: StorageService, gemini: GeminiService) =>
    new SessionAnalysisService(db, storage, gemini, new ExecFfmpegRunner()),
  inject: [DB, StorageService, GeminiService],
};
```

- [ ] **Step 5: 서비스 테스트 통과 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/worker/session-analysis.service.spec.ts`
Expected: PASS

- [ ] **Step 6: consumer 테스트 갱신**

`analysis.consumer.spec.ts`의 `makeConsumer`를 바꾸고 케이스를 추가한다:

```ts
import type { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { AnalysisConsumer } from "./analysis.consumer.js";
import type { SessionAnalysisService } from "./session-analysis.service.js";

function makeConsumer(send: ReturnType<typeof vi.fn>, run: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined)) {
  const analysis = { run } as unknown as SessionAnalysisService;
  return { consumer: new AnalysisConsumer({ send } as unknown as SQSClient, analysis, 10), run };
}
```

(생성자 세 번째 인자는 heartbeat 간격 ms — 기본 60초, 테스트는 10ms.)

기존 케이스의 `makeConsumer(send)`는 `makeConsumer(send).consumer`로 바꾸고, 다음을 추가:

```ts
  it("runs the analysis for the session and deletes the message", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Messages: [{ Body: JSON.stringify({ sessionId: "s-1" }), ReceiptHandle: "rh-1" }] })
      .mockResolvedValue({});
    const { consumer, run } = makeConsumer(send);
    await consumer.pollOnce();
    expect(run).toHaveBeenCalledWith("s-1");
    const del = send.mock.calls.at(-1)![0] as DeleteMessageCommand;
    expect(del.input.ReceiptHandle).toBe("rh-1");
  });

  it("extends message visibility while a long analysis runs", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Messages: [{ Body: JSON.stringify({ sessionId: "s-1" }), ReceiptHandle: "rh-1" }] })
      .mockResolvedValue({});
    const run = vi.fn().mockImplementation(() => new Promise((r) => setTimeout(r, 35)));
    const { consumer } = makeConsumer(send, run);
    await consumer.pollOnce();
    const visibility = send.mock.calls.map((c) => c[0]).filter((c) => c.constructor.name === "ChangeMessageVisibilityCommand") as ChangeMessageVisibilityCommand[];
    expect(visibility.length).toBeGreaterThanOrEqual(2);
    expect(visibility[0]!.input).toEqual({ QueueUrl: queueUrl, ReceiptHandle: "rh-1", VisibilityTimeout: 300 });
  });

  it("leaves the message when run() itself throws (e.g. DB down)", async () => {
    const send = vi.fn().mockResolvedValueOnce({ Messages: [{ Body: JSON.stringify({ sessionId: "s-1" }), ReceiptHandle: "rh-1" }] });
    const { consumer } = makeConsumer(send, vi.fn().mockRejectedValue(new Error("db down")));
    await consumer.pollOnce();
    expect(send.mock.calls.some((c) => c[0].constructor.name === "DeleteMessageCommand")).toBe(false);
  });
```

- [ ] **Step 7: consumer 구현**

`apps/api/src/worker/analysis.consumer.ts` 전체:

```ts
import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import type { AnalyzeSessionJob } from "@bandapp/types";
import { SQS_CLIENT } from "../queue/queue.constants.js";
import { SessionAnalysisService } from "./session-analysis.service.js";

/** 긴 분석 중 재전달을 막는다 (스펙 결정 8). 큐 기본 visibility(300초)와 같은 값으로 연장한다. */
const VISIBILITY_TIMEOUT_SEC = 300;

@Injectable()
export class AnalysisConsumer {
  private readonly logger = new Logger(AnalysisConsumer.name);
  private running = false;

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    private readonly analysis: SessionAnalysisService,
    private readonly heartbeatMs = 60_000,
  ) {}

  async start(): Promise<void> {
    this.running = true;
    this.logger.log("analysis consumer started");
    while (this.running) {
      await this.pollOnce();
    }
    this.logger.log("analysis consumer stopped");
  }

  stop(): void {
    this.running = false;
  }

  async pollOnce(errorBackoffMs = 5000): Promise<void> {
    const queueUrl = process.env.SQS_ANALYSIS_QUEUE_URL;
    if (!queueUrl) {
      throw new Error("SQS_ANALYSIS_QUEUE_URL is not set");
    }

    let messages: Message[];
    try {
      const result = await this.sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 20 }),
      );
      messages = result.Messages ?? [];
    } catch (error) {
      this.logger.error(`SQS receive failed, backing off: ${String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, errorBackoffMs));
      return;
    }

    for (const message of messages) {
      const heartbeat = this.startHeartbeat(queueUrl, message.ReceiptHandle);
      try {
        await this.handleMessage(message);
        await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
      } catch (error) {
        // 삭제하지 않으면 visibility timeout 이후 재전달된다.
        this.logger.error(`message handling failed, left for redelivery: ${String(error)}`);
      } finally {
        clearInterval(heartbeat);
      }
    }

    if (messages.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  private startHeartbeat(queueUrl: string, receiptHandle: string | undefined): NodeJS.Timeout {
    return setInterval(() => {
      this.sqs
        .send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: VISIBILITY_TIMEOUT_SEC }))
        .catch((err: unknown) => this.logger.warn(`visibility extension failed: ${String(err)}`));
    }, this.heartbeatMs);
  }

  private async handleMessage(message: Message): Promise<void> {
    const job = JSON.parse(message.Body ?? "") as AnalyzeSessionJob;
    if (typeof job.sessionId !== "string") throw new Error("message has no sessionId");
    this.logger.log(`received analysis job: sessionId=${job.sessionId}`);
    await this.analysis.run(job.sessionId);
  }
}
```

`MaxNumberOfMessages`를 1로 낮춘 이유: 한 워커가 한 번에 3시간짜리 세션 여러 개를 쥐면 뒤의 것들이 heartbeat 없이 visibility를 넘긴다.

`worker.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { geminiServiceProvider } from "../analysis/gemini.service.js";
import { DbModule } from "../db/db.module.js";
import { QueueModule } from "../queue/queue.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { AnalysisConsumer } from "./analysis.consumer.js";
import { sessionAnalysisServiceProvider } from "./session-analysis.service.js";

@Module({
  imports: [QueueModule, DbModule, StorageModule],
  providers: [geminiServiceProvider, sessionAnalysisServiceProvider, AnalysisConsumer],
})
export class WorkerModule {}
```

`AnalysisConsumer`는 `@Injectable`이고 세 번째 생성자 인자가 숫자라 Nest가 주입하지 못한다 — `heartbeatMs`에 `@Optional()` 데코레이터를 붙이거나, provider를 `{ provide: AnalysisConsumer, useFactory: (sqs, analysis) => new AnalysisConsumer(sqs, analysis), inject: [SQS_CLIENT, SessionAnalysisService] }`로 등록한다. 후자를 택한다 (기존 관례).

- [ ] **Step 8: 인프라 — ffmpeg과 visibility timeout**

`apps/api/Dockerfile`의 `RUN corepack enable` 다음 줄에:

```dockerfile
# 워커가 청크·take를 잘라내는 데 ffmpeg/ffprobe가 필요하다. api 컨테이너도 같은 이미지를 쓴다.
RUN apk add --no-cache ffmpeg
```

`docker/localstack/init-aws.sh`의 `recording-analysis` 큐 생성에 `VisibilityTimeout`을 더한다:

```sh
awslocal sqs create-queue --queue-name recording-analysis --attributes '{"VisibilityTimeout":"300","RedrivePolicy":"{\"deadLetterTargetArn\":\"arn:aws:sqs:ap-northeast-2:000000000000:recording-analysis-dlq\",\"maxReceiveCount\":\"3\"}"}'
```

- [ ] **Step 9: 단위 테스트 전체 통과 확인**

Run: `pnpm --filter @bandapp/api exec vitest run`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/worker apps/api/Dockerfile docker/localstack/init-aws.sh
git commit -m "feat(worker): analyze uploaded sessions in chunks and cut take audio"
```

---

### Task 12: api-client — 계약 확장, 업로드 오케스트레이터, HTTP·Mock 구현

**Files:**
- Modify: `packages/api-client/src/client.ts`
- Create: `packages/api-client/src/upload.ts`, `upload.spec.ts`
- Modify: `packages/api-client/src/http/HttpApiClient.ts`, `HttpApiClient.spec.ts`
- Modify: `packages/api-client/src/mock/MockApiClient.ts`, `mock/seed.ts`
- Modify: `packages/api-client/src/index.ts`

**Interfaces:**
- Consumes: Task 1 타입.
- Produces:

```ts
// client.ts
export interface UploadSource {
  sizeBytes: number;
  /** [start, end) 바이트 범위를 Blob으로 돌려준다. 호출자는 파트마다 한 번 부른다. */
  readPart(range: { start: number; end: number }): Promise<Blob>;
}
export interface UploadProgress { uploadedBytes: number; totalBytes: number }
sessions: {
  list(bandId): Promise<Session[]>;
  get(id): Promise<Session>;
  create(bandId, input: CreateSessionInput): Promise<CreateSessionResult>;
  partUrls(id, partNumbers: number[]): Promise<UploadPartUrl[]>;
  uploadStatus(id): Promise<UploadStatus>;
  completeUpload(id, parts: UploadedPart[]): Promise<Session>;
  retryAnalysis(id): Promise<Session>;
  audioUrl(id): Promise<AudioUrl>;
  /** create → 파트 업로드 → complete를 한 번에. Mock은 진행률만 흉내 낸다. */
  upload(bandId, input: CreateSessionInput, source: UploadSource, onProgress?: (p: UploadProgress) => void): Promise<Session>;
};
takes: { list(sessionId): Promise<Take[]>; audioUrl(takeId): Promise<AudioUrl> };
comments: { list(takeId): Promise<TakeComment[]>; create(takeId, input: CreateCommentInput): Promise<TakeComment> };

// upload.ts
export async function uploadRecording(opts: {
  client: Pick<RehearsalApiClient, "sessions">;
  bandId: string;
  input: CreateSessionInput;
  source: UploadSource;
  fetchFn?: typeof fetch;
  onProgress?: (p: UploadProgress) => void;
  concurrency?: number;   // 기본 2
  attemptsPerPart?: number; // 기본 3
}): Promise<Session>
```

  `CreateSessionInput`과 `CreateCommentInput`은 이제 `@bandapp/types`에서 온다 — `client.ts`의 로컬 정의를 지우고 re-export한다 (`export type { CreateCommentInput, CreateSessionInput } from "@bandapp/types";`).

- [ ] **Step 1: 인터페이스 갱신**

`packages/api-client/src/client.ts`에서 `CreateSessionInput`/`CreateCommentInput` 정의를 지우고 위 `UploadSource`, `UploadProgress`, `sessions/takes/comments` 시그니처로 교체한다. import에 `AudioUrl, CreateCommentInput, CreateSessionInput, CreateSessionResult, UploadPartUrl, UploadStatus, UploadedPart`를 더한다.

- [ ] **Step 2: 실패하는 uploadRecording 테스트**

`packages/api-client/src/upload.spec.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { Session } from "@bandapp/types";
import type { RehearsalApiClient } from "./client";
import { uploadRecording } from "./upload";

const MB = 1024 * 1024;
const session = (status: Session["status"]): Session => ({
  id: "s1", bandId: "b1", title: "Sep 4 Rehearsal", status, startedAt: "2026-09-04T10:00:00.000Z", durationSec: 0, takeCount: 0, commentCount: 0,
});

function fakeClient(partCount: number, uploaded: number[] = []) {
  const calls = { partUrls: [] as number[][], completed: undefined as unknown };
  const sessions = {
    create: vi.fn(async () => ({ session: session("uploading"), upload: { partSize: 10 * MB, partCount } })),
    uploadStatus: vi.fn(async () => ({ partSize: 10 * MB, partCount, uploadedParts: uploaded.map((n) => ({ partNumber: n, etag: `old${n}` })) })),
    partUrls: vi.fn(async (_id: string, numbers: number[]) => {
      calls.partUrls.push(numbers);
      return numbers.map((partNumber) => ({ partNumber, url: `https://r2/part/${partNumber}` }));
    }),
    completeUpload: vi.fn(async (_id: string, parts: unknown) => {
      calls.completed = parts;
      return session("analyzing");
    }),
  };
  return { client: { sessions } as unknown as Pick<RehearsalApiClient, "sessions">, sessions, calls };
}

const source = (sizeBytes: number) => ({
  sizeBytes,
  readPart: vi.fn(async ({ start, end }: { start: number; end: number }) => new Blob([new Uint8Array(end - start)])),
});

const okPut = (etag: string) => new Response(null, { status: 200, headers: { etag: `"${etag}"` } });

describe("uploadRecording", () => {
  it("creates the session, PUTs every part, and completes with the returned ETags", async () => {
    const { client, calls } = fakeClient(3);
    const src = source(25 * MB);
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => okPut(`e${String(url).at(-1)}`));
    const progress: number[] = [];
    const result = await uploadRecording({
      client, bandId: "b1", source: src, fetchFn, onProgress: (p) => progress.push(p.uploadedBytes),
      input: { startedAt: "2026-09-04T19:00:00+09:00", sizeBytes: 25 * MB, contentType: "audio/mp4", source: "import" },
    });
    expect(result.status).toBe("analyzing");
    expect(src.readPart.mock.calls.map((c) => c[0])).toEqual([
      { start: 0, end: 10 * MB },
      { start: 10 * MB, end: 20 * MB },
      { start: 20 * MB, end: 25 * MB },
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(fetchFn.mock.calls[0]![1]).toMatchObject({ method: "PUT" });
    expect(calls.completed).toEqual([
      { partNumber: 1, etag: "e1" },
      { partNumber: 2, etag: "e2" },
      { partNumber: 3, etag: "e3" },
    ]);
    expect(progress.at(-1)).toBe(25 * MB);
  });

  it("skips parts the server already has", async () => {
    const { client, calls } = fakeClient(3, [1, 2]);
    const fetchFn = vi.fn(async () => okPut("e3"));
    await uploadRecording({ client, bandId: "b1", source: source(25 * MB), fetchFn, input: { startedAt: "2026-09-04T19:00:00+09:00", sizeBytes: 25 * MB, contentType: "audio/mp4", source: "import" } });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(calls.partUrls).toEqual([[3]]);
    expect(calls.completed).toEqual([
      { partNumber: 1, etag: "old1" },
      { partNumber: 2, etag: "old2" },
      { partNumber: 3, etag: "e3" },
    ]);
  });

  it("retries a failed part up to attemptsPerPart and then throws", async () => {
    const { client, sessions } = fakeClient(1);
    const fetchFn = vi.fn(async () => new Response(null, { status: 500 }));
    await expect(
      uploadRecording({ client, bandId: "b1", source: source(MB), fetchFn, attemptsPerPart: 3, input: { startedAt: "2026-09-04T19:00:00+09:00", sizeBytes: MB, contentType: "audio/mp4", source: "import" } }),
    ).rejects.toThrow(/part 1/);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sessions.completeUpload).not.toHaveBeenCalled();
  });

  it("recovers when a part succeeds on the second attempt", async () => {
    const { client } = fakeClient(1);
    const fetchFn = vi.fn().mockRejectedValueOnce(new TypeError("network")).mockResolvedValueOnce(okPut("e1"));
    const result = await uploadRecording({ client, bandId: "b1", source: source(MB), fetchFn, input: { startedAt: "2026-09-04T19:00:00+09:00", sizeBytes: MB, contentType: "audio/mp4", source: "import" } });
    expect(result.status).toBe("analyzing");
  });

  it("throws when the PUT response carries no ETag", async () => {
    const { client } = fakeClient(1);
    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
    await expect(
      uploadRecording({ client, bandId: "b1", source: source(MB), fetchFn, attemptsPerPart: 1, input: { startedAt: "2026-09-04T19:00:00+09:00", sizeBytes: MB, contentType: "audio/mp4", source: "import" } }),
    ).rejects.toThrow(/ETag/);
  });

  it("requests part URLs in batches of 100", async () => {
    const { client, calls } = fakeClient(150);
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => okPut(`e${String(url).split("/").at(-1)}`));
    await uploadRecording({ client, bandId: "b1", source: source(1500 * MB), fetchFn, concurrency: 8, input: { startedAt: "2026-09-04T19:00:00+09:00", sizeBytes: 1500 * MB, contentType: "audio/mp4", source: "import" } });
    expect(calls.partUrls.map((b) => b.length)).toEqual([100, 50]);
  });
});
```

- [ ] **Step 3: 실행해서 실패 확인**

Run: `pnpm --filter @bandapp/types build && pnpm --filter @bandapp/api-client exec vitest run src/upload.spec.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 4: uploadRecording 구현**

`packages/api-client/src/upload.ts`:

```ts
import type { CreateSessionInput, Session, UploadedPart } from "@bandapp/types";
import type { RehearsalApiClient, UploadProgress, UploadSource } from "./client";

const URL_BATCH = 100;

export interface UploadRecordingOptions {
  client: Pick<RehearsalApiClient, "sessions">;
  bandId: string;
  input: CreateSessionInput;
  source: UploadSource;
  fetchFn?: typeof fetch;
  onProgress?: (p: UploadProgress) => void;
  /** 동시에 올리는 파트 수. 기본 2 — 모바일 회선에서 더 올려도 총 처리량은 거의 늘지 않는다. */
  concurrency?: number;
  attemptsPerPart?: number;
}

/**
 * create → (이미 올라간 파트 제외) presigned PUT → complete. 순수 함수라 Node 스크립트와
 * 모바일이 같은 코드를 쓴다 (스펙 결정 15). 파트 하나가 attemptsPerPart번 실패하면 throw하고
 * 세션은 uploading으로 남는다 — 같은 세션에 대해 다시 부르면 uploadStatus로 이어 올린다.
 */
export async function uploadRecording(opts: UploadRecordingOptions): Promise<Session> {
  const fetchFn = opts.fetchFn ?? fetch;
  const concurrency = opts.concurrency ?? 2;
  const attempts = opts.attemptsPerPart ?? 3;
  const { sessions } = opts.client;

  const { session, upload } = await sessions.create(opts.bandId, opts.input);
  return resumeUpload({ ...opts, fetchFn, concurrency, attempts, sessionId: session.id, partSize: upload.partSize, partCount: upload.partCount });
}

interface ResumeArgs extends UploadRecordingOptions {
  fetchFn: typeof fetch;
  concurrency: number;
  attempts: number;
  sessionId: string;
  partSize: number;
  partCount: number;
}

async function resumeUpload(a: ResumeArgs): Promise<Session> {
  const { sessions } = a.client;
  const status = await sessions.uploadStatus(a.sessionId);
  const done = new Map(status.uploadedParts.map((p) => [p.partNumber, p.etag]));
  const total = a.source.sizeBytes;
  let uploadedBytes = [...done.keys()].reduce((sum, n) => sum + partLength(n, a.partSize, total), 0);
  a.onProgress?.({ uploadedBytes, totalBytes: total });

  const pending = Array.from({ length: a.partCount }, (_, i) => i + 1).filter((n) => !done.has(n));
  const urls = new Map<number, string>();
  for (let i = 0; i < pending.length; i += URL_BATCH) {
    for (const { partNumber, url } of await sessions.partUrls(a.sessionId, pending.slice(i, i + URL_BATCH))) {
      urls.set(partNumber, url);
    }
  }

  const queue = [...pending];
  const worker = async () => {
    for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
      const url = urls.get(n);
      if (!url) throw new Error(`no upload URL for part ${n}`);
      const etag = await putPart(a, n, url);
      done.set(n, etag);
      uploadedBytes += partLength(n, a.partSize, total);
      a.onProgress?.({ uploadedBytes, totalBytes: total });
    }
  };
  await Promise.all(Array.from({ length: Math.min(a.concurrency, pending.length) }, worker));

  const parts: UploadedPart[] = [...done.entries()].map(([partNumber, etag]) => ({ partNumber, etag })).sort((x, y) => x.partNumber - y.partNumber);
  return sessions.completeUpload(a.sessionId, parts);
}

function partLength(partNumber: number, partSize: number, total: number): number {
  const start = (partNumber - 1) * partSize;
  return Math.min(partSize, total - start);
}

async function putPart(a: ResumeArgs, partNumber: number, url: string): Promise<string> {
  const start = (partNumber - 1) * a.partSize;
  const end = Math.min(start + a.partSize, a.source.sizeBytes);
  let lastError: unknown;
  for (let attempt = 1; attempt <= a.attempts; attempt++) {
    try {
      const body = await a.source.readPart({ start, end });
      const res = await a.fetchFn(url, { method: "PUT", body });
      if (!res.ok) throw new Error(`part ${partNumber} upload failed with HTTP ${res.status}`);
      const etag = res.headers.get("etag");
      if (!etag) throw new Error(`part ${partNumber} upload returned no ETag`);
      return etag.replace(/^"|"$/g, "");
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`part ${partNumber} upload failed`);
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `pnpm --filter @bandapp/api-client exec vitest run src/upload.spec.ts`
Expected: PASS

- [ ] **Step 6: HttpApiClient 실구현**

`HttpApiClient.ts`에서 `fallback` 옵션·필드·`MockApiClient` import·`subscribe`의 `unsubFallback`·세 개의 getter를 지우고 아래로 교체한다. import에 `uploadRecording`(`../upload`)과 `UploadProgress, UploadSource`(`../client`)를 더한다.

```ts
  sessions = {
    list: (bandId: string): Promise<Session[]> => this.request<Session[]>("GET", `/bands/${bandId}/sessions`),
    get: (id: string): Promise<Session> => this.request<Session>("GET", `/sessions/${id}`),
    create: async (bandId: string, input: CreateSessionInput): Promise<CreateSessionResult> => {
      const result = await this.request<CreateSessionResult>("POST", `/bands/${bandId}/sessions`, input);
      this.emit();
      return result;
    },
    partUrls: (id: string, partNumbers: number[]): Promise<UploadPartUrl[]> =>
      this.request<UploadPartUrl[]>("POST", `/sessions/${id}/upload/parts`, { partNumbers }),
    uploadStatus: (id: string): Promise<UploadStatus> => this.request<UploadStatus>("GET", `/sessions/${id}/upload`),
    completeUpload: async (id: string, parts: UploadedPart[]): Promise<Session> => {
      const session = await this.request<Session>("POST", `/sessions/${id}/upload/complete`, { parts });
      this.emit();
      return session;
    },
    retryAnalysis: async (id: string): Promise<Session> => {
      const session = await this.request<Session>("POST", `/sessions/${id}/retry`);
      this.emit();
      return session;
    },
    audioUrl: (id: string): Promise<AudioUrl> => this.request<AudioUrl>("GET", `/sessions/${id}/audio`),
    upload: (bandId: string, input: CreateSessionInput, source: UploadSource, onProgress?: (p: UploadProgress) => void): Promise<Session> =>
      // presigned URL로의 PUT은 API 서버가 아니라 R2로 가므로 Authorization 없이 fetchFn을 그대로 쓴다
      uploadRecording({ client: this, bandId, input, source, fetchFn: this.fetchFn, onProgress }),
  };

  takes = {
    list: (sessionId: string): Promise<Take[]> => this.request<Take[]>("GET", `/sessions/${sessionId}/takes`),
    audioUrl: (takeId: string): Promise<AudioUrl> => this.request<AudioUrl>("GET", `/takes/${takeId}/audio`),
  };

  comments = {
    list: (takeId: string): Promise<TakeComment[]> => this.request<TakeComment[]>("GET", `/takes/${takeId}/comments`),
    create: async (takeId: string, input: CreateCommentInput): Promise<TakeComment> => {
      const comment = await this.request<TakeComment>("POST", `/takes/${takeId}/comments`, input);
      this.emit();
      return comment;
    },
  };
```

`HttpApiClient.spec.ts`에 케이스 추가:

```ts
  it("sessions.create는 밴드 경로로 POST하고 구독자에게 알린다", async () => {
    const tokens = memoryTokens({ accessToken: "a1" });
    const fetchFn = vi.fn(async () => json(201, { session: { id: "s1" }, upload: { partSize: 1, partCount: 1 } }));
    const client = new HttpApiClient({ baseUrl: "https://api.test", tokens, fetchFn });
    const listener = vi.fn();
    client.subscribe(listener);
    await client.sessions.create("b1", { startedAt: "2026-09-04T19:00:00+09:00", sizeBytes: 1, contentType: "audio/mp4", source: "import" });
    expect(fetchFn).toHaveBeenCalledWith("https://api.test/bands/b1/sessions", expect.objectContaining({ method: "POST" }));
    expect(listener).toHaveBeenCalled();
  });

  it("comments.create는 takes 경로로 POST한다", async () => {
    const tokens = memoryTokens({ accessToken: "a1" });
    const fetchFn = vi.fn(async () => json(201, { id: "c1" }));
    const client = new HttpApiClient({ baseUrl: "https://api.test", tokens, fetchFn });
    await client.comments.create("t1", { atSec: 3, text: "x" });
    expect(fetchFn).toHaveBeenCalledWith("https://api.test/takes/t1/comments", expect.objectContaining({ method: "POST", body: JSON.stringify({ atSec: 3, text: "x" }) }));
  });
```

- [ ] **Step 7: MockApiClient 갱신**

`MockApiClient.ts`의 `sessions`/`takes`/`comments`를 새 시그니처에 맞춘다:

```ts
  sessions = {
    list: async (bandId: string): Promise<Session[]> =>
      this.state.sessions.filter((s) => s.bandId === bandId).slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    get: async (id: string): Promise<Session> => ({ ...this.mustSession(id) }),
    create: async (bandId: string, input: CreateSessionInput): Promise<CreateSessionResult> => {
      const startedAt = new Date(input.startedAt);
      const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const s: Session = {
        id: `g${this.nextId++}`,
        bandId,
        title: `${MONTHS[startedAt.getMonth()]} ${startedAt.getDate()} Rehearsal`,
        status: "uploading",
        startedAt: input.startedAt,
        durationSec: Math.round((input.durationMs ?? 0) / 1000),
        takeCount: 0,
        commentCount: 0,
      };
      this.state.sessions.unshift(s);
      this.emit();
      const partSize = 10 * 1024 * 1024;
      return { session: { ...s }, upload: { partSize, partCount: Math.max(1, Math.ceil(input.sizeBytes / partSize)) } };
    },
    partUrls: async (id: string, partNumbers: number[]): Promise<UploadPartUrl[]> =>
      partNumbers.map((partNumber) => ({ partNumber, url: `https://mock.upload/${id}/${partNumber}` })),
    uploadStatus: async (): Promise<UploadStatus> => ({ partSize: 10 * 1024 * 1024, partCount: 1, uploadedParts: [] }),
    completeUpload: async (id: string): Promise<Session> => {
      const s = this.mustSession(id);
      s.status = "analyzing";
      // 가져오기는 길이를 모른 채 들어온다 — 45분 세션이었다고 치고 take 개수를 정한다
      if (s.durationSec === 0) s.durationSec = 2717;
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
    audioUrl: async (): Promise<AudioUrl> => ({ url: "", expiresAt: week() }),
    upload: async (bandId: string, input: CreateSessionInput, source: UploadSource, onProgress?: (p: UploadProgress) => void): Promise<Session> => {
      const { session } = await this.sessions.create(bandId, input);
      // 실제 PUT 없이 진행률만 흘려보낸다 — 화면이 업로드 단계를 그리게 하려는 것
      for (let i = 1; i <= 5; i++) {
        await new Promise((r) => setTimeout(r, 150));
        onProgress?.({ uploadedBytes: Math.round((source.sizeBytes * i) / 5), totalBytes: source.sizeBytes });
      }
      return this.sessions.completeUpload(session.id);
    },
  };

  takes = {
    list: async (sessionId: string): Promise<Take[]> => (this.state.takes[sessionId] ?? []).map((t) => ({ ...t })),
    audioUrl: async (): Promise<AudioUrl> => ({ url: "", expiresAt: week() }),
  };

  comments = {
    list: async (takeId: string): Promise<TakeComment[]> => (this.state.comments[takeId] ?? []).slice().sort((a, b) => a.atSec - b.atSec),
    create: async (takeId: string, input: CreateCommentInput): Promise<TakeComment> => {
      const c: TakeComment = {
        id: `u${this.nextId++}`,
        takeId,
        authorId: MOCK_USER.id,
        authorName: "You",
        parentId: null,
        atSec: Math.floor(input.atSec),
        text: input.text,
        createdAt: new Date().toISOString(),
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
```

`mock/seed.ts`의 `generateTakes`가 `Take`의 새 필드를 채우도록 바꾼다 (`startMs`/`endMs`는 이전 take 끝에서 이어지게, `type`은 `"PERFORMANCE"`):

```ts
export function generateTakes(sessionId: string, count: number): Take[] {
  const seed = seedOf(sessionId);
  let cursorMs = 60_000;
  return Array.from({ length: count }, (_, i) => {
    const durationSec = 180 + Math.floor(seededUnit(seed * 91 + i * 17) * 150);
    const startMs = cursorMs;
    cursorMs += durationSec * 1000 + 45_000;
    return { id: `${sessionId}-t${i}`, sessionId, index: i, name: `Take ${i + 1}`, durationSec, startMs, endMs: startMs + durationSec * 1000, type: "PERFORMANCE" as const, commentCount: 0 };
  });
}
```

`scheduleAnalysis`에서 `t.durationSec`를 덮어쓰는 곳은 `t.endMs = t.startMs + t.durationSec * 1000`도 함께 갱신한다. `SEED_COMMENTS`를 `TakeComment`로 만드는 곳에 `authorId: "m2"`, `parentId: null`, `createdAt: new Date(startedAt).toISOString()` 같은 값을 채운다 (임의의 고정 문자열이면 된다).

`index.ts`에 `export { uploadRecording } from "./upload"; export type { UploadRecordingOptions } from "./upload";`를 추가한다.

- [ ] **Step 8: 빌드·테스트 통과 확인**

Run: `pnpm --filter @bandapp/api-client build && pnpm --filter @bandapp/api-client test`
Expected: PASS. `MockApiClient.test.ts`가 옛 `create(bandId, { durationSec, source })` 시그니처를 쓰고 있으면 `create(bandId, { startedAt: new Date().toISOString(), durationMs: 4_620_000, sizeBytes: 1, contentType: "audio/mp4", source: "recording" })` 뒤 `completeUpload(id)`로 고친다.

- [ ] **Step 9: Commit**

```bash
git add packages/api-client
git commit -m "feat(api-client): implement sessions, takes, comments, and a resumable multipart uploader"
```

---

### Task 13: 라이브 검증 스크립트, env·문서, 백로그

**Files:**
- Create: `apps/api/scripts/upload-session.ts`
- Modify: `apps/api/package.json` (`tsx`, `@bandapp/api-client` devDependency, `upload-session` 스크립트)
- Modify: `.env.example`, `README.md`
- Create: `docs/backlog.md`

**Interfaces:**
- Consumes: `uploadRecording`, `HttpApiClient` (Task 12), `POST /auth/dev` (Task 6).

- [ ] **Step 1: 의존성과 스크립트 등록**

Run: `pnpm --filter @bandapp/api add -D tsx @bandapp/api-client@workspace:*`

`apps/api/package.json` scripts에 추가:

```json
    "upload-session": "tsx scripts/upload-session.ts"
```

- [ ] **Step 2: 스크립트 작성**

`apps/api/scripts/upload-session.ts`:

```ts
/**
 * Windows에서 서버 전 구간을 실제 R2·Gemini로 검증한다 (스펙 "검증 스크립트").
 *
 *   UPLOAD_FILE=poc/data/raw_sessions/IMG_2811.m4a API_URL=http://localhost:3001 DEV_LOGIN_SECRET=... \
 *     pnpm --filter @bandapp/api upload-session
 *
 * dev 로그인 → 밴드 확보 → multipart 업로드 → ready/failed까지 폴링 → takes 출력 → 첫 take를 내려받아 ffprobe.
 */
import { execFile } from "node:child_process";
import { open, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { HttpApiClient, uploadRecording, type TokenStorage } from "@bandapp/api-client";
import type { AuthTokens } from "@bandapp/types";

const execFileAsync = promisify(execFile);

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function memoryTokens(): TokenStorage {
  let tokens: AuthTokens | null = null;
  return {
    getAccessToken: async () => tokens?.accessToken ?? null,
    getRefreshToken: async () => tokens?.refreshToken ?? null,
    setTokens: async (t) => {
      tokens = t;
    },
    clear: async () => {
      tokens = null;
    },
  };
}

async function main(): Promise<void> {
  const apiUrl = env("API_URL", "http://localhost:3001");
  const file = resolve(env("UPLOAD_FILE"));
  const secret = env("DEV_LOGIN_SECRET");
  const tokens = memoryTokens();
  const client = new HttpApiClient({ baseUrl: apiUrl, tokens });

  const loginRes = await fetch(`${apiUrl}/auth/dev`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret, displayName: "Dongjin (script)" }),
  });
  if (!loginRes.ok) throw new Error(`dev login failed: ${loginRes.status} ${await loginRes.text()}`);
  const login = (await loginRes.json()) as AuthTokens;
  await tokens.setTokens({ accessToken: login.accessToken, refreshToken: login.refreshToken });

  const bands = await client.bands.list();
  const band = bands[0] ?? (await client.bands.create("Script Band"));
  console.log(`band ${band.id} (${band.name})`);

  const { size } = await stat(file);
  const handle = await open(file, "r");
  try {
    const started = Date.now();
    const session = await uploadRecording({
      client,
      bandId: band.id,
      input: { startedAt: new Date().toISOString(), sizeBytes: size, contentType: "audio/mp4", source: "import" },
      source: {
        sizeBytes: size,
        readPart: async ({ start, end }) => {
          const buf = Buffer.alloc(end - start);
          await handle.read(buf, 0, end - start, start);
          return new Blob([buf]);
        },
      },
      onProgress: (p) => process.stdout.write(`\rupload ${Math.round((p.uploadedBytes / p.totalBytes) * 100)}%   `),
    });
    console.log(`\nuploaded in ${((Date.now() - started) / 1000).toFixed(1)}s → session ${session.id} ${session.status}`);

    let current = session;
    const analysisStarted = Date.now();
    while (current.status === "analyzing" || current.status === "uploading") {
      await new Promise((r) => setTimeout(r, 5000));
      current = await client.sessions.get(session.id);
      process.stdout.write(`\ranalyzing… ${Math.round((Date.now() - analysisStarted) / 1000)}s   `);
    }
    console.log(`\nsession ${current.status}: ${current.takeCount} takes, ${current.durationSec}s`);
    if (current.status === "failed") {
      throw new Error("analysis failed — check the worker logs (docker compose logs worker)");
    }

    const takes = await client.takes.list(session.id);
    for (const t of takes) {
      console.log(`  #${t.index + 1} ${t.name}  ${fmt(t.startMs)} → ${fmt(t.endMs)}  (${t.durationSec}s, ${t.type})`);
    }
    if (takes[0]) {
      const { url } = await client.takes.audioUrl(takes[0].id);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`take download failed: ${res.status}`);
      const out = join(tmpdir(), `take-${takes[0].id}.m4a`);
      await writeFile(out, Buffer.from(await res.arrayBuffer()));
      const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out]);
      console.log(`first take downloaded to ${out}, ffprobe duration ${Number(stdout).toFixed(1)}s`);
    }
  } finally {
    await handle.close();
  }
}

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: env·README**

`.env.example`:
- `STORAGE_PROVIDER=r2` 줄과 `R2_ENDPOINT=` 줄을 지운다 (엔드포인트는 계정 ID에서 유도되고 `R2_ENDPOINT`는 override 전용이라 example에 두지 않는다).
- R2 블록 위 주석을 바꾼다: `# Cloudflare R2 (버킷 taken-rehearsal-dev). 토큰은 대시보드 > R2 > Manage API Tokens에서 Object Read & Write로 발급한다.`
- 아래를 추가:

```
# dev 로그인 (POST /auth/dev). 설정돼 있고 NODE_ENV가 production이 아닐 때만 열린다. 비우면 라우트가 404다.
DEV_LOGIN_SECRET=
```

`.env`에도 `DEV_LOGIN_SECRET`을 채운다 (`openssl rand -hex 16`).

`README.md`의 "로컬 개발 환경" 분석 요청 줄을 교체한다:

```markdown
- 분석 파이프라인: 세션 생성(`POST /bands/:bandId/sessions`) → presigned multipart 업로드 → `POST /sessions/:id/upload/complete` → SQS → worker(R2 다운로드 → ffmpeg 청크 → Gemini → take 절단 → R2 업로드 → DB). `.env`에 `GEMINI_API_KEY`, `R2_*`, `DEV_LOGIN_SECRET`이 필요하다.
- 서버 전 구간 검증(Windows): `UPLOAD_FILE=poc/data/raw_sessions/IMG_2811.m4a DEV_LOGIN_SECRET=<.env 값> pnpm --filter @bandapp/api upload-session` → 업로드 진행률, 분석 대기, take 목록, 첫 take ffprobe 길이가 순서대로 찍힌다. 워커 로그는 `docker compose logs -f worker`.
- Dockerfile에 ffmpeg이 추가됐고 큐 visibility timeout이 바뀌었으니 기존 체크아웃은 `docker compose up --build -V`로 재빌드하고 localstack 볼륨도 새로 만든다 (`docker compose down -v` 후 up).
```

- [ ] **Step 4: 백로그 문서**

`docs/backlog.md`:

```markdown
# 백로그

이번 스펙([2026-09-04](superpowers/specs/2026-09-04-upload-analysis-takes-feedback-design.md))에서 의도적으로 미룬 것. 각 항목은 자기 스펙을 받아 진행한다.

## 업로드·녹음
- **가져오기 원본 업로드 + 서버 변환.** wav·영상 등 원본을 그대로 올리고 워커가 ffmpeg으로 m4a로 바꾼다. `recordings`가 세션당 원본·변환본 두 행을 갖게 된다.
- **앱 종료 후 업로드 재개.** `{ sessionId, fileUri }`를 로컬에 남기고, 세션 목록의 `uploading` 행을 눌러 이어 올린다. 서버 `GET /sessions/:id/upload`(ListParts)는 준비돼 있다.
- **3시간 백그라운드 녹음 안정성.** 백그라운드 오디오 모드, 중단(전화·앱 종료) 복구, 저장 공간 부족 처리.
- **녹음 중 `+MARK`를 분석 힌트로.** 마크 타임스탬프를 세션에 저장하고 Gemini 프롬프트·병합에 반영.

## 분석
- **검출기 전처리(Python 워커).** POC의 YAMNet/PANNs 등으로 음악 구간 후보를 먼저 뽑아 `planChunks()`를 "후보 구간 목록"으로 교체. Gemini 토큰과 시간을 줄인다. 모델 선정이 선행돼야 한다.
- **gap-merge 옵션.** 떨어진 후보를 N초 이내면 합치는 규칙. 지금은 Gemini 프롬프트가 담당한다.
- **Take 경계 편집.** 사용자가 start/end를 고치면 take 파일을 다시 잘라 올린다.

## 재생·피드백
- **실제 파형.** 워커가 take별 피크 배열을 만들어 저장하고 앱이 그린다. 지금은 시드 기반 가짜 파형.
- **대댓글 UI·작성.** `comments.parent_id`와 `TakeComment.parentId`는 준비됨. 스레드 표시와 답글 입력이 남았다.
- **원본 녹음에 대한 코멘트.** `comments.take_id`를 nullable로 바꾸고 `session_id`를 더한다.

## 운영
- **세션 삭제 API와 R2 객체 정리.** 세션을 지울 때 원본·take 객체를 함께 지운다.
- **만료된 multipart 업로드.** 버킷 수명주기 규칙이 7일 뒤 자동 중단한다. `recordings.upload_status=pending`으로 남은 행을 같이 정리하는 배치가 필요하다.
- **Gemini 파일 정리 실패 재시도.** 지금은 경고 로그만 남긴다.
```

- [ ] **Step 5: 전체 테스트**

Run: `pnpm build && pnpm test`
Expected: types/api-client/api(unit+e2e)/mobile 전부 PASS. e2e는 docker postgres 필요.

- [ ] **Step 6: 라이브 검증**

사용자가 `.env`에 R2 토큰과 `DEV_LOGIN_SECRET`을 넣은 뒤:

```bash
docker compose up --build -V -d
```

```bash
UPLOAD_FILE=poc/data/raw_sessions/IMG_2811.m4a DEV_LOGIN_SECRET=$(grep ^DEV_LOGIN_SECRET= .env | cut -d= -f2) pnpm --filter @bandapp/api upload-session
```

Expected: 업로드 100% → `analyzing…` 수 분 → `session ready: N takes` → take 목록 → `first take downloaded ... ffprobe duration ...s`. 워커 로그(`docker compose logs -f worker`)에 `session <id>: N takes from 3 chunks`. R2 대시보드 Objects에 `bands/<bandId>/sessions/<id>/original.m4a`와 `takes/*.m4a`.

실패하면 워커 로그의 오류를 보고 `POST /sessions/:id/retry`(스크립트가 실패 세션을 만들면 `client.sessions.retryAnalysis`) 또는 원인 수정 후 재실행한다.

- [ ] **Step 7: Commit**

```bash
git add apps/api/scripts apps/api/package.json pnpm-lock.yaml .env.example README.md docs/backlog.md
git commit -m "feat(api): add an end-to-end upload verification script and record the backlog"
```

## 자체 검토 결과

- 스펙 API 계약 전부: Task 6·7·8·9. 워커 파이프라인·visibility·멱등성: Task 11. StorageService·CORS: Task 4(코드), 대시보드(완료). 업로드 오케스트레이터·Mock: Task 12. dev 로그인·스크립트: Task 6·13. 백로그: Task 13.
- 이름 일치: `loadForMember`(SessionsService·TakesService), `PRESIGN_EXPIRES_SEC`, `takeKey`/`originalKey`, `analyzeFile`, `enqueueAnalysis(sessionId)`, `FakeStorage`/`FakeProducer`, `UploadSource.readPart({ start, end })`가 task 간 동일하다.
- 스펙과의 차이 하나: `RehearsalApiClient.sessions.upload()`를 추가했다. 스펙은 순수 함수 `uploadRecording`만 말했지만, Mock 모드에서 화면이 같은 코드 경로를 타려면 클라이언트 인터페이스에 진입점이 필요했다. `uploadRecording`은 그대로 있고 HttpApiClient가 그것을 호출한다.
