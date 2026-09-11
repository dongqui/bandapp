# 타임라인 뷰어 (스펙 A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 2~3시간 원본 녹음 위에서 AI가 뽑은 take를 팬·핀치 줌으로 찾고 듣는 읽기 전용 타임라인 화면(`/session/[id]/timeline`)을 만든다. 편집(핸들 드래그·재컷)은 스펙 B.

**Architecture:** 워커가 이미 만드는 50 peaks/초 `Uint8Array`를 R2 사이드카 `peaks.bin`(8바이트 헤더)으로 올리고 `sessions.peaks_key`에 키를 남긴다. 앱은 `GET /sessions/:id/peaks`로 presigned URL을 받아 한 번 내려받고 `lib/timeline/`의 순수 함수로 LOD 피라미드·좌표·줌·follow·눈금을 계산한다. viewport(`startMs`, `msPerPx`)와 playhead는 Reanimated shared value로만 살고, `react-native-svg` Path의 `d`를 `useDerivedValue` + `animatedProps`로 UI 스레드에서 만든다. 제스처는 react-native-gesture-handler v3 훅.

**Tech Stack:** NestJS 11 + drizzle(Postgres), vitest(단위 + 실 Postgres e2e), `@bandapp/types`·`@bandapp/api-client`(dist 소비), Expo SDK 57 / RN 0.86, react-native-reanimated 4.5 + react-native-worklets 0.10, react-native-gesture-handler 3.2 (v3 훅 API: `usePanGesture`·`usePinchGesture`·`useTapGesture`·`useSimultaneousGestures`·`useCompetingGestures`·`GestureDetector`), react-native-svg 15, expo-audio 57.

**Spec:** [docs/superpowers/specs/2026-09-11-timeline-viewer-design.md](../specs/2026-09-11-timeline-viewer-design.md)

## Global Constraints

- 코드 주석은 한국어, 커밋 제목은 영어 conventional commit. 커밋 트레일러 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` 필수.
- `@bandapp/types`·`@bandapp/api-client`는 `dist`로 소비된다 — 바꾸면 `pnpm --filter @bandapp/types build` / `pnpm --filter @bandapp/api-client build` 후에야 다른 패키지의 typecheck가 맞는다.
- 타입 확인: `pnpm --filter mobile typecheck` + `pnpm --filter @bandapp/api build`. 각 패키지 tsconfig가 `**/*.spec.ts`를 제외하므로 spec 파일의 타입 오류는 어느 명령도 못 잡는다 — spec 코드는 그대로 옮겨 적는다.
- `pnpm lint`는 `apps/api`만 돈다(oxlint). `new Array(n)` 금지 → `Array.from({ length: n }, () => 0)`. `Array.from<number>(...)` 제네릭 금지(nest build가 깨진다).
- 워커 상수 `PEAKS_PER_SEC = 50`은 바꾸지 않는다. peaks.bin 헤더: `"TNPK"`(4) + version u8(1) + peaksPerSec u16 LE + reserved u8(0) = `PEAKS_FILE_HEADER_BYTES = 8`.
- 사이드카·피크 실패는 세션을 failed로 만들지 않는다 — warn 로그 + `peaks_key: null`.
- 앱 `lib/timeline/*`은 `@/` 별칭과 React Native import 없이 상대 경로·`@bandapp/types`만 쓴다 (mobile vitest에 별칭 설정이 없다). UI 스레드에서 부르는 함수는 본문 첫 줄에 `"worklet";`.
- 줌 범위: 가장 넓게 `durationMs / widthPx`(전체 한 화면), 가장 촘촘히 `5000 / widthPx`(5초 한 화면). 바 피치 `BAR_PX = 3`. LOD hysteresis: 바당 피크 > 3.5면 거칠게, < 0.8이면 세밀하게. Follow: playhead x > 80% 폭 또는 화면 밖이면 30% 위치로. Playhead 보간 상한 400ms. Take fit 여백 20%.
- 이 화면의 최종 레이아웃은 Claude Design 결과가 명세다 (스펙 결정 2). Task 15의 레이아웃은 디자인이 오기 전에 동작을 검증하기 위한 잠정 조립이며, 디자인이 오면 그 화면을 기준으로 다시 맞춘다. Task 1~14는 디자인과 무관하다.
- e2e는 로컬 Postgres(docker compose `postgres`)가 떠 있어야 한다. Bash 툴이 복합 명령을 거부하면 한 번에 하나씩.
- 모바일 화면 검증은 Browser pane 웹 Mock 프리뷰(`preview_start({name:"mobile-web-mock"})`, 경로 `/session/s1/timeline`)로 한다. Mock은 사이드카가 없어 128버킷 폴백 파형이 나오는 게 정상이다. 핀치는 웹에서 못 누른다 — 기기 검증 목록(Task 16)으로 넘긴다.

---

### Task 1: peaks.bin 헤더 상수와 `encodePeaksFile`

**Files:**
- Modify: `packages/types/src/peaks.ts`
- Modify: `apps/api/src/worker/peaks.ts`
- Test: `apps/api/src/worker/peaks.spec.ts`

**Interfaces:**
- Produces: `PEAKS_FILE_MAGIC = "TNPK"`, `PEAKS_FILE_VERSION = 1`, `PEAKS_FILE_HEADER_BYTES = 8` (`@bandapp/types`); `encodePeaksFile(hires: Uint8Array, peaksPerSec: number): Buffer` (`worker/peaks.ts`).

- [ ] **Step 1: 상수 추가**

`packages/types/src/peaks.ts` 끝에:

```ts
/**
 * 고해상도 피크 사이드카(peaks.bin) 헤더 — 워커 인코더와 앱 파서가 공유한다 (2026-09-11 스펙 결정 4).
 * 바이트 0..3 "TNPK", 4 version, 5..6 peaksPerSec(u16 LE), 7 reserved(0), 8.. 피크 바이트(0~255).
 */
export const PEAKS_FILE_MAGIC = "TNPK";
export const PEAKS_FILE_VERSION = 1;
export const PEAKS_FILE_HEADER_BYTES = 8;
```

- [ ] **Step 2: types 빌드**

Run: `pnpm --filter @bandapp/types build`
Expected: 오류 없음. `packages/types/dist/peaks.d.ts`에 세 상수가 보인다.

- [ ] **Step 3: 실패하는 테스트**

`apps/api/src/worker/peaks.spec.ts` import를 바꾸고 describe를 추가:

```ts
import { PEAKS_FILE_HEADER_BYTES, PEAKS_FILE_MAGIC, PEAKS_FILE_VERSION } from "@bandapp/types";
import { describe, expect, it } from "vitest";
import { encodePeaksFile, PeakAccumulator, slicePeaks } from "./peaks.js";
```

파일 끝에:

```ts
describe("encodePeaksFile", () => {
  it("8바이트 헤더(magic, version, peaksPerSec u16 LE, reserved) 뒤에 피크 바이트를 그대로 붙인다", () => {
    const buf = encodePeaksFile(Uint8Array.from([0, 128, 255]), 50);
    expect(buf.length).toBe(PEAKS_FILE_HEADER_BYTES + 3);
    expect(buf.subarray(0, 4).toString("ascii")).toBe(PEAKS_FILE_MAGIC);
    expect(buf.readUInt8(4)).toBe(PEAKS_FILE_VERSION);
    expect(buf.readUInt16LE(5)).toBe(50);
    expect(buf.readUInt8(7)).toBe(0);
    expect(Array.from(buf.subarray(8))).toEqual([0, 128, 255]);
  });

  it("빈 피크는 헤더만 있는 파일이 된다", () => {
    expect(encodePeaksFile(new Uint8Array(0), 50).length).toBe(PEAKS_FILE_HEADER_BYTES);
  });

  it("peaksPerSec가 1..65535 정수가 아니면 throw", () => {
    expect(() => encodePeaksFile(new Uint8Array(0), 0)).toThrow();
    expect(() => encodePeaksFile(new Uint8Array(0), 70_000)).toThrow();
    expect(() => encodePeaksFile(new Uint8Array(0), 1.5)).toThrow();
  });
});
```

- [ ] **Step 4: 실패 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/worker/peaks.spec.ts`
Expected: FAIL — `encodePeaksFile is not a function` (또는 export 없음).

- [ ] **Step 5: 구현**

`apps/api/src/worker/peaks.ts` 상단 import와 파일 끝:

```ts
import { PEAKS_FILE_HEADER_BYTES, PEAKS_FILE_MAGIC, PEAKS_FILE_VERSION } from "@bandapp/types";
```

```ts
/** 고해상도 피크를 peaks.bin 바이트로. 헤더 형식은 @bandapp/types의 PEAKS_FILE_* 참고 (스펙 결정 4). */
export function encodePeaksFile(hires: Uint8Array, peaksPerSec: number): Buffer {
  if (!Number.isInteger(peaksPerSec) || peaksPerSec <= 0 || peaksPerSec > 0xffff) {
    throw new Error(`peaksPerSec must be an integer in 1..65535, got ${peaksPerSec}`);
  }
  const out = Buffer.alloc(PEAKS_FILE_HEADER_BYTES + hires.length);
  out.write(PEAKS_FILE_MAGIC, 0, "ascii");
  out.writeUInt8(PEAKS_FILE_VERSION, 4);
  out.writeUInt16LE(peaksPerSec, 5);
  out.writeUInt8(0, 7);
  out.set(hires, PEAKS_FILE_HEADER_BYTES);
  return out;
}
```

- [ ] **Step 6: 통과 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/worker/peaks.spec.ts`
Expected: PASS (기존 PeakAccumulator·slicePeaks 테스트 포함).

- [ ] **Step 7: 커밋**

```bash
git add packages/types/src/peaks.ts apps/api/src/worker/peaks.ts apps/api/src/worker/peaks.spec.ts
git commit -m "feat(worker): add peaks.bin encoder and header constants" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `sessions.peaks_key` 컬럼, 마이그레이션 0008, `peaksKey()`

**Files:**
- Modify: `apps/api/src/db/schema.ts` (`sessions` 테이블, `peaks` 아래)
- Create: `apps/api/drizzle/0008_<drizzle가 붙인 이름>.sql` + `drizzle/meta/*` (drizzle-kit 생성)
- Modify: `apps/api/src/sessions/session-mapper.ts`
- Test: `apps/api/src/sessions/session-mapper.spec.ts`

**Interfaces:**
- Produces: `sessions.peaksKey` (drizzle 컬럼 `peaks_key text`), `SessionRow.peaksKey: string | null`, `SESSION_WITH_COUNTS.peaksKey`, `peaksKey(bandId, sessionId): string` = `bands/{bandId}/sessions/{sessionId}/peaks.bin`. `toSession`은 `peaksKey`를 노출하지 않는다.

- [ ] **Step 1: 실패하는 테스트**

`apps/api/src/sessions/session-mapper.spec.ts` import에 `peaksKey`를 더하고 describe 추가:

```ts
import { originalKey, peaksKey, takeKey, titleFor, toSession } from "./session-mapper.js";
```

```ts
describe("peaksKey", () => {
  it("원본·take와 같은 세션 접두어 아래 peaks.bin", () => {
    expect(peaksKey("b1", "s1")).toBe("bands/b1/sessions/s1/peaks.bin");
  });
});
```

`toSession` 테스트의 row 객체에 `peaksKey: null`을 추가하고, 그 테스트 끝에 한 줄:

```ts
    expect(session).not.toHaveProperty("peaksKey");
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/sessions/session-mapper.spec.ts`
Expected: FAIL — `peaksKey is not a function`.

- [ ] **Step 3: 스키마·매퍼 구현**

`apps/api/src/db/schema.ts`의 `sessions` 테이블, `peaks` 줄 아래:

```ts
  // 고해상도 피크 사이드카(peaks.bin)의 R2 키. 워커 업로드가 성공했을 때만 채운다. 옛 데이터·실패면 null (2026-09-11 스펙 결정 5)
  peaksKey: text("peaks_key"),
```

`apps/api/src/sessions/session-mapper.ts`:

```ts
export interface SessionRow {
  // ...기존 필드
  peaks: number[] | null;
  /** peaks.bin R2 키 — wire Session에는 노출하지 않는다 (엔드포인트가 404로 알린다) */
  peaksKey: string | null;
  updatedAt: Date;
}
```

`SESSION_WITH_COUNTS`의 `peaks: sessions.peaks,` 아래:

```ts
  peaksKey: sessions.peaksKey,
```

`takesPrefix` 아래:

```ts
/** 고해상도 피크 사이드카 객체 키 (2026-09-11 스펙 결정 3). retry는 같은 키를 덮어쓴다. */
export function peaksKey(bandId: string, sessionId: string): string {
  return `bands/${bandId}/sessions/${sessionId}/peaks.bin`;
}
```

- [ ] **Step 4: 마이그레이션 생성**

Run: `pnpm --filter @bandapp/api db:generate`
Expected: `apps/api/drizzle/0008_*.sql`이 생기고 내용이 정확히 `ALTER TABLE "sessions" ADD COLUMN "peaks_key" text;` 한 줄. `drizzle/meta/_journal.json`에 0008 항목, `0008_snapshot.json` 생성.

- [ ] **Step 5: 테스트·빌드 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/sessions/session-mapper.spec.ts`
Expected: PASS.
Run: `pnpm --filter @bandapp/api build`
Expected: 오류 없음 (`SessionRow`를 쓰는 곳은 select 결과라 자동으로 맞는다).

- [ ] **Step 6: 커밋**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle apps/api/src/sessions/session-mapper.ts apps/api/src/sessions/session-mapper.spec.ts
git commit -m "feat(api): add sessions.peaks_key column and sidecar key helper" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: 워커가 사이드카를 R2에 올린다

**Files:**
- Modify: `apps/api/src/worker/session-analysis.service.ts`
- Test: `apps/api/src/worker/session-analysis.service.spec.ts`

**Interfaces:**
- Consumes: `encodePeaksFile`(Task 1), `peaksKey`(Task 2), `StorageService.putFile(key, path, contentType)`.
- Produces: 세션 ready update에 `peaksKey: string | null`. 업로드 순서: peaks.bin → take 컷들.

- [ ] **Step 1: 가짜 storage 확장 + 실패하는 테스트**

`session-analysis.service.spec.ts` 상단 import:

```ts
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
```

`fakeStorage`를 통째로 교체:

```ts
function fakeStorage(orphanKeys: string[] = ["bands/b/sessions/s/takes/orphan.m4a"], opts: { failPutKeys?: string[] } = {}) {
  const calls = {
    downloads: [] as string[],
    puts: [] as string[],
    putTypes: [] as string[],
    // 사이드카는 워커가 실제로 파일을 쓰므로 업로드 시점의 본문을 남겨 헤더를 검증한다. take 컷은 가짜 ffmpeg가 파일을 안 만든다.
    putBodies: new Map<string, Buffer>(),
    deleted: [] as string[],
    listedPrefixes: [] as string[],
  };
  const storage = {
    downloadToFile: async (key: string) => { calls.downloads.push(key); },
    putFile: async (key: string, path: string, contentType: string) => {
      if (opts.failPutKeys?.includes(key)) throw new Error(`put failed: ${key}`);
      calls.puts.push(key);
      calls.putTypes.push(contentType);
      if (existsSync(path)) calls.putBodies.set(key, readFileSync(path));
    },
    deleteObjects: async (keys: string[]) => { calls.deleted.push(...keys); },
    listKeys: async (prefix: string) => { calls.listedPrefixes.push(prefix); return orphanKeys; },
  } as unknown as StorageService;
  return { storage, calls };
}
```

첫 테스트("downloads, chunks, analyzes, …")에서 아래 두 줄을

```ts
    expect(calls.puts).toHaveLength(2);
    expect(calls.puts[0]).toMatch(/^bands\/b\/sessions\/s\/takes\/.+\.m4a$/);
    expect(state.updates.at(-1)).toMatchObject({ status: "ready", takeCount: 2, durationMs: 45 * MIN });
