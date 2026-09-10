# 업로드 재개·캐시 정리 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 끊긴 업로드를 세션 목록의 `uploading` 행에서 이어 올리고, 업로드가 끝난 녹음·가져오기 파일이 캐시에 남지 않게 한다.

**Architecture:** 앱이 `documentDirectory/uploads/`에 파일을 옮기고 `pending.json`에 `{sessionId, fileUri, …}` 레코드를 남긴다. api-client의 `uploadRecording`이 create 직후 `onCreated(sessionId)`를 불러 레코드를 기록할 시점을 주고, 새 `sessions.resumeUpload`가 이어 올리기를 담당한다(Http는 `resumeRecordingUpload`, Mock은 진행률만 흉내). `useUploadSession`이 첫 업로드/재개 두 모드를 갖고, 오류→상태 매핑은 순수 함수 `classifyUploadFailure`로 뺀다. 스토어는 파일 시스템 어댑터를 주입받아 메모리 구현으로 테스트한다.

**Tech Stack:** TypeScript, vitest, expo-file-system/legacy, expo-router(`useFocusEffect`), pnpm workspace(`@bandapp/api-client`는 `dist`로 소비 — 수정 후 반드시 `pnpm --filter @bandapp/api-client build`).

스펙: [docs/superpowers/specs/2026-09-10-upload-resume-design.md](../specs/2026-09-10-upload-resume-design.md)

## Global Constraints

- 서버(`apps/api`) 변경 없음. 새 npm 의존성 없음.
- 레코드 저장 위치: `documentDirectory + "uploads/"` 아래 `pending.json`(sessionId → 레코드 맵)과 `<name>.m4a`.
- `PendingUpload = { sessionId: string; bandId: string; fileUri: string; source: "recording" | "import"; createdAt: string }`.
- 스토어 메서드(`stage` 제외)는 절대 throw하지 않는다 — try/catch 후 `console.warn("[pendingUploads] …")`. `stage`만 throw하고 호출자가 원래 URI로 진행한다.
- 클라이언트 인터페이스: `sessions.upload(bandId, input, source, onProgress?, onCreated?)`, `sessions.resumeUpload(id, source, onProgress?)`.
- 화면 문구(정확히): `"Tap to continue uploading"`, `"Uploading…"`, `"This upload was started on another device"`, `"Resuming upload… N%"`, `"Recording file is missing"`, `"This session no longer exists"`, `"Couldn’t resume the upload — check your connection and try again"`, `"Back to sessions"`. 기존 문구(`"Couldn’t upload this recording — check your connection and try again"` 등)는 그대로.
- 재개 오류 분기(스펙 결정 6): 파일/레코드 없음 → discard·재시도 불가, `ApiError` 404 → discard·재시도 불가, `ApiError` 409 → discard 후 `sessions.get`으로 합류, 그 외 → 레코드 유지·재시도 가능.
- 코드 주석은 한국어, 커밋 제목은 영어 conventional commit, 커밋 트레일러 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- 모바일 테스트는 순수 vitest(`pnpm --filter @bandapp/mobile test`) — `react-native`·`expo-*`를 import하는 모듈은 테스트에서 import하지 않는다. 타입 검사 `pnpm --filter @bandapp/mobile typecheck`.

---

## File Structure

| 파일 | 책임 |
|---|---|
| `packages/api-client/src/upload.ts` | `onCreated` 옵션 |
| `packages/api-client/src/client.ts` | `sessions.upload` 5번째 인자, `sessions.resumeUpload` 추가 |
| `packages/api-client/src/http/HttpApiClient.ts`, `mock/MockApiClient.ts` | 두 메서드 구현 |
| `apps/mobile/src/features/upload/uploadErrors.ts` | `MissingUploadFileError` (RN import 없음) |
| `apps/mobile/src/features/upload/createPendingUploads.ts` | 순수 스토어 팩토리 + `createMemoryFs` |
| `apps/mobile/src/features/upload/pendingUploads.ts` | Platform에 따라 expo fs/메모리 fs를 물린 싱글턴 |
| `apps/mobile/src/features/upload/classifyUploadFailure.ts` | 오류 → `{ message, discard, retryable, refetch }` |
| `apps/mobile/src/features/upload/useUploadSession.ts` | 첫 업로드/재개 훅 |
| `apps/mobile/src/features/upload/usePendingUploadIds.ts` | 목록 화면용 레코드 id 집합 + prune |
| `apps/mobile/src/features/upload/readFilePart.ts` | 파일 없음을 `MissingUploadFileError`로 |
| `apps/mobile/src/features/recording/ProcessingScreen.tsx` | `sessionId` 파라미터, 재개 캡션, `retryable` |
| `apps/mobile/src/features/sessions/SessionsScreen.tsx`, `SessionRow.tsx` | resumable 행, 탭 라우팅 |
| `apps/mobile/app/_layout.tsx` | 시작 시 `sweepOrphans()` |
| `README.md`, `docs/backlog.md` | 문서 |

---

### Task 1: api-client — `onCreated` 콜백과 `sessions.resumeUpload`

**Files:**
- Modify: `packages/api-client/src/upload.ts`
- Modify: `packages/api-client/src/client.ts:83-99`
- Modify: `packages/api-client/src/http/HttpApiClient.ts:269-271`
- Modify: `packages/api-client/src/mock/MockApiClient.ts:283-291`
- Test: `packages/api-client/src/upload.spec.ts`, `packages/api-client/src/mock/MockApiClient.test.ts`

**Interfaces:**
- Produces: `UploadRecordingOptions.onCreated?: (sessionId: string) => Promise<void>`; `RehearsalApiClient.sessions.upload(bandId, input, source, onProgress?, onCreated?)`; `RehearsalApiClient.sessions.resumeUpload(id: string, source: UploadSource, onProgress?: (p: UploadProgress) => void): Promise<Session>`.

- [ ] **Step 1: upload.spec.ts에 실패 테스트 2개 추가** (`describe("uploadRecording")` 안, 기존 `fakeClient`·`source`·`okPut` 재사용)

