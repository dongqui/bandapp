import type {
  AppleLoginCredential,
  AudioUrl,
  AuthTokens,
  Band,
  BandInvite,
  BandMember,
  BandPart,
  CreateCommentInput,
  CreateSessionInput,
  CreateSessionResult,
  InvitePreview,
  JoinInviteResult,
  LoginResponse,
  Session,
  Take,
  TakeComment,
  UploadPartUrl,
  UploadStatus,
  UploadedPart,
  User,
} from "@bandapp/types";

export type { CreateCommentInput, CreateSessionInput } from "@bandapp/types";

export interface UploadSource {
  sizeBytes: number;
  /** [start, end) 바이트 범위를 Blob으로 돌려준다. 호출자는 파트마다 한 번 부른다. */
  readPart(range: { start: number; end: number }): Promise<Blob>;
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
    deleteAccount(): Promise<void>;
  };
  bands: {
    list(): Promise<Band[]>;
    create(name: string): Promise<Band>;
    members(bandId: string): Promise<BandMember[]>;
    /** 본인 파트만 설정한다. null이면 해제. */
    setMyPart(bandId: string, part: BandPart | null): Promise<BandMember>;
    /** Owner 전용. 성공하면 서버가 그 밴드의 활성 초대를 함께 무효화한다. */
    removeMember(bandId: string, userId: string): Promise<void>;
    leave(bandId: string): Promise<void>;
    createInvite(bandId: string): Promise<BandInvite>;
    revokeInvite(bandId: string, inviteId: string): Promise<void>;
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
    /** create → 파트 업로드 → complete를 한 번에. Mock은 진행률만 흉내 낸다. */
    upload(
      bandId: string,
      input: CreateSessionInput,
      source: UploadSource,
      onProgress?: (p: UploadProgress) => void,
    ): Promise<Session>;
  };
  takes: {
    list(sessionId: string): Promise<Take[]>;
    audioUrl(takeId: string): Promise<AudioUrl>;
  };
  comments: {
    list(takeId: string): Promise<TakeComment[]>;
    create(takeId: string, input: CreateCommentInput): Promise<TakeComment>;
  };
  /** 데이터 변경 통지. 반환값은 구독 해제 함수. */
  subscribe(listener: () => void): () => void;
}