```

다음으로 교체:

```ts
    // 사이드카가 먼저(컷 루프 앞), 그 뒤 take 2개
    expect(calls.puts).toHaveLength(3);
    expect(calls.puts[0]).toBe("bands/b/sessions/s/peaks.bin");
    expect(calls.putTypes[0]).toBe("application/octet-stream");
    const sidecar = calls.putBodies.get("bands/b/sessions/s/peaks.bin")!;
    expect(sidecar.subarray(0, 4).toString("ascii")).toBe("TNPK");
    expect(sidecar.readUInt16LE(5)).toBe(50);
    expect(sidecar.length).toBe(8 + Math.ceil((45 * MIN) / 1000) * 50);
    expect(calls.puts[1]).toMatch(/^bands\/b\/sessions\/s\/takes\/.+\.m4a$/);
    expect(state.updates.at(-1)).toMatchObject({ status: "ready", takeCount: 2, durationMs: 45 * MIN, peaksKey: "bands/b/sessions/s/peaks.bin" });
```

"stores null peaks and still marks the session ready when peak extraction fails" 테스트의 `toMatchObject`를 `{ status: "ready", takeCount: 1, peaks: null, peaksKey: null }`로 바꾸고 그 아래 한 줄:

```ts
    expect(calls.puts.some((k) => k.endsWith("peaks.bin"))).toBe(false);
```

(그 테스트가 `calls`를 구조분해하지 않았다면 `const { storage, calls } = fakeStorage();`로 바꾼다.)

새 테스트 추가:

```ts
  it("keeps 128-bucket peaks and ready but stores a null key when the sidecar upload fails", async () => {
    const { db, state } = fakeDb({ id: "s", bandId: "b", status: "analyzing" });
    const { storage, calls } = fakeStorage(undefined, { failPutKeys: ["bands/b/sessions/s/peaks.bin"] });
    const { ffmpeg } = fakeFfmpeg(5 * MIN);
    const analyzeFile = vi.fn().mockResolvedValue([{ startMs: 0, endMs: 2 * MIN, type: "PERFORMANCE", confidence: 0.9 }]);
    await new SessionAnalysisService(db, storage, { analyzeFile } as unknown as GeminiService, ffmpeg, tmp, 0).run("s");
    expect(state.updates.at(-1)).toMatchObject({ status: "ready", takeCount: 1, peaksKey: null });
    expect(state.updates.at(-1)!.peaks as number[]).toHaveLength(128);
    expect(calls.puts).toHaveLength(1); // take 컷만
  });
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/worker/session-analysis.service.spec.ts`
Expected: FAIL — `calls.puts` 길이 2, `peaksKey` undefined.

- [ ] **Step 3: 구현**

`session-analysis.service.ts` import 세 줄 교체:

```ts
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { peaksKey, takeKey, takesPrefix } from "../sessions/session-mapper.js";
import { PEAKS_PER_SEC, encodePeaksFile, slicePeaks } from "./peaks.js";
```

상수:

```ts
const TAKE_CONTENT_TYPE = "audio/mp4";
const PEAKS_CONTENT_TYPE = "application/octet-stream";
```

`run()` 안 `const hires = await this.extractPeaks(sessionId, original);` 바로 아래:

```ts
      // 사이드카는 take 컷보다 먼저 올린다 — 컷이 여러 개 실패해도 파형은 남는다. 실패해도 세션은 ready (스펙 결정 5)
      const sidecarKey = hires ? await this.uploadPeaks(session.bandId, sessionId, hires, workDir) : null;
```

마무리 트랜잭션 `.set({ ... peaks: ..., updatedAt: new Date() })`에 `peaksKey: sidecarKey,` 추가. 로그 한 줄을:

```ts
      this.logger.log(`session ${sessionId}: ${rows.length} takes from ${chunks.length} chunks, peaks ${hires ? hires.length : "none"}, sidecar ${sidecarKey ? "uploaded" : "none"}`);
```

`extractPeaks` 아래 메서드 추가:

```ts
  /**
   * 고해상도 피크를 peaks.bin으로 R2에 올리고 키를 돌려준다. 쓰기·업로드가 실패하면 warn 로그 + null —
   * 앱은 128버킷 폴백으로 그린다 (스펙 결정 5). retry는 같은 키를 덮어쓴다.
   */
  private async uploadPeaks(bandId: string, sessionId: string, hires: Uint8Array, workDir: string): Promise<string | null> {
    const key = peaksKey(bandId, sessionId);
    const path = join(workDir, "peaks.bin");
    try {
      await writeFile(path, encodePeaksFile(hires, PEAKS_PER_SEC));
      await this.storage.putFile(key, path, PEAKS_CONTENT_TYPE);
      return key;
    } catch (err) {
      this.logger.warn(`session ${sessionId}: peaks sidecar upload failed, storing null key: ${String(err)}`);
      return null;
    } finally {
      await unlink(path).catch(() => undefined);
    }
  }
```

- [ ] **Step 4: 통과·빌드 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/worker/session-analysis.service.spec.ts`
Expected: PASS (전부).
Run: `pnpm --filter @bandapp/api build`
Expected: 오류 없음.

- [ ] **Step 5: 커밋**

```bash
git add apps/api/src/worker/session-analysis.service.ts apps/api/src/worker/session-analysis.service.spec.ts
git commit -m "feat(worker): upload hires peaks sidecar to R2 and record its key" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `GET /sessions/:id/peaks`

**Files:**
- Modify: `apps/api/src/sessions/sessions.service.ts`
- Modify: `apps/api/src/sessions/sessions.controller.ts`
- Test: `apps/api/test/sessions.e2e-spec.ts`

**Interfaces:**
- Consumes: `SessionRow.peaksKey`(Task 2), `loadForMember`, `presignGet`, `PRESIGN_EXPIRES_SEC`.
- Produces: `GET /sessions/:id/peaks` → `AudioUrl` `{ url, expiresAt }`; 키 없으면 404 본문 `{ message, code: "peaks_not_found" }`; 비멤버 403 `band_forbidden`(기존 `assertMember`).

- [ ] **Step 1: 실패하는 e2e 테스트**

`apps/api/test/sessions.e2e-spec.ts`의 "세션 응답은 peaks를 싣는다" 테스트 뒤에:

```ts
  it("피크 사이드카 URL은 peaks_key가 있을 때만 주고, 세션 응답에는 키가 새지 않는다", async () => {
    const { session } = await createSession();
    const missing = await request(app.getHttpServer()).get(`/sessions/${session.id}/peaks`).set(auth(owner.accessToken)).expect(404);
    expect(missing.body.code).toBe("peaks_not_found");
    const key = `bands/${bandId}/sessions/${session.id}/peaks.bin`;
    await db.update(sessions).set({ peaksKey: key }).where(eq(sessions.id, session.id));
    const res = await request(app.getHttpServer()).get(`/sessions/${session.id}/peaks`).set(auth(owner.accessToken)).expect(200);
    expect(res.body).toEqual({ url: `https://fake.r2/${key}?signed`, expiresAt: expect.any(String) });
    const detail = await request(app.getHttpServer()).get(`/sessions/${session.id}`).set(auth(owner.accessToken)).expect(200);
    expect(detail.body).not.toHaveProperty("peaksKey");
  });

  it("비멤버는 피크 URL을 못 받는다", async () => {
    const { session } = await createSession();
    await db.update(sessions).set({ peaksKey: "bands/x/sessions/y/peaks.bin" }).where(eq(sessions.id, session.id));
    const other = await stranger();
    await request(app.getHttpServer()).get(`/sessions/${session.id}/peaks`).set(auth(other.accessToken)).expect(403);
  });
```

- [ ] **Step 2: 실패 확인**

Postgres가 떠 있는지 확인 후 (`docker compose up -d postgres`):
Run: `pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/sessions.e2e-spec.ts`
Expected: FAIL — 404이지만 `code`가 없음 (라우트 없음).

- [ ] **Step 3: 서비스·컨트롤러 구현**

`sessions.service.ts`, `audioUrl` 아래:

```ts
  /**
   * 고해상도 피크 사이드카의 presigned URL. 워커가 못 올렸거나 옛 세션이면 404 peaks_not_found —
   * 앱은 그때 128버킷(Session.peaks)으로 그린다 (2026-09-11 스펙 결정 5·14).
   */
  async peaksUrl(id: string, userId: string): Promise<AudioUrl> {
    const session = await this.loadForMember(id, userId);
    if (!session.peaksKey) throw new NotFoundException({ message: "파형 데이터가 아직 없어요.", code: "peaks_not_found" });
    return {
      url: await this.storage.presignGet(session.peaksKey, PRESIGN_EXPIRES_SEC),
      expiresAt: new Date(Date.now() + PRESIGN_EXPIRES_SEC * 1000).toISOString(),
    };
  }
```

`sessions.controller.ts`의 `SessionsController`, `audio` 아래:

```ts
  @Get(":id/peaks")
  peaks(@CurrentUserId() userId: string, @Param("id") id: string): Promise<AudioUrl> {
    requireUuidParam(id, "id");
    return this.sessions.peaksUrl(id, userId);
  }
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter @bandapp/api exec vitest run --config ./vitest.config.e2e.ts test/sessions.e2e-spec.ts`
Expected: PASS.
Run: `pnpm --filter @bandapp/api lint` / `pnpm --filter @bandapp/api build`
Expected: 오류 없음.

- [ ] **Step 5: 커밋**

```bash
git add apps/api/src/sessions/sessions.service.ts apps/api/src/sessions/sessions.controller.ts apps/api/test/sessions.e2e-spec.ts
git commit -m "feat(api): serve presigned peaks sidecar url" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: api-client `sessions.peaksUrl`

**Files:**
- Modify: `packages/api-client/src/client.ts` (`sessions` 인터페이스)
- Modify: `packages/api-client/src/http/HttpApiClient.ts`
- Modify: `packages/api-client/src/mock/MockApiClient.ts`
- Test: `packages/api-client/src/http/HttpApiClient.spec.ts`, `packages/api-client/src/mock/MockApiClient.spec.ts`

**Interfaces:**
- Produces: `api.sessions.peaksUrl(id: string): Promise<AudioUrl>`. Http는 `GET /sessions/:id/peaks`, Mock은 `{ url: "" }`.

- [ ] **Step 1: 실패하는 테스트**

`HttpApiClient.spec.ts` 끝에:

```ts
  it("sessions.peaksUrl은 GET /sessions/:id/peaks", async () => {
    const tokens = memoryTokens({ accessToken: "a1", refreshToken: "r1" });
    const fetchFn = vi.fn(async () => json(200, { url: "https://r2/peaks.bin", expiresAt: "2026-09-11T00:00:00.000Z" }));
    const client = new HttpApiClient({ baseUrl: "https://api.test", tokens, fetchFn });
    const res = await client.sessions.peaksUrl("s1");
    expect(res.url).toBe("https://r2/peaks.bin");
    expect(fetchFn).toHaveBeenCalledWith("https://api.test/sessions/s1/peaks", expect.objectContaining({ method: "GET" }));
  });
```

`MockApiClient.spec.ts` 끝에:

```ts
describe("MockApiClient sessions.peaksUrl", () => {
  it("Mock에는 사이드카가 없다 — 빈 url (앱은 128버킷 폴백)", async () => {
    const api = new MockApiClient();
    const res = await api.sessions.peaksUrl("s1");
    expect(res.url).toBe("");
    expect(typeof res.expiresAt).toBe("string");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @bandapp/api-client test`
Expected: FAIL — `peaksUrl is not a function` 두 곳.

- [ ] **Step 3: 구현**

`client.ts` `sessions` 인터페이스, `audioUrl` 아래:

```ts
    /** 고해상도 피크 사이드카(peaks.bin) URL. 없으면 ApiError 404 code "peaks_not_found". Mock은 url ""를 준다 → 앱은 128버킷 폴백 */
    peaksUrl(id: string): Promise<AudioUrl>;
```

`HttpApiClient.ts` `sessions`, `audioUrl` 아래:

```ts
    peaksUrl: (id: string): Promise<AudioUrl> => this.request<AudioUrl>("GET", `/sessions/${id}/peaks`),
```

`MockApiClient.ts` `sessions`, `audioUrl` 아래:

```ts
    peaksUrl: async (): Promise<AudioUrl> => ({ url: "", expiresAt: week() }),
```

- [ ] **Step 4: 통과·빌드 확인**

Run: `pnpm --filter @bandapp/api-client test`
Expected: PASS.
Run: `pnpm --filter @bandapp/api-client build`
Expected: 오류 없음.

- [ ] **Step 5: 커밋**

```bash
git add packages/api-client/src/client.ts packages/api-client/src/http/HttpApiClient.ts packages/api-client/src/http/HttpApiClient.spec.ts packages/api-client/src/mock/MockApiClient.ts packages/api-client/src/mock/MockApiClient.spec.ts
git commit -m "feat(api-client): add sessions.peaksUrl" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `lib/timeline/viewport.ts` — 좌표·clamp·팬·줌·fit

**Files:**
- Create: `apps/mobile/src/lib/timeline/viewport.ts`
- Test: `apps/mobile/src/lib/timeline/viewport.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface Viewport { startMs: number; msPerPx: number; widthPx: number }
  const CLOSEST_WINDOW_MS = 5000
  widestMsPerPx(durationMs, widthPx): number          // 전체 한 화면
  closestMsPerPx(durationMs, widthPx): number         // 5초 한 화면 (짧은 녹음이면 widest와 같음)
  timeToX(v, ms): number; xToTime(v, x): number; viewportEndMs(v): number
  clampViewport(v, durationMs): Viewport
  panViewport(v, dxPx, durationMs): Viewport          // 손가락 오른쪽 = 과거
  zoomAtFocal(v, focalX, scale, durationMs): Viewport // scale > 1 확대
  fitRange(widthPx, startMs, endMs, padFrac, durationMs): Viewport
  keepCenterOnResize(v, newWidthPx, durationMs): Viewport
  ```
  모든 함수 `"worklet"`.

- [ ] **Step 1: 실패하는 테스트**

`apps/mobile/src/lib/timeline/viewport.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  clampViewport,
  closestMsPerPx,
  fitRange,
  keepCenterOnResize,
  panViewport,
  timeToX,
  viewportEndMs,
  widestMsPerPx,
  xToTime,
  zoomAtFocal,
  type Viewport,
} from "./viewport";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DURATIONS = [10 * SEC, 1 * MIN, 10 * MIN, 2 * HOUR, 3 * HOUR, 6 * HOUR];
const WIDTHS = [320, 390, 768];

/** 시드 고정 LCG — 랜덤 불변식 테스트가 재현 가능해야 한다 */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function full(durationMs: number, widthPx: number): Viewport {
  return { startMs: 0, msPerPx: widestMsPerPx(durationMs, widthPx), widthPx };
}

function expectInvariants(v: Viewport, durationMs: number) {
  expect(v.startMs).toBeGreaterThanOrEqual(0);
  expect(viewportEndMs(v)).toBeLessThanOrEqual(durationMs + 1e-6);
  expect(v.msPerPx).toBeLessThanOrEqual(widestMsPerPx(durationMs, v.widthPx) + 1e-9);
  expect(v.msPerPx).toBeGreaterThanOrEqual(closestMsPerPx(durationMs, v.widthPx) - 1e-9);
}

describe("timeToX / xToTime", () => {
  it("서로 역함수다", () => {
    for (const d of DURATIONS) {
      for (const w of WIDTHS) {
        const v = { startMs: d / 3, msPerPx: 12.5, widthPx: w };
        for (const t of [0, d / 3, d / 2, d]) expect(xToTime(v, timeToX(v, t))).toBeCloseTo(t, 6);
      }
    }
  });
  it("viewportEndMs = start + width·msPerPx", () => {
    expect(viewportEndMs({ startMs: 1000, msPerPx: 10, widthPx: 100 })).toBe(2000);
  });
});

