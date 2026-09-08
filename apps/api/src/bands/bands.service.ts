import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Band, BandMember, MemberRole } from "@bandapp/types";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { bandInvites, bandMembers, bands, users } from "../db/schema.js";
import { MembershipsService } from "../memberships/memberships.service.js";
import { bandError } from "./band-errors.js";

const memberColumns = {
  id: users.id,
  name: users.displayName,
  role: bandMembers.role,
  part: bandMembers.part,
};

function toBandMember(row: {
  id: string;
  name: string | null;
  role: MemberRole;
  part: string | null;
}): BandMember {
  return { id: row.id, name: row.name ?? "탈퇴한 멤버", role: row.role, part: row.part };
}

export class BandsService {
  constructor(
    private readonly db: Db,
    private readonly memberships: MembershipsService,
  ) {}

  async create(userId: string, name: string): Promise<Band> {
    return this.db.transaction(async (tx) => {
      const [band] = await tx.insert(bands).values({ name }).returning();
      if (!band) throw new Error("failed to insert band");
      await tx.insert(bandMembers).values({ bandId: band.id, userId, role: "owner" });
      return { id: band.id, name: band.name, memberCount: 1 };
    });
  }

  async listForUser(userId: string): Promise<Band[]> {
    return this.db
      .select({
        id: bands.id,
        name: bands.name,
        memberCount: sql<number>`(select count(*)::int from band_members bm where bm.band_id = ${bands.id})`,
      })
      .from(bandMembers)
      .innerJoin(bands, eq(bands.id, bandMembers.bandId))
      .where(and(eq(bandMembers.userId, userId), isNull(bands.deletedAt)))
      .orderBy(bandMembers.joinedAt);
  }

  async members(bandId: string): Promise<BandMember[]> {
    const rows = await this.db
      .select(memberColumns)
      .from(bandMembers)
      .innerJoin(users, eq(users.id, bandMembers.userId))
      .where(eq(bandMembers.bandId, bandId))
      .orderBy(bandMembers.joinedAt);
    return rows.map(toBandMember);
  }

  async leave(bandId: string, userId: string): Promise<void> {
    const role = await this.memberships.assertMember(bandId, userId);
    const total = await this.countMembers(bandId);
    if (total === 1) {
      // 마지막 멤버가 나가면 밴드를 soft delete — 행은 남고 목록·라우트에서 사라진다 (2026-09-08 스펙 결정 5)
      await this.markDeleted(bandId);
      return;
    }
    if (role === "owner") throw new ConflictException(bandError("band_owner_must_transfer"));
    await this.db
      .delete(bandMembers)
      .where(and(eq(bandMembers.bandId, bandId), eq(bandMembers.userId, userId)));
  }

  /**
   * 검증 순서가 중요하다 — owner 확인이 먼저다. 권한 없는 사람이 404/409로
   * 멤버십 존재 여부를 물어볼 수 있으면 안 된다.
   */
  async removeMember(bandId: string, actorId: string, targetUserId: string): Promise<void> {
    await this.memberships.assertOwner(bandId, actorId);
    const targetRole = await this.memberships.roleOf(bandId, targetUserId);
    if (!targetRole) throw new NotFoundException(bandError("band_member_not_found"));
    if (targetUserId === actorId) throw new ConflictException(bandError("band_cannot_remove_self"));
    if (targetRole === "owner") throw new ConflictException(bandError("band_cannot_remove_owner"));
    await this.db.transaction(async (tx) => {
      await tx
        .delete(bandMembers)
        .where(and(eq(bandMembers.bandId, bandId), eq(bandMembers.userId, targetUserId)));
      // 내보낸 사람이 폰에 남은 링크로 곧장 돌아오지 못하게 활성 초대를 전부 무효화한다 (스펙 결정 5)
      await tx
        .update(bandInvites)
        .set({ revokedAt: new Date() })
        .where(and(eq(bandInvites.bandId, bandId), isNull(bandInvites.revokedAt)));
    });
  }

