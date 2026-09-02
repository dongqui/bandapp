import { ConflictException, NotFoundException } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Band, BandMember, BandPart, MemberRole } from "@bandapp/types";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { bandInvites, bandMembers, bands, users } from "../db/schema.js";
import { MembershipsService } from "../memberships/memberships.service.js";

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
  part: BandPart | null;
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
      .where(eq(bandMembers.userId, userId))
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
      // 마지막 멤버가 나가면 밴드 삭제 — cascade로 멤버·초대 함께 삭제
      await this.db.delete(bands).where(eq(bands.id, bandId));
      return;
    }
    if (role === "owner") {
      throw new ConflictException("관리자는 먼저 소유권을 넘기거나 팀을 삭제해야 해요.");
    }
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
    if (!targetRole) throw new NotFoundException("팀원을 찾을 수 없어요.");
    if (targetUserId === actorId) {
      throw new ConflictException("자기 자신은 내보낼 수 없어요. 팀 나가기를 사용해 주세요.");
    }
    if (targetRole === "owner") throw new ConflictException("팀장은 내보낼 수 없어요.");
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
  async setPart(bandId: string, userId: string, part: BandPart | null): Promise<BandMember> {
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
    if (!row) throw new Error("member vanished between update and read");
    return toBandMember(row);
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
