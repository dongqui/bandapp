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