```ts
  it("calls onCreated with the session id after create and before the first part PUT", async () => {
    const { client, sessions } = fakeClient(1);
    const order: string[] = [];
    const fetchFn = vi.fn(async () => { order.push("put"); return okPut("e1"); });
    await uploadRecording({
      client, bandId: "b1", source: source(MB), fetchFn,
      onCreated: async (id) => { order.push(`created:${id}`); },
      input: { startedAt: "2026-09-04T19:00:00+09:00", sizeBytes: MB, contentType: "audio/mp4", source: "recording" },
    });
    expect(sessions.create).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["created:s1", "put"]);
  });

  it("wraps an onCreated failure in UploadRecordingError and uploads no parts", async () => {
    const { client, sessions } = fakeClient(1);
    const fetchFn = vi.fn(async () => okPut("e1"));
    const err = await uploadRecording({
      client, bandId: "b1", source: source(MB), fetchFn,
      onCreated: async () => { throw new Error("disk full"); },
      input: { startedAt: "2026-09-04T19:00:00+09:00", sizeBytes: MB, contentType: "audio/mp4", source: "recording" },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadRecordingError);
    expect((err as UploadRecordingError).sessionId).toBe("s1");
    expect((err as UploadRecordingError).message).toBe("disk full");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(sessions.completeUpload).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: MockApiClient.test.ts에 실패 테스트 2개 추가** (`describe("MockApiClient")` 안; 파일 상단의 `BAND`, `wait` 재사용)

```ts
  it("upload calls onCreated with the new session id before finishing", async () => {
    const api = new MockApiClient({ analysisDelayMs: 10 });
    const seen: string[] = [];
    const source = { sizeBytes: 5, readPart: async () => new Uint8Array(1) };
    const done = await api.sessions.upload(
      BAND,
      { startedAt: new Date().toISOString(), durationMs: 60_000, sizeBytes: 5, contentType: "audio/mp4", source: "recording" },
      source,
      undefined,
      async (id) => { seen.push(id); },
    );
    expect(seen).toEqual([done.id]);
    expect(done.status).toBe("analyzing");
  });

  it("resumeUpload reports progress and completes an uploading session", async () => {
    const api = new MockApiClient({ analysisDelayMs: 10 });
    const { session: created } = await api.sessions.create(BAND, {
      startedAt: new Date().toISOString(), durationMs: 60_000, sizeBytes: 100, contentType: "audio/mp4", source: "recording",
    });
    const progress: number[] = [];
    const source = { sizeBytes: 100, readPart: async () => new Uint8Array(1) };
    const done = await api.sessions.resumeUpload(created.id, source, (p) => progress.push(p.uploadedBytes));
    expect(done.id).toBe(created.id);
    expect(done.status).toBe("analyzing");
    expect(progress.at(-1)).toBe(100);
    await expect(api.sessions.resumeUpload("nope", source)).rejects.toThrow();
  });
```

- [ ] **Step 3: 실패 확인**

Run: `pnpm --filter @bandapp/api-client test`
Expected: 새 테스트 4개 FAIL (`onCreated` 미호출, `resumeUpload is not a function`), 나머지 PASS.

- [ ] **Step 4: `upload.ts` — `onCreated` 옵션**

`UploadRecordingOptions`에 추가:
```ts
  /**
   * create가 끝나 sessionId가 생긴 직후, 첫 파트 PUT 전에 호출한다. 앱이 "이어 올리기" 레코드를
   * 남기는 시점이다 (2026-09-10 업로드 재개 스펙 결정 4). 던지면 UploadRecordingError로 감싼다.
   */
  onCreated?: (sessionId: string) => Promise<void>;
```
`uploadRecording`의 try 블록을 이렇게 바꾼다:
```ts
  const { session } = await sessions.create(opts.bandId, opts.input);
  try {
    await opts.onCreated?.(session.id);
    return await resumeUpload({
      client: opts.client,
      source: opts.source,
      fetchFn: opts.fetchFn ?? fetch,
      onProgress: opts.onProgress,
      concurrency: opts.concurrency ?? 2,
      attempts: opts.attemptsPerPart ?? 3,
      sessionId: session.id,
    });
  } catch (err) {
    throw new UploadRecordingError(err instanceof Error ? err.message : String(err), session.id, err);
  }
```

- [ ] **Step 5: `client.ts` 인터페이스**

`sessions.upload` 시그니처를 다음으로 바꾸고 `resumeUpload`를 추가한다:
```ts
    /** create → 파트 업로드 → complete를 한 번에. onCreated는 create 직후 sessionId를 준다. Mock은 진행률만 흉내 낸다. */
    upload(
      bandId: string,
      input: CreateSessionInput,
      source: UploadSource,
      onProgress?: (p: UploadProgress) => void,
      onCreated?: (sessionId: string) => Promise<void>,
    ): Promise<Session>;
    /** 이미 create된 uploading 세션의 남은 파트를 올리고 complete한다 (앱 종료 후 이어 올리기). */
    resumeUpload(id: string, source: UploadSource, onProgress?: (p: UploadProgress) => void): Promise<Session>;
```

- [ ] **Step 6: `HttpApiClient.ts`**

```ts
    upload: (bandId: string, input: CreateSessionInput, source: UploadSource, onProgress?: (p: UploadProgress) => void, onCreated?: (sessionId: string) => Promise<void>): Promise<Session> =>
      // presigned URL로의 PUT은 API 서버가 아니라 R2로 가므로 Authorization 없이 fetchFn을 그대로 쓴다
      uploadRecording({ client: this, bandId, input, source, fetchFn: this.fetchFn, onProgress, onCreated }),
    resumeUpload: (id: string, source: UploadSource, onProgress?: (p: UploadProgress) => void): Promise<Session> =>
      resumeRecordingUpload({ client: this, sessionId: id, source, fetchFn: this.fetchFn, onProgress }),
```
import 줄을 `import { resumeRecordingUpload, uploadRecording } from "../upload";`로.

- [ ] **Step 7: `MockApiClient.ts`**

```ts
    upload: async (bandId: string, input: CreateSessionInput, source: UploadSource, onProgress?: (p: UploadProgress) => void, onCreated?: (sessionId: string) => Promise<void>): Promise<Session> => {
      const { session } = await this.sessions.create(bandId, input);
      await onCreated?.(session.id);
      return this.sessions.resumeUpload(session.id, source, onProgress);
    },
    resumeUpload: async (id: string, source: UploadSource, onProgress?: (p: UploadProgress) => void): Promise<Session> => {
      this.mustSession(id);
      // 실제 PUT 없이 진행률만 흘려보낸다 — 화면이 업로드 단계를 그리게 하려는 것
      for (let i = 1; i <= 5; i++) {
        await new Promise((r) => setTimeout(r, 150));
        onProgress?.({ uploadedBytes: Math.round((source.sizeBytes * i) / 5), totalBytes: source.sizeBytes });
      }
      return this.sessions.completeUpload(id);
    },
