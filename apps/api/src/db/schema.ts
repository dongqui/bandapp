import {
  type AnyPgColumn,
  bigint,
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const authProvider = pgEnum("auth_provider", ["GOOGLE", "APPLE", "DEV"]);
export type AuthProviderName = (typeof authProvider.enumValues)[number];

// @bandapp/types의 SessionStatus / TakeCandidateType과 값을 일치시킨다
export const sessionStatus = pgEnum("session_status", ["uploading", "analyzing", "failed", "ready"]);
export const uploadStatus = pgEnum("upload_status", ["pending", "completed", "aborted"]);
export const takeType = pgEnum("take_type", ["PERFORMANCE", "PARTIAL_PRACTICE"]);
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

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  bandId: uuid("band_id")
    .notNull()
    .references(() => bands.id, { onDelete: "cascade" }),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  title: text("title").notNull(),
  name: text("name"),
  status: sessionStatus("status").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  // 가져오기는 클라이언트가 길이를 모른다 — 워커가 ffprobe로 채운다
  durationMs: integer("duration_ms"),
  takeCount: integer("take_count").notNull().default(0),
  analysisError: text("analysis_error"),
  analysisModel: text("analysis_model"),
  ...timestamps,
});

// 세션과 1:1. 저장 객체와 업로드 상태의 수명주기가 세션과 달라 테이블을 나눈다 (스펙 결정 5)
export const recordings = pgTable("recordings", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .unique()
    .references(() => sessions.id, { onDelete: "cascade" }),
  objectKey: text("object_key").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  uploadId: text("upload_id"),
  partSize: integer("part_size").notNull(),
  partCount: integer("part_count").notNull(),
  uploadStatus: uploadStatus("upload_status").notNull().default("pending"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const takes = pgTable(
  "takes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    index: integer("index").notNull(),
    name: text("name").notNull(),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    type: takeType("type").notNull(),
    confidence: real("confidence").notNull(),
    objectKey: text("object_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("takes_session_index_uq").on(t.sessionId, t.index)],
);

export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    takeId: uuid("take_id")
      .notNull()
      .references(() => takes.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    // 대댓글 자리 (스펙 결정 6). 이번 범위에서는 항상 null
    parentId: uuid("parent_id").references((): AnyPgColumn => comments.id, { onDelete: "cascade" }),
    atMs: integer("at_ms").notNull(),
    text: text("text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("comments_take_at_idx").on(t.takeId, t.atMs)],
);
