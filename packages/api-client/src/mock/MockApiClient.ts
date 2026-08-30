import type { Band, BandMember, Session, Take, TakeComment } from "@bandapp/types";
import type { CreateCommentInput, CreateSessionInput, RehearsalApiClient } from "../client";
import { seededUnit } from "./rand";
import { createSeedState, generateTakes, type MockState } from "./seed";

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

  bands = {
    list: async (): Promise<Band[]> => [...this.state.bands],
    members: async (bandId: string): Promise<BandMember[]> => [...(this.state.members[bandId] ?? [])],
    inviteLink: async (bandId: string): Promise<string> => {
      const band = this.state.bands.find((b) => b.id === bandId);
      if (!band) throw new Error(`band not found: ${bandId}`);
      return `band.app/join/${band.id}`;
    },
  };

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