```
(`mustSession`은 없는 id면 throw하는 기존 private 메서드.)

- [ ] **Step 8: 통과 확인 + 빌드**

Run: `pnpm --filter @bandapp/api-client test` → 전부 PASS.
Run: `pnpm --filter @bandapp/api-client build` → 오류 없음 (모바일이 dist를 쓴다).
Run: `pnpm --filter @bandapp/mobile typecheck` → 오류 없음 (기존 호출은 선택 인자라 그대로 컴파일).

- [ ] **Step 9: Commit**

```bash
git add packages/api-client/src
git commit -m "feat(api-client): onCreated hook on upload and sessions.resumeUpload"
```

---

### Task 2: 로컬 스토어 `createPendingUploads` + 메모리 fs

**Files:**
- Create: `apps/mobile/src/features/upload/uploadErrors.ts`
- Create: `apps/mobile/src/features/upload/createPendingUploads.ts`
- Create: `apps/mobile/src/features/upload/pendingUploads.ts`
- Modify: `apps/mobile/src/features/upload/readFilePart.ts:30`
- Test: `apps/mobile/src/features/upload/createPendingUploads.test.ts`

**Interfaces:**
- Produces: `MissingUploadFileError`; `PendingUpload`; `UploadFs`; `createPendingUploads(fs): PendingUploadsStore`; `createMemoryFs(files?: Record<string, string>): UploadFs & { files: Map<string, string> }`; `pendingUploads` 싱글턴.

- [ ] **Step 1: `uploadErrors.ts`**

```ts
/** 이어 올릴 녹음 파일(또는 그 레코드)이 이 기기에 없다 — 재시도해도 소용없는 오류. */
export class MissingUploadFileError extends Error {
  constructor(message = "recording file not found") {
    super(message);
    this.name = "MissingUploadFileError";
  }
}
```

- [ ] **Step 2: 실패 테스트 `createPendingUploads.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import { createMemoryFs, createPendingUploads, type PendingUpload } from "./createPendingUploads";

const rec = (sessionId: string, fileUri: string): PendingUpload => ({
  sessionId, bandId: "b1", fileUri, source: "recording", createdAt: "2026-09-10T10:00:00.000Z",
});

