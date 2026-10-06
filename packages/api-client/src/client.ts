import type {
  AppleLoginCredential,
  AudioUrl,
  AuthTokens,
  Band,
  BandBilling,
  BandInvite,
  BandMember,
  CommentTarget,
  CreateCommentInput,
  CreateSessionInput,
  CreateSupportRequestInput,
  CreateSessionResult,
  InvitePreview,
  JoinInviteResult,
  LoginResponse,
  Session,
  SupportRequestCreated,
  Take,
  TakeComment,
  UpdateCommentInput,
  UpdateMeInput,
  UpdateTakeInput,
  UploadPartUrl,
  UploadStatus,
  UploadedPart,
  User,
} from "@bandapp/types";

export type { CommentTarget, CreateCommentInput, CreateSessionInput, UpdateCommentInput, UpdateMeInput } from "@bandapp/types";

/**
 * 프로필 사진 업로드 조각. 웹은 Blob, RN은 fetch가 네이티브 파일로 읽는 `{ uri, name, type }`를
 * FormData에 그대로 넣는다 — api-client는 플랫폼을 모르므로 호출자가 고른다.
 */
export type ProfilePhotoUpload = Blob | { uri: string; name: string; type: string };

/**
 * PUT body로 그대로 넘길 수 있는 파트 한 조각. 웹은 Blob(게으른 slice), RN은 Uint8Array를
 * 준다 — RN fetch는 Uint8Array를 RCTNetworking이 base64로 바꿔 네이티브로 보낸다.
 */
export type UploadPartBody = Blob | Uint8Array;

export interface UploadSource {
  sizeBytes: number;
  /** [start, end) 바이트 범위를 돌려준다. 호출자는 파트마다 한 번 부른다. */
  readPart(range: { start: number; end: number }): Promise<UploadPartBody>;
}

export interface UploadProgress {
  uploadedBytes: number;
  totalBytes: number;
}

/** 토큰 보관소 — 모바일이 SecureStore로 구현한다. */
export interface TokenStorage {
  getAccessToken(): Promise<string | null>;
  getRefreshToken(): Promise<string | null>;
  setTokens(tokens: AuthTokens): Promise<void>;
  clear(): Promise<void>;
}

