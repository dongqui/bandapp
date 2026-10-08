import { BadRequestException, ConflictException, Logger, NotFoundException } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { checkTakeRange, defaultTakeName, neighborsAt, neighborsOf, type AudioUrl, type CreateTakeInput, type Take, type TakeAudioStatus, type TakeCandidateType, type TakeRangeError, type UpdateTakeInput } from "@bandapp/types";
import { AnalysisProducer } from "../analysis/analysis.producer.js";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { comments, sessions, takes } from "../db/schema.js";
import { takeKey, type SessionRow } from "../sessions/session-mapper.js";
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
  peaks: takes.peaks,
  version: takes.version,
  audioStatus: takes.audioStatus,
  // ${takes.id}는 단일 테이블 select에서 테이블 접두어 없이 "id"로 렌더링돼 서브쿼리 안의
  // comments.id와 충돌한다 — 상관 서브쿼리이므로 테이블명을 직접 명시해 모호성을 없앤다.
  // 답글은 세지 않는다 — "N comments"는 스레드 수다 (스레드 스펙 결정 5).
  commentCount: sql<number>`(select count(*)::int from comments c where c.take_id = "takes"."id" and c.parent_id is null)`,
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
  peaks: number[] | null;
  version: number;
  audioStatus: TakeAudioStatus;
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
    peaks: row.peaks ?? null,
    version: row.version,
    audioStatus: row.audioStatus,
  };
}

const RANGE_MESSAGES: Record<TakeRangeError, string> = {
  take_range_invalid: "take 구간이 올바르지 않아요.",
  take_overlap: "옆 take와 겹칠 수 없어요.",
};

/**
 * take를 만들거나 고칠 수 있는 세션 상태. 2026-10-08까지는 ready만이었지만 수동 take가 생기면서 분석 안 한
 * 세션(waiting_for_time·failed)에서도 허용한다 — 막는 건 워커가 take를 쓰고 있는 analyzing과 녹음이 아직 없는 uploading.
 */
function assertEditable(session: SessionRow, verb: string): void {
  if (session.status === "analyzing" || session.status === "uploading") {
    throw new ConflictException({ message: `분석 중에는 take를 ${verb} 수 없어요.`, code: "session_not_ready" });
  }
}

export class TakesService {
  private readonly logger = new Logger(TakesService.name);

  constructor(
    private readonly db: Db,
    private readonly sessions: SessionsService,
    private readonly storage: StorageService,
    private readonly producer: AnalysisProducer,
  ) {}

  async list(sessionId: string, userId: string): Promise<Take[]> {
    await this.sessions.loadForMember(sessionId, userId);
    // 시간 순 — 수동 take는 index가 제일 크면서 시간상 중간에 들어간다 (2026-10-08)
    const rows = await this.db.select(TAKE_WITH_COUNT).from(takes).where(eq(takes.sessionId, sessionId)).orderBy(asc(takes.startMs), asc(takes.index));
    return rows.map(toTake);
  }

  /**
   * 수동 take (2026-10-08 Edit 화면 "Add take"). index는 세션의 다음 번호, 이름은 기본 이름. 오디오는 아직 없다 —
   * 재컷 잡이 `{takeId}-v1` 키에 잘라 올리므로 objectKey를 그 키로 미리 적고 updating으로 시작한다 (update()와 같은 흐름).
   * 분석 안 한 세션에도 만들 수 있지만 길이를 모르면(durationMs null) 범위를 검사할 수 없어 막는다.
   */
  async create(sessionId: string, userId: string, input: CreateTakeInput): Promise<Take> {
    const session = await this.sessions.loadForMember(sessionId, userId);
    assertEditable(session, "만들");
    if (session.durationMs === null) throw new ConflictException({ message: "녹음 길이를 아직 몰라 take를 만들 수 없어요.", code: "session_not_ready" });
    const siblings = await this.db.select({ index: takes.index, startMs: takes.startMs, endMs: takes.endMs }).from(takes).where(eq(takes.sessionId, sessionId));
    const error = checkTakeRange(input.startMs, input.endMs, session.durationMs, neighborsAt(siblings, input.startMs));
    if (error) throw new BadRequestException({ message: RANGE_MESSAGES[error], code: error });

    const takeId = randomUUID();
    const version = 1;
    const index = siblings.reduce((m, t) => Math.max(m, t.index + 1), 0);
    await this.db.transaction(async (tx) => {
      await tx.insert(takes).values({
        id: takeId,
        sessionId,
        index,
        name: defaultTakeName(index),
        startMs: input.startMs,
        endMs: input.endMs,
        type: "PERFORMANCE",
        confidence: 1,
        objectKey: takeKey(session.bandId, sessionId, `${takeId}-v${version}`),
        peaks: null,
        version,
        audioStatus: "updating",
        manual: true,
      });
      await tx
        .update(sessions)
        .set({ takeCount: sql`${sessions.takeCount} + 1`, updatedAt: new Date() })
        .where(eq(sessions.id, sessionId));
    });
    await this.enqueueRecutOrFail(takeId, version);
    const [row] = await this.db.select(TAKE_WITH_COUNT).from(takes).where(eq(takes.id, takeId));
    if (!row) throw new NotFoundException("Take를 찾을 수 없어요.");
    return toTake(row);
  }

  /** 큐 실패는 사용자가 Save/Retry를 다시 눌러 복구한다 — 세션 enqueue 실패와 같은 패턴 */
  private async enqueueRecutOrFail(takeId: string, version: number): Promise<void> {
    try {
      await this.producer.enqueueRecut(takeId, version);
    } catch (err) {
      this.logger.error(`failed to enqueue recut for take ${takeId}: ${String(err)}`);
      await this.db
        .update(takes)
        .set({ audioStatus: "failed", audioError: "재컷 요청을 보내지 못했어요." })
        .where(and(eq(takes.id, takeId), eq(takes.version, version)));
    }
  }

