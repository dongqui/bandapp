import { randomUUID } from "node:crypto";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { TakeCandidate } from "@bandapp/types";
import { mergeCandidates, planChunks, type Chunk } from "../analysis/chunking.js";
import { DEFAULT_GEMINI_MODEL, GeminiService } from "../analysis/gemini.service.js";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { recordings, sessions, takes } from "../db/schema.js";
import { takeKey, takesPrefix } from "../sessions/session-mapper.js";
import { StorageService } from "../storage/storage.service.js";
import { ExecFfmpegRunner, type FfmpegRunner } from "./ffmpeg.js";

const CHUNK_ATTEMPTS = 2;
const TAKE_CONTENT_TYPE = "audio/mp4";

/**
 * 중복 전달 경합 방지용 마커 (다른 워커가 이미 이 세션을 처리해 status가 더 이상 analyzing이 아닌 경우).
 * DB 오류가 아니라 "더 이상 내 세션이 아니다"라는 신호라 fail()을 호출하지 않고 조용히 넘어간다.
 */
class StaleSessionError extends Error {
  constructor(sessionId: string) {
    super(`session ${sessionId} is no longer analyzing (handled by another delivery), skipping ready update`);
    this.name = "StaleSessionError";
  }
}

export class SessionAnalysisService {
  private readonly logger = new Logger(SessionAnalysisService.name);

  constructor(
    private readonly db: Db,
    private readonly storage: StorageService,
    private readonly gemini: GeminiService,
    private readonly ffmpeg: FfmpegRunner,
    private readonly tmpRoot: string = tmpdir(),
    private readonly retryDelayMs: number = 2000,
  ) {}

  /**
   * 파이프라인 오류는 세션을 failed로 기록하고 삼킨다 — consumer가 메시지를 지운다 (스펙 결정 7).
   * DB 읽기 자체가 실패하면 throw해서 메시지를 남긴다 (재전달로 복구될 수 있는 오류).
   */
  async run(sessionId: string): Promise<void> {
    // 실행 도중 배포로 환경변수가 바뀌어도 이 세션은 시작할 때의 모델로 끝까지 간다 —
    // 마무리 트랜잭션이 기록하는 값과 실제로 호출한 모델이 어긋나지 않도록 한 번만 읽어 둔다.
    const model = process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;
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
      await this.resetTakes(session.bandId, sessionId);

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

      const rows: (typeof takes.$inferInsert)[] = [];
      for (const [index, candidate] of merged.entries()) {
        const takeId = randomUUID();
        const key = takeKey(session.bandId, sessionId, takeId);
        const output = join(workDir, `take-${index}.m4a`);
        await this.ffmpeg.cut(original, candidate.startMs, candidate.endMs, output);
        await this.storage.putFile(key, output, TAKE_CONTENT_TYPE);
        // R2 업로드가 끝났으니 로컬 사본은 바로 지운다 — take 여러 개가 쌓이는 동안 임시 디스크가
        // 꽉 차는 걸 막는다. 스펙 테스트의 가짜 ffmpeg는 파일을 실제로 만들지 않으니 ENOENT는 무시한다.
        await unlink(output).catch(() => undefined);
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
        // 중복 전달 경합 방지: 이 실행이 시작됐을 때와 같은 analyzing 상태일 때만 ready로 바꾼다.
        // 다른 워커가 먼저 끝냈다면(status가 이미 바뀌었다면) 0행이 반환되고, 그걸 throw로 알려
        // 위 insert까지 통째로 롤백시킨다.
        const updated = await tx
          .update(sessions)
          .set({
            status: "ready",
            takeCount: rows.length,
            durationMs,
            analysisError: null,
            analysisModel: model,
            updatedAt: new Date(),
          })
          .where(and(eq(sessions.id, sessionId), eq(sessions.status, "analyzing")))
          .returning({ id: sessions.id });
        if (updated.length === 0) throw new StaleSessionError(sessionId);
      });
      this.logger.log(`session ${sessionId}: ${rows.length} takes from ${chunks.length} chunks`);
    } catch (err) {
      if (err instanceof StaleSessionError) {
        this.logger.warn(err.message);
      } else {
        this.logger.error(`session ${sessionId} analysis failed: ${String(err)}`);
        await this.fail(sessionId, err instanceof Error ? err.message : String(err));
      }
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /**
   * 재시도 멱등성 (스펙 결정 9): 이전 실행이 남긴 take 행과 R2 객체를 지운다.
   * 이전 실행이 트랜잭션 커밋 전에 죽었다면 take 객체가 R2에는 올라갔는데 DB 행은 없는 상태로
   * 남을 수 있다 — DB 행뿐 아니라 take 접두어 전체를 나열해 고아 객체까지 함께 지운다.
   */
  private async resetTakes(bandId: string, sessionId: string): Promise<void> {
    const existing = await this.db.query.takes.findMany({ where: eq(takes.sessionId, sessionId) });
    const orphanKeys = await this.storage.listKeys(takesPrefix(bandId, sessionId));
    const keys = [...new Set([...existing.map((t) => t.objectKey), ...orphanKeys])];
    if (keys.length > 0) await this.storage.deleteObjects(keys);
    if (existing.length > 0) await this.db.delete(takes).where(eq(takes.sessionId, sessionId));
  }

  private async analyzeChunk(original: string, chunk: Chunk, workDir: string): Promise<TakeCandidate[]> {
    const path = join(workDir, `chunk-${chunk.index}.m4a`);
    await this.ffmpeg.cut(original, chunk.startMs, chunk.endMs, path);
    try {
      let lastError: unknown;
      for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt++) {
        try {
          const found = await this.gemini.analyzeFile(path);
          return found.map((c) => ({ ...c, startMs: c.startMs + chunk.startMs, endMs: c.endMs + chunk.startMs }));
        } catch (err) {
          lastError = err;
          this.logger.warn(`chunk ${chunk.index} attempt ${attempt} failed: ${String(err)}`);
          // 재시도 사이에 잠깐 쉰다 — Gemini가 일시적으로 과부하일 때 바로 재요청하면 같은 오류가
          // 반복될 뿐이다. 스펙 테스트는 retryDelayMs=0으로 넘겨 이 대기를 건너뛴다.
          if (attempt < CHUNK_ATTEMPTS) await new Promise((r) => setTimeout(r, this.retryDelayMs));
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    } finally {
      // 청크 분석이 끝나면(성공하든 실패하든) 로컬 사본은 바로 지운다 — 임시 디스크 압박을 줄인다.
      // 스펙의 가짜 ffmpeg는 파일을 실제로 만들지 않으니 ENOENT는 무시한다.
      await unlink(path).catch(() => undefined);
    }
  }

  private async fail(sessionId: string, message: string): Promise<void> {
    // 다른 워커가 이미 이 세션을 끝냈다면(status가 더 이상 analyzing이 아니면) 덮어쓰지 않는다 — 중복 전달 경합 방지.
    await this.db
      .update(sessions)
      .set({ status: "failed", analysisError: message.slice(0, 500), updatedAt: new Date() })
      .where(and(eq(sessions.id, sessionId), eq(sessions.status, "analyzing")));
  }
}

export const sessionAnalysisServiceProvider: Provider = {
  provide: SessionAnalysisService,
  useFactory: (db: Db, storage: StorageService, gemini: GeminiService) =>
    new SessionAnalysisService(db, storage, gemini, new ExecFfmpegRunner()),
  inject: [DB, StorageService, GeminiService],
};