export interface RehearsalApiClient {
  auth: {
    loginWithGoogle(idToken: string): Promise<LoginResponse>;
    loginWithApple(credential: AppleLoginCredential): Promise<LoginResponse>;
    /** 서버 refresh 세션 revoke + 로컬 토큰 삭제. 인자 없음 — 구현이 보관소에서 읽는다. */
    logout(): Promise<void>;
    me(): Promise<User>;
    /** 이름 변경. trim 후 1~DISPLAY_NAME_MAX자. 성공하면 구독자에게 통지한다 (멤버 목록의 이름이 바뀐다) */
    updateMe(input: UpdateMeInput): Promise<User>;
    /** 프로필 사진 교체. 응답의 profileImageUrl은 새 사진 URL */
    setPhoto(photo: ProfilePhotoUpload): Promise<User>;
    /** 프로필 사진 제거 — 제공자 사진도 함께 지워져 이니셜만 남는다 */
    removePhoto(): Promise<void>;
    deleteAccount(): Promise<void>;
  };
  support: {
    /** Contact us 전송. 서버가 저장하고 운영 채널에 알린다 */
    send(input: CreateSupportRequestInput): Promise<SupportRequestCreated>;
  };
  bands: {
    list(): Promise<Band[]>;
    create(name: string): Promise<Band>;
    members(bandId: string): Promise<BandMember[]>;
    /** 본인 파트만 설정한다. null이면 해제. */
    setMyPart(bandId: string, part: string | null): Promise<BandMember>;
    /** Owner 전용. 성공하면 서버가 그 밴드의 활성 초대를 함께 무효화한다. */
    removeMember(bandId: string, userId: string): Promise<void>;
    leave(bandId: string): Promise<void>;
    /** Owner 전용. trim 후 1~50자. */
    rename(bandId: string, name: string): Promise<Band>;
    /** Owner 전용. 대상이 owner가 되고 호출자는 member가 된다. */
    transferOwnership(bandId: string, userId: string): Promise<void>;
    /** Owner 전용. soft delete — 목록에서 사라진다. */
    delete(bandId: string): Promise<void>;
    createInvite(bandId: string): Promise<BandInvite>;
    revokeInvite(bandId: string, inviteId: string): Promise<void>;
    /** 밴드 결제 상태. 멤버 누구나. 디자인 B01의 재료 */
    billing(bandId: string): Promise<BandBilling>;
    /** Owner 전용. 내 활성 풀에 연결. 409 billing_no_active_pool */
    linkPool(bandId: string): Promise<BandBilling>;
    /** Owner 전용. 연결 해제 — 밴드는 무료로 돌아가고 추가 시간은 남는다 */
    unlinkPool(bandId: string): Promise<BandBilling>;
  };
  billing: {
    /** 구매 직후·"Check status"에서. 서버가 RevenueCat 상태를 다시 읽는다. bandId가 있으면 그 밴드 billing을 돌려준다 */
    sync(bandId?: string): Promise<BandBilling | null>;
  };
  invites: {
    preview(token: string): Promise<InvitePreview>;
    join(token: string): Promise<JoinInviteResult>;
  };
  sessions: {
    list(bandId: string): Promise<Session[]>;
    get(id: string): Promise<Session>;
    create(bandId: string, input: CreateSessionInput): Promise<CreateSessionResult>;
    partUrls(id: string, partNumbers: number[]): Promise<UploadPartUrl[]>;
    uploadStatus(id: string): Promise<UploadStatus>;
    completeUpload(id: string, parts: UploadedPart[]): Promise<Session>;
    retryAnalysis(id: string): Promise<Session>;
    audioUrl(id: string): Promise<AudioUrl>;
    /** 고해상도 피크 사이드카(peaks.bin) URL. 없으면 ApiError 404 code "peaks_not_found". Mock은 url ""를 준다 → 앱은 128버킷 폴백 */
    peaksUrl(id: string): Promise<AudioUrl>;
    /** create → 파트 업로드 → complete를 한 번에. onCreated는 create 직후 sessionId를 준다. Mock은 진행률만 흉내 낸다. */
    upload(
      bandId: string,
      input: CreateSessionInput,
      source: UploadSource,
      onProgress?: (p: UploadProgress) => void,
      onCreated?: (sessionId: string) => Promise<void>,
    ): Promise<Session>;
    /** 이미 create된 uploading 세션의 남은 파트를 올리고 complete한다 (앱 종료 후 이어 올리기). */
    resumeUpload(id: string, source: UploadSource, onProgress?: (p: UploadProgress) => void): Promise<Session>;
  };
  takes: {
    list(sessionId: string): Promise<Take[]>;
    audioUrl(takeId: string): Promise<AudioUrl>;
    /** 경계 변경. 409 take_version_conflict / session_not_ready, 400 take_range_invalid / take_overlap. 응답은 audioStatus "updating" */
    update(takeId: string, input: UpdateTakeInput): Promise<Take>;
    /** 삭제. 코멘트도 함께 사라진다 */
    remove(takeId: string): Promise<void>;
    /** 이름 변경. null이나 빈 문자열이면 기본 이름 "Take n"으로 돌아간다. 1~40자, 서버가 trim */
    rename(takeId: string, name: string | null): Promise<Take>;
  };
  comments: {
    /** target이 { takeId }면 take 코멘트, { sessionId }면 원본 녹음 코멘트 */
    list(target: CommentTarget): Promise<TakeComment[]>;
    create(target: CommentTarget, input: CreateCommentInput): Promise<TakeComment>;
    /** 작성자만. 본문만 바꾸고 updatedAt이 채워진다 */
    update(id: string, input: UpdateCommentInput): Promise<TakeComment>;
    /** 작성자만. 최상위 코멘트를 지우면 답글도 함께 사라진다 */
    remove(id: string): Promise<void>;
  };
  /** 데이터 변경 통지. 반환값은 구독 해제 함수. */
  subscribe(listener: () => void): () => void;
}
