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
  smallint,
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
  // soft delete — 행·R2 객체는 남긴다. 영구 삭제는 배치가 맡는다 (2026-09-08 스펙 결정 3)
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
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
    // null = 미설정. 프리셋 키(vocal 등)든 자유 문자열이든 서버는 구분하지 않는다 (2026-09-08 스펙 결정 1·2)
    part: text("part"),
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
  // 원본 녹음 전체 피크 — 길이 128, 0~255. 워커가 ready로 바꿀 때 채운다. 옛 데이터·추출 실패면 null (2026-09-10 스펙 결정 1, 5)
  peaks: smallint("peaks").array(),
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
    // 원본 타임라인의 start_ms~end_ms 구간 피크 — 길이 128, 0~255. 추출 실패면 null (2026-09-10 스펙 결정 3, 5)
    peaks: smallint("peaks").array(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("takes_session_index_uq").on(t.sessionId, t.index)],
);

export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // 모든 코멘트가 세션에 속한다 — 원본 녹음 코멘트는 take_id가 NULL (2026-09-09 스펙 결정 4)
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    takeId: uuid("take_id").references(() => takes.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    // 답글이면 부모(최상위 코멘트). 스레드는 1단계만 허용한다 — 서비스에서 검증
    parentId: uuid("parent_id").references((): AnyPgColumn => comments.id, { onDelete: "cascade" }),
    atMs: integer("at_ms").notNull(),
    text: text("text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // 본문을 수정할 때만 채운다 → "edited" (2026-09-09 스펙 결정 2)
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => [index("comments_take_at_idx").on(t.takeId, t.atMs), index("comments_session_at_idx").on(t.sessionId, t.atMs)],
);
