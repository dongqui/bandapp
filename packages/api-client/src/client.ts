import type {
  AppleLoginCredential,
  AuthTokens,
  Band,
  BandInvite,
  BandMember,
  InvitePreview,
  JoinInviteResult,
  LoginResponse,
  Session,
  Take,
  TakeComment,
  User,
} from "@bandapp/types";

export interface CreateSessionInput {
  durationSec: number;
  source: "recording" | "import";
}

export interface CreateCommentInput {
  atSec: number;
  text: string;
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
    leave(bandId: string): Promise<void>;
    createInvite(bandId: string): Promise<BandInvite>;
  };
  invites: {
    preview(token: string): Promise<InvitePreview>;
    join(token: string): Promise<JoinInviteResult>;
  };
  sessions: {
    list(bandId: string): Promise<Session[]>;
    get(id: string): Promise<Session>;
    create(bandId: string, input: CreateSessionInput): Promise<Session>;
    retryAnalysis(id: string): Promise<Session>;
  };
  takes: {
    list(sessionId: string): Promise<Take[]>;
  };
  comments: {
    list(takeId: string): Promise<TakeComment[]>;
    create(takeId: string, input: CreateCommentInput): Promise<TakeComment>;
  };
  /** 데이터 변경 통지. 반환값은 구독 해제 함수. */
  subscribe(listener: () => void): () => void;
}
