import { PEAK_BUCKETS, type Band, type BandMember, type CommentTarget, type Session, type Take, type TakeComment } from "@bandapp/types";
import { seedOf, seededUnit } from "./rand";

export interface MockState {
  bands: Band[];
  members: Record<string, BandMember[]>;
  sessions: Session[];
  takes: Record<string, Take[]>; // sessionId -> takes
  comments: Record<string, TakeComment[]>; // commentKey(target) -> comments
}

/** state.comments의 키 — take 코멘트와 원본 녹음 코멘트를 한 맵에 둔다 */
export function commentKey(target: CommentTarget): string {
  return "takeId" in target ? `take:${target.takeId}` : `session:${target.sessionId}`;
}

/** 시드 take id는 `${sessionId}-t${index}` — 세션 id를 되돌린다 */
function sessionOfTake(takeId: string): string {
  return takeId.slice(0, takeId.lastIndexOf("-t"));
}

/** 결정적 가짜 피크 — 길이 PEAK_BUCKETS, 0~255, 최댓값 255 (워커 출력과 같은 형식) */
export function fakePeaks(seed: number): number[] {
  const raw = Array.from({ length: PEAK_BUCKETS }, (_, i) => 0.15 + 0.85 * seededUnit(seed * 97 + i * 13));
  const max = Math.max(...raw);
  return raw.map((v) => Math.round((v / max) * 255));
}

export function generateTakes(sessionId: string, count: number): Take[] {
  const seed = seedOf(sessionId);
  let cursorMs = 60_000;
  return Array.from({ length: count }, (_, i) => {
    const durationSec = 180 + Math.floor(seededUnit(seed * 91 + i * 17) * 150);
    const startMs = cursorMs;
    cursorMs += durationSec * 1000 + 45_000;
    return { id: `${sessionId}-t${i}`, sessionId, index: i, name: `Take ${i + 1}`, durationSec, startMs, endMs: startMs + durationSec * 1000, type: "PERFORMANCE" as const, commentCount: 0, peaks: fakePeaks(seed * 7 + i) };
  });
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
  peaks: status === "ready" ? fakePeaks(seedOf(id)) : null,
});

function titleFor(startedAt: string): string {
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const d = new Date(startedAt);
  return `${MONTHS[d.getMonth()]} ${d.getDate()} Rehearsal`;
}

interface SeedReply {
  who: string;
  text: string;
}
interface SeedComment {
  who: string;
  t: number;
  text: string;
  replies?: SeedReply[];
  /** 본문을 고친 적 있는 것으로 시드 — "edited" 표기를 웹 프리뷰에서 본다 */
  edited?: boolean;
}

/** 시드 작성자 이름 → 멤버 id. 없는 이름은 m2. */
const AUTHOR_IDS: Record<string, string> = { Dongjin: "u-mock", Minsu: "m2", Jihoon: "m3", Suhyun: "m4" };

