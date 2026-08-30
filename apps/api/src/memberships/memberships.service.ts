import { ForbiddenException } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { MemberRole } from "@bandapp/types";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { bandMembers } from "../db/schema.js";

export class MembershipsService {
  constructor(private readonly db: Db) {}

  async roleOf(bandId: string, userId: string): Promise<MemberRole | null> {
    const row = await this.db.query.bandMembers.findFirst({
      where: and(eq(bandMembers.bandId, bandId), eq(bandMembers.userId, userId)),
    });
    return row?.role ?? null;
  }

  /** Band 권한은 항상 서버에서 검증한다 (기획서 9장). 멤버가 아니면 403. */
  async assertMember(bandId: string, userId: string): Promise<MemberRole> {
    const role = await this.roleOf(bandId, userId);
    if (!role) throw new ForbiddenException("이 밴드에 접근할 수 없어요.");
    return role;
  }

  async assertOwner(bandId: string, userId: string): Promise<void> {
    if ((await this.assertMember(bandId, userId)) !== "owner") {
      throw new ForbiddenException("밴드 관리자만 할 수 있어요.");
    }
  }
}

export const membershipsServiceProvider: Provider = {
  provide: MembershipsService,
  useFactory: (db: Db) => new MembershipsService(db),
  inject: [DB],
};