describe("createPendingUploads", () => {
  it("stage moves the file into uploads/ and returns the new URI", async () => {
    const fs = createMemoryFs({ "file:///cache/rec.m4a": "audio" });
    const store = createPendingUploads(fs);
    const staged = await store.stage("file:///cache/rec.m4a");
    expect(staged.startsWith("file:///docs/uploads/")).toBe(true);
    expect(staged.endsWith(".m4a")).toBe(true);
    expect(fs.files.has("file:///cache/rec.m4a")).toBe(false);
    expect(fs.files.get(staged)).toBe("audio");
  });

  it("stage throws when the source file does not exist", async () => {
    const store = createPendingUploads(createMemoryFs());
    await expect(store.stage("blob:http://localhost/abc")).rejects.toThrow();
  });

  it("add/get/list round-trip through pending.json", async () => {
    const fs = createMemoryFs();
    const store = createPendingUploads(fs);
    await store.add(rec("s1", "file:///docs/uploads/a.m4a"));
    await store.add(rec("s2", "file:///docs/uploads/b.m4a"));
    expect(await store.get("s1")).toEqual(rec("s1", "file:///docs/uploads/a.m4a"));
    expect(await store.get("zz")).toBeNull();
    expect((await store.list()).map((r) => r.sessionId).sort()).toEqual(["s1", "s2"]);
    // 새 스토어 인스턴스가 같은 fs를 읽어도 보인다 (앱 재시작 흉내)
    expect(await createPendingUploads(fs).get("s2")).not.toBeNull();
  });

  it("discard removes the record and the file, and succeeds when the file is already gone", async () => {
    const fs = createMemoryFs({ "file:///docs/uploads/a.m4a": "x" });
    const store = createPendingUploads(fs);
    await store.add(rec("s1", "file:///docs/uploads/a.m4a"));
    await store.add(rec("s2", "file:///docs/uploads/missing.m4a"));
    await store.discard("s1");
    expect(fs.files.has("file:///docs/uploads/a.m4a")).toBe(false);
    expect(await store.get("s1")).toBeNull();
    await expect(store.discard("s2")).resolves.toBeUndefined();
    expect(await store.get("s2")).toBeNull();
    await expect(store.discard("never")).resolves.toBeUndefined();
  });

  it("sweepOrphans deletes uploads/*.m4a that no record points to, keeping pending.json", async () => {
    const fs = createMemoryFs({
      "file:///docs/uploads/keep.m4a": "k",
      "file:///docs/uploads/orphan.m4a": "o",
    });
    const store = createPendingUploads(fs);
    await store.add(rec("s1", "file:///docs/uploads/keep.m4a"));
    await store.sweepOrphans();
    expect(fs.files.has("file:///docs/uploads/keep.m4a")).toBe(true);
    expect(fs.files.has("file:///docs/uploads/orphan.m4a")).toBe(false);
    expect(fs.files.has("file:///docs/uploads/pending.json")).toBe(true);
  });

  it("treats a corrupt pending.json as empty and warns", async () => {
    const fs = createMemoryFs({ "file:///docs/uploads/pending.json": "{not json" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = createPendingUploads(fs);
    expect(await store.list()).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("never throws from add/get/list/discard/sweepOrphans when the fs fails", async () => {
    const broken = createMemoryFs();
    broken.writeAsStringAsync = async () => { throw new Error("EIO"); };
    broken.readDirectoryAsync = async () => { throw new Error("EIO"); };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = createPendingUploads(broken);
    await expect(store.add(rec("s1", "file:///docs/uploads/a.m4a"))).resolves.toBeUndefined();
    await expect(store.sweepOrphans()).resolves.toBeUndefined();
    await expect(store.dropFile("file:///docs/uploads/none.m4a")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `pnpm --filter @bandapp/mobile test`
Expected: 새 파일이 모듈을 못 찾아 FAIL.

- [ ] **Step 4: `createPendingUploads.ts`**

```ts
/**
 * 앱 종료 후 이어 올리기용 로컬 스토어 (2026-09-10 업로드 재개 스펙 결정 1·7·8·9).
 * documentDirectory/uploads/ 한 폴더에 옮겨 둔 녹음 파일(<name>.m4a)과 레코드(pending.json)를 함께 둔다 —
 * 폴더가 곧 정리 단위라 고아 정리는 "레코드가 가리키지 않는 파일 삭제"로 끝난다.
 * 파일 시스템은 주입받는다: 네이티브는 expo-file-system/legacy, 웹과 테스트는 메모리 구현.
 * react-native를 import하지 않는다 — 순수 vitest에서 돌아야 한다.
 */
export interface PendingUpload {
  sessionId: string;
  bandId: string;
  fileUri: string;
  source: "recording" | "import";
  /** ISO 8601 */
  createdAt: string;
}

export interface UploadFs {
  documentDirectory: string | null;
  moveAsync(o: { from: string; to: string }): Promise<void>;
  deleteAsync(uri: string, o?: { idempotent?: boolean }): Promise<void>;
  readAsStringAsync(uri: string): Promise<string>;
  writeAsStringAsync(uri: string, contents: string): Promise<void>;
  makeDirectoryAsync(uri: string, o?: { intermediates?: boolean }): Promise<void>;
  readDirectoryAsync(uri: string): Promise<string[]>;
  getInfoAsync(uri: string): Promise<{ exists: boolean }>;
}

export interface PendingUploadsStore {
  /** 캐시의 파일을 uploads/<name>.m4a로 옮기고 새 URI를 돌려준다. 실패하면 throw — 호출자가 원래 URI로 진행한다. */
  stage(uri: string): Promise<string>;
  add(rec: PendingUpload): Promise<void>;
  get(sessionId: string): Promise<PendingUpload | null>;
  list(): Promise<PendingUpload[]>;
  /** 레코드와 파일을 지운다. 어느 쪽이 없어도 조용히 성공한다. */
  discard(sessionId: string): Promise<void>;
  /** 레코드 없이 옮겨 둔 파일만 지운다 (create 전에 실패한 경로). */
  dropFile(uri: string): Promise<void>;
  /** 레코드가 가리키지 않는 uploads/*.m4a를 지운다. 앱 시작 시 한 번 부른다. */
  sweepOrphans(): Promise<void>;
}

const INDEX_NAME = "pending.json";

const warn = (what: string, err: unknown) =>
  console.warn(`[pendingUploads] ${what}: ${err instanceof Error ? err.message : String(err)}`);

function isRecord(v: unknown): v is PendingUpload {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.sessionId === "string" && typeof r.fileUri === "string" && typeof r.bandId === "string";
}

function baseName(uri: string): string {
  return uri.slice(uri.lastIndexOf("/") + 1);
}

export function createPendingUploads(fs: UploadFs): PendingUploadsStore {
  // documentDirectory가 null인 환경(웹)은 메모리 fs를 물려 쓰므로 여기서는 항상 문자열이지만 방어한다
  const dir = `${fs.documentDirectory ?? "memory:///"}uploads/`;
  const indexUri = dir + INDEX_NAME;

  const ensureDir = async () => {
    if (!(await fs.getInfoAsync(dir)).exists) await fs.makeDirectoryAsync(dir, { intermediates: true });
  };

  const readIndex = async (): Promise<Record<string, PendingUpload>> => {
    try {
      if (!(await fs.getInfoAsync(indexUri)).exists) return {};
      const parsed: unknown = JSON.parse(await fs.readAsStringAsync(indexUri));
      if (typeof parsed !== "object" || parsed === null) return {};
      const out: Record<string, PendingUpload> = {};
      for (const [k, v] of Object.entries(parsed)) if (isRecord(v)) out[k] = v;
      return out;
    } catch (err) {
      warn("read index failed, treating as empty", err);
      return {};
    }
  };

  const writeIndex = async (map: Record<string, PendingUpload>) => {
    await ensureDir();
    await fs.writeAsStringAsync(indexUri, JSON.stringify(map));
  };

  const list = async (): Promise<PendingUpload[]> => Object.values(await readIndex());

  return {
    async stage(uri) {
      await ensureDir();
      // crypto.randomUUID는 Hermes에 없다 — 충돌만 피하면 되는 이름이라 시각+난수로 충분하다
      const name = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.m4a`;
      const to = dir + name;
      await fs.moveAsync({ from: uri, to });
      return to;
    },
    async add(rec) {
      try {
        const map = await readIndex();
        map[rec.sessionId] = rec;
        await writeIndex(map);
      } catch (err) {
        warn(`add ${rec.sessionId} failed`, err);
      }
    },
    async get(sessionId) {
      return (await readIndex())[sessionId] ?? null;
    },
    list,
    async discard(sessionId) {
      try {
        const map = await readIndex();
        const rec = map[sessionId];
        if (rec) await fs.deleteAsync(rec.fileUri, { idempotent: true }).catch((err) => warn(`delete ${rec.fileUri} failed`, err));
        if (sessionId in map) {
          delete map[sessionId];
          await writeIndex(map);
        }
      } catch (err) {
        warn(`discard ${sessionId} failed`, err);
      }
    },
    async dropFile(uri) {
      try {
        await fs.deleteAsync(uri, { idempotent: true });
      } catch (err) {
        warn(`drop ${uri} failed`, err);
      }
    },
    async sweepOrphans() {
      try {
        if (!(await fs.getInfoAsync(dir)).exists) return;
        const referenced = new Set((await list()).map((r) => baseName(r.fileUri)));
        for (const name of await fs.readDirectoryAsync(dir)) {
          if (name === INDEX_NAME || referenced.has(name)) continue;
          await fs.deleteAsync(dir + name, { idempotent: true }).catch((err) => warn(`sweep ${name} failed`, err));
        }
      } catch (err) {
        warn("sweep failed", err);
      }
    },
  };
}

/**
 * 메모리 파일 시스템 — 웹 프리뷰(documentDirectory가 null)와 테스트용. 디렉터리는 접두어로만 흉내 낸다.
 * documentDirectory는 "file:///docs/"로 고정해 테스트가 경로를 예측할 수 있게 한다.
 */
export function createMemoryFs(initial: Record<string, string> = {}): UploadFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  const dirs = new Set<string>();
  const isDir = (uri: string) => dirs.has(uri) || [...files.keys()].some((k) => k.startsWith(uri));
  return {
    files,
    documentDirectory: "file:///docs/",
    async moveAsync({ from, to }) {
      const body = files.get(from);
      if (body === undefined) throw new Error(`memory fs: no such file ${from}`);
      files.delete(from);
      files.set(to, body);
    },
    async deleteAsync(uri, o) {
      if (!files.delete(uri) && !o?.idempotent) throw new Error(`memory fs: no such file ${uri}`);
    },
    async readAsStringAsync(uri) {
      const body = files.get(uri);
      if (body === undefined) throw new Error(`memory fs: no such file ${uri}`);
      return body;
    },
    async writeAsStringAsync(uri, contents) {
      files.set(uri, contents);
    },
    async makeDirectoryAsync(uri) {
      dirs.add(uri);
    },
    async readDirectoryAsync(uri) {
      return [...files.keys()].filter((k) => k.startsWith(uri)).map((k) => k.slice(uri.length)).filter((n) => !n.includes("/"));
    },
    async getInfoAsync(uri) {
      return { exists: files.has(uri) || isDir(uri) };
    },
  };
}
```

- [ ] **Step 5: `pendingUploads.ts` (싱글턴 배선)**

```ts
import { Platform } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import { createMemoryFs, createPendingUploads, type UploadFs } from "./createPendingUploads";

/** expo-file-system/legacy를 스토어가 요구하는 최소 인터페이스로 좁힌다 */
const expoFs: UploadFs = {
  documentDirectory: FileSystem.documentDirectory,
  moveAsync: (o) => FileSystem.moveAsync(o),
  deleteAsync: (uri, o) => FileSystem.deleteAsync(uri, o),
  readAsStringAsync: (uri) => FileSystem.readAsStringAsync(uri),
  writeAsStringAsync: (uri, contents) => FileSystem.writeAsStringAsync(uri, contents),
  makeDirectoryAsync: (uri, o) => FileSystem.makeDirectoryAsync(uri, o),
  readDirectoryAsync: (uri) => FileSystem.readDirectoryAsync(uri),
  getInfoAsync: (uri) => FileSystem.getInfoAsync(uri),
};

// 웹 프리뷰는 documentDirectory가 null이고 blob: URI를 옮길 수 없다 — 메모리 fs를 쓰면 stage는 실패해
// (훅이 원래 URI로 진행) 레코드만 메모리에 남는다. 페이지를 새로 고치면 사라지지만 프리뷰 용도로 충분하다.
export const pendingUploads = createPendingUploads(
  Platform.OS === "web" || FileSystem.documentDirectory === null ? createMemoryFs() : expoFs,
);
```

- [ ] **Step 6: `readFilePart.ts` — 파일 없음을 전용 오류로**

`import { MissingUploadFileError } from "./uploadErrors";`를 추가하고 `if (!info.exists) throw new Error("recording file not found");`를 `if (!info.exists) throw new MissingUploadFileError();`로 바꾼다.

- [ ] **Step 7: 통과 확인**

Run: `pnpm --filter @bandapp/mobile test` → 새 테스트 7개 PASS.
Run: `pnpm --filter @bandapp/mobile typecheck` → 오류 없음.

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/src/features/upload
git commit -m "feat(mobile): pending upload store in documentDirectory/uploads with memory fs for tests"
```

---

### Task 3: `classifyUploadFailure`

**Files:**
- Create: `apps/mobile/src/features/upload/classifyUploadFailure.ts`
- Test: `apps/mobile/src/features/upload/classifyUploadFailure.test.ts`

**Interfaces:**
- Consumes: `MissingUploadFileError` (Task 2), `ApiError` from `@bandapp/api-client` (`status: number`).
- Produces: `classifyUploadFailure(err: unknown, mode: "upload" | "resume"): UploadFailure` with `UploadFailure = { message: string; discard: boolean; retryable: boolean; refetch: boolean }`.

- [ ] **Step 1: 실패 테스트**

```ts
import { ApiError } from "@bandapp/api-client";
import { describe, expect, it } from "vitest";
import { classifyUploadFailure } from "./classifyUploadFailure";
import { MissingUploadFileError } from "./uploadErrors";

describe("classifyUploadFailure", () => {
  it("missing file or record: discard, not retryable", () => {
    expect(classifyUploadFailure(new MissingUploadFileError(), "resume")).toEqual({
      message: "Recording file is missing", discard: true, retryable: false, refetch: false,
    });
    expect(classifyUploadFailure(new MissingUploadFileError(), "upload")).toEqual({
      message: "Recording file is missing", discard: true, retryable: false, refetch: false,
    });
  });

  it("404: discard, not retryable", () => {
    expect(classifyUploadFailure(new ApiError(404, "not found"), "resume")).toEqual({
      message: "This session no longer exists", discard: true, retryable: false, refetch: false,
    });
  });

  it("409 (already completed elsewhere): discard and refetch the session", () => {
    expect(classifyUploadFailure(new ApiError(409, "done"), "resume")).toEqual({
      message: "", discard: true, retryable: false, refetch: true,
    });
  });

  it("anything else keeps the record and is retryable, with a mode-specific message", () => {
    expect(classifyUploadFailure(new TypeError("Network request failed"), "resume")).toEqual({
      message: "Couldn’t resume the upload — check your connection and try again", discard: false, retryable: true, refetch: false,
    });
    expect(classifyUploadFailure(new Error("part 3 upload failed with HTTP 500"), "upload")).toEqual({
      message: "Couldn’t upload this recording — check your connection and try again", discard: false, retryable: true, refetch: false,
    });
    expect(classifyUploadFailure("weird", "upload").retryable).toBe(true);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @bandapp/mobile test` → 모듈 없음으로 FAIL.

- [ ] **Step 3: 구현**

```ts
import { ApiError } from "@bandapp/api-client";
import { MissingUploadFileError } from "./uploadErrors";

export interface UploadFailure {
  /** 화면 캡션. refetch면 빈 문자열 (세션을 다시 받아 흐름에 합류하므로 표시할 게 없다) */
  message: string;
  /** 로컬 레코드·파일을 지울지 */
  discard: boolean;
  /** "Try again" 칩을 보일지 */
  retryable: boolean;
  /** sessions.get으로 현재 상태를 받아 analyzing/ready 흐름에 합류할지 */
  refetch: boolean;
}

export const UPLOAD_ERROR = "Couldn’t upload this recording — check your connection and try again";
export const RESUME_ERROR = "Couldn’t resume the upload — check your connection and try again";

/**
 * 업로드/재개 오류를 화면 상태로 바꾼다 (2026-09-10 업로드 재개 스펙 결정 6). 순수 함수라 훅 없이 테스트한다.
 * 파일·레코드 없음과 404는 재시도해도 소용없으니 레코드를 지우고 칩을 숨긴다. 409는 다른 경로로 이미
 * 업로드가 끝난 것이라 레코드를 지우고 세션을 다시 받는다. 그 외(네트워크)는 레코드를 남겨 다시 시도한다.
 */
export function classifyUploadFailure(err: unknown, mode: "upload" | "resume"): UploadFailure {
  if (err instanceof MissingUploadFileError) {
    return { message: "Recording file is missing", discard: true, retryable: false, refetch: false };
  }
  if (err instanceof ApiError && err.status === 404) {
    return { message: "This session no longer exists", discard: true, retryable: false, refetch: false };
  }
  if (err instanceof ApiError && err.status === 409) {
    return { message: "", discard: true, retryable: false, refetch: true };
  }
  return { message: mode === "resume" ? RESUME_ERROR : UPLOAD_ERROR, discard: false, retryable: true, refetch: false };
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter @bandapp/mobile test` → PASS. `pnpm --filter @bandapp/mobile typecheck` → 오류 없음.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/features/upload/classifyUploadFailure.ts apps/mobile/src/features/upload/classifyUploadFailure.test.ts
git commit -m "feat(mobile): classify upload failures into discard/retry/refetch outcomes"
```

---

### Task 4: `useUploadSession` 재개 모드 + `ProcessingScreen`

**Files:**
- Modify: `apps/mobile/src/features/upload/useUploadSession.ts` (전체 교체)
- Modify: `apps/mobile/src/features/recording/ProcessingScreen.tsx`

**Interfaces:**
- Consumes: `pendingUploads` (Task 2), `classifyUploadFailure`·`UPLOAD_ERROR` (Task 3), `MissingUploadFileError` (Task 2), `api.sessions.upload(..., onCreated)`·`api.sessions.resumeUpload` (Task 1).
- Produces: `export interface ResumeParams { sessionId: string }`; `useUploadSession(params: UploadParams | ResumeParams | null)` returning `{ phase, progress, session, error, retry, retryable }`.

UI 테스트 도구가 없으니 이 태스크는 `typecheck`와 웹 프리뷰로 검증한다. 순수 로직은 Task 2·3에서 이미 테스트됐다.

- [ ] **Step 1: `useUploadSession.ts` 전체 교체**

```ts
import type { Session } from "@bandapp/types";
import { UploadRecordingError } from "@bandapp/api-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "@/api";
import { useCurrentBand } from "@/features/band/useCurrentBand";
import { classifyUploadFailure } from "./classifyUploadFailure";
import { pendingUploads } from "./pendingUploads";
import { fileUploadSource } from "./readFilePart";
import { MissingUploadFileError } from "./uploadErrors";

export interface UploadParams {
  fileUri: string;
  source: "recording" | "import";
  /** toLocalIso() 결과 */
  startedAt: string;
  durationMs?: number;
}

/** 세션 목록의 uploading 행에서 들어온 이어 올리기 — 파일은 로컬 레코드가 가리킨다 */
export interface ResumeParams {
  sessionId: string;
}

export type UploadPhase = "idle" | "uploading" | "analyzing" | "ready" | "failed";

const POLL_MS = 3000;
/** 이만큼 연속으로 폴링이 실패하면 조용히 계속 두지 않고 실패로 알린다. */
const MAX_POLL_FAILURES = 5;

const RETRY_ERROR = "Couldn’t retry — please try again";
const ANALYZE_ERROR = "Couldn’t analyze this recording";
const POLL_ERROR = "Lost contact with the server — try again";

const isResume = (p: UploadParams | ResumeParams | null): p is ResumeParams => p !== null && "sessionId" in p;

/**
 * 업로드(또는 이어 올리기) → 서버 상태 폴링. 이어 올리기의 단일 진실은 pendingUploads 스토어다
 * (2026-09-10 업로드 재개 스펙 결정 5): create가 끝나면 레코드를 남기고, complete가 끝나면 지운다.
 * retry()는 셋을 구분한다: 서버가 failed면 서버 retry, create까지 된 세션이 있으면 이어 올리기,
 * 둘 다 아니면 처음부터 업로드.
 */
export function useUploadSession(params: UploadParams | ResumeParams | null) {
  const api = useApi();
  const { band } = useCurrentBand();
  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [progress, setProgress] = useState(0);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(true);
  const startedRef = useRef(false);
  // 첫 업로드에서 create까지 성공한 세션 id — 같은 화면의 "Try again"이 새 세션을 만들지 않고 이어 올리게 한다
  const createdIdRef = useRef<string | null>(null);
  // uploads/로 옮긴 파일 URI. stage가 실패하면 원래 URI가 들어간다.
  const stagedRef = useRef<string | null>(null);

  // 업로드가 끝난 뒤 처리는 첫 시도든 재시도든 같다 — 파일과 레코드는 여기서 지운다 (스펙 결정 7)
  const settle = useCallback((created: Session) => {
    void pendingUploads.discard(created.id);
    setSession(created);
    if (created.status === "failed") {
      setError(ANALYZE_ERROR);
      setRetryable(true);
      setPhase("failed");
    } else {
      setPhase("analyzing");
    }
  }, []);

  const onProgress = useCallback(
    (p: { uploadedBytes: number; totalBytes: number }) =>
      setProgress(p.totalBytes ? p.uploadedBytes / p.totalBytes : 0),
    [],
  );

  const fail = useCallback(
    async (err: unknown, mode: "upload" | "resume", sessionId: string | null) => {
      console.warn(`[upload] ${mode} failed:`, err instanceof Error ? err.message : err);
      const outcome = classifyUploadFailure(err, mode);
      if (outcome.discard && sessionId) await pendingUploads.discard(sessionId);
      if (outcome.refetch && sessionId) {
        // 다른 경로로 이미 업로드가 끝난 세션 — 현재 상태를 받아 analyzing/ready 흐름에 합류한다
        try {
          settle(await api.sessions.get(sessionId));
          return;
        } catch (e) {
          console.warn("[upload] refetch failed:", e instanceof Error ? e.message : e);
        }
      }
      setError(outcome.message || RETRY_ERROR);
      setRetryable(outcome.retryable);
      setPhase("failed");
    },
    [api, settle],
  );

  const begin = useCallback(() => {
    setPhase("uploading");
    setProgress(0);
    setError(null);
    setRetryable(true);
  }, []);

  /** fileUri를 알면(같은 화면의 재시도) 레코드를 거치지 않는다 — 레코드 기록이 실패했어도 파일은 있다 */
  const resume = useCallback(
    async (sessionId: string, fileUri?: string) => {
      begin();
      try {
        const uri = fileUri ?? (await pendingUploads.get(sessionId))?.fileUri;
        if (!uri) throw new MissingUploadFileError();
        const source = await fileUploadSource(uri);
        settle(await api.sessions.resumeUpload(sessionId, source, onProgress));
      } catch (e) {
        await fail(e, "resume", sessionId);
      }
    },
    [api, begin, settle, onProgress, fail],
  );

  const upload = useCallback(async () => {
    if (!params || isResume(params) || !band) return;
    begin();
    try {
      if (!stagedRef.current) {
        // 캐시는 OS가 지울 수 있어 앱 소유 폴더로 옮긴다 (스펙 결정 2). 못 옮기면 원래 URI로 그대로 간다 —
        // 재개는 못 하지만 업로드는 막지 않는다 (스펙 결정 8).
        stagedRef.current = await pendingUploads.stage(params.fileUri).catch((e: unknown) => {
          console.warn("[upload] stage failed, uploading in place:", e instanceof Error ? e.message : e);
          return params.fileUri;
        });
      }
      const fileUri = stagedRef.current;
      const source = await fileUploadSource(fileUri);
      settle(
        await api.sessions.upload(
          band.id,
          {
            startedAt: params.startedAt,
            durationMs: params.durationMs,
            sizeBytes: source.sizeBytes,
            contentType: "audio/mp4",
            source: params.source,
          },
          source,
          onProgress,
          async (sessionId) => {
            createdIdRef.current = sessionId;
            await pendingUploads.add({ sessionId, bandId: band.id, fileUri, source: params.source, createdAt: new Date().toISOString() });
          },
        ),
      );
    } catch (e) {
      const sessionId = e instanceof UploadRecordingError ? e.sessionId : null;
      if (sessionId) createdIdRef.current = sessionId;
      await fail(e, "upload", sessionId);
    }
  }, [api, band, params, begin, settle, onProgress, fail]);

  useEffect(() => {
    if (!params || startedRef.current) return;
    if (isResume(params)) {
      startedRef.current = true;
      void resume(params.sessionId);
      return;
    }
    if (!band) return;
    startedRef.current = true;
    void upload();
  }, [params, band, upload, resume]);

  // create 전에 실패하고 화면을 떠나면 옮겨 둔 파일은 아무 레코드도 가리키지 않는다 — 여기서 지운다.
  // (남겨도 다음 앱 시작의 sweepOrphans가 지우지만, 바로 지우는 편이 디스크에 낫다.)
  useEffect(
    () => () => {
      const staged = stagedRef.current;
      if (staged && !createdIdRef.current && !(params && !isResume(params) && staged === params.fileUri)) {
        void pendingUploads.dropFile(staged);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // 서버 상태 폴링 — 세션이 analyzing인 동안만, 세션 id가 바뀔 때만 새 interval을 만든다
  const sessionId = session?.id ?? null;
  useEffect(() => {
    if (phase !== "analyzing" || !sessionId) return;
    let failures = 0;
    const t = setInterval(() => {
      void api.sessions
        .get(sessionId)
        .then((s) => {
          failures = 0;
          setSession(s);
          if (s.status === "ready") setPhase("ready");
          if (s.status === "failed") {
            setError(ANALYZE_ERROR);
            setPhase("failed");
          }
        })
        .catch((e: unknown) => {
          // 폴링이 몇 번 튀는 건 정상이지만 계속 실패하면 영원히 analyzing으로 두지 않는다
          if (++failures < MAX_POLL_FAILURES) return;
          console.warn("[upload] polling failed:", e instanceof Error ? e.message : e);
          setError(POLL_ERROR);
          setPhase("failed");
        });
    }, POLL_MS);
    return () => clearInterval(t);
  }, [api, phase, sessionId]);

  const retry = useCallback(() => {
    if (session && session.status === "failed") {
      setPhase("analyzing");
      setError(null);
      void api.sessions
        .retryAnalysis(session.id)
        .then(setSession)
        .catch((e: unknown) => {
          console.warn("[upload] retryAnalysis failed:", e instanceof Error ? e.message : e);
          setError(RETRY_ERROR);
          setPhase("failed");
        });
      return;
    }
    if (isResume(params)) {
      void resume(params.sessionId);
      return;
    }
    if (createdIdRef.current) {
      void resume(createdIdRef.current, stagedRef.current ?? undefined);
      return;
    }
    void upload();
  }, [api, session, params, upload, resume]);

  return { phase, progress, session, error, retry, retryable };
}
```

`resumeRecordingUpload` import는 사라진다 (클라이언트 `resumeUpload`가 대신한다).

- [ ] **Step 2: `ProcessingScreen.tsx`**

`raw` 타입에 `sessionId?: string`을 더하고 `params` memo를 이렇게 바꾼다:
```ts
  const raw = useLocalSearchParams<{ sessionId?: string; fileUri?: string; source?: "recording" | "import"; startedAt?: string; durationMs?: string }>();
  const params = useMemo<UploadParams | ResumeParams | null>(
    () =>
      raw.sessionId
        ? { sessionId: raw.sessionId }
        : raw.fileUri
          ? { fileUri: raw.fileUri, source: raw.source ?? "import", startedAt: raw.startedAt ?? "", durationMs: raw.durationMs ? Number(raw.durationMs) : undefined }
          : null,
    [raw.sessionId, raw.fileUri, raw.source, raw.startedAt, raw.durationMs],
  );
  const resuming = params !== null && "sessionId" in params;
  const { phase, progress, session, error, retry, retryable } = useUploadSession(params);
```
import에 `import type { ResumeParams, UploadParams } from "@/features/upload/useUploadSession";`를 더한다.

`durationSec` 줄을 `const durationSec = session?.durationSec || (params && !("sessionId" in params) && params.durationMs ? Math.round(params.durationMs / 1000) : 0);`로.

캡션의 uploading 분기를 ``phase === "uploading" ? `${resuming ? "Resuming upload…" : "Uploading…"} ${Math.round(progress * 100)}%` ``로.

칩 줄을 다음으로:
```tsx
        {phase === "failed" ? (
          retryable ? <Chip label="Try again" onPress={retry} /> : <Chip label="Back to sessions" onPress={() => router.replace("/")} />
        ) : null}
```

- [ ] **Step 3: 타입·테스트 확인**

Run: `pnpm --filter @bandapp/mobile typecheck` → 오류 없음.
Run: `pnpm --filter @bandapp/mobile test` → 전부 PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/features/upload/useUploadSession.ts apps/mobile/src/features/recording/ProcessingScreen.tsx
git commit -m "feat(mobile): resume mode in useUploadSession and ProcessingScreen"
```

---

### Task 5: 세션 목록 재개 행 + 앱 시작 고아 정리

**Files:**
- Create: `apps/mobile/src/features/upload/usePendingUploadIds.ts`
- Modify: `apps/mobile/src/features/sessions/SessionRow.tsx`
- Modify: `apps/mobile/src/features/sessions/SessionsScreen.tsx`
- Modify: `apps/mobile/app/_layout.tsx`

**Interfaces:**
- Consumes: `pendingUploads` (Task 2), `/processing?sessionId=` (Task 4).
- Produces: `usePendingUploadIds(sessions: Session[] | undefined): Set<string>`; `SessionRow` prop `resumable?: boolean`.

- [ ] **Step 1: `usePendingUploadIds.ts`**

```ts
import type { Session } from "@bandapp/types";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { pendingUploads } from "./pendingUploads";

/**
 * 세션 목록이 "이어 올릴 수 있는" uploading 행을 표시하려고 쓰는 로컬 레코드 id 집합.
 * 화면이 포커스될 때마다 다시 읽고(재개 화면에서 돌아오면 레코드가 사라져 있다), 목록에 있으면서
 * 더 이상 uploading이 아닌 세션의 레코드는 지운다 (2026-09-10 업로드 재개 스펙 결정 7). 목록에 없는
 * 레코드는 다른 밴드의 것일 수 있어 건드리지 않는다.
 */
export function usePendingUploadIds(sessions: Session[] | undefined): Set<string> {
  const [ids, setIds] = useState<Set<string>>(() => new Set());

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void pendingUploads.list().then((list) => {
        if (active) setIds(new Set(list.map((r) => r.sessionId)));
      });
      return () => {
        active = false;
      };
    }, []),
  );

  useEffect(() => {
    if (!sessions || ids.size === 0) return;
    const stale = sessions.filter((s) => ids.has(s.id) && s.status !== "uploading").map((s) => s.id);
    if (stale.length === 0) return;
    void Promise.all(stale.map((id) => pendingUploads.discard(id))).then(() =>
      setIds((prev) => {
        const next = new Set(prev);
        for (const id of stale) next.delete(id);
        return next;
      }),
    );
  }, [sessions, ids]);

  return ids;
}
```

- [ ] **Step 2: `SessionRow.tsx`**

시그니처를 `{ session, onPress, resumable = false }: { session: Session; onPress: () => void; resumable?: boolean }`로. uploading 문구:
```tsx
              {s.status === "uploading" ? (resumable ? "Tap to continue uploading" : "Uploading…") : "Finding takes…"}
```

- [ ] **Step 3: `SessionsScreen.tsx`**

`import { usePendingUploadIds } from "@/features/upload/usePendingUploadIds";`를 더하고, `useSessions` 아래에 `const pendingIds = usePendingUploadIds(sessions);`.

`onRowPress`:
```ts
  const onRowPress = (s: Session) => {
    if (s.status === "ready") router.push(`/session/${s.id}`);
    else if (s.status === "failed")
      void api.sessions.retryAnalysis(s.id).catch(() => toast.show("Something went wrong"));
    else if (s.status === "uploading") {
      // 로컬 레코드가 있으면 이어 올린다. 없으면 다른 기기에서 시작한 업로드라 이 기기에서는 할 수 있는 게 없다.
      if (pendingIds.has(s.id)) router.push({ pathname: "/processing", params: { sessionId: s.id } });
      else toast.show("This upload was started on another device");
    } else toast.show("Still finding takes…");
  };
```
`renderItem`: `<SessionRow session={item} resumable={pendingIds.has(item.id)} onPress={() => onRowPress(item)} />`.

- [ ] **Step 4: `_layout.tsx` — 시작 시 고아 정리**

`import { pendingUploads } from "@/features/upload/pendingUploads";`를 더하고 `RootLayout` 함수 본문 첫 줄에:
```ts
  // 레코드 없이 남은 uploads/*.m4a(create 전에 죽은 경우)를 지운다 — 앱 시작에 한 번이면 충분하다
  useEffect(() => {
    void pendingUploads.sweepOrphans();
  }, []);
```
(`useEffect`는 이미 import돼 있다. `RootLayout`에 기존 훅 호출이 있다면 그 뒤에 두어 훅 순서를 바꾸지 않는다.)

- [ ] **Step 5: 타입 확인 + 웹 프리뷰**

Run: `pnpm --filter @bandapp/mobile typecheck` → 오류 없음. `pnpm --filter @bandapp/mobile test` → PASS.

웹 프리뷰(Mock, `.claude/launch.json`의 mobile 설정, Browser pane은 숨겨져 있을 수 있으니 직접 라우트로 이동):
1. `/`에서 "+" → Import a recording → 작은 m4a 선택 → `/processing`이 "Uploading… N%" → "Finding the parts you played…" → 세션 화면으로 이동하는지.
2. `/processing?sessionId=nope`로 직접 이동 → "Recording file is missing"과 "Back to sessions" 칩(메모리 fs에 레코드가 없다).
3. 세션 목록의 uploading 행(시드에 있으면)을 탭 → "This upload was started on another device" 토스트.
콘솔에 `[pendingUploads]` 경고 외 오류가 없어야 한다.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/features/upload/usePendingUploadIds.ts apps/mobile/src/features/sessions/SessionRow.tsx apps/mobile/src/features/sessions/SessionsScreen.tsx apps/mobile/app/_layout.tsx
git commit -m "feat(mobile): resume paused uploads from the session list, sweep orphan files on launch"
```

---

### Task 6: 문서

**Files:**
- Modify: `README.md:42`
- Modify: `docs/backlog.md`

- [ ] **Step 1: README**

42행 "분석 파이프라인" 항목 바로 아래에 한 항목 추가:
```
- 업로드 재개: 앱이 녹음/가져오기 파일을 `documentDirectory/uploads/`로 옮기고 create 직후 `pending.json`에 레코드를 남긴다. 끊긴 업로드는 세션 목록의 uploading 행("Tap to continue uploading")에서 `GET /sessions/:id/upload`로 남은 파트만 올린다. complete가 끝나면 파일·레코드를 지우고, 앱 시작 시 레코드 없는 파일을 정리한다.
```

- [ ] **Step 2: backlog**

"## 업로드·녹음"에서 "**앱 종료 후 업로드 재개.**"와 "**업로드 성공 후 캐시 디렉터리 정리.**" 두 항목을 지우고 다음을 추가:
```
- **끊긴 업로드 자동 재개.** 지금은 세션 목록의 uploading 행을 눌러야 이어 올린다 ([2026-09-10 스펙](superpowers/specs/2026-09-10-upload-resume-design.md) 범위 제외). 앱 시작 시 백그라운드에서 이어 올리려면 화면 밖 진행 상태 관리가 필요하다.
- **2026-09-10 이전에 캐시에 쌓인 녹음·가져오기 파일 청소.** 지금은 새 파일만 `uploads/`로 옮겨 관리한다. 옛 캐시 파일은 어떤 게 우리 것인지 알 수 없어 손대지 않았다.
```
"## 팀·설정"의 "**기기 검증(dev build) 필요.**" 항목 끝에 문장 추가: `녹음 파일을 uploads/로 옮긴 뒤 expo-audio가 문제없는지, 앱 강제 종료 후 목록에서 이어 올리기가 되는지.`

- [ ] **Step 3: Commit**

```bash
git add README.md docs/backlog.md
git commit -m "docs: describe upload resume and update backlog"
```
