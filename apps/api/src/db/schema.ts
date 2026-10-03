import {
  type AnyPgColumn,
  bigint,
  boolean,
  index,
  integer,
  jsonb,
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
export const sessionStatus = pgEnum("session_status", ["uploading", "analyzing", "waiting_for_time", "failed", "ready"]);
export const uploadStatus = pgEnum("upload_status", ["pending", "completed", "aborted"]);
export const takeType = pgEnum("take_type", ["PERFORMANCE", "PARTIAL_PRACTICE"]);
export const takeAudioStatus = pgEnum("take_audio_status", ["ready", "updating", "failed"]);
// @bandapp/types의 MemberRole("owner" | "member")과 값을 일치시킨다 (스펙 결정 5)
export const bandRole = pgEnum("band_role", ["owner", "member"]);
// 결제 (2026-10-03 스펙)
export const poolPlan = pgEnum("pool_plan", ["band", "plus"]);
export const poolStatus = pgEnum("pool_status", ["active", "grace", "expired"]);
export const chargeState = pgEnum("charge_state", ["reserved", "charged", "refunded"]);
export const billingStore = pgEnum("billing_store", ["app_store", "play_store"]);

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

// 구독자(오너) 1명당 1행. 월 시간은 used_sec + 예약 합계로 계산하므로 남은 시간 컬럼은 없다.
export const billingPools = pgTable("billing_pools", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  plan: poolPlan("plan"),
  status: poolStatus("status").notNull().default("expired"),
  store: billingStore("store"),
  periodStart: timestamp("period_start", { withTimezone: true }),
  periodEnd: timestamp("period_end", { withTimezone: true }),
  willRenew: boolean("will_renew").notNull().default(false),
  // 이번 기간에 확정(charged)된 월 시간 사용량. 갱신(period_start 변경)마다 0
  usedSec: integer("used_sec").notNull().default(0),
  ...timestamps,
});

export const bands = pgTable("bands", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  // 연결된 풀. 오너 양도·연결 해제 시 null. 풀이 지워지면 null
  poolId: uuid("pool_id").references(() => billingPools.id, { onDelete: "set null" }),
  // 밴드당 무료 3h는 평생 1회 — 초기화하지 않는다
  freeUsedSec: integer("free_used_sec").notNull().default(0),
  // 밴드가 산 추가 시간 잔여. 연결 해제·만료·양도 뒤에도 밴드에 남는다
  extraSec: integer("extra_sec").notNull().default(0),
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
  // 고해상도 피크 사이드카(peaks.bin)의 R2 키. 워커 업로드가 성공했을 때만 채운다. 옛 데이터·실패면 null (2026-09-11 스펙 결정 5)
  peaksKey: text("peaks_key"),
  ...timestamps,
});

// 분석 차감 원장. 세션당 1행이라 재시도·중복 전달이 이중 차감되지 않는다
export const analysisCharges = pgTable("analysis_charges", {
  sessionId: uuid("session_id")
    .primaryKey()
    .references(() => sessions.id, { onDelete: "cascade" }),
  bandId: uuid("band_id")
    .notNull()
    .references(() => bands.id, { onDelete: "cascade" }),
  poolId: uuid("pool_id").references(() => billingPools.id, { onDelete: "set null" }),
  freeSec: integer("free_sec").notNull().default(0),
  monthlySec: integer("monthly_sec").notNull().default(0),
  extraSec: integer("extra_sec").notNull().default(0),
  state: chargeState("state").notNull(),
  ...timestamps,
});

// RevenueCat 웹훅 원본. id 충돌 = 중복 전달
export const billingEvents = pgTable("billing_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  appUserId: text("app_user_id").notNull(),
  payload: jsonb("payload").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

// 소모성(추가 시간) 거래 원장. 같은 거래가 웹훅·sync 양쪽에서 와도 applied_at으로 한 번만 반영
export const extraPurchases = pgTable("extra_purchases", {
  transactionId: text("transaction_id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  bandId: uuid("band_id").references(() => bands.id, { onDelete: "set null" }),
  sec: integer("sec").notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
    // 경계 편집 낙관적 잠금. PATCH마다 +1 (2026-09-11 스펙 B 결정 4)
    version: integer("version").notNull().default(1),
    // 재컷 진행 상태 — updating이면 앱이 재생을 막는다. 실패 사유는 audio_error (결정 3)
    audioStatus: takeAudioStatus("audio_status").notNull().default("ready"),
    audioError: text("audio_error"),
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
