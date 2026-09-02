import type { Band, BandMember, Session, Take, TakeComment } from "@bandapp/types";
import { seedOf, seededUnit } from "./rand";

export interface MockState {
  bands: Band[];
  members: Record<string, BandMember[]>;
  sessions: Session[];
  takes: Record<string, Take[]>; // sessionId -> takes
  comments: Record<string, TakeComment[]>; // takeId -> comments
}

export function generateTakes(sessionId: string, count: number): Take[] {
  const seed = seedOf(sessionId);
  return Array.from({ length: count }, (_, i) => ({
    id: `${sessionId}-t${i}`,
    sessionId,
    index: i,
    name: `Take ${i + 1}`,
    durationSec: 180 + Math.floor(seededUnit(seed * 91 + i * 17) * 150),
    commentCount: 0,
  }));
}

const session = (
  id: string,
  startedAt: string,
  durationSec: number,
  takeCount: number,
  status: Session["status"],
  name?: string,
): Session => ({
  id,
  bandId: "b1",
  title: titleFor(startedAt),
  name,
  status,
  startedAt,
  durationSec,
  takeCount,
  commentCount: 0,
});

function titleFor(startedAt: string): string {
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const d = new Date(startedAt);
  return `${MONTHS[d.getMonth()]} ${d.getDate()} Rehearsal`;
}

const SEED_COMMENTS: Record<string, Array<{ who: string; t: number; text: string }>> = {
  "s1-t0": [
    { who: "Suhyun", t: 28, text: "Drums a bit loud in the intro?" },
    { who: "Minsu", t: 133, text: "Rushing going into the chorus" },
    { who: "Jihoon", t: 182, text: "Guitar tone is great here" },
  ],
  "s1-t1": [{ who: "Jihoon", t: 95, text: "This one felt tight — keep this arrangement" }],
  "s1-t3": [
    { who: "Minsu", t: 62, text: "Bass and kick drifting apart here" },
    { who: "Suhyun", t: 201, text: "Nice ending" },
  ],
  "s1-t5": [{ who: "Dongjin", t: 148, text: "Best run of the night" }],
  "s2-t1": [
    { who: "Minsu", t: 88, text: "Second verse harmony works" },
    { who: "Jihoon", t: 190, text: "Bridge still shaky — slow it down next time" },
  ],
  "s2-t4": [
    { who: "Dongjin", t: 15, text: "Count-in was off" },
    { who: "Suhyun", t: 120, text: "Check tuning before this one" },
  ],
};

export function createSeedState(): MockState {
  const sessions = [
    session("p1", "2026-08-29T18:47:00", 4620, 0, "analyzing"),
    session("f1", "2026-08-28T15:30:00", 4320, 0, "failed"),
    session("s1", "2026-08-27T19:03:00", 8040, 7, "ready", "Full set run-through"),
    session("s2", "2026-08-20T20:11:00", 6480, 5, "ready"),
    session("s3", "2026-08-13T19:42:00", 9060, 9, "ready"),
  ];
  const takes: MockState["takes"] = {};
  for (const s of sessions) {
    if (s.status === "ready") {
      const sessionTakes = generateTakes(s.id, s.takeCount);
      if (s.id === "s1" && sessionTakes.length > 1) {
        sessionTakes[0]!.durationSec = 272;
        sessionTakes[1]!.durationSec = 268;
      }
      takes[s.id] = sessionTakes;
    }
  }

  const comments: MockState["comments"] = {};
  let cid = 0;
  for (const [takeId, rows] of Object.entries(SEED_COMMENTS)) {
    comments[takeId] = rows.map((r) => ({
      id: `c${cid++}`,
      takeId,
      authorName: r.who,
      atSec: r.t,
      text: r.text,
    }));
  }
  // commentCount 반영
  for (const list of Object.values(takes)) {
    for (const t of list) t.commentCount = comments[t.id]?.length ?? 0;
  }
  for (const s of sessions) {
    s.commentCount = (takes[s.id] ?? []).reduce((a, t) => a + t.commentCount, 0);
  }

  return {
    bands: [{ id: "b1", name: "FRIDAY NIGHT", memberCount: 4 }],
    members: {
      b1: [
        { id: "m1", name: "Dongjin Kim", role: "owner", part: "guitar" },
        { id: "m2", name: "Minsu", role: "member", part: "vocal" },
        { id: "m3", name: "Jihoon", role: "member", part: "bass" },
        { id: "m4", name: "Suhyun", role: "member", part: null },
      ],
    },
    sessions,
    takes,
    comments,
  };
}
