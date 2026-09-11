import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { PEAK_BUCKETS } from "@bandapp/types";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { recordings, sessions, takes } from "../db/schema.js";
import { takeKey } from "../sessions/session-mapper.js";
import { StorageService } from "../storage/storage.service.js";
import { ExecFfmpegRunner, type FfmpegRunner } from "./ffmpeg.js";
import { decodePeaksFile, slicePeaks } from "./peaks.js";

const TAKE_CONTENT_TYPE = "audio/mp4";

/**
 * take 경계가 바뀐 뒤 오디오를 다시 자른다 (2026-09-11 스펙 B §워커). 결과는 새 키(`{takeId}-v{version}`)에 올리고
 * 옛 키를 지운다 — 같은 키에 덮어쓰면 앱이 1시간 캐시한 presigned URL이 옛 파일을 가리킨다 (결정 9).
 * 피크는 원본을 디코드하지 않고 peaks.bin 사이드카를 잘라 계산한다 (결정 10).
 * 잡의 version이 현재와 다르면 이미 다음 편집이 덮어썼으므로 건너뛴다 (결정 11).
 */
export class TakeRecutService {
  private readonly logger = new Logger(TakeRecutService.name);

  constructor(
    private readonly db: Db,
    private readonly storage: StorageService,
    private readonly ffmpeg: FfmpegRunner,
    private readonly tmpRoot: string = tmpdir(),
  ) {}

  async run(takeId: string, version: number): Promise<void> {
    const take = await this.db.query.takes.findFirst({ where: eq(takes.id, takeId) });
    if (!take) {
      this.logger.warn(`take ${takeId} not found (deleted?), ignoring recut`);
      return;
    }
    if (take.version !== version) {
      this.logger.log(`take ${takeId}: recut v${version} is stale (now v${take.version}), skipping`);
      return;
    }
    const session = await this.db.query.sessions.findFirst({ where: eq(sessions.id, take.sessionId) });
    const recording = await this.db.query.recordings.findFirst({ where: eq(recordings.sessionId, take.sessionId) });
    if (!session || !recording) {
      await this.fail(takeId, version, "녹음 파일 정보가 없어요.");
      return;
    }

    const workDir = await mkdtemp(join(this.tmpRoot, `recut-${takeId}-`));
    const newKey = takeKey(session.bandId, session.id, `${takeId}-v${version}`);
    try {
      const original = join(workDir, "original.m4a");
      await this.storage.downloadToFile(recording.objectKey, original);
      const output = join(workDir, "take.m4a");
      await this.ffmpeg.cut(original, take.startMs, take.endMs, output);
      await this.storage.putFile(newKey, output, TAKE_CONTENT_TYPE);
      const peaks = await this.peaksFromSidecar(session.peaksKey, take.startMs, take.endMs, workDir);
      const updated = await this.db
        .update(takes)
        .set({ objectKey: newKey, peaks, audioStatus: "ready", audioError: null })
        .where(and(eq(takes.id, takeId), eq(takes.version, version)))
        .returning({ id: takes.id });
      if (updated.length === 0) {
        // 자르는 동안 다음 편집이 version을 올렸다 — 방금 올린 객체는 고아라 바로 지운다
        this.logger.log(`take ${takeId}: v${version} superseded during recut, discarding ${newKey}`);
        await this.storage.deleteObjects([newKey]).catch((err: unknown) => this.logger.warn(`orphan delete failed: ${String(err)}`));
        return;
      }
      if (take.objectKey !== newKey) {
        await this.storage.deleteObjects([take.objectKey]).catch((err: unknown) => this.logger.warn(`old take object delete failed: ${String(err)}`));
      }
      this.logger.log(`take ${takeId}: recut v${version} ready, peaks ${peaks ? "sliced" : "none"}`);
    } catch (err) {
      this.logger.error(`take ${takeId}: recut v${version} failed: ${String(err)}`);
      await this.fail(takeId, version, err instanceof Error ? err.message : String(err));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /** 사이드카가 없거나 못 읽으면 null — 파형은 장식이라 재컷을 막지 않는다 */
  private async peaksFromSidecar(peaksKey: string | null, startMs: number, endMs: number, workDir: string): Promise<number[] | null> {
    if (!peaksKey) return null;
    try {
      const path = join(workDir, "peaks.bin");
      await this.storage.downloadToFile(peaksKey, path);
      const { peaksPerSec, hires } = decodePeaksFile(await readFile(path));
      return slicePeaks(hires, peaksPerSec, startMs, endMs, PEAK_BUCKETS);
    } catch (err) {
      this.logger.warn(`peaks sidecar unusable, storing null: ${String(err)}`);
      return null;
    }
  }

  private async fail(takeId: string, version: number, message: string): Promise<void> {
    await this.db
      .update(takes)
      .set({ audioStatus: "failed", audioError: message.slice(0, 500) })
      .where(and(eq(takes.id, takeId), eq(takes.version, version)))
      .returning({ id: takes.id });
  }
}

export const takeRecutServiceProvider: Provider = {
  provide: TakeRecutService,
  useFactory: (db: Db, storage: StorageService) => new TakeRecutService(db, storage, new ExecFfmpegRunner()),
  inject: [DB, StorageService],
};