  /** 본인 파트만 쓴다 — 타인의 파트를 쓰는 경로는 없다 (스펙 결정 3). */
  async setPart(bandId: string, userId: string, part: string | null): Promise<BandMember> {
    await this.memberships.assertMember(bandId, userId);
    await this.db
      .update(bandMembers)
      .set({ part })
      .where(and(eq(bandMembers.bandId, bandId), eq(bandMembers.userId, userId)));
    const [row] = await this.db
      .select(memberColumns)
      .from(bandMembers)
      .innerJoin(users, eq(users.id, bandMembers.userId))
      .where(and(eq(bandMembers.bandId, bandId), eq(bandMembers.userId, userId)));
    // update와 read 사이에 동시 removeMember로 행이 사라졌을 수 있다 — assertMember와 같은 403.
    if (!row) throw new ForbiddenException(bandError("band_forbidden"));
    return toBandMember(row);
  }

  async rename(bandId: string, actorId: string, name: string): Promise<Band> {
    await this.memberships.assertOwner(bandId, actorId);
    const [row] = await this.db
      .update(bands)
      .set({ name, updatedAt: new Date() })
      .where(eq(bands.id, bandId))
      .returning({ id: bands.id, name: bands.name });
    if (!row) throw new ForbiddenException(bandError("band_forbidden"));
    return { id: row.id, name: row.name, memberCount: await this.countMembers(bandId) };
  }

  /**
   * owner↔member 교체 한 번. 밴드당 owner는 항상 정확히 1명이다 (2026-09-08 스펙 결정 7).
   * 검증 순서: owner 확인 → 본인 여부 → 대상 존재. 권한 없는 호출자에게 멤버십 존재를 알려주지 않는다.
   */
  async transferOwnership(bandId: string, actorId: string, targetUserId: string): Promise<void> {
    await this.memberships.assertOwner(bandId, actorId);
    if (targetUserId === actorId) throw new ConflictException(bandError("band_transfer_self"));
    const targetRole = await this.memberships.roleOf(bandId, targetUserId);
    if (!targetRole) throw new NotFoundException(bandError("band_member_not_found"));
    await this.db.transaction(async (tx) => {
      // 트랜잭션 밖의 assertOwner/roleOf는 스냅샷일 뿐이다 — 동시에 두 번 이전 요청이 오면
      // 둘 다 그 스냅샷을 통과할 수 있다. 실제 UPDATE 직전에 행을 잠그고 역할을 다시 확인해
      // owner가 둘이 되는 것을 막는다 (Important #2).
      const [actor] = await tx
        .select({ role: bandMembers.role })
        .from(bandMembers)
        .where(and(eq(bandMembers.bandId, bandId), eq(bandMembers.userId, actorId)))
        .for("update");
      if (actor?.role !== "owner") throw new ForbiddenException(bandError("band_owner_only"));
      const [target] = await tx
        .select({ role: bandMembers.role })
        .from(bandMembers)
        .where(and(eq(bandMembers.bandId, bandId), eq(bandMembers.userId, targetUserId)))
        .for("update");
      if (!target) throw new NotFoundException(bandError("band_member_not_found"));
      await tx
        .update(bandMembers)
        .set({ role: "owner" })
        .where(and(eq(bandMembers.bandId, bandId), eq(bandMembers.userId, targetUserId)));
      await tx
        .update(bandMembers)
        .set({ role: "member" })
        .where(and(eq(bandMembers.bandId, bandId), eq(bandMembers.userId, actorId)));
    });
  }

  /** soft delete — 행·세션·R2 객체는 남긴다 (2026-09-08 스펙 결정 3). 이미 삭제된 밴드는 assertOwner가 403. */
  async softDelete(bandId: string, actorId: string): Promise<void> {
    await this.memberships.assertOwner(bandId, actorId);
    await this.markDeleted(bandId);
  }

  private async markDeleted(bandId: string): Promise<void> {
    await this.db.update(bands).set({ deletedAt: new Date() }).where(eq(bands.id, bandId));
  }

  private async countMembers(bandId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(bandMembers)
      .where(eq(bandMembers.bandId, bandId));
    return row?.n ?? 0;
  }
}

export const bandsServiceProvider: Provider = {
  provide: BandsService,
  useFactory: (db: Db, memberships: MembershipsService) => new BandsService(db, memberships),
  inject: [DB, MembershipsService],
};
