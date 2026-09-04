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
