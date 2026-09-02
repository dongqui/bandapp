import type {
  AppleLoginCredential,
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
import type { CreateCommentInput, CreateSessionInput, RehearsalApiClient } from "../client";
import { seededUnit } from "./rand";
import { createSeedState, generateTakes, type MockState } from "./seed";

const MOCK_USER: User = { id: "u-mock", displayName: "Dongjin", profileImageUrl: null };
const week = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

export class MockApiClient implements RehearsalApiClient {
  private state: MockState = createSeedState();
  private listeners = new Set<() => void>();
  private analysisDelayMs: number;
  private nextId = 1;

  constructor(opts?: { analysisDelayMs?: number }) {
    this.analysisDelayMs = opts?.analysisDelayMs ?? 4000;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  private mustSession(id: string): Session {
    const s = this.state.sessions.find((x) => x.id === id);
    if (!s) throw new Error(`session not found: ${id}`);
    return s;
  }

  private scheduleAnalysis(sessionId: string) {
    setTimeout(() => {
      const s = this.state.sessions.find((x) => x.id === sessionId);
      if (!s || s.status !== "analyzing") return;
      const count = Math.max(1, Math.min(9, Math.round(s.durationSec / 900)));
      const takes = generateTakes(s.id, count);
      const base = Math.min(300, s.durationSec / count);
      takes.forEach((t, i) => {
        t.durationSec = Math.max(4, Math.round(base * (0.55 + 0.8 * seededUnit(i * 31 + 7))));
      });
      this.state.takes[s.id] = takes;
      s.status = "ready";
      s.takeCount = takes.length;
      this.emit();
    }, this.analysisDelayMs);
  }

  auth = {
    loginWithGoogle: async (): Promise<LoginResponse> => this.loginResult(),
    loginWithApple: async (credential: AppleLoginCredential): Promise<LoginResponse> =>
      this.loginResult(credential.displayName),
    logout: async (): Promise<void> => {},
    me: async (): Promise<User> => ({ ...MOCK_USER }),
    deleteAccount: async (): Promise<void> => {},
  };

  private loginResult(displayName?: string): LoginResponse {
    return {
      accessToken: "mock-access",
      refreshToken: "mock-refresh",
      user: { ...MOCK_USER, displayName: displayName ?? MOCK_USER.displayName },
      isNewUser: false,
    };
  }

  bands = {
    list: async (): Promise<Band[]> => [...this.state.bands],
    members: async (bandId: string): Promise<BandMember[]> => [...(this.state.members[bandId] ?? [])],
    create: async (name: string): Promise<Band> => {
      const band: Band = { id: `b${this.nextId++}`, name, memberCount: 1 };
      this.state.bands.push(band);
      this.state.members[band.id] = [
        { id: MOCK_USER.id, name: MOCK_USER.displayName ?? "나", role: "owner", part: null },
      ];
      this.emit();
      return { ...band };
    },
    leave: async (bandId: string): Promise<void> => {
      this.state.bands = this.state.bands.filter((b) => b.id !== bandId);
      delete this.state.members[bandId];
      this.emit();
    },
    createInvite: async (bandId: string): Promise<BandInvite> => ({
      id: `i${this.nextId++}`,
      // parseInviteToken은 토큰을 16~64자로 요구한다 — bandId만으로는 짧아서 온보딩 붙여넣기가 항상 실패했다.
      url: `https://band.app/invite/${this.mockInviteToken(bandId)}`,
      expiresAt: week(),
    }),
  };

  invites = {
    preview: async (token: string): Promise<InvitePreview> => {
      const band = this.bandFromInviteToken(token);
      return {
        band: { name: band.name, memberCount: band.memberCount },
        invitedBy: { displayName: "Minsoo" },
        expiresAt: week(),
      };
    },
    join: async (token: string): Promise<JoinInviteResult> => {
      const band = this.bandFromInviteToken(token);
      const members = (this.state.members[band.id] ??= []);
      if (members.some((m) => m.id === MOCK_USER.id)) return { bandId: band.id, alreadyMember: true };
      members.push({ id: MOCK_USER.id, name: MOCK_USER.displayName ?? "나", role: "member", part: null });
      band.memberCount = members.length;
      this.emit();
      return { bandId: band.id, alreadyMember: false };
    },
  };

  /**
   * mock 토큰 형식: mock-<bandId>-invite-0000 (parseInviteToken의 16자 최소 길이를 만족시키려는 패딩).
   * 구버전 mock-<bandId> 형식도 하위 호환으로 계속 허용한다. 그 외에는 첫 밴드로 처리한다.
   */
  private bandFromInviteToken(token: string): Band {
    const padded = /^mock-(.+)-invite-\d+$/.exec(token);
    const bandId = padded ? padded[1] : token.startsWith("mock-") ? token.slice(5) : undefined;
    const band = this.state.bands.find((b) => b.id === bandId) ?? this.state.bands[0];
    if (!band) throw new Error("초대장을 찾을 수 없어요.");
    return band;
  }

  /** parseInviteToken의 16~64자 최소 길이 요구를 만족하도록 결정적으로 패딩한 mock 초대 토큰. */
  private mockInviteToken(bandId: string): string {
    return `mock-${bandId}-invite-0000`;
  }

  sessions = {
    list: async (bandId: string): Promise<Session[]> =>
      this.state.sessions
        .filter((s) => s.bandId === bandId)
        .slice()
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    get: async (id: string): Promise<Session> => ({ ...this.mustSession(id) }),
    create: async (bandId: string, input: CreateSessionInput): Promise<Session> => {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const startedAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:00`;
      const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const s: Session = {
        id: `g${this.nextId++}`,
        bandId,
        title: `${MONTHS[now.getMonth()]} ${now.getDate()} Rehearsal`,
        status: "analyzing",
        startedAt,
        durationSec: Math.round(input.durationSec),
        takeCount: 0,
        commentCount: 0,
      };
      this.state.sessions.unshift(s);
      this.scheduleAnalysis(s.id);
      this.emit();
      return { ...s };
    },
    retryAnalysis: async (id: string): Promise<Session> => {
      const s = this.mustSession(id);
      s.status = "analyzing";
      this.scheduleAnalysis(s.id);
      this.emit();
      return { ...s };
    },
  };

  takes = {
    list: async (sessionId: string): Promise<Take[]> =>
      (this.state.takes[sessionId] ?? []).map((t) => ({ ...t })),
  };

  comments = {
    list: async (takeId: string): Promise<TakeComment[]> =>
      (this.state.comments[takeId] ?? []).slice().sort((a, b) => a.atSec - b.atSec),
    create: async (takeId: string, input: CreateCommentInput): Promise<TakeComment> => {
      const c: TakeComment = {
        id: `u${this.nextId++}`,
        takeId,
        authorName: "You",
        atSec: Math.floor(input.atSec),
        text: input.text,
      };
      (this.state.comments[takeId] ??= []).push(c);
      for (const takes of Object.values(this.state.takes)) {
        const take = takes.find((t) => t.id === takeId);
        if (take) {
          take.commentCount += 1;
          const s = this.state.sessions.find((x) => x.id === take.sessionId);
          if (s) s.commentCount += 1;
        }
      }
      this.emit();
      return { ...c };
    },
  };
}