const SEED_COMMENTS: Record<string, SeedComment[]> = {
  "take:s1-t0": [
    { who: "Suhyun", t: 28, text: "Drums a bit loud in the intro?" },
    {
      who: "Minsu",
      t: 133,
      text: "Rushing going into the chorus",
      replies: [
        { who: "Dongjin", text: "Yeah I felt it too, let’s click-track this one next time" },
        { who: "Minsu", text: "ok 👍" },
        { who: "Jihoon", text: "@Dongjin click at 128 or the album tempo?" },
        { who: "Dongjin", text: "@Jihoon 128, album feels too slow live" },
        { who: "Suhyun", text: "Can we run just the transition a few times?" },
      ],
    },
    { who: "Dongjin", t: 158, text: "Second chorus vocals sitting better here", edited: true },
    { who: "Jihoon", t: 182, text: "Guitar tone is great here" },
    { who: "Suhyun", t: 210, text: "Outro cymbal swell too early", replies: [{ who: "Suhyun", text: "Never mind, it was the room" }] },
  ],
  "take:s1-t1": [{ who: "Jihoon", t: 95, text: "This one felt tight — keep this arrangement" }],
  "take:s1-t3": [
    { who: "Minsu", t: 62, text: "Bass and kick drifting apart here" },
    { who: "Suhyun", t: 201, text: "Nice ending" },
  ],
  "take:s1-t5": [{ who: "Dongjin", t: 148, text: "Best run of the night" }],
  "take:s2-t1": [
    { who: "Minsu", t: 88, text: "Second verse harmony works" },
    { who: "Jihoon", t: 190, text: "Bridge still shaky — slow it down next time" },
  ],
  "take:s2-t4": [
    { who: "Dongjin", t: 15, text: "Count-in was off" },
    { who: "Suhyun", t: 120, text: "Check tuning before this one" },
  ],
  // 원본 녹음 코멘트 — take 밖 구간에 남긴다 (2026-09-09 스펙)
  "session:s1": [
    { who: "Dongjin", t: 412, text: "Soundcheck ends here — takes start after this" },
    { who: "Suhyun", t: 3125, text: "Break chatter, skip this bit" },
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
        // 옛 데이터·추출 실패 상태를 프리뷰에서 본다 — 평평한 플레이스홀더 (2026-09-10 스펙 결정 6)
        sessionTakes.at(-1)!.peaks = null;
      }
      takes[s.id] = sessionTakes;
    }
  }

  const comments: MockState["comments"] = {};
  let cid = 0;
  // 답글은 부모 뒤에 1분 간격으로 쓴 것으로 둔다 — createdAt 순 정렬이 시드 순서를 유지하게
  const base = new Date("2026-08-27T19:03:00").getTime();
  for (const [key, rows] of Object.entries(SEED_COMMENTS)) {
    const [kind, id] = key.split(":") as ["take" | "session", string];
    const takeId = kind === "take" ? id : null;
    const sessionId = kind === "take" ? sessionOfTake(id) : id;
    const list: TakeComment[] = [];
    for (const r of rows) {
      const parentId = `c${cid++}`;
      list.push({
        id: parentId,
        sessionId,
        takeId,
        authorId: AUTHOR_IDS[r.who] ?? "m2",
        authorName: r.who,
        parentId: null,
        atSec: r.t,
        text: r.text,
        createdAt: new Date(base).toISOString(),
        updatedAt: r.edited ? new Date(base + 5 * 60_000).toISOString() : null,
      });
      (r.replies ?? []).forEach((rep, i) => {
        list.push({
          id: `c${cid++}`,
          sessionId,
          takeId,
          authorId: AUTHOR_IDS[rep.who] ?? "m2",
          authorName: rep.who,
          parentId,
          atSec: r.t,
          text: rep.text,
          createdAt: new Date(base + (i + 1) * 60_000).toISOString(),
          updatedAt: null,
        });
      });
    }
    comments[key] = list;
  }
  // commentCount 반영 — 답글은 세지 않는다. 세션은 take 코멘트 + 원본 코멘트 (2026-09-09 스펙 결정 6)
  const topLevel = (key: string) => (comments[key] ?? []).filter((c) => c.parentId === null).length;
  for (const list of Object.values(takes)) {
    for (const t of list) t.commentCount = topLevel(commentKey({ takeId: t.id }));
  }
  for (const s of sessions) {
    s.commentCount = (takes[s.id] ?? []).reduce((a, t) => a + t.commentCount, 0) + topLevel(commentKey({ sessionId: s.id }));
  }

  return {
    // b1: 내가 owner. b2: 내가 member — 팀 관리 화면의 owner/member 두 상태를 웹 프리뷰에서 본다 (2026-09-08 스펙).
    bands: [
      { id: "b1", name: "FRIDAY NIGHT", memberCount: 4 },
      { id: "b2", name: "SIDE PROJECT", memberCount: 3 },
    ],
    members: {
      b1: [
        { id: "u-mock", name: "Dongjin", role: "owner", part: "guitar" },
        { id: "m2", name: "Minsu", role: "member", part: "vocal" },
        { id: "m3", name: "Jihoon", role: "member", part: "Synth" },
        { id: "m4", name: "Suhyun", role: "member", part: null },
      ],
      b2: [
        { id: "m2", name: "Minsu", role: "owner", part: "bass" },
        { id: "u-mock", name: "Dongjin", role: "member", part: null },
        { id: "m4", name: "Suhyun", role: "member", part: "drums" },
      ],
    },
    sessions,
    takes,
    comments,
  };
}
