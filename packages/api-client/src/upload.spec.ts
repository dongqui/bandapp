import { describe, expect, it, vi } from "vitest";
import type { Session } from "@bandapp/types";
import type { RehearsalApiClient } from "./client";
import { resumeRecordingUpload, uploadRecording, UploadRecordingError } from "./upload";

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

/** RN 경로 — readPart가 Blob 대신 Uint8Array를 준다. */
const bytesSource = (sizeBytes: number) => ({
  sizeBytes,
  readPart: vi.fn(async ({ start, end }: { start: number; end: number }) => new Uint8Array(end - start).fill(7)),
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

  it("passes a Uint8Array part straight through as the PUT body", async () => {
    const { client } = fakeClient(1);
    const src = bytesSource(MB);
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => okPut("e1"));
    await uploadRecording({ client, bandId: "b1", source: src, fetchFn, input: { startedAt: "2026-09-04T19:00:00+09:00", sizeBytes: MB, contentType: "audio/mp4", source: "recording" } });
    const body = fetchFn.mock.calls[0]![1]!.body;
    expect(body).toBeInstanceOf(Uint8Array);
    expect(body).toBe(await src.readPart.mock.results[0]!.value);
    expect((body as Uint8Array).length).toBe(MB);
  });

  it("wraps a post-create failure in an UploadRecordingError carrying the session id", async () => {
    const { client } = fakeClient(1);
    const fetchFn = vi.fn(async () => new Response(null, { status: 500 }));
    const err = await uploadRecording({
      client, bandId: "b1", source: source(MB), fetchFn, attemptsPerPart: 1,
      input: { startedAt: "2026-09-04T19:00:00+09:00", sizeBytes: MB, contentType: "audio/mp4", source: "import" },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadRecordingError);
    expect((err as UploadRecordingError).sessionId).toBe("s1");
    expect((err as UploadRecordingError).message).toMatch(/part 1/);
    expect((err as UploadRecordingError).cause).toBeInstanceOf(Error);
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

  it("stops issuing new PUTs once a part exhausts its attempts, instead of racing ahead on other workers", async () => {
    const { client, sessions } = fakeClient(4);
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
      const n = Number(String(url).split("/").at(-1));
      if (n === 1) throw new Error("boom");
      await new Promise((r) => setTimeout(r, 20));
      return okPut(`e${n}`);
    });
    await expect(
      uploadRecording({
        client,
        bandId: "b1",
        source: source(40 * MB),
        fetchFn,
        concurrency: 2,
        attemptsPerPart: 1,
        input: { startedAt: "2026-09-04T19:00:00+09:00", sizeBytes: 40 * MB, contentType: "audio/mp4", source: "import" },
      }),
    ).rejects.toThrow();
    // 파트 1이 실패하는 즉시 중단해야 한다 — 동시에 떠 있던 것(최대 concurrency개)만큼만 fetch가 나갈 수 있고,
    // 큐에 남아있던 파트(4번)는 절대 새로 시작되면 안 된다.
    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(3);
    expect(sessions.completeUpload).not.toHaveBeenCalled();
  });
});

describe("resumeRecordingUpload", () => {
  it("skips parts the server already has and resumes with the existing sessionId", async () => {
    const { client, calls } = fakeClient(3, [1, 2]);
    const fetchFn = vi.fn(async () => okPut("e3"));
    await resumeRecordingUpload({ client, sessionId: "s1", source: source(25 * MB), fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(calls.partUrls).toEqual([[3]]);
    expect(calls.completed).toEqual([
      { partNumber: 1, etag: "old1" },
      { partNumber: 2, etag: "old2" },
      { partNumber: 3, etag: "e3" },
    ]);
  });
});
