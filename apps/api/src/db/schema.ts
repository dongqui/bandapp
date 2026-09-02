import {
  boolean,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const authProvider = pgEnum("auth_provider", ["GOOGLE", "APPLE"]);
// @bandapp/types의 MemberRole("owner" | "member")과 값을 일치시킨다 (스펙 결정 5)
export const bandRole = pgEnum("band_role", ["owner", "member"]);
// @bandapp/types의 BandPart와 값을 일치시킨다. 표시 문자열은 클라이언트 책임이다 (스펙 결정 2)
export const bandPart = pgEnum("band_part", [
  "vocal",
  "guitar",
  "bass",
  "drums",
  "keyboard",
  "other",
]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  displayName: text("display_name"),
  profileImageUrl: text("profile_image_url"),
  ...timestamps,
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const userIdentities = pgTable(
  "user_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: authProvider("provider").notNull(),
    providerSubject: text("provider_subject").notNull(),
    email: text("email"),
    emailVerified: boolean("email_verified"),
    // Apple /auth/revoke에 필요한 refresh token. id_token으로는 revoke가 안 되고,
    // authorizationCode는 5분 1회용이라 로그인 때 교환해 보관해야 한다.
    providerRefreshToken: text("provider_refresh_token"),
    ...timestamps,
  },
  (t) => [uniqueIndex("user_identities_provider_subject_uq").on(t.provider, t.providerSubject)],
);

export const authSessions = pgTable("auth_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  refreshTokenHash: text("refresh_token_hash").notNull().unique(),
  deviceName: text("device_name"),
  platform: text("platform"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const bands = pgTable("bands", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  ...timestamps,
});

export const bandMembers = pgTable(
  "band_members",
  {
    bandId: uuid("band_id")
      .notNull()
      .references(() => bands.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: bandRole("role").notNull(),
    // null = 미설정. 초대 과정에서 파트를 묻지 않으므로 갓 참여한 멤버는 항상 null이다 (스펙 결정 4)
    part: bandPart("part"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.bandId, t.userId] })],
);

export const bandInvites = pgTable("band_invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  bandId: uuid("band_id")
    .notNull()
    .references(() => bands.id, { onDelete: "cascade" }),
  // 평문 저장 — 활성 초대를 재사용하려면 URL을 복원할 수 있어야 한다 (스펙 결정 6)
  token: text("token").notNull().unique(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  maxUses: integer("max_uses"),
  usedCount: integer("used_count").notNull().default(0),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