describe("줌 범위", () => {
  it("widest는 전체가 한 화면, closest는 5초가 한 화면", () => {
    expect(widestMsPerPx(3 * HOUR, 390)).toBeCloseTo((3 * HOUR) / 390);
    expect(closestMsPerPx(3 * HOUR, 390)).toBeCloseTo(5000 / 390);
  });
  it("5초보다 짧은 녹음은 closest가 widest와 같다 (역전 없음)", () => {
    expect(closestMsPerPx(3 * SEC, 390)).toBe(widestMsPerPx(3 * SEC, 390));
  });
  it("폭 0은 1로 취급한다", () => {
    expect(Number.isFinite(widestMsPerPx(MIN, 0))).toBe(true);
  });
});

describe("clampViewport", () => {
  it("msPerPx를 먼저 자르고 그 폭으로 startMs를 자른다", () => {
    const d = 10 * MIN;
    const v = clampViewport({ startMs: 10 * MIN, msPerPx: 1, widthPx: 390 }, d);
    expectInvariants(v, d);
    expect(v.msPerPx).toBeCloseTo(closestMsPerPx(d, 390));
    // start가 끝을 넘었으니 5초 창이 끝에 딱 걸치도록 당긴다
    expect(viewportEndMs(v)).toBeCloseTo(d);
  });
  it("녹음보다 넓게 줌아웃하면 전체 보기로 고정", () => {
    const d = MIN;
    const v = clampViewport({ startMs: 0, msPerPx: 1e9, widthPx: 390 }, d);
    expect(v.msPerPx).toBeCloseTo(widestMsPerPx(d, 390));
    expect(v.startMs).toBe(0);
  });
  it("음수 start는 0", () => {
    expect(clampViewport({ startMs: -5000, msPerPx: 100, widthPx: 100 }, HOUR).startMs).toBe(0);
  });
});

describe("panViewport", () => {
  it("오른쪽으로 끌면 과거로 간다", () => {
    const v = { startMs: 60 * SEC, msPerPx: 100, widthPx: 100 };
    expect(panViewport(v, 10, HOUR).startMs).toBe(59 * SEC);
    expect(panViewport(v, -10, HOUR).startMs).toBe(61 * SEC);
  });
  it("처음·끝을 넘지 않는다", () => {
    const v = { startMs: 0, msPerPx: 100, widthPx: 100 };
    expect(panViewport(v, 50, HOUR).startMs).toBe(0);
    const end = { startMs: HOUR - 10 * SEC, msPerPx: 100, widthPx: 100 };
    expect(panViewport(end, -50, HOUR).startMs).toBe(HOUR - 10 * SEC);
  });
});

describe("zoomAtFocal", () => {
  it("focal 아래의 시각이 그 자리에 남는다 — 0.5x~5x 20회 왕복", () => {
    const d = 3 * HOUR;
    let v = { startMs: 38 * MIN, msPerPx: 1000, widthPx: 390 };
    const focalX = 150;
    const focalMs = xToTime(v, focalX);
    const scales = [2, 0.5, 5, 0.2, 1.5, 0.75];
    for (let i = 0; i < 20; i++) {
      v = zoomAtFocal(v, focalX, scales[i % scales.length]!, d);
      expectInvariants(v, d);
      expect(Math.abs(timeToX(v, focalMs) - focalX)).toBeLessThan(0.5);
    }
  });
  it("scale > 1이면 msPerPx가 줄어든다(확대)", () => {
    const v = { startMs: 0, msPerPx: 1000, widthPx: 390 };
    expect(zoomAtFocal(v, 100, 2, HOUR).msPerPx).toBeCloseTo(500);
  });
  it("녹음 끝에서 줌아웃해도 빈 화면이 없다 (22-H)", () => {
    const d = 10 * MIN;
    const v = { startMs: d - 30 * SEC, msPerPx: closestMsPerPx(d, 390), widthPx: 390 };
    const out = zoomAtFocal(v, 380, 0.05, d);
    expectInvariants(out, d);
    expect(viewportEndMs(out)).toBeLessThanOrEqual(d);
  });
  it("최대 줌을 넘기면 5초 창에서 멈추고 focal은 유지한다", () => {
    const d = HOUR;
    const v = { startMs: 10 * MIN, msPerPx: 20, widthPx: 390 };
    const focalMs = xToTime(v, 200);
    const out = zoomAtFocal(v, 200, 100, d);
    expect(out.msPerPx).toBeCloseTo(closestMsPerPx(d, 390));
    expect(timeToX(out, focalMs)).toBeCloseTo(200, 3);
  });
});

describe("fitRange", () => {
  it("구간 + 좌우 20% 여백이 화면에 들어온다", () => {
    const d = HOUR;
    const v = fitRange(390, 10 * MIN, 12 * MIN, 0.2, d);
    expectInvariants(v, d);
    expect(timeToX(v, 10 * MIN)).toBeCloseTo(390 * 0.2 / 1.4, 3);
    expect(timeToX(v, 12 * MIN)).toBeCloseTo(390 - 390 * 0.2 / 1.4, 3);
  });
  it("녹음 전체보다 긴 fit은 전체 보기에서 멈춘다", () => {
    const d = MIN;
    const v = fitRange(390, 0, MIN, 0.2, d);
    expect(v.msPerPx).toBeCloseTo(widestMsPerPx(d, 390));
  });
  it("0 길이 구간도 터지지 않는다", () => {
    const v = fitRange(390, 5000, 5000, 0.2, MIN);
    expectInvariants(v, MIN);
  });
});

describe("keepCenterOnResize", () => {
  it("폭이 바뀌어도 중앙 시각이 같다", () => {
    const d = HOUR;
    const v = { startMs: 10 * MIN, msPerPx: 100, widthPx: 390 };
    const center = v.startMs + (v.widthPx * v.msPerPx) / 2;
    const out = keepCenterOnResize(v, 768, d);
    expectInvariants(out, d);
    expect(out.widthPx).toBe(768);
    expect(out.startMs + (out.widthPx * out.msPerPx) / 2).toBeCloseTo(center, 3);
  });
});

