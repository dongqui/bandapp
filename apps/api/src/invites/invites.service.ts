import { randomBytes } from "node:crypto";
import { GoneException, NotFoundException } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { and, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { BandInvite, InvitePreview, JoinInviteResult } from "@bandapp/types";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { bandInvites, bandMembers, bands, users } from "../db/schema.js";
import { MembershipsService } from "../memberships/memberships.service.js";
import { inviteError } from "./invite-errors.js";

// MVP 정책 (기획서 11장): 링크 방식, 7일, MEMBER, owner 생성
const INVITE_TTL_DAYS = 7;

export class InvitesService {
  constructor(
    private readonly db: Db,
    private readonly memberships: MembershipsService,
  ) {}

  async create(bandId: string, userId: string): Promise<BandInvite> {
    await this.memberships.assertOwner(bandId, userId);
    // 화면 진입마다 새 링크가 생기지 않도록 살아있는 초대를 재사용한다 (스펙 결정 6).
    // 동시 요청이 둘 다 "없음"으로 판정해 2개가 생길 수 있으나, revoke가 활성 초대를
    // 전부 무효화하므로 보장이 깨지지 않는다. 밴드 단위 락은 얻는 것에 비해 비싸다.
    const active = await this.findActive(bandId);
    if (active) return this.toBandInvite(active);
    const token = randomBytes(24).toString("base64url"); // 32자 — 충분히 긴 random token
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
    const [row] = await this.db
      .insert(bandInvites)
      .values({ bandId, token, createdBy: userId, expiresAt })
      .returning();
    if (!row) throw new Error("failed to insert invite");
    return this.toBandInvite(row);
  }

  /** "활성"의 정의는 findValid와 같다. 여럿이면 가장 최근 것. */
  private async findActive(bandId: string): Promise<typeof bandInvites.$inferSelect | null> {
    const [row] = await this.db
      .select()
      .from(bandInvites)
      .where(
        and(
          eq(bandInvites.bandId, bandId),
          isNull(bandInvites.revokedAt),
          gt(bandInvites.expiresAt, new Date()),
          or(isNull(bandInvites.maxUses), lt(bandInvites.usedCount, bandInvites.maxUses)),
        ),
      )
      .orderBy(desc(bandInvites.createdAt))
      .limit(1);
    return row ?? null;
  }

  private toBandInvite(row: typeof bandInvites.$inferSelect): BandInvite {
    return { id: row.id, url: this.inviteUrl(row.token), expiresAt: row.expiresAt.toISOString() };
  }

  async preview(token: string): Promise<InvitePreview> {
    const invite = await this.findValid(token);
    const band = await this.db.query.bands.findFirst({ where: eq(bands.id, invite.bandId) });
    if (!band) throw new NotFoundException(inviteError("invite_not_found"));
    const creator = await this.db.query.users.findFirst({ where: eq(users.id, invite.createdBy) });
    const [count] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(bandMembers)
      .where(eq(bandMembers.bandId, invite.bandId));
    return {
      band: { name: band.name, memberCount: count?.n ?? 0 },
      invitedBy: { displayName: creator?.displayName ?? null },
      expiresAt: invite.expiresAt.toISOString(),
    };
  }

  /** idempotent — 이미 멤버면 오류 대신 alreadyMember=true (기획서 15장). */
  async join(token: string, userId: string): Promise<JoinInviteResult> {
    const invite = await this.findValid(token);
    const existing = await this.db.query.bandMembers.findFirst({
      where: and(eq(bandMembers.bandId, invite.bandId), eq(bandMembers.userId, userId)),
    });
    if (existing) return { bandId: invite.bandId, alreadyMember: true };
    // findFirst 이후 실제 insert 사이에 동시 요청이 끼어들 수 있으므로
    // (band_id, user_id) PK 충돌을 onConflictDoNothing으로 흡수해 race-safe하게 만든다.
    const inserted = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(bandMembers)
        .values({ bandId: invite.bandId, userId, role: "member" })
        .onConflictDoNothing()
        .returning();
      if (!row) return false;
      await tx
        .update(bandInvites)
        .set({ usedCount: sql`${bandInvites.usedCount} + 1` })
        .where(eq(bandInvites.id, invite.id));
      return true;
    });
    return { bandId: invite.bandId, alreadyMember: !inserted };
  }

  async revoke(bandId: string, inviteId: string, userId: string): Promise<void> {
    await this.memberships.assertOwner(bandId, userId);
    const [row] = await this.db
      .update(bandInvites)
      .set({ revokedAt: new Date() })
      .where(and(eq(bandInvites.id, inviteId), eq(bandInvites.bandId, bandId)))
      .returning();
    if (!row) throw new NotFoundException(inviteError("invite_not_found"));
  }

  private inviteUrl(token: string): string {
    const base = process.env.INVITE_LINK_BASE_URL;
    if (!base) throw new Error("INVITE_LINK_BASE_URL is not set");
    return `${base.replace(/\/+$/, "")}/invite/${token}`;
  }

  /**
   * 찾지 못한 토큰은 사유를 밝히지 않는다. 찾은 토큰은 이미 그 문자열을 쥔 사람에게만
   * 응답하는 것이라 사유를 알려도 새로 새는 정보가 없다 (스펙 결정 7).
   * 취소가 만료보다 먼저다 — 둘 다 해당해도 "취소됨"이 더 정확한 설명이다.
   */
  private async findValid(token: string): Promise<typeof bandInvites.$inferSelect> {
    const invite = await this.db.query.bandInvites.findFirst({
      where: eq(bandInvites.token, token),
    });
    if (!invite) throw new NotFoundException(inviteError("invite_not_found"));
    if (invite.revokedAt) throw new GoneException(inviteError("invite_revoked"));
    if (invite.expiresAt <= new Date()) throw new GoneException(inviteError("invite_expired"));
    if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) {
      throw new GoneException(inviteError("invite_exhausted"));
    }
    return invite;
  }
}

export const invitesServiceProvider: Provider = {
  provide: InvitesService,
  useFactory: (db: Db, memberships: MembershipsService) => new InvitesService(db, memberships),
  inject: [DB, MembershipsService],
};
