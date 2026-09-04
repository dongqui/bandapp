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
 * 세션은 uploading으로 남는다. 새 세션은 항상 빈 상태로 시작하므로 이어 올리기는
 * resumeRecordingUpload가 담당한다.
 */
export async function uploadRecording(opts: UploadRecordingOptions): Promise<Session> {
  const { sessions } = opts.client;
  const { session } = await sessions.create(opts.bandId, opts.input);
  return resumeUpload({
    client: opts.client,
    source: opts.source,
    fetchFn: opts.fetchFn ?? fetch,
    onProgress: opts.onProgress,
    concurrency: opts.concurrency ?? 2,
    attempts: opts.attemptsPerPart ?? 3,
    sessionId: session.id,
  });
}

/**
 * 이미 create되어 id를 아는 세션의 업로드를 이어간다 — 앱이 중간에 죽었거나 네트워크가 끊긴 뒤
 * 다시 시작할 때 호출자가 저장해둔 sessionId로 부른다. uploadStatus로 partSize/partCount와
 * 이미 올라간 파트를 알아내고 나머지만 올린다 (uploadRecording과 동일한 resumeUpload를 공유한다).
 */
export async function resumeRecordingUpload(
  opts: Omit<UploadRecordingOptions, "input" | "bandId"> & { sessionId: string },
): Promise<Session> {
  return resumeUpload({
    client: opts.client,
    source: opts.source,
    fetchFn: opts.fetchFn ?? fetch,
    onProgress: opts.onProgress,
    concurrency: opts.concurrency ?? 2,
    attempts: opts.attemptsPerPart ?? 3,
    sessionId: opts.sessionId,
  });
}

interface ResumeArgs {
  client: Pick<RehearsalApiClient, "sessions">;
  source: UploadSource;
  fetchFn: typeof fetch;
  onProgress?: (p: UploadProgress) => void;
  concurrency: number;
  attempts: number;
  sessionId: string;
}

async function resumeUpload(a: ResumeArgs): Promise<Session> {
  const { sessions } = a.client;
  const status = await sessions.uploadStatus(a.sessionId);
  const { partSize, partCount } = status;
  const done = new Map(status.uploadedParts.map((p) => [p.partNumber, p.etag]));
  const total = a.source.sizeBytes;
  let uploadedBytes = [...done.keys()].reduce((sum, n) => sum + partLength(n, partSize, total), 0);
  a.onProgress?.({ uploadedBytes, totalBytes: total });

  const pending = Array.from({ length: partCount }, (_, i) => i + 1).filter((n) => !done.has(n));
  const urls = new Map<number, string>();
  for (let i = 0; i < pending.length; i += URL_BATCH) {
    for (const { partNumber, url } of await sessions.partUrls(a.sessionId, pending.slice(i, i + URL_BATCH))) {
      urls.set(partNumber, url);
    }
  }

  const queue = [...pending];
  // 파트 하나가 완전히 실패하면 나머지 워커도 곧바로 멈춘다 — 안 그러면 호출자가 이미 에러를
  // 받은 뒤에도 다른 워커들이 계속 PUT을 날리고 onProgress를 흘려보내게 된다.
  let aborted = false;
  let firstError: unknown;
  const worker = async (): Promise<void> => {
    for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
      if (aborted) return;
      try {
        const url = urls.get(n);
        if (!url) throw new Error(`no upload URL for part ${n}`);
        const etag = await putPart(a, n, url, partSize);
        if (aborted) return; // 기다리는 동안 다른 워커가 먼저 실패했다 — 이 결과는 버린다
        done.set(n, etag);
        uploadedBytes += partLength(n, partSize, total);
        a.onProgress?.({ uploadedBytes, totalBytes: total });
      } catch (err) {
        aborted = true;
        firstError ??= err;
        return;
      }
    }
  };
  // allSettled: 어느 워커가 먼저 실패해도 나머지 워커들이 (진행 중이던 PUT까지) 끝날 때까지
  // 기다린 다음에 throw한다 — 그래야 "함수는 실패했는데 fetch는 백그라운드에서 계속 나간다" 상태가 안 생긴다.
  await Promise.allSettled(Array.from({ length: Math.min(a.concurrency, pending.length) }, worker));
  if (aborted) throw firstError instanceof Error ? firstError : new Error(String(firstError));

  const parts: UploadedPart[] = [...done.entries()].map(([partNumber, etag]) => ({ partNumber, etag })).sort((x, y) => x.partNumber - y.partNumber);
  return sessions.completeUpload(a.sessionId, parts);
}

function partLength(partNumber: number, partSize: number, total: number): number {
  const start = (partNumber - 1) * partSize;
  return Math.min(partSize, total - start);
}

async function putPart(a: ResumeArgs, partNumber: number, url: string, partSize: number): Promise<string> {
  const start = (partNumber - 1) * partSize;
  const end = Math.min(start + partSize, a.source.sizeBytes);
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