describe("랜덤 불변식 (2000회)", () => {
  it("pan·zoom·fit을 섞어도 viewport가 녹음 범위 안에 있고 focal이 미끄러지지 않는다", () => {
    const rnd = lcg(20260911);
    for (const d of DURATIONS) {
      for (const w of WIDTHS) {
        let v = full(d, w);
        for (let i = 0; i < 2000 / (DURATIONS.length * WIDTHS.length) + 1; i++) {
          const op = rnd();
          if (op < 0.4) {
            v = panViewport(v, (rnd() - 0.5) * 2 * w, d);
          } else if (op < 0.8) {
            const focalX = rnd() * w;
            const focalMs = xToTime(v, focalX);
            const scale = 0.25 + rnd() * 3.75;
            const next = zoomAtFocal(v, focalX, scale, d);
            // 경계에 걸려 start가 잘리지 않은 경우에만 focal 고정을 요구한다
            const unclamped = focalMs - focalX * next.msPerPx;
            if (Math.abs(unclamped - next.startMs) < 1e-6) expect(Math.abs(timeToX(next, focalMs) - focalX)).toBeLessThan(0.5);
            v = next;
          } else {
            const a = rnd() * d;
            const b = Math.min(d, a + rnd() * 5 * MIN);
            v = fitRange(w, a, b, 0.2, d);
          }
          expectInvariants(v, d);
          // 픽셀 누적이 아니라 절대 계산이므로 왕복 오차가 없다 (22-J)
          expect(xToTime(v, timeToX(v, d / 2))).toBeCloseTo(d / 2, 3);
        }
      }
    }
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter mobile exec vitest run src/lib/timeline/viewport.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현**

`apps/mobile/src/lib/timeline/viewport.ts`:

```ts
/**
 * 타임라인 좌표계 (2026-09-11 스펙 §좌표·viewport). 모든 상태는 ms가 기준이고 픽셀은 여기서만 계산한다.
 * 함수마다 "worklet"을 붙여 Reanimated UI 스레드에서 그대로 부른다 — React Native 없이 vitest로 검증한다.
 */
export interface Viewport {
  startMs: number;
  msPerPx: number;
  widthPx: number;
}

/** 최대 줌 — 화면 폭이 5초가 되는 지점 */
export const CLOSEST_WINDOW_MS = 5000;

/** 전체 녹음이 한 화면에 들어오는 msPerPx (가장 넓게) */
export function widestMsPerPx(durationMs: number, widthPx: number): number {
  "worklet";
  return Math.max(1, durationMs) / Math.max(1, widthPx);
}

/** 화면 폭이 5초가 되는 msPerPx (가장 촘촘히). 녹음이 5초보다 짧으면 widest와 같다 — 역전 방지 */
export function closestMsPerPx(durationMs: number, widthPx: number): number {
  "worklet";
  return Math.min(CLOSEST_WINDOW_MS / Math.max(1, widthPx), widestMsPerPx(durationMs, widthPx));
}

export function timeToX(v: Viewport, ms: number): number {
  "worklet";
  return (ms - v.startMs) / v.msPerPx;
}

export function xToTime(v: Viewport, x: number): number {
  "worklet";
  return v.startMs + x * v.msPerPx;
}

export function viewportEndMs(v: Viewport): number {
  "worklet";
  return v.startMs + v.widthPx * v.msPerPx;
}

/**
 * msPerPx를 [closest, widest]로 자른 뒤, 그 폭 기준으로 startMs를 [0, duration − 화면폭]으로 자른다.
 * 순서가 중요하다 — 줌이 정해져야 끝 여백을 계산할 수 있다 (22-H).
 */
export function clampViewport(v: Viewport, durationMs: number): Viewport {
  "worklet";
  const widthPx = Math.max(1, v.widthPx);
  const widest = widestMsPerPx(durationMs, widthPx);
  const closest = closestMsPerPx(durationMs, widthPx);
  const msPerPx = Math.min(widest, Math.max(closest, v.msPerPx));
  const maxStart = Math.max(0, durationMs - widthPx * msPerPx);
  const startMs = Math.min(maxStart, Math.max(0, v.startMs));
  return { startMs, msPerPx, widthPx };
}

/** 손가락이 dxPx만큼 오른쪽으로 가면 과거로 간다 */
export function panViewport(v: Viewport, dxPx: number, durationMs: number): Viewport {
  "worklet";
  return clampViewport({ startMs: v.startMs - dxPx * v.msPerPx, msPerPx: v.msPerPx, widthPx: v.widthPx }, durationMs);
}

/** focalX 아래의 시각이 줌 뒤에도 같은 x에 남는다. scale > 1이 확대. 범위 경계에 걸리면 start만 밀린다 */
export function zoomAtFocal(v: Viewport, focalX: number, scale: number, durationMs: number): Viewport {
  "worklet";
  const focalMs = xToTime(v, focalX);
  const wanted = v.msPerPx / Math.max(1e-6, scale);
  const msPerPx = clampViewport({ startMs: 0, msPerPx: wanted, widthPx: v.widthPx }, durationMs).msPerPx;
  return clampViewport({ startMs: focalMs - focalX * msPerPx, msPerPx, widthPx: v.widthPx }, durationMs);
}

/** [startMs, endMs]가 좌우 padFrac 여백과 함께 보이게. 너무 긴 구간은 전체 보기에서 멈춘다 */
export function fitRange(widthPx: number, startMs: number, endMs: number, padFrac: number, durationMs: number): Viewport {
  "worklet";
  const span = Math.max(1, endMs - startMs);
  const msPerPx = (span * (1 + 2 * padFrac)) / Math.max(1, widthPx);
  return clampViewport({ startMs: startMs - span * padFrac, msPerPx, widthPx }, durationMs);
}

/** 폭이 바뀌어도 화면 중앙 시각을 유지한다 (태블릿 split 등, 22-I) */
export function keepCenterOnResize(v: Viewport, newWidthPx: number, durationMs: number): Viewport {
  "worklet";
  const centerMs = v.startMs + (v.widthPx * v.msPerPx) / 2;
  return clampViewport({ startMs: centerMs - (newWidthPx * v.msPerPx) / 2, msPerPx: v.msPerPx, widthPx: newWidthPx }, durationMs);
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter mobile exec vitest run src/lib/timeline/viewport.test.ts`
Expected: PASS. (fitRange 여백 테스트가 소수점에서 어긋나면 기대값 계산이 아니라 `toBeCloseTo` 자릿수를 3→1로 낮춘다 — 구현의 공식은 바꾸지 않는다.)

- [ ] **Step 5: 커밋**

```bash
git add apps/mobile/src/lib/timeline/viewport.ts apps/mobile/src/lib/timeline/viewport.test.ts
git commit -m "feat(mobile): add timeline viewport math with invariant tests" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `follow.ts`·`playhead.ts` — follow 정책과 playhead 보간

**Files:**
- Create: `apps/mobile/src/lib/timeline/follow.ts`, `apps/mobile/src/lib/timeline/playhead.ts`
- Test: `apps/mobile/src/lib/timeline/follow.test.ts`, `apps/mobile/src/lib/timeline/playhead.test.ts`

**Interfaces:**
- Consumes: `Viewport`, `clampViewport`, `timeToX`(Task 6).
- Produces:
  ```ts
  FOLLOW_TRIGGER_FRAC = 0.8; FOLLOW_RESET_FRAC = 0.3
  followViewport(v, playheadMs, durationMs): Viewport | null   // null = 안 움직임
  playheadEdge(v, playheadMs): "left" | "right" | null
  interface PlayheadAnchor { seq: number; posMs: number; playing: boolean }
  MAX_EXTRAPOLATION_MS = 400
  interpolatePlayhead(anchor, elapsedMs): number
  ```

- [ ] **Step 1: 실패하는 테스트**

`follow.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { followViewport, playheadEdge } from "./follow";
import { timeToX } from "./viewport";

const HOUR = 3_600_000;
const v = { startMs: 60_000, msPerPx: 100, widthPx: 400 }; // 60s ~ 100s

describe("followViewport", () => {
  it("playhead가 80% 안쪽이면 움직이지 않는다", () => {
    expect(followViewport(v, 60_000 + 100 * 320, HOUR)).toBeNull();
    expect(followViewport(v, 60_000, HOUR)).toBeNull();
  });
  it("80%를 넘으면 playhead를 30% 위치에 놓는다", () => {
    const ms = 60_000 + 100 * 330;
    const out = followViewport(v, ms, HOUR)!;
    expect(timeToX(out, ms)).toBeCloseTo(120);
    expect(out.msPerPx).toBe(v.msPerPx);
  });
  it("화면 왼쪽 밖(뒤로 seek)이어도 30% 위치로 데려온다", () => {
    const out = followViewport(v, 10_000, HOUR)!;
    expect(timeToX(out, 10_000)).toBeCloseTo(120);
  });
  it("녹음 끝에서는 clamp된 viewport를 준다", () => {
    const end = { startMs: HOUR - 40_000, msPerPx: 100, widthPx: 400 };
    const out = followViewport(end, HOUR - 1000, HOUR)!;
    expect(out.startMs).toBe(HOUR - 40_000);
  });
});

describe("playheadEdge", () => {
  it("화면 밖이면 방향, 안이면 null", () => {
    expect(playheadEdge(v, 59_000)).toBe("left");
    expect(playheadEdge(v, 101_000)).toBe("right");
    expect(playheadEdge(v, 80_000)).toBeNull();
  });
});
```

`playhead.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { interpolatePlayhead, MAX_EXTRAPOLATION_MS } from "./playhead";

describe("interpolatePlayhead", () => {
  it("정지 중이면 anchor 그대로", () => {
    expect(interpolatePlayhead({ seq: 1, posMs: 5000, playing: false }, 300)).toBe(5000);
  });
  it("재생 중이면 흐른 시간만큼 앞으로", () => {
    expect(interpolatePlayhead({ seq: 1, posMs: 5000, playing: true }, 120)).toBe(5120);
  });
  it("400ms 넘게 status가 안 오면 거기서 멈춘다 (버퍼링·인터럽션)", () => {
    expect(interpolatePlayhead({ seq: 1, posMs: 5000, playing: true }, 5000)).toBe(5000 + MAX_EXTRAPOLATION_MS);
  });
  it("음수 elapsed는 0으로", () => {
    expect(interpolatePlayhead({ seq: 1, posMs: 5000, playing: true }, -50)).toBe(5000);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter mobile exec vitest run src/lib/timeline/follow.test.ts src/lib/timeline/playhead.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현**

`follow.ts`:

```ts
import { clampViewport, timeToX, type Viewport } from "./viewport";

/** playhead가 화면 폭의 이 비율을 넘으면 viewport를 옮긴다 (스펙 결정 10, 초안 14절) */
export const FOLLOW_TRIGGER_FRAC = 0.8;
/** 옮긴 뒤 playhead가 놓이는 위치 */
export const FOLLOW_RESET_FRAC = 0.3;

/** follow가 켜져 있을 때 viewport를 옮겨야 하면 새 viewport, 아니면 null. 애니메이션 없이 점프한다 */
export function followViewport(v: Viewport, playheadMs: number, durationMs: number): Viewport | null {
  "worklet";
  const x = timeToX(v, playheadMs);
  if (x >= 0 && x <= v.widthPx * FOLLOW_TRIGGER_FRAC) return null;
  return clampViewport(
    { startMs: playheadMs - v.widthPx * FOLLOW_RESET_FRAC * v.msPerPx, msPerPx: v.msPerPx, widthPx: v.widthPx },
    durationMs,
  );
}

/** playhead가 화면 밖이면 어느 쪽인지 — 가장자리 표시용 */
export function playheadEdge(v: Viewport, playheadMs: number): "left" | "right" | null {
  "worklet";
  const x = timeToX(v, playheadMs);
  if (x < 0) return "left";
  if (x > v.widthPx) return "right";
  return null;
}
```

`playhead.ts`:

```ts
/** expo-audio status 하나가 anchor다. seq는 새 status가 왔음을 UI 스레드에 알리는 카운터 */
export interface PlayheadAnchor {
  seq: number;
  posMs: number;
  playing: boolean;
}

/** anchor 이후 이만큼까지만 앞으로 보간한다 — status가 멈추면(버퍼링·인터럽션) playhead도 멈춘다 (스펙 결정 9) */
export const MAX_EXTRAPOLATION_MS = 400;

/** anchor 이후 elapsedMs만큼 흘렀을 때의 표시 위치 */
export function interpolatePlayhead(anchor: PlayheadAnchor, elapsedMs: number): number {
  "worklet";
  if (!anchor.playing) return anchor.posMs;
  return anchor.posMs + Math.min(MAX_EXTRAPOLATION_MS, Math.max(0, elapsedMs));
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter mobile exec vitest run src/lib/timeline`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add apps/mobile/src/lib/timeline/follow.ts apps/mobile/src/lib/timeline/follow.test.ts apps/mobile/src/lib/timeline/playhead.ts apps/mobile/src/lib/timeline/playhead.test.ts
git commit -m "feat(mobile): add follow-playhead policy and playhead interpolation" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: `levels.ts`·`peaksFile.ts` — LOD 피라미드와 사이드카 파서

**Files:**
- Create: `apps/mobile/src/lib/timeline/levels.ts`, `apps/mobile/src/lib/timeline/peaksFile.ts`
- Test: `apps/mobile/src/lib/timeline/levels.test.ts`, `apps/mobile/src/lib/timeline/peaksFile.test.ts`

**Interfaces:**
- Consumes: `xToTime`, `Viewport`(Task 6), `PEAKS_FILE_*`(Task 1).
- Produces:
  ```ts
  interface PeakLevels { levels: Uint8Array[]; peaksPerSec: number; max: number }
  LEVEL_MIN_LENGTH = 512; BAR_PX = 3; PEAKS_PER_BAR_COARSER = 3.5; PEAKS_PER_BAR_FINER = 0.8
  buildLevels(hires: Uint8Array, peaksPerSec: number): PeakLevels
  bucketsToLevels(buckets: number[], durationMs: number): PeakLevels   // 128버킷 폴백
  peaksPerBar(p, level, msPerPx, barPx): number
  selectLevel(p, msPerPx, barPx, current: number): number             // current -1 = 처음
  barsForViewport(p, level, v, barPx): number[]                       // 바마다 0~1
  parsePeaksFile(buf: ArrayBuffer): { peaksPerSec: number; peaks: Uint8Array }
  ```

- [ ] **Step 1: 실패하는 테스트**

`levels.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BAR_PX, barsForViewport, bucketsToLevels, buildLevels, peaksPerBar, selectLevel } from "./levels";

describe("buildLevels", () => {
  it("512 이하가 될 때까지 2개씩 max로 접고, 전체 max를 기억한다", () => {
    const hires = Uint8Array.from({ length: 5000 }, (_, i) => i % 200);
    const p = buildLevels(hires, 50);
    expect(p.levels.map((l) => l.length)).toEqual([5000, 2500, 1250, 625, 313]);
    expect(p.max).toBe(199);
    expect(p.peaksPerSec).toBe(50);
    // 레벨 1의 0번은 hires 0·1의 max
    expect(p.levels[1]![0]).toBe(1);
    // 홀수 길이의 마지막 원소는 짝이 없어도 살아남는다
    const odd = buildLevels(Uint8Array.from([1, 2, 3]), 50);
    expect(Array.from(odd.levels[0]!)).toEqual([1, 2, 3]);
  });
  it("무음이면 max 0", () => {
    expect(buildLevels(new Uint8Array(10), 50).max).toBe(0);
  });
  it("bucketsToLevels는 레벨 하나, peaksPerSec = 버킷 수 / 길이", () => {
    const p = bucketsToLevels(Array.from({ length: 128 }, (_, i) => i * 2), 128_000);
    expect(p.levels).toHaveLength(1);
    expect(p.peaksPerSec).toBeCloseTo(1);
    expect(p.max).toBe(254);
  });
});

describe("selectLevel", () => {
  const p = buildLevels(new Uint8Array(3 * 3600 * 50), 50); // 3시간
  it("처음에는 바당 피크가 2 이하인 첫 레벨, 없으면 가장 거친 레벨", () => {
    // 전체 보기 390px: msPerPx = 3h/390 → 레벨 0에서 바당 피크 4153. 가장 거친 레벨(264개)에서도 2.03이라 마지막 레벨
    const fullView = (3 * 3600 * 1000) / 390;
    expect(selectLevel(p, fullView, BAR_PX, -1)).toBe(p.levels.length - 1);
    // 1분 창: msPerPx = 153.8 → 레벨 0에서 23 → 레벨 4에서 1.44 (레벨 3은 2.88)
    const minuteView = 60_000 / 390;
    const k = selectLevel(p, minuteView, BAR_PX, -1);
    expect(k).toBe(4);
    expect(peaksPerBar(p, k, minuteView, BAR_PX)).toBeLessThanOrEqual(2);
    expect(peaksPerBar(p, k - 1, minuteView, BAR_PX)).toBeGreaterThan(2);
    // 5초 창: msPerPx = 12.82 → 바당 피크 1.92 → 레벨 0
    expect(selectLevel(p, 5000 / 390, BAR_PX, -1)).toBe(0);
  });
  it("hysteresis — 경계 근처에서 왔다 갔다 하지 않는다", () => {
    // 레벨 k에서 바당 피크 3.5 직전/직후
    const mAt = (k: number, ppb: number) => (ppb * 1000 * 2 ** k) / (BAR_PX * 50);
    expect(selectLevel(p, mAt(2, 3.4), BAR_PX, 2)).toBe(2);
    expect(selectLevel(p, mAt(2, 3.6), BAR_PX, 2)).toBe(3);
    // 레벨 3으로 간 뒤 3.6/2 = 1.8 — 0.8보다 크니 그대로
    expect(selectLevel(p, mAt(2, 3.6), BAR_PX, 3)).toBe(3);
    expect(selectLevel(p, mAt(3, 0.79), BAR_PX, 3)).toBe(2);
    expect(selectLevel(p, mAt(3, 0.81), BAR_PX, 3)).toBe(3);
  });
  it("레벨 범위를 벗어난 current는 처음처럼 고른다", () => {
    expect(selectLevel(p, 5000 / 390, BAR_PX, 99)).toBe(0);
  });
});

describe("barsForViewport", () => {
  it("바마다 픽셀 구간에 걸친 피크의 max / 전체 max", () => {
    // 10 peaks/s = 100ms/peak. viewport 0~1s, 폭 10px, 바 1px, 100ms/px → 10바, 바당 피크 정확히 1개 (부동소수 경계 없음)
    const p = buildLevels(Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]), 10);
    const bars = barsForViewport(p, 0, { startMs: 0, msPerPx: 100, widthPx: 10 }, 1);
    expect(bars).toHaveLength(10);
    expect(bars[0]).toBeCloseTo(0.1);
    expect(bars[9]).toBeCloseTo(1);
  });
  it("범위 밖 바는 0, 무음 피라미드는 전부 0", () => {
    const p = buildLevels(Uint8Array.from([255, 255]), 10);
    const bars = barsForViewport(p, 0, { startMs: 0, msPerPx: 100, widthPx: 30 }, 3); // 0~3s, 피크는 0.2s까지만
    expect(bars[0]).toBe(1);
    expect(bars[9]).toBe(0);
    const silent = buildLevels(new Uint8Array(20), 10);
    expect(barsForViewport(silent, 0, { startMs: 0, msPerPx: 100, widthPx: 30 }, 3).every((u) => u === 0)).toBe(true);
  });
  it("거친 레벨은 2^k 피크를 한 원소로 본다", () => {
    const hires = Uint8Array.from({ length: 2048 }, (_, i) => (i === 2047 ? 255 : 0));
    const p = buildLevels(hires, 50); // 레벨 0..2 (2048→1024→512)
    // 전체 40.96s를 30px에 — 마지막 바에 255가 있어야 한다
    const bars = barsForViewport(p, 2, { startMs: 0, msPerPx: 40960 / 30, widthPx: 30 }, 3);
    expect(bars[9]).toBe(1);
    expect(bars[0]).toBe(0);
  });
});
```

`peaksFile.test.ts`:

```ts
import { PEAKS_FILE_HEADER_BYTES } from "@bandapp/types";
import { describe, expect, it } from "vitest";
import { parsePeaksFile } from "./peaksFile";

function file(magic: string, version: number, peaksPerSec: number, body: number[]): ArrayBuffer {
  const bytes = new Uint8Array(PEAKS_FILE_HEADER_BYTES + body.length);
  for (let i = 0; i < 4; i++) bytes[i] = magic.charCodeAt(i);
  bytes[4] = version;
  bytes[5] = peaksPerSec & 0xff;
  bytes[6] = peaksPerSec >> 8;
  bytes[7] = 0;
  bytes.set(body, PEAKS_FILE_HEADER_BYTES);
  return bytes.buffer;
}

describe("parsePeaksFile", () => {
  it("헤더를 읽고 본문을 돌려준다", () => {
    const out = parsePeaksFile(file("TNPK", 1, 50, [0, 128, 255]));
    expect(out.peaksPerSec).toBe(50);
    expect(Array.from(out.peaks)).toEqual([0, 128, 255]);
  });
  it("u16 LE — 300 peaks/s", () => {
    expect(parsePeaksFile(file("TNPK", 1, 300, [])).peaksPerSec).toBe(300);
  });
  it("magic·version이 다르거나 너무 짧으면 throw", () => {
    expect(() => parsePeaksFile(file("XXXX", 1, 50, []))).toThrow(/magic/);
    expect(() => parsePeaksFile(file("TNPK", 2, 50, []))).toThrow(/version/);
    expect(() => parsePeaksFile(new ArrayBuffer(4))).toThrow(/short/);
    expect(() => parsePeaksFile(file("TNPK", 1, 0, []))).toThrow(/peaksPerSec/);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter mobile exec vitest run src/lib/timeline/levels.test.ts src/lib/timeline/peaksFile.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현**

`levels.ts`:

```ts
import { xToTime, type Viewport } from "./viewport";

/** LOD 피라미드 (2026-09-11 스펙 결정 13). levels[k]의 원소 하나는 hires 피크 2^k개의 max */
export interface PeakLevels {
  levels: Uint8Array[];
  peaksPerSec: number;
  /** hires 전체 최댓값 — 정규화 기준 (결정 6). 무음이면 0 */
  max: number;
}

/** 이 길이 이하가 되면 더 접지 않는다 */
export const LEVEL_MIN_LENGTH = 512;
/** 바 피치 — 2px 바 + 1px 간격 */
export const BAR_PX = 3;
/** hysteresis: 바당 피크가 이보다 많으면 한 단계 거칠게 */
export const PEAKS_PER_BAR_COARSER = 3.5;
/** 바당 피크가 이보다 적으면 한 단계 세밀하게 */
export const PEAKS_PER_BAR_FINER = 0.8;

export function buildLevels(hires: Uint8Array, peaksPerSec: number): PeakLevels {
  let max = 0;
  for (let i = 0; i < hires.length; i++) if (hires[i]! > max) max = hires[i]!;
  const levels: Uint8Array[] = [hires];
  let cur = hires;
  while (cur.length > LEVEL_MIN_LENGTH) {
    const next = new Uint8Array(Math.ceil(cur.length / 2));
    for (let i = 0; i < next.length; i++) {
      const a = cur[2 * i]!;
      const b = 2 * i + 1 < cur.length ? cur[2 * i + 1]! : 0;
      next[i] = a > b ? a : b;
    }
    levels.push(next);
    cur = next;
  }
  return { levels, peaksPerSec, max };
}

/** 128버킷(Session.peaks) 폴백 — 레벨 하나짜리 피라미드. 버킷 하나가 duration/128 ms (결정 14) */
export function bucketsToLevels(buckets: number[], durationMs: number): PeakLevels {
  return buildLevels(Uint8Array.from(buckets), (buckets.length * 1000) / Math.max(1, durationMs));
}

/** 레벨 k에서 바 하나(barPx)에 들어가는 피크 수 */
export function peaksPerBar(p: PeakLevels, level: number, msPerPx: number, barPx: number): number {
  "worklet";
  return (((barPx * msPerPx) / 1000) * p.peaksPerSec) / 2 ** level;
}

/**
 * 현재 레벨 기준 hysteresis — 바당 피크가 3.5를 넘으면 거칠게, 0.8 미만이면 세밀하게. 인접 레벨은 2배 차이라
 * 한 번 옮기면 [1.75, 3.5) 또는 (0.8, 1.6]에 들어가 다시 튀지 않는다. current가 범위 밖(-1)이면 처음 고른다.
 */
export function selectLevel(p: PeakLevels, msPerPx: number, barPx: number, current: number): number {
  "worklet";
  const last = p.levels.length - 1;
  let k = current;
  if (k < 0 || k > last) {
    k = 0;
    while (k < last && peaksPerBar(p, k, msPerPx, barPx) > 2) k++;
    return k;
  }
  while (k < last && peaksPerBar(p, k, msPerPx, barPx) > PEAKS_PER_BAR_COARSER) k++;
  while (k > 0 && peaksPerBar(p, k, msPerPx, barPx) < PEAKS_PER_BAR_FINER) k--;
  return k;
}

/** viewport의 바마다 0~1 높이. 바 b는 [b·barPx, (b+1)·barPx) 픽셀 구간에 걸친 피크의 max / 전체 max */
export function barsForViewport(p: PeakLevels, level: number, v: Viewport, barPx: number): number[] {
  "worklet";
  const data = p.levels[level]!;
  const perPeakMs = (1000 * 2 ** level) / p.peaksPerSec;
  const bars = Math.floor(v.widthPx / barPx);
  const out: number[] = [];
  for (let b = 0; b < bars; b++) {
    let i0 = Math.floor(xToTime(v, b * barPx) / perPeakMs);
    let i1 = Math.ceil(xToTime(v, (b + 1) * barPx) / perPeakMs);
    if (i1 <= i0) i1 = i0 + 1;
    if (i0 < 0) i0 = 0;
    if (i1 > data.length) i1 = data.length;
    let m = 0;
    for (let i = i0; i < i1; i++) if (data[i]! > m) m = data[i]!;
    out.push(p.max > 0 ? m / p.max : 0);
  }
  return out;
}
```

`peaksFile.ts`:

```ts
import { PEAKS_FILE_HEADER_BYTES, PEAKS_FILE_MAGIC, PEAKS_FILE_VERSION } from "@bandapp/types";

export interface PeaksFile {
  peaksPerSec: number;
  peaks: Uint8Array;
}

/** peaks.bin 파서 (스펙 결정 4). 형식이 다르면 throw — 화면은 128버킷 폴백으로 내려간다 */
export function parsePeaksFile(buf: ArrayBuffer): PeaksFile {
  if (buf.byteLength < PEAKS_FILE_HEADER_BYTES) throw new Error("peaks file too short");
  const bytes = new Uint8Array(buf);
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (magic !== PEAKS_FILE_MAGIC) throw new Error(`bad peaks magic: ${magic}`);
  const version = bytes[4]!;
  if (version !== PEAKS_FILE_VERSION) throw new Error(`unsupported peaks version: ${version}`);
  const peaksPerSec = bytes[5]! | (bytes[6]! << 8);
  if (peaksPerSec === 0) throw new Error("peaksPerSec is 0");
  return { peaksPerSec, peaks: bytes.slice(PEAKS_FILE_HEADER_BYTES) };
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter mobile exec vitest run src/lib/timeline`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add apps/mobile/src/lib/timeline/levels.ts apps/mobile/src/lib/timeline/levels.test.ts apps/mobile/src/lib/timeline/peaksFile.ts apps/mobile/src/lib/timeline/peaksFile.test.ts
git commit -m "feat(mobile): add peak LOD pyramid, level selection and peaks.bin parser" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: `ruler.ts` — 시간 눈금

**Files:**
- Create: `apps/mobile/src/lib/timeline/ruler.ts`
- Test: `apps/mobile/src/lib/timeline/ruler.test.ts`

**Interfaces:**
- Consumes: `timeToX`, `viewportEndMs`, `Viewport`(Task 6), `fmtClock`(`../time`).
- Produces: `TICK_STEPS_MS`, `MIN_LABEL_PX = 80`, `tickStepMs(msPerPx): number`, `rulerTicks(v): { xPx, ms, label }[]`.

- [ ] **Step 1: 실패하는 테스트**

```ts
import { describe, expect, it } from "vitest";
import { MIN_LABEL_PX, rulerTicks, tickStepMs } from "./ruler";

describe("tickStepMs", () => {
  it("라벨 간격이 80px 이상이 되는 첫 단계", () => {
    expect(tickStepMs(5000 / 390)).toBe(5000); // 1s는 78px라 탈락
    expect(tickStepMs(1)).toBe(1000);
    expect(tickStepMs(60_000 / 390)).toBe(30_000);
    expect(tickStepMs((3 * 3_600_000) / 390)).toBe(3_600_000); // 1h도 130px
  });
  it("사다리 끝을 넘으면 마지막 단계", () => {
    expect(tickStepMs(1e9)).toBe(3_600_000);
  });
});

describe("rulerTicks", () => {
  it("viewport 안의 step 배수마다 x와 라벨", () => {
    const ticks = rulerTicks({ startMs: 62_000, msPerPx: 100, widthPx: 400 }); // 62s~102s, step 10s
    expect(ticks.map((t) => t.ms)).toEqual([70_000, 80_000, 90_000, 100_000]);
    expect(ticks[0]!.xPx).toBe(80);
    expect(ticks.map((t) => t.label)).toEqual(["01:10", "01:20", "01:30", "01:40"]);
  });
  it("1시간 이상은 h:mm:ss", () => {
    const ticks = rulerTicks({ startMs: 3_600_000 - 1000, msPerPx: 100, widthPx: 400 });
    expect(ticks[0]!.label).toBe("1:00:00");
  });
  it("라벨 사이 간격이 MIN_LABEL_PX 이상", () => {
    const ticks = rulerTicks({ startMs: 0, msPerPx: 12.82, widthPx: 390 });
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]!.xPx - ticks[i - 1]!.xPx).toBeGreaterThanOrEqual(MIN_LABEL_PX);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter mobile exec vitest run src/lib/timeline/ruler.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현**

```ts
import { fmtClock } from "../time";
import { timeToX, viewportEndMs, type Viewport } from "./viewport";

/** 눈금 간격 사다리 — 줌에 따라 라벨이 80px 이상 떨어지는 첫 단계를 고른다 */
export const TICK_STEPS_MS = [1_000, 5_000, 10_000, 30_000, 60_000, 300_000, 600_000, 1_800_000, 3_600_000];
export const MIN_LABEL_PX = 80;

export interface RulerTick {
  xPx: number;
  ms: number;
  label: string;
}

export function tickStepMs(msPerPx: number): number {
  for (const step of TICK_STEPS_MS) if (step / msPerPx >= MIN_LABEL_PX) return step;
  return TICK_STEPS_MS[TICK_STEPS_MS.length - 1]!;
}

/** viewport 안에 있는 step 배수마다 눈금. 라벨은 앱 공통 fmtClock (mm:ss / h:mm:ss) */
export function rulerTicks(v: Viewport): RulerTick[] {
  const step = tickStepMs(v.msPerPx);
  const first = Math.ceil(v.startMs / step) * step;
  const end = viewportEndMs(v);
  const out: RulerTick[] = [];
  for (let ms = first; ms <= end; ms += step) out.push({ xPx: timeToX(v, ms), ms, label: fmtClock(ms / 1000) });
  return out;
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter mobile exec vitest run src/lib/timeline`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add apps/mobile/src/lib/timeline/ruler.ts apps/mobile/src/lib/timeline/ruler.test.ts
git commit -m "feat(mobile): add timeline ruler tick math" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: `useSessionPeaks` — 사이드카 로드와 폴백

**Files:**
- Create: `apps/mobile/src/features/timeline/useSessionPeaks.ts`

**Interfaces:**
- Consumes: `api.sessions.peaksUrl`(Task 5), `parsePeaksFile`, `buildLevels`, `bucketsToLevels`(Task 8), `ApiError`(`@bandapp/api-client`).
- Produces:
  ```ts
  type PeaksSource = "hires" | "buckets" | "none"
  interface SessionPeaks { loading: boolean; levels: PeakLevels | null; source: PeaksSource }
  useSessionPeaks(sessionId: string | undefined, buckets: number[] | null | undefined, durationMs: number): SessionPeaks
  ```

- [ ] **Step 1: 구현** (훅은 RN 테스트 인프라가 없어 단위 테스트 없이 프리뷰에서 확인한다 — 순수 부분은 Task 8이 덮는다)

```ts
import { ApiError } from "@bandapp/api-client";
import { useEffect, useState } from "react";
import { useApi } from "@/api";
import { bucketsToLevels, buildLevels, type PeakLevels } from "@/lib/timeline/levels";
import { parsePeaksFile } from "@/lib/timeline/peaksFile";

export type PeaksSource = "hires" | "buckets" | "none";

export interface SessionPeaks {
  loading: boolean;
  levels: PeakLevels | null;
  source: PeaksSource;
}

/**
 * 사이드카(peaks.bin)를 받아 LOD 피라미드를 만든다 (2026-09-11 스펙 결정 3·13). 404(옛 세션)·빈 URL(Mock)·
 * 파싱 실패면 128버킷으로, 그것도 없으면 none. 화면에 있는 동안만 메모리에 둔다 — 디스크 캐시는 범위 밖.
 */
export function useSessionPeaks(sessionId: string | undefined, buckets: number[] | null | undefined, durationMs: number): SessionPeaks {
  const api = useApi();
  const [state, setState] = useState<SessionPeaks>({ loading: true, levels: null, source: "none" });

  useEffect(() => {
    if (!sessionId || durationMs <= 0) return;
    let cancelled = false;
    const fallback = (): SessionPeaks =>
      buckets && buckets.length > 0
        ? { loading: false, levels: bucketsToLevels(buckets, durationMs), source: "buckets" }
        : { loading: false, levels: null, source: "none" };

    const load = async (): Promise<SessionPeaks> => {
      try {
        const { url } = await api.sessions.peaksUrl(sessionId);
        if (!url) return fallback();
        const res = await fetch(url);
        if (!res.ok) throw new Error(`peaks fetch failed: ${res.status}`);
        const file = parsePeaksFile(await res.arrayBuffer());
        return { loading: false, levels: buildLevels(file.peaks, file.peaksPerSec), source: "hires" };
      } catch (err) {
        // 404는 정상 경로(옛 세션)라 조용히, 나머지는 원인을 남긴다
        if (!(err instanceof ApiError && err.status === 404)) console.warn("useSessionPeaks: falling back to buckets", err);
        return fallback();
      }
    };

    void load().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [api, sessionId, buckets, durationMs]);

  return state;
}
```

- [ ] **Step 2: 타입 확인**

Run: `pnpm --filter mobile typecheck`
Expected: 오류 없음 (`@bandapp/api-client` dist가 Task 5에서 빌드돼 있어야 한다).

- [ ] **Step 3: 커밋**

```bash
git add apps/mobile/src/features/timeline/useSessionPeaks.ts
git commit -m "feat(mobile): load peaks sidecar into LOD levels with bucket fallback" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: `usePlaybackClock`·`useFollowPlayhead`

**Files:**
- Create: `apps/mobile/src/features/timeline/usePlaybackClock.ts`
- Create: `apps/mobile/src/features/timeline/useFollowPlayhead.ts`

**Interfaces:**
- Consumes: `interpolatePlayhead`, `PlayheadAnchor`(Task 7), `followViewport`(Task 7), `TimelineViewportState`(Task 12 — `startMs`, `msPerPx`, `widthPx`, `follow` shared values).
- Produces:
  ```ts
  interface PlaybackClock { playheadMs: SharedValue<number>; playing: boolean; positionMs: number; error: string | null; toggle(): void; seekTo(ms: number): void }
  usePlaybackClock(url: string | null, durationMs: number): PlaybackClock
  interface FollowPlayhead { following: boolean; returnToPlayhead(): void }
  useFollowPlayhead(vp: TimelineViewportState, playheadMs: SharedValue<number>, durationMs: number, playing: boolean): FollowPlayhead
  ```
  Task 12가 `TimelineViewportState`를 정의하므로 이 Task는 Task 12와 같은 커밋 전에 typecheck가 안 맞을 수 있다 — Task 12까지 끝내고 함께 typecheck한다.

- [ ] **Step 1: `usePlaybackClock` 구현**

```ts
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFrameCallback, useSharedValue, type SharedValue } from "react-native-reanimated";
import { interpolatePlayhead, type PlayheadAnchor } from "@/lib/timeline/playhead";

const STATUS_INTERVAL_MS = 200;

export interface PlaybackClock {
  /** UI 스레드에서 매 프레임 보간되는 표시 위치 (ms) */
  playheadMs: SharedValue<number>;
  playing: boolean;
  /** 클럭 라벨용 — status 간격(200ms)으로만 바뀐다 */
  positionMs: number;
  error: string | null;
  toggle: () => void;
  seekTo: (ms: number) => void;
}

/**
 * 재생 위치의 기준은 expo-audio status(200ms)다 (2026-09-11 스펙 결정 9). status가 anchor가 되고
 * useFrameCallback이 그 사이를 최대 400ms까지 보간한다. anchor를 본 프레임 시각(seenAt)에서부터 재니
 * JS·UI 스레드 시계가 달라도 상관없다. seek 중에는 도착하는 status를 무시하고 목표 위치에 고정한다.
 * url이 없으면(Mock) 200ms 타이머가 anchor를 흉내 낸다 — 기존 usePlayback의 시뮬레이션과 같은 역할.
 */
export function usePlaybackClock(url: string | null, durationMs: number): PlaybackClock {
  const source = useMemo(() => (url ? { uri: url } : null), [url]);
  const player = useAudioPlayer(source, { updateInterval: STATUS_INTERVAL_MS });
  const status = useAudioPlayerStatus(player);

  const anchor = useSharedValue<PlayheadAnchor>({ seq: 0, posMs: 0, playing: false });
  const seenSeq = useSharedValue(-1);
  const seenAt = useSharedValue(0);
  const playheadMs = useSharedValue(0);
  const seqRef = useRef(0);
  const seekPendingRef = useRef(false);
  const [positionMs, setPositionMs] = useState(0);
  const [simPlaying, setSimPlaying] = useState(false);
  const simPosRef = useRef(0);

  const setAnchor = useCallback(
    (posMs: number, playing: boolean) => {
      seqRef.current += 1;
      anchor.value = { seq: seqRef.current, posMs, playing };
      setPositionMs(posMs);
    },
    [anchor],
  );

  // 실제 플레이어: status → anchor. seek 대기 중이면 옛 status가 playhead를 되돌리지 못하게 무시한다 (22-D)
  useEffect(() => {
    if (!url || seekPendingRef.current) return;
    setAnchor(status.currentTime * 1000, status.playing && !status.isBuffering);
  }, [url, status.currentTime, status.playing, status.isBuffering, setAnchor]);

  // Mock: 200ms마다 anchor를 앞으로
  useEffect(() => {
    if (url || !simPlaying) return;
    const t = setInterval(() => {
      const next = simPosRef.current + STATUS_INTERVAL_MS;
      if (next >= durationMs) {
        simPosRef.current = durationMs;
        setSimPlaying(false);
        setAnchor(durationMs, false);
      } else {
        simPosRef.current = next;
        setAnchor(next, true);
      }
    }, STATUS_INTERVAL_MS);
    return () => clearInterval(t);
  }, [url, simPlaying, durationMs, setAnchor]);

  // 프레임마다: 새 anchor면 그 프레임 시각을 기억하고, 거기서 흐른 만큼 보간
  useFrameCallback((frame) => {
    const a = anchor.value;
    if (a.seq !== seenSeq.value) {
      seenSeq.value = a.seq;
      seenAt.value = frame.timestamp;
    }
    playheadMs.value = interpolatePlayhead(a, frame.timestamp - seenAt.value);
  });

  const totalMs = url ? (status.duration ? status.duration * 1000 : durationMs) : durationMs;
  const playing = url ? status.playing : simPlaying;

  const seekTo = useCallback(
    (ms: number) => {
      const target = Math.max(0, Math.min(totalMs, ms));
      if (!url) {
        simPosRef.current = target;
        setAnchor(target, simPlaying);
        return;
      }
      seekPendingRef.current = true;
      setAnchor(target, false);
      void player.seekTo(target / 1000).finally(() => {
        seekPendingRef.current = false;
      });
    },
    [url, totalMs, simPlaying, player, setAnchor],
  );

  const toggle = useCallback(() => {
    if (!url) {
      if (simPlaying) {
        setAnchor(simPosRef.current, false);
        setSimPlaying(false);
        return;
      }
      if (simPosRef.current >= durationMs) simPosRef.current = 0;
      setAnchor(simPosRef.current, true);
      setSimPlaying(true);
      return;
    }
    if (status.playing) {
      player.pause();
      return;
    }
    if (status.didJustFinish || status.currentTime * 1000 >= totalMs) void player.seekTo(0);
    player.play();
  }, [url, simPlaying, durationMs, status.playing, status.didJustFinish, status.currentTime, totalMs, player, setAnchor]);

  return { playheadMs, playing, positionMs, error: url ? (status.error ?? null) : null, toggle, seekTo };
}
```

- [ ] **Step 2: `useFollowPlayhead` 구현**

```ts
import { useCallback, useEffect, useState } from "react";
import { runOnUI, useAnimatedReaction, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { followViewport } from "@/lib/timeline/follow";
import type { TimelineViewportState } from "./useTimelineViewport";

export interface FollowPlayhead {
  /** React 미러 — "재생 위치로" 버튼 표시용 */
  following: boolean;
  returnToPlayhead: () => void;
}

/**
 * 재생 시작 → ON, 사용자 팬/핀치 → OFF(useTimelineViewport의 제스처가 끈다), 버튼 → ON + 이동 (스펙 결정 10).
 * follow 자체는 vp.follow shared value에 산다 — 제스처 worklet과 이 훅이 같은 값을 본다.
 */
export function useFollowPlayhead(vp: TimelineViewportState, playheadMs: SharedValue<number>, durationMs: number, playing: boolean): FollowPlayhead {
  const [following, setFollowing] = useState(false);

  useEffect(() => {
    if (playing) vp.follow.value = true;
  }, [playing, vp.follow]);

  useAnimatedReaction(
    () => vp.follow.value,
    (on, prev) => {
      if (on !== prev) scheduleOnRN(setFollowing, on);
    },
  );

  useAnimatedReaction(
    () => playheadMs.value,
    (ms) => {
      if (!vp.follow.value) return;
      const next = followViewport({ startMs: vp.startMs.value, msPerPx: vp.msPerPx.value, widthPx: vp.widthPx.value }, ms, durationMs);
      if (next) vp.startMs.value = next.startMs;
    },
    [durationMs],
  );

  const returnToPlayhead = useCallback(() => {
    runOnUI((duration: number) => {
      "worklet";
      vp.follow.value = true;
      const v = { startMs: vp.startMs.value, msPerPx: vp.msPerPx.value, widthPx: vp.widthPx.value };
      const next = followViewport(v, playheadMs.value, duration);
      if (next) vp.startMs.value = next.startMs;
    })(durationMs);
  }, [vp, playheadMs, durationMs]);

  return { following, returnToPlayhead };
}
```

- [ ] **Step 3: 커밋** (typecheck는 Task 12 끝에서)

```bash
git add apps/mobile/src/features/timeline/usePlaybackClock.ts apps/mobile/src/features/timeline/useFollowPlayhead.ts
git commit -m "feat(mobile): add playback clock interpolation and follow-playhead hooks" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: gesture-handler 의존성, 루트 뷰, `useTimelineViewport`

**Files:**
- Modify: `apps/mobile/package.json` (`react-native-gesture-handler` 추가)
- Modify: `apps/mobile/app/_layout.tsx`
- Create: `apps/mobile/src/features/timeline/useTimelineViewport.ts`

**Interfaces:**
- Consumes: `clampViewport`, `keepCenterOnResize`, `panViewport`, `widestMsPerPx`, `zoomAtFocal`, `Viewport`(Task 6).
- Produces:
  ```ts
  type ActiveGesture = "pan" | "pinch" | null
  interface TimelineViewportState {
    startMs: SharedValue<number>; msPerPx: SharedValue<number>; widthPx: SharedValue<number>;
    follow: SharedValue<boolean>; activeGesture: SharedValue<ActiveGesture>;
    gesture: ComposedGesture;                 // <GestureDetector gesture={vp.gesture}>
    onLayout(e: LayoutChangeEvent): void;     // 파형 컨테이너에
    setViewport(v: Viewport): void;           // JS에서 통째로 (take fit)
    snapshot(): Viewport;                     // JS에서 읽기 (탭 → 시각)
  }
  useTimelineViewport(durationMs: number, onTap: (xPx: number, yPx: number) => void): TimelineViewportState
  ```

- [ ] **Step 1: 의존성 추가**

`node_modules/expo/bundledNativeModules.json`에서 `react-native-gesture-handler`의 SDK 57 버전을 확인한다(잠긴 3.2.1과 맞아야 한다). 그 뒤:

Run: `pnpm --filter mobile add react-native-gesture-handler@3.2.1`
Expected: `apps/mobile/package.json` dependencies에 `"react-native-gesture-handler": "3.2.1"`, lockfile은 이미 같은 버전이라 새 다운로드 없음. (`expo install`이 `.env` 문제로 실패하는 이력이 있어 pnpm을 직접 쓴다.) bundledNativeModules의 버전이 다르면 그 버전으로 맞춘다.

- [ ] **Step 2: 루트 뷰**

`apps/mobile/app/_layout.tsx`:

```ts
import { GestureHandlerRootView } from "react-native-gesture-handler";
```

`RootLayout`의 return을 `GestureHandlerRootView`로 감싼다:

```tsx
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        {/* ...기존 그대로 */}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
```

- [ ] **Step 3: `useTimelineViewport` 구현**

```ts
import { useCallback, useEffect } from "react";
import type { LayoutChangeEvent } from "react-native";
import {
  useCompetingGestures,
  usePanGesture,
  usePinchGesture,
  useSimultaneousGestures,
  useTapGesture,
  type ComposedGesture,
} from "react-native-gesture-handler";
import { runOnUI, useSharedValue, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { clampViewport, keepCenterOnResize, panViewport, widestMsPerPx, zoomAtFocal, type Viewport } from "@/lib/timeline/viewport";

export type ActiveGesture = "pan" | "pinch" | null;

export interface TimelineViewportState {
  startMs: SharedValue<number>;
  msPerPx: SharedValue<number>;
  widthPx: SharedValue<number>;
  /** 재생 위치 따라가기 — 제스처가 시작되면 여기서 끈다 (스펙 결정 10) */
  follow: SharedValue<boolean>;
  activeGesture: SharedValue<ActiveGesture>;
  gesture: ComposedGesture;
  onLayout: (e: LayoutChangeEvent) => void;
  /** JS에서 viewport를 통째로 바꾼다 (take fit 등). clamp된다 */
  setViewport: (v: Viewport) => void;
  /** JS에서 현재 viewport를 읽는다 (탭 → 시각 변환) */
  snapshot: () => Viewport;
}

/**
 * viewport 두 값(startMs, msPerPx)은 shared value로만 살고 React state가 없다 (스펙 §상태 구분).
 * 팬은 changeX 증분을 현재 viewport에 더하고, 핀치는 onBegin 시점 viewport 기준 절대 scale로 계산한다.
 * 둘이 동시에 오면 팬이 핀치 origin의 startMs도 같이 밀어 서로 덮어쓰지 않는다 (결정 8, 초안 22-G).
 * 모든 콜백은 UI 스레드 worklet — React 리렌더 없이 매 프레임 갱신된다.
 */
export function useTimelineViewport(durationMs: number, onTap: (xPx: number, yPx: number) => void): TimelineViewportState {
  const startMs = useSharedValue(0);
  const msPerPx = useSharedValue(1);
  const widthPx = useSharedValue(0);
  const follow = useSharedValue(false);
  const activeGesture = useSharedValue<ActiveGesture>(null);
  const pinchOrigin = useSharedValue<Viewport | null>(null);

  const pan = usePanGesture({
    activeOffsetX: [-6, 6],
    onBegin: () => {
      "worklet";
      follow.value = false;
      activeGesture.value = "pan";
    },
    onUpdate: (e) => {
      "worklet";
      const v = panViewport({ startMs: startMs.value, msPerPx: msPerPx.value, widthPx: widthPx.value }, e.changeX, durationMs);
      startMs.value = v.startMs;
      const o = pinchOrigin.value;
      if (o) pinchOrigin.value = { startMs: o.startMs - e.changeX * o.msPerPx, msPerPx: o.msPerPx, widthPx: o.widthPx };
    },
    onFinalize: () => {
      "worklet";
      activeGesture.value = null;
    },
  });

  const pinch = usePinchGesture({
    onBegin: () => {
      "worklet";
      follow.value = false;
      activeGesture.value = "pinch";
      pinchOrigin.value = { startMs: startMs.value, msPerPx: msPerPx.value, widthPx: widthPx.value };
    },
    onUpdate: (e) => {
      "worklet";
      const o = pinchOrigin.value;
      if (!o) return;
      const v = zoomAtFocal(o, e.focalX, e.scale, durationMs);
      startMs.value = v.startMs;
      msPerPx.value = v.msPerPx;
    },
    onFinalize: () => {
      "worklet";
      pinchOrigin.value = null;
      activeGesture.value = null;
    },
  });

  const tap = useTapGesture({
    onActivate: (e) => {
      "worklet";
      scheduleOnRN(onTap, e.x, e.y);
    },
  });

  const panPinch = useSimultaneousGestures(pan, pinch);
  const gesture = useCompetingGestures(panPinch, tap);

  const onLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const width = e.nativeEvent.layout.width;
      runOnUI((w: number, duration: number) => {
        "worklet";
        if (widthPx.value === 0) {
          widthPx.value = w;
          msPerPx.value = widestMsPerPx(duration, w);
          startMs.value = 0;
          return;
        }
        if (w === widthPx.value) return;
        const v = keepCenterOnResize({ startMs: startMs.value, msPerPx: msPerPx.value, widthPx: widthPx.value }, w, duration);
        widthPx.value = v.widthPx;
        msPerPx.value = v.msPerPx;
        startMs.value = v.startMs;
      })(width, durationMs);
    },
    [durationMs, widthPx, msPerPx, startMs],
  );

  // duration이 늦게 들어오거나 바뀌면 지금 viewport를 다시 clamp한다
  useEffect(() => {
    runOnUI((duration: number) => {
      "worklet";
      if (widthPx.value === 0) return;
      const v = clampViewport({ startMs: startMs.value, msPerPx: msPerPx.value, widthPx: widthPx.value }, duration);
      startMs.value = v.startMs;
      msPerPx.value = v.msPerPx;
    })(durationMs);
  }, [durationMs, widthPx, msPerPx, startMs]);

  const setViewport = useCallback(
    (next: Viewport) => {
      runOnUI((v: Viewport, duration: number) => {
        "worklet";
        const c = clampViewport(v, duration);
        startMs.value = c.startMs;
        msPerPx.value = c.msPerPx;
      })(next, durationMs);
    },
    [durationMs, startMs, msPerPx],
  );

  const snapshot = useCallback(
    (): Viewport => ({ startMs: startMs.value, msPerPx: msPerPx.value, widthPx: widthPx.value }),
    [startMs, msPerPx, widthPx],
  );

  return { startMs, msPerPx, widthPx, follow, activeGesture, gesture, onLayout, setViewport, snapshot };
}
```

- [ ] **Step 4: 타입 확인 (Task 11 포함)**

Run: `pnpm --filter mobile typecheck`
Expected: 오류 없음. RNGH v3 훅의 `onUpdate` 이벤트 타입에 `changeX`/`focalX`/`scale`이 없다고 나오면 `PanGestureActiveEvent`·`PinchGestureActiveEvent`를 `react-native-gesture-handler`에서 import해 콜백 매개변수에 명시한다. `useTapGesture`에 `onActivate`가 없다고 나오면 `onDeactivate: (e) => { if (!e.canceled) scheduleOnRN(onTap, e.x, e.y) }`로 바꾼다 — 둘 중 어느 쪽이든 탭 완료 시점 한 번만 불려야 한다.

- [ ] **Step 5: 커밋**

```bash
git add apps/mobile/package.json pnpm-lock.yaml apps/mobile/app/_layout.tsx apps/mobile/src/features/timeline/useTimelineViewport.ts
git commit -m "feat(mobile): add gesture-handler root and timeline viewport gestures" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: `WaveformCanvas`·`TimeRuler` — SVG 파형, take 레인, playhead, 눈금

**Files:**
- Modify: `apps/mobile/src/lib/peaks.ts` (`barHeight`에 `"worklet"`)
- Create: `apps/mobile/src/features/timeline/WaveformCanvas.tsx`
- Create: `apps/mobile/src/features/timeline/TimeRuler.tsx`

**Interfaces:**
- Consumes: `TimelineViewportState`(Task 12), `PeakLevels`·`selectLevel`·`barsForViewport`·`BAR_PX`(Task 8), `timeToX`(Task 6), `playheadEdge`(Task 7), `rulerTicks`(Task 9), `barHeight`(`@/lib/peaks`).
- Produces:
  ```ts
  RULER_H = 18; LANE_H = 22; WAVE_H = 120
  interface TakeSpans { starts: number[]; ends: number[] }
  WaveformCanvas({ levels, vp, playheadMs, takes: SharedValue<TakeSpans>, selectedIndex: SharedValue<number>, level: SharedValue<number> })
    // 높이 LANE_H + WAVE_H. 탭 y < LANE_H면 take 레인 (Task 15의 onTap이 판단)
  TimeRuler({ vp })   // 높이 RULER_H
  ```

- [ ] **Step 1: `barHeight`를 worklet으로**

`apps/mobile/src/lib/peaks.ts`의 `barHeight` 본문 첫 줄에 `"worklet";`를 넣는다. 기존 테스트 `src/lib/peaks.test.ts`가 그대로 통과해야 한다:

Run: `pnpm --filter mobile exec vitest run src/lib/peaks.test.ts`
Expected: PASS.

- [ ] **Step 2: `WaveformCanvas` 구현**

```tsx
import { View } from "react-native";
import Animated, { useAnimatedProps, useAnimatedStyle, useDerivedValue, type SharedValue } from "react-native-reanimated";
import Svg, { G, Path, Rect } from "react-native-svg";
import { barHeight } from "@/lib/peaks";
import { playheadEdge } from "@/lib/timeline/follow";
import { BAR_PX, barsForViewport, selectLevel, type PeakLevels } from "@/lib/timeline/levels";
import { timeToX, type Viewport } from "@/lib/timeline/viewport";
import { useTheme } from "@/theme";
import type { TimelineViewportState } from "./useTimelineViewport";

export const RULER_H = 18;
export const LANE_H = 22;
export const WAVE_H = 120;

export interface TakeSpans {
  starts: number[];
  ends: number[];
}

const APath = Animated.createAnimatedComponent(Path);
const ARect = Animated.createAnimatedComponent(Rect);

/** 바 하나의 path 조각 — 2px 바, 아래 정렬 */
function bar(x: number, h: number): string {
  "worklet";
  return `M${x} ${WAVE_H - h}h2v${h}h-2z`;
}

function spanRect(v: Viewport, startMs: number, endMs: number): { x0: number; x1: number } | null {
  "worklet";
  const x0 = Math.max(-2, timeToX(v, startMs));
  const x1 = Math.min(v.widthPx + 2, timeToX(v, endMs));
  if (x1 <= 0 || x0 >= v.widthPx) return null;
  return { x0, x1 };
}

/**
 * 파형·take 레인·playhead. 모든 기하는 shared value에서 매 프레임 UI 스레드가 계산하고 animatedProps로 흘린다 —
 * 팬·줌·재생 중 이 컴포넌트는 리렌더되지 않는다 (2026-09-11 스펙 결정 7, §파형 렌더링).
 */
export function WaveformCanvas({
  levels,
  vp,
  playheadMs,
  takes,
  selectedIndex,
  level,
}: {
  levels: PeakLevels | null;
  vp: TimelineViewportState;
  playheadMs: SharedValue<number>;
  takes: SharedValue<TakeSpans>;
  /** -1이면 선택 없음 */
  selectedIndex: SharedValue<number>;
  /** 현재 LOD — 디버그 오버레이용 출력 */
  level: SharedValue<number>;
}) {
  const { colors } = useTheme();

  // 바 path 두 개: playhead 이전(accent) / 이후(muted). 레벨은 hysteresis 상태라 shared value에 기억한다
  const paths = useDerivedValue(() => {
    const v = { startMs: vp.startMs.value, msPerPx: vp.msPerPx.value, widthPx: vp.widthPx.value };
    if (!levels || v.widthPx === 0) return { played: "", rest: "" };
    const k = selectLevel(levels, v.msPerPx, BAR_PX, level.value);
    level.value = k;
    const units = barsForViewport(levels, k, v, BAR_PX);
    const px = timeToX(v, playheadMs.value);
    let played = "";
    let rest = "";
    for (let b = 0; b < units.length; b++) {
      const x = b * BAR_PX;
      const d = bar(x, barHeight(units[b]!, WAVE_H, 3));
      if (x + BAR_PX <= px) played += d;
      else rest += d;
    }
    return { played, rest };
  }, [levels]);
  const playedProps = useAnimatedProps(() => ({ d: paths.value.played }));
  const restProps = useAnimatedProps(() => ({ d: paths.value.rest }));

  // take 레인: 선택 안 된 take는 path 하나, 선택된 take는 Rect(레인) + 파형 위 반투명 Rect
  const laneProps = useAnimatedProps(() => {
    const v = { startMs: vp.startMs.value, msPerPx: vp.msPerPx.value, widthPx: vp.widthPx.value };
    const t = takes.value;
    let d = "";
    for (let i = 0; i < t.starts.length; i++) {
      if (i === selectedIndex.value) continue;
      const r = spanRect(v, t.starts[i]!, t.ends[i]!);
      if (!r) continue;
      const w = Math.max(1, r.x1 - r.x0);
      d += `M${r.x0} 4h${w}v${LANE_H - 8}h-${w}z`;
    }
    return { d };
  });
  const selectedProps = useAnimatedProps(() => {
    const v = { startMs: vp.startMs.value, msPerPx: vp.msPerPx.value, widthPx: vp.widthPx.value };
    const i = selectedIndex.value;
    const t = takes.value;
    if (i < 0 || i >= t.starts.length) return { x: 0, width: 0 };
    const r = spanRect(v, t.starts[i]!, t.ends[i]!);
    return r ? { x: r.x0, width: Math.max(1, r.x1 - r.x0) } : { x: 0, width: 0 };
  });

  // playhead: 화면 안이면 그 x, 밖이면 숨기고 가장자리 표시
  const playheadStyle = useAnimatedStyle(() => {
    const v = { startMs: vp.startMs.value, msPerPx: vp.msPerPx.value, widthPx: vp.widthPx.value };
    const x = timeToX(v, playheadMs.value);
    const on = x >= 0 && x <= v.widthPx;
    return { transform: [{ translateX: on ? x : 0 }], opacity: on ? 1 : 0 };
  });
  const edgeStyle = (side: "left" | "right") =>
    useAnimatedStyle(() => {
      const v = { startMs: vp.startMs.value, msPerPx: vp.msPerPx.value, widthPx: vp.widthPx.value };
      return { opacity: playheadEdge(v, playheadMs.value) === side ? 1 : 0 };
    });
  const leftEdge = edgeStyle("left");
  const rightEdge = edgeStyle("right");

  return (
    <View onLayout={vp.onLayout} style={{ width: "100%", height: LANE_H + WAVE_H }}>
      <Svg width="100%" height={LANE_H + WAVE_H}>
        {/* take 레인 (y 0..LANE_H) */}
        <APath animatedProps={laneProps} fill={colors.borderStronger} />
        <ARect animatedProps={selectedProps} y={4} height={LANE_H - 8} rx={2} fill={colors.accent} />
        {/* 파형 (y LANE_H..) — 그룹으로 내린다 */}
        <G y={LANE_H}>
          <APath animatedProps={restProps} fill={colors.borderStronger} />
          <APath animatedProps={playedProps} fill={colors.accent} />
          <ARect animatedProps={selectedProps} y={0} height={WAVE_H} fill={colors.accent} fillOpacity={0.12} />
        </G>
      </Svg>
      <Animated.View pointerEvents="none" style={[{ position: "absolute", top: 0, left: 0, height: LANE_H + WAVE_H, width: 1, backgroundColor: colors.text }, playheadStyle]}>
        <View style={{ position: "absolute", top: 0, left: -4, width: 0, height: 0, borderLeftWidth: 4.5, borderRightWidth: 4.5, borderTopWidth: 6, borderLeftColor: "transparent", borderRightColor: "transparent", borderTopColor: colors.text }} />
      </Animated.View>
      <Animated.View pointerEvents="none" style={[{ position: "absolute", top: LANE_H, left: 0, width: 3, height: WAVE_H, backgroundColor: colors.accent }, leftEdge]} />
      <Animated.View pointerEvents="none" style={[{ position: "absolute", top: LANE_H, right: 0, width: 3, height: WAVE_H, backgroundColor: colors.accent }, rightEdge]} />
    </View>
  );
}
```

`edgeStyle`이 훅을 함수 안에서 부르는 형태라 lint가 걸리면 `leftEdge`·`rightEdge`를 각각 `useAnimatedStyle`로 펼쳐 쓴다(호출 순서가 고정이라 동작은 같다).

- [ ] **Step 3: `TimeRuler` 구현**

```tsx
import { useState } from "react";
import { View } from "react-native";
import { useAnimatedReaction } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { rulerTicks } from "@/lib/timeline/ruler";
import type { Viewport } from "@/lib/timeline/viewport";
import { useTheme } from "@/theme";
import { AppText } from "@/ui";
import { RULER_H } from "./WaveformCanvas";
import type { TimelineViewportState } from "./useTimelineViewport";

/**
 * 시간 눈금. 라벨 텍스트는 UI 스레드에서 못 바꾸므로 viewport 스냅샷을 React state로 받는다 —
 * 제스처 중에만 바뀌는 작은 컴포넌트라 리렌더 비용이 무시할 만하다 (스펙 §파형 렌더링).
 */
export function TimeRuler({ vp }: { vp: TimelineViewportState }) {
  const { colors } = useTheme();
  const [view, setView] = useState<Viewport | null>(null);

  useAnimatedReaction(
    () => ({ startMs: vp.startMs.value, msPerPx: vp.msPerPx.value, widthPx: vp.widthPx.value }),
    (cur, prev) => {
      if (prev && cur.startMs === prev.startMs && cur.msPerPx === prev.msPerPx && cur.widthPx === prev.widthPx) return;
      scheduleOnRN(setView, cur);
    },
  );

  const ticks = view && view.widthPx > 0 ? rulerTicks(view) : [];
  return (
    <View style={{ height: RULER_H, overflow: "hidden" }}>
      {ticks.map((t) => (
        <View key={t.ms} style={{ position: "absolute", left: t.xPx, top: 0, alignItems: "flex-start" }}>
          <View style={{ width: 1, height: 5, backgroundColor: colors.borderStronger }} />
          <AppText variant="monoMeta" style={{ fontSize: 10, lineHeight: 12, marginLeft: 3 }} color={colors.textFaint}>
            {t.label}
          </AppText>
        </View>
      ))}
    </View>
  );
}
```

- [ ] **Step 4: 타입 확인**

Run: `pnpm --filter mobile typecheck`
Expected: 오류 없음.

- [ ] **Step 5: 커밋**

```bash
git add apps/mobile/src/lib/peaks.ts apps/mobile/src/features/timeline/WaveformCanvas.tsx apps/mobile/src/features/timeline/TimeRuler.tsx
git commit -m "feat(mobile): render timeline waveform, take lane, playhead and ruler from shared values" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: `OverviewStrip` — 전체 개요와 viewport 창

**Files:**
- Create: `apps/mobile/src/features/timeline/OverviewStrip.tsx`

**Interfaces:**
- Consumes: `TimelineViewportState`(Task 12), `PeakLevels`·`barsForViewport`(Task 8), `clampViewport`(Task 6), RNGH 훅.
- Produces: `OVERVIEW_H = 36`, `OverviewStrip({ levels, vp, takes: Take[], durationMs, playheadMs })`.

- [ ] **Step 1: 구현**

```tsx
import type { Take } from "@bandapp/types";
import { useMemo, useState } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { GestureDetector, useCompetingGestures, usePanGesture, useTapGesture } from "react-native-gesture-handler";
import Animated, { useAnimatedProps, type SharedValue } from "react-native-reanimated";
import Svg, { Path, Rect } from "react-native-svg";
import { barsForViewport, type PeakLevels } from "@/lib/timeline/levels";
import { clampViewport } from "@/lib/timeline/viewport";
import { useTheme } from "@/theme";
import type { TimelineViewportState } from "./useTimelineViewport";

export const OVERVIEW_H = 36;
const OVERVIEW_BAR_PX = 2;

const ARect = Animated.createAnimatedComponent(Rect);

/**
 * 전체 녹음 개요 (스펙 §파형 렌더링, 초안 21절). 파형은 최저 LOD를 한 번만 그리고, viewport 창과 playhead만
 * animatedProps로 움직인다. take는 마커다 — 3시간 위에서 1~2분을 정확히 그리려 하지 않는다. 클러스터 없음.
 * 탭·드래그는 그 시각을 viewport 중앙으로 옮긴다 (seek 아님) — 사용자 이동이라 follow를 끈다.
 */
export function OverviewStrip({
  levels,
  vp,
  takes,
  durationMs,
  playheadMs,
}: {
  levels: PeakLevels | null;
  vp: TimelineViewportState;
  takes: Take[];
  durationMs: number;
  playheadMs: SharedValue<number>;
}) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  const wavePath = useMemo(() => {
    if (!levels || width === 0 || durationMs <= 0) return "";
    const full = { startMs: 0, msPerPx: durationMs / width, widthPx: width };
    return barsForViewport(levels, levels.levels.length - 1, full, OVERVIEW_BAR_PX)
      .map((u, i) => {
        const h = Math.max(1, Math.round(u * OVERVIEW_H));
        return `M${i * OVERVIEW_BAR_PX} ${OVERVIEW_H - h}h1v${h}h-1z`;
      })
      .join("");
  }, [levels, width, durationMs]);

  const pxPerMs = durationMs > 0 && width > 0 ? width / durationMs : 0;
  const windowProps = useAnimatedProps(() => ({
    x: vp.startMs.value * pxPerMs,
    width: Math.max(2, vp.widthPx.value * vp.msPerPx.value * pxPerMs),
  }));
  const headProps = useAnimatedProps(() => ({ x: playheadMs.value * pxPerMs }));

  const centerOn = (x: number) => {
    "worklet";
    if (pxPerMs === 0) return;
    vp.follow.value = false;
    const half = (vp.widthPx.value * vp.msPerPx.value) / 2;
    const v = clampViewport({ startMs: x / pxPerMs - half, msPerPx: vp.msPerPx.value, widthPx: vp.widthPx.value }, durationMs);
    vp.startMs.value = v.startMs;
  };
  const pan = usePanGesture({
    onBegin: (e) => {
      "worklet";
      centerOn(e.x);
    },
    onUpdate: (e) => {
      "worklet";
      centerOn(e.x);
    },
  });
  const tap = useTapGesture({
    onActivate: (e) => {
      "worklet";
      centerOn(e.x);
    },
  });
  const gesture = useCompetingGestures(pan, tap);

  return (
    <GestureDetector gesture={gesture}>
      <View onLayout={onLayout} style={{ width: "100%", height: OVERVIEW_H, backgroundColor: colors.surfaceSunken, borderRadius: 4, overflow: "hidden" }}>
        <Svg width="100%" height={OVERVIEW_H}>
          <Path d={wavePath} fill={colors.borderStronger} />
          {takes.map((t) => (
            <Rect key={t.id} x={t.startMs * pxPerMs} y={0} width={Math.max(3, (t.endMs - t.startMs) * pxPerMs)} height={OVERVIEW_H} fill={colors.accent} fillOpacity={0.35} />
          ))}
          <ARect animatedProps={windowProps} y={0} height={OVERVIEW_H} fill={colors.text} fillOpacity={0.12} stroke={colors.textMuted} strokeWidth={1} />
          <ARect animatedProps={headProps} y={0} width={1} height={OVERVIEW_H} fill={colors.text} />
        </Svg>
      </View>
    </GestureDetector>
  );
}
```

- [ ] **Step 2: 타입 확인**

Run: `pnpm --filter mobile typecheck`
Expected: 오류 없음. `useTapGesture`의 `onActivate`가 없다면 Task 12 Step 4와 같은 방식으로 `onDeactivate`.

- [ ] **Step 3: 커밋**

```bash
git add apps/mobile/src/features/timeline/OverviewStrip.tsx
git commit -m "feat(mobile): add timeline overview strip with viewport window" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15: `TimelineScreen`, 라우트, 세션 상세 진입, 디버그 오버레이

> **디자인 블로커.** 이 화면의 최종 레이아웃은 Claude Design 결과가 명세다(스펙 결정 2, 브리프는 스펙 끝). 아래 조립은 기존 Take Feedback 화면의 헤더·재생 버튼·클럭 패턴을 그대로 가져온 **잠정 레이아웃**으로, 동작을 프리뷰·기기에서 검증하기 위한 것이다. 디자인이 오면 이 Task의 JSX만 그 화면대로 다시 맞춘다 — 훅·캔버스·오버뷰는 그대로다.

**Files:**
- Create: `apps/mobile/src/features/timeline/TimelineScreen.tsx`
- Create: `apps/mobile/src/features/timeline/TimelineDebugOverlay.tsx`
- Create: `apps/mobile/app/session/[id]/timeline.tsx`
- Modify: `apps/mobile/src/features/takes/SessionDetailScreen.tsx` ("Edit takes" 칩)

**Interfaces:**
- Consumes: Task 10~14 전부, `useSession`·`useTakes`·`useAudioUrl`(`@/features/takes`), `fitRange`·`xToTime`(Task 6), `fmtClock`·`fmtDuration`.

- [ ] **Step 1: 디버그 오버레이**

`TimelineDebugOverlay.tsx`:

```tsx
import { useState } from "react";
import { View } from "react-native";
import { useAnimatedReaction, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { viewportEndMs } from "@/lib/timeline/viewport";
import { AppText } from "@/ui";
import type { PeaksSource } from "./useSessionPeaks";
import type { TimelineViewportState } from "./useTimelineViewport";

interface Snapshot {
  startMs: number;
  endMs: number;
  msPerPx: number;
  level: number;
  playheadMs: number;
  follow: boolean;
  gesture: string;
}

/** __DEV__ 전용. 스크린샷만 보고도 상태를 알 수 있게 (초안 30절). 200ms에 한 번만 React로 넘긴다 */
export function TimelineDebugOverlay({
  vp,
  playheadMs,
  level,
  source,
  selectedTakeId,
}: {
  vp: TimelineViewportState;
  playheadMs: SharedValue<number>;
  level: SharedValue<number>;
  source: PeaksSource;
  selectedTakeId: string | null;
}) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  useAnimatedReaction(
    () => Math.floor(Date.now() / 200),
    (tick, prev) => {
      if (tick === prev) return;
      const v = { startMs: vp.startMs.value, msPerPx: vp.msPerPx.value, widthPx: vp.widthPx.value };
      scheduleOnRN(setSnap, {
        startMs: v.startMs,
        endMs: viewportEndMs(v),
        msPerPx: v.msPerPx,
        level: level.value,
        playheadMs: playheadMs.value,
        follow: vp.follow.value,
        gesture: vp.activeGesture.value ?? "-",
      });
    },
  );
  if (!snap) return null;
  const lines = [
    `view ${Math.round(snap.startMs)}..${Math.round(snap.endMs)} ms  ${snap.msPerPx.toFixed(2)} ms/px  LOD ${snap.level}`,
    `playhead ${Math.round(snap.playheadMs)} ms  follow ${snap.follow}  gesture ${snap.gesture}`,
    `peaks ${source}  take ${selectedTakeId ?? "-"}`,
  ];
  return (
    <View pointerEvents="none" style={{ position: "absolute", top: 60, left: 8, right: 8, backgroundColor: "rgba(0,0,0,0.6)", padding: 6, borderRadius: 4 }}>
      {lines.map((l) => (
        <AppText key={l} variant="monoMeta" style={{ fontSize: 10, lineHeight: 13 }}>
          {l}
        </AppText>
      ))}
    </View>
  );
}
```

- [ ] **Step 2: 화면**

`TimelineScreen.tsx`:

```tsx
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import { useSharedValue } from "react-native-reanimated";
import { useAudioUrl } from "@/features/takes/useAudioUrl";
import { useSession } from "@/features/takes/useSession";
import { useTakes } from "@/features/takes/useTakes";
import { fmtClock, fmtDuration } from "@/lib/time";
import { fitRange, xToTime } from "@/lib/timeline/viewport";
import { space, useTheme } from "@/theme";
import { AppText, Chip, PressableOpacity, Screen, useToast } from "@/ui";
import { OverviewStrip } from "./OverviewStrip";
import { TimeRuler } from "./TimeRuler";
import { TimelineDebugOverlay } from "./TimelineDebugOverlay";
import { LANE_H, WaveformCanvas, type TakeSpans } from "./WaveformCanvas";
import { useFollowPlayhead } from "./useFollowPlayhead";
import { usePlaybackClock } from "./usePlaybackClock";
import { useSessionPeaks } from "./useSessionPeaks";
import { useTimelineViewport } from "./useTimelineViewport";

/** ±버튼이 재생 위치를 옮기는 폭 — Take Feedback 화면과 같다 */
const NUDGE_MS = 1000;
/** take 선택 시 좌우 여백 (스펙 결정 11) */
const FIT_PAD = 0.2;

/**
 * 타임라인 뷰어 (2026-09-11 스펙 A). 잠정 레이아웃 — Claude Design 결과가 오면 JSX를 그 화면대로 맞춘다.
 * 데이터·제스처·재생은 전부 훅에 있고 이 컴포넌트는 조립과 탭 판정만 한다.
 */
export function TimelineScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const { colors } = useTheme();
  const { data: session } = useSession(id);
  const { data: takes } = useTakes(id);
  const durationMs = (session?.durationSec ?? 0) * 1000;
  const url = useAudioUrl("session", session?.id);
  const peaks = useSessionPeaks(session?.id, session?.peaks, durationMs);
  const clock = usePlaybackClock(url, durationMs);

  const takeSpans = useSharedValue<TakeSpans>({ starts: [], ends: [] });
  const selectedIndex = useSharedValue(-1);
  const level = useSharedValue(-1);
  const [selectedTakeId, setSelectedTakeId] = useState<string | null>(null);
  const [debug, setDebug] = useState(false);

  useEffect(() => {
    takeSpans.value = { starts: (takes ?? []).map((t) => t.startMs), ends: (takes ?? []).map((t) => t.endMs) };
  }, [takes, takeSpans]);

  // 탭 판정은 JS에서 — take 레인이면 선택 + fit, 파형이면 seek (스펙 결정 11)
  const takesRef = useRef(takes);
  takesRef.current = takes;
  const vpRef = useRef<ReturnType<typeof useTimelineViewport> | null>(null);
  const onTap = useCallback(
    (x: number, y: number) => {
      const vp = vpRef.current;
      if (!vp) return;
      const ms = xToTime(vp.snapshot(), x);
      if (y < LANE_H) {
        const list = takesRef.current ?? [];
        const idx = list.findIndex((t) => ms >= t.startMs && ms <= t.endMs);
        if (idx < 0) return;
        selectedIndex.value = idx;
        setSelectedTakeId(list[idx]!.id);
        vp.follow.value = false;
        vp.setViewport(fitRange(vp.snapshot().widthPx, list[idx]!.startMs, list[idx]!.endMs, FIT_PAD, durationMs));
        return;
      }
      clock.seekTo(ms);
    },
    [durationMs, clock, selectedIndex],
  );
  const vp = useTimelineViewport(durationMs, onTap);
  vpRef.current = vp;
  const follow = useFollowPlayhead(vp, clock.playheadMs, durationMs, clock.playing);

  const shownErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!clock.error || clock.error === shownErrorRef.current) return;
    shownErrorRef.current = clock.error;
    toast.show("Couldn’t play this audio");
  }, [clock.error, toast]);

  const selectedTake = useMemo(() => (takes ?? []).find((t) => t.id === selectedTakeId) ?? null, [takes, selectedTakeId]);

  if (!session) return <Screen>{null}</Screen>;

  return (
    <Screen>
      <View style={{ paddingHorizontal: space.sheetX }}>
        <PressableOpacity onPress={() => router.back()} style={{ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", padding: 8 }}>
          <AppText style={{ fontSize: 18, lineHeight: 20, color: colors.textMuted }}>‹</AppText>
          <AppText variant="body" color={colors.textMuted}>
            Session
          </AppText>
        </PressableOpacity>
      </View>
      <View style={{ paddingHorizontal: space.screenX, paddingTop: 4, paddingBottom: 10, flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" }}>
        <View>
          <AppText variant="heading">Timeline</AppText>
          <AppText variant="caption" style={{ marginTop: 4 }}>
            {`${session.name ?? session.title} · ${fmtDuration(session.durationSec)} · ${(takes ?? []).length} takes`}
          </AppText>
        </View>
        {__DEV__ ? <Chip label={debug ? "debug on" : "debug"} onPress={() => setDebug((d) => !d)} /> : null}
      </View>

      <View style={{ paddingHorizontal: space.screenX, gap: 8 }}>
        <TimeRuler vp={vp} />
        <GestureDetector gesture={vp.gesture}>
          <View>
            <WaveformCanvas levels={peaks.levels} vp={vp} playheadMs={clock.playheadMs} takes={takeSpans} selectedIndex={selectedIndex} level={level} />
          </View>
        </GestureDetector>
        {peaks.loading ? (
          <AppText variant="small" color={colors.textFaint}>
            Loading waveform…
          </AppText>
        ) : peaks.source !== "hires" ? (
          <AppText variant="small" color={colors.textFaint}>
            {peaks.source === "buckets" ? "Coarse waveform — detailed peaks not available for this session" : "No waveform for this session"}
          </AppText>
        ) : null}
        <OverviewStrip levels={peaks.levels} vp={vp} takes={takes ?? []} durationMs={durationMs} playheadMs={clock.playheadMs} />
      </View>

      <View style={{ paddingHorizontal: space.screenX, paddingTop: 14, alignItems: "center", gap: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <PressableOpacity onPress={() => clock.seekTo(clock.positionMs - NUDGE_MS)} hitSlop={6} style={{ paddingVertical: 8, paddingHorizontal: 14 }}>
            <AppText style={{ fontSize: 16, lineHeight: 18, color: colors.textMuted }}>−</AppText>
          </PressableOpacity>
          <AppText variant="monoMeta">
            <AppText variant="monoMeta" color={colors.text}>
              {fmtClock(clock.positionMs / 1000)}
            </AppText>
            {` / ${fmtClock(session.durationSec)}`}
          </AppText>
          <PressableOpacity onPress={() => clock.seekTo(clock.positionMs + NUDGE_MS)} hitSlop={6} style={{ paddingVertical: 8, paddingHorizontal: 14 }}>
            <AppText style={{ fontSize: 16, lineHeight: 18, color: colors.textMuted }}>＋</AppText>
          </PressableOpacity>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
          <PressableOpacity
            onPress={clock.toggle}
            style={{ width: 60, height: 60, borderRadius: 30, borderWidth: 1, borderColor: clock.playing ? colors.accent : colors.borderStronger, alignItems: "center", justifyContent: "center" }}
          >
            {clock.playing ? (
              <View style={{ flexDirection: "row", gap: 5 }}>
                <View style={{ width: 5, height: 18, backgroundColor: colors.text, borderRadius: 1 }} />
                <View style={{ width: 5, height: 18, backgroundColor: colors.text, borderRadius: 1 }} />
              </View>
            ) : (
              <View style={{ width: 0, height: 0, borderTopWidth: 10, borderBottomWidth: 10, borderLeftWidth: 16, borderTopColor: "transparent", borderBottomColor: "transparent", borderLeftColor: colors.text, marginLeft: 4 }} />
            )}
          </PressableOpacity>
          {!follow.following ? <Chip label="Go to playhead" onPress={follow.returnToPlayhead} /> : null}
        </View>
      </View>

      {selectedTake ? (
        <View style={{ marginHorizontal: space.screenX, marginTop: 16, padding: 14, borderRadius: 10, borderWidth: 1, borderColor: colors.borderStrong, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View>
            <AppText variant="rowTitle">{selectedTake.name}</AppText>
            <AppText variant="monoMeta" style={{ marginTop: 4 }}>
              {`${fmtClock(selectedTake.startMs / 1000)} – ${fmtClock(selectedTake.endMs / 1000)}`}
            </AppText>
          </View>
          <Chip label="Open take" onPress={() => router.push(`/session/${session.id}/take/${selectedTake.id}`)} />
        </View>
      ) : null}

      {debug ? <TimelineDebugOverlay vp={vp} playheadMs={clock.playheadMs} level={level} source={peaks.source} selectedTakeId={selectedTakeId} /> : null}
    </Screen>
  );
}
```

`onTap`이 `vp`를 ref로 읽는 이유: `useTimelineViewport`가 `onTap`을 인자로 받는데 `onTap`은 `vp`가 필요해 순환이 생긴다. ref로 끊는다.

- [ ] **Step 3: 라우트와 진입 칩**

`apps/mobile/app/session/[id]/timeline.tsx`:

```ts
export { TimelineScreen as default } from "@/features/timeline/TimelineScreen";
```

`SessionDetailScreen.tsx`의 칩 두 줄 중 두 번째를:

```tsx
        {/* 스펙 A 동안은 읽기 전용 타임라인이라 "Timeline". 편집(스펙 B)이 들어오면 디자인대로 "Edit takes"로 되돌린다 (2026-09-11 스펙 결정 1) */}
        <Chip label="Timeline" onPress={() => router.push(`/session/${session.id}/timeline`)} />
```

`useToast` import가 더 이상 안 쓰이면 지운다.

- [ ] **Step 4: 타입 확인**

Run: `pnpm --filter mobile typecheck`
Expected: 오류 없음.

- [ ] **Step 5: 웹 Mock 프리뷰 검증**

`preview_start({ name: "mobile-web-mock" })` 후 `/session/s1/timeline`으로 이동한다. 확인 항목(스크린샷과 `read_console_messages`로):
1. 128버킷 폴백 파형이 전체 보기로 그려지고 "Coarse waveform…" 안내가 보인다. 콘솔에 빨간 오류 없음.
2. 파형 위에서 마우스 드래그 → 전체 보기라 안 움직인다(정상). take 레인의 take 마커를 클릭 → 그 take가 20% 여백으로 확대되고 아래에 이름·구간 카드가 뜬다. 눈금 라벨이 바뀐다.
3. 확대된 상태에서 드래그 → 팬. 오버뷰의 창이 따라 움직인다. 오버뷰를 클릭 → 그 지점이 중앙으로.
4. 재생 버튼 → 시뮬레이션 playhead가 움직이고 클럭이 200ms마다 올라간다. 팬하면 "Go to playhead" 칩이 나타나고, 누르면 playhead가 30% 위치로 돌아온다.
5. 파형 클릭 → seek. −/＋ → 1초씩.
6. debug 칩 → 오버레이에 view·LOD·playhead·follow·gesture가 찍힌다.

동작이 다르면 원인을 훅·순수 함수에서 찾아 고친다 — 화면에서 offset을 더해 맞추지 않는다(초안 34절).

- [ ] **Step 6: 커밋**

```bash
git add apps/mobile/src/features/timeline/TimelineScreen.tsx apps/mobile/src/features/timeline/TimelineDebugOverlay.tsx "apps/mobile/app/session/[id]/timeline.tsx" apps/mobile/src/features/takes/SessionDetailScreen.tsx
git commit -m "feat(mobile): add timeline viewer screen with take selection and debug overlay" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 16: 문서, 전체 검증, 기기 검증 목록

**Files:**
- Modify: `README.md` (분석 파이프라인 한 줄)
- Modify: `docs/backlog.md`

- [ ] **Step 1: README**

42행 근처 파이프라인 문장의 `피크 추출(원본 1회 디코드)`을 `피크 추출(원본 1회 디코드) → 피크 사이드카(peaks.bin) R2 업로드`로 바꾼다.

- [ ] **Step 2: 백로그**

`docs/backlog.md`:
- "## 분석"의 **Take 경계 편집** 항목을 다음으로 교체:
  ```
  - **Take 경계 편집 (스펙 B).** 타임라인 뷰어([2026-09-11 스펙](superpowers/specs/2026-09-11-timeline-viewer-design.md)) 위에 start/end 핸들 드래그·edge auto pan·playhead 스크럽을 더하고, `PATCH /takes/:id`로 재컷(`-c copy` ±23ms 오차)·peaks·durationSec 재계산. take 코멘트 `atSec`이 take 상대 시각이라 start를 옮기면 함께 밀어야 한다 — 제품 결정 필요. 세션 상세 칩 라벨을 디자인대로 "Edit takes"로 되돌린다.
  ```
- "## 재생·피드백"에 추가:
  ```
  - **타임라인 코멘트 마커.** 원본 코멘트(절대 시각)를 타임라인 위에 마커로. 2026-09-11 스펙 범위 제외.
  - **타임라인 LOD crossfade.** 지금은 hysteresis만 있다. 레벨 교체가 눈에 띄면 두 레벨을 짧게 섞는다.
  - **타임라인 파형을 Skia로.** SVG `animatedProps`가 기기에서 60fps에 못 미치면 `WaveformCanvas` 한 파일만 Skia로 바꾼다 (스펙 결정 7). 웹 프리뷰는 canvaskit 설정이 필요하다.
  ```
- "## 운영"의 **세션 삭제 API와 R2 객체 정리** 항목 끝에 ` 피크 사이드카(`peaks.bin`)도 함께.`를 붙인다.

- [ ] **Step 3: 전체 검증**

각각 실행하고 결과를 기록한다:
- `pnpm --filter @bandapp/types build`
- `pnpm --filter @bandapp/api-client build`
- `pnpm --filter @bandapp/api-client test`
- `pnpm --filter @bandapp/api lint`
- `pnpm --filter @bandapp/api build`
- `pnpm --filter @bandapp/api test` (단위 + e2e, Postgres 필요)
- `pnpm --filter mobile typecheck`
- `pnpm --filter mobile test`

Expected: 전부 통과.

- [ ] **Step 4: 커밋**

```bash
git add README.md docs/backlog.md
git commit -m "docs: record peaks sidecar in pipeline and timeline follow-ups in backlog" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 5: 기기 검증 목록 (dev build, 사람이 수행)**

gesture-handler가 직접 의존성이 됐으니 dev client를 다시 빌드한다 (Android: `subst B:` 경로에서 `expo run:android`, USB 재연결 시 `adb reverse`). 실제 세션(사이드카가 있는 새로 분석한 세션)에서:

1. 핀치: 화면 x≈150의 특정 시각을 잡고 0.5x~5x 확대·축소 20회 — 그 시각이 손가락 아래에 머문다 (디버그 오버레이 view 값으로 확인).
2. 핀치 중 손가락 하나 떼기 → 팬으로 이어질 때 점프 없음.
3. 재생 중 팬·핀치 → follow가 꺼지고 viewport가 되돌아가지 않는다. "Go to playhead" → 30% 위치.
4. 파형 탭 seek 직후 playhead가 이전 위치로 잠깐 돌아가지 않는다.
5. 백그라운드 → 포그라운드, 블루투스 연결/해제 → playhead가 status와 다시 맞는다 (400ms 상한이라 어긋나도 멈출 뿐 앞서가지 않는다).
6. 3시간 세션에서 팬·줌이 체감 60fps. 못 미치면 백로그 "타임라인 파형을 Skia로".
7. Android에서 제스처 취소(전화 수신 등) 후 debug의 gesture가 `-`로 돌아온다.
8. 사이드카가 없는 옛 세션 → "Coarse waveform…" + 128버킷 파형으로 동일 동작.

결과를 스펙 파일 끝 "기기 검증 기록" 절에 날짜와 함께 남긴다.