  /** take → 세션 순으로 검증한다 (sessions.loadForMember가 멤버십을 확인한다). 없으면 404, 멤버가 아니면 403. */
  async loadForMember(takeId: string, userId: string): Promise<TakeRow> {
    const [row] = await this.db.select(TAKE_WITH_COUNT).from(takes).where(eq(takes.id, takeId));
    if (!row) throw new NotFoundException("Take를 찾을 수 없어요.");
    await this.sessions.loadForMember(row.sessionId, userId);
    return row;
  }

  async audioUrl(takeId: string, userId: string): Promise<AudioUrl> {
    const take = await this.loadForMember(takeId, userId);
    return {
      url: await this.storage.presignGet(take.objectKey, PRESIGN_EXPIRES_SEC),
      expiresAt: new Date(Date.now() + PRESIGN_EXPIRES_SEC * 1000).toISOString(),
    };
  }

  private async loadWithSession(takeId: string, userId: string): Promise<{ take: TakeRow; session: SessionRow }> {
    const [take] = await this.db.select(TAKE_WITH_COUNT).from(takes).where(eq(takes.id, takeId));
    if (!take) throw new NotFoundException("Take를 찾을 수 없어요.");
    const session = await this.sessions.loadForMember(take.sessionId, userId);
    return { take, session };
  }

  /**
   * 경계 변경 (2026-09-11 스펙 B). DB만 바꾸고 재컷은 워커 잡으로 넘긴다 (결정 3). 코멘트는 절대 시각을 보존하도록
   * at_ms를 함께 옮긴다 (결정 2). 같은 값을 다시 보내도 받는다 — 실패 재시도로 쓴다.
   */
  async update(takeId: string, userId: string, input: UpdateTakeInput): Promise<Take> {
    const { take, session } = await this.loadWithSession(takeId, userId);
    assertEditable(session, "고칠");
    if (input.version !== take.version) throw new ConflictException({ message: "다른 멤버가 먼저 고쳤어요.", code: "take_version_conflict" });
    const siblings = await this.db.select({ index: takes.index, startMs: takes.startMs, endMs: takes.endMs }).from(takes).where(eq(takes.sessionId, take.sessionId));
    const error = checkTakeRange(input.startMs, input.endMs, session.durationMs ?? 0, neighborsOf(siblings, take.index));
    if (error) throw new BadRequestException({ message: RANGE_MESSAGES[error], code: error });

    const nextVersion = take.version + 1;
    const shiftMs = take.startMs - input.startMs;
    await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(takes)
        .set({ startMs: input.startMs, endMs: input.endMs, version: nextVersion, audioStatus: "updating", audioError: null })
        .where(and(eq(takes.id, takeId), eq(takes.version, input.version)))
        .returning({ id: takes.id });
      // 검사와 갱신 사이에 다른 요청이 먼저 갔다 — 같은 409로 알린다
      if (updated.length === 0) throw new ConflictException({ message: "다른 멤버가 먼저 고쳤어요.", code: "take_version_conflict" });
      if (shiftMs !== 0) await tx.update(comments).set({ atMs: sql`${comments.atMs} + ${shiftMs}` }).where(eq(comments.takeId, takeId));
    });

    await this.enqueueRecutOrFail(takeId, nextVersion);
    const [row] = await this.db.select(TAKE_WITH_COUNT).from(takes).where(eq(takes.id, takeId));
    // 트랜잭션과 재조회 사이에 다른 멤버가 지웠을 수 있다 — non-null assertion 대신 명시적으로 404
    if (!row) throw new NotFoundException("Take를 찾을 수 없어요.");
    return toTake(row);
  }

  /**
   * 이름 변경 (2026-10-02). null이면 기본 이름 "Take n"으로 돌아간다. 오디오를 건드리지 않으니 version은 그대로고
   * 세션 상태(analyzing)와도 무관하다. 멤버 누구나.
   */
  async rename(takeId: string, userId: string, name: string | null): Promise<Take> {
    const take = await this.loadForMember(takeId, userId);
    await this.db.update(takes).set({ name: name ?? defaultTakeName(take.index) }).where(eq(takes.id, takeId));
    const [row] = await this.db.select(TAKE_WITH_COUNT).from(takes).where(eq(takes.id, takeId));
    // 갱신과 재조회 사이에 다른 멤버가 지웠을 수 있다
    if (!row) throw new NotFoundException("Take를 찾을 수 없어요.");
    return toTake(row);
  }

  /** 삭제 (결정 1·6). 코멘트는 FK cascade. 남은 take의 name·index는 그대로. 객체 삭제 실패는 정리 배치(백로그)가 줍는다 */
  async remove(takeId: string, userId: string): Promise<void> {
    const { take, session } = await this.loadWithSession(takeId, userId);
    assertEditable(session, "지울");
    await this.db.transaction(async (tx) => {
      await tx.delete(takes).where(eq(takes.id, takeId));
      await tx
        .update(sessions)
        .set({ takeCount: sql`greatest(${sessions.takeCount} - 1, 0)`, updatedAt: new Date() })
        .where(eq(sessions.id, take.sessionId));
    });
    await this.storage.deleteObjects([take.objectKey]).catch((err: unknown) => this.logger.warn(`take object delete failed for ${take.objectKey}: ${String(err)}`));
  }
}

export const takesServiceProvider: Provider = {
  provide: TakesService,
  useFactory: (db: Db, sessions: SessionsService, storage: StorageService, producer: AnalysisProducer) =>
    new TakesService(db, sessions, storage, producer),
  inject: [DB, SessionsService, StorageService, AnalysisProducer],
};
