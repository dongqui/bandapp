import { ForbiddenException } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import type { MemberRole } from "@bandapp/types";
import { bandError } from "../bands/band-errors.js";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { bandMembers, bands } from "../db/schema.js";

export class MembershipsService {
  constructor(private readonly db: Db) {}

  /**
   * 삭제된 밴드(bands.deleted_at)는 여기서 "멤버 아님"으로 판정한다. 밴드 스코프 라우트가 전부
   * assertMember/assertOwner를 지나므로 이 한 곳으로 닫힌다 (2026-09-08 스펙 결정 4).
   */
  async roleOf(bandId: string, userId: string): Promise<MemberRole | null> {
    const [row] = await this.db
      .select({ role: bandMembers.role })
      .from(bandMembers)
      .innerJoin(bands, eq(bands.id, bandMembers.bandId))
      .where(
        and(eq(bandMembers.bandId, bandId), eq(bandMembers.userId, userId), isNull(bands.deletedAt)),
      )
      .limit(1);
    return row?.role ?? null;
  }

  /** Band 권한은 항상 서버에서 검증한다 (기획서 9장). 멤버가 아니면 403. */
  async assertMember(bandId: string, userId: string): Promise<MemberRole> {
    const role = await this.roleOf(bandId, userId);
    if (!role) throw new ForbiddenException(bandError("band_forbidden"));
    return role;
  }

  async assertOwner(bandId: string, userId: string): Promise<void> {
    if ((await this.assertMember(bandId, userId)) !== "owner") {
      throw new ForbiddenException(bandError("band_owner_only"));
    }
  }
}

export const membershipsServiceProvider: Provider = {
  provide: MembershipsService,
  useFactory: (db: Db) => new MembershipsService(db),
  inject: [DB],
};
