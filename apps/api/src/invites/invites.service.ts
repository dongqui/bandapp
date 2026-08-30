import { createHash, randomBytes } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import type { BandInvite, InvitePreview, JoinInviteResult } from "@bandapp/types";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { bandInvites, bandMembers, bands, users } from "../db/schema.js";
import { MembershipsService } from "../memberships/memberships.service.js";

// MVP 정책 (기획서 11장): 링크 방식, 7일, MEMBER, owner 생성
const INVITE_TTL_DAYS = 7;

export class InvitesService {
  constructor(
    private readonly db: Db,
    private readonly memberships: MembershipsService,
  ) {}

  async create(bandId: string, userId: string): Promise<BandInvite> {
    await this.memberships.assertOwner(bandId, userId);
    const token = randomBytes(24).toString("base64url"); // 32자 — 충분히 긴 random token
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
    const [row] = await this.db
      .insert(bandInvites)
      .values({ bandId, tokenHash: this.hash(token), createdBy: userId, expiresAt })
      .returning();
    if (!row) throw new Error("failed to insert invite");
    return { id: row.id, url: this.inviteUrl(token), expiresAt: expiresAt.toISOString() };
  }

  async preview(token: string): Promise<InvitePreview> {
    const invite = await this.findValid(token);
    const band = await this.db.query.bands.findFirst({ where: eq(bands.id, invite.bandId) });
    if (!band) throw new NotFoundException("초대장을 찾을 수 없어요.");
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
    if (!row) throw new NotFoundException("초대장을 찾을 수 없어요.");
  }

  private hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private inviteUrl(token: string): string {
    const base = process.env.INVITE_LINK_BASE_URL;
    if (!base) throw new Error("INVITE_LINK_BASE_URL is not set");
    return `${base.replace(/\/+$/, "")}/invite/${token}`;
  }

  /** 미존재/만료/취소/소진을 구분하지 않고 404 — 토큰 존재 여부를 노출하지 않는다. */
  private async findValid(token: string): Promise<typeof bandInvites.$inferSelect> {
    const invite = await this.db.query.bandInvites.findFirst({
      where: eq(bandInvites.tokenHash, this.hash(token)),
    });
    const valid =
      invite &&
      !invite.revokedAt &&
      invite.expiresAt > new Date() &&
      (invite.maxUses === null || invite.usedCount < invite.maxUses);
    if (!valid) throw new NotFoundException("초대장을 찾을 수 없어요. 링크가 만료됐을 수 있어요.");
    return invite;
  }
}

export const invitesServiceProvider: Provider = {
  provide: InvitesService,
  useFactory: (db: Db, memberships: MembershipsService) => new InvitesService(db, memberships),
  inject: [DB, MembershipsService],
};
