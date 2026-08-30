import type { Band, BandMember, Session, Take, TakeComment } from "@bandapp/types";

export interface CreateSessionInput {
  durationSec: number;
  source: "recording" | "import";
}

export interface CreateCommentInput {
  atSec: number;
  text: string;
}

export interface RehearsalApiClient {
  bands: {
    list(): Promise<Band[]>;
    members(bandId: string): Promise<BandMember[]>;
    inviteLink(bandId: string): Promise<string>;
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
