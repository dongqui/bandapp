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

      const rows: (typeof takes.$inferInsert)[] = [];
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
