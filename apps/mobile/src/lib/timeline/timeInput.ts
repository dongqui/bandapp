import type { Neighbors } from "@bandapp/types";

/**
 * Edit 화면 START / END 시간 입력 (2026-10-08 디자인 "Add take"). 모바일 숫자 키패드에는 ':'가 없으므로 사용자는
 * 숫자만 치고, 콜론은 타이머처럼 오른쪽부터 채워 자동으로 넣는다: 1 → 0:01, 123 → 1:23, 12305 → 1:23:05.
 * 붙여넣은 "12:30"이나 외장 키보드의 콜론은 숫자만 남겨 같은 규칙으로 다시 그린다.
 */

/** h:mm:ss까지 — 더 치면 앞자리가 밀려 나간다 */
const MAX_DIGITS = 6;

/** 입력 문자열에서 숫자만 남긴다. 앞의 0은 버린다 (0:05 ↔ "5") */
export function clockDigits(text: string): string {
  return text
    .replace(/\D/g, "")
    .replace(/^0+/, "")
    .slice(-MAX_DIGITS);
}

const pad2 = (n: string) => n.padStart(2, "0");

/** 자리수를 오른쪽부터 채워 m:ss 또는 h:mm:ss로. 빈 문자열이면 "" (placeholder가 보인다) */
export function formatClockDigits(digits: string): string {
  if (digits.length === 0) return "";
  const ss = digits.slice(-2);
  const mm = digits.slice(-4, -2);
  const hh = digits.slice(0, -4);
  if (hh.length > 0) return `${hh}:${pad2(mm)}:${pad2(ss)}`;
  return `${mm.length > 0 ? mm : "0"}:${pad2(ss)}`;
}

/** 자리수를 초로. 비었거나 초·분 자리가 60 이상이면 null */
export function parseClockDigits(digits: string): number | null {
  if (digits.length === 0) return null;
  const ss = Number(digits.slice(-2));
  const mm = Number(digits.slice(-4, -2) || "0");
  const hh = Number(digits.slice(0, -4) || "0");
  if (ss >= 60 || mm >= 60) return null;
  return hh * 3600 + mm * 60 + ss;
}

/** 초를 입력 칸 표시용으로 — fmtClock과 달리 분을 0으로 채우지 않는다 (디자인 "0:00" placeholder와 같은 꼴) */
export function secToClockInput(sec: number): string {
  const t = Math.max(0, Math.floor(sec));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h ? `${h}:${pad2(String(m))}:${pad2(String(s))}` : `${m}:${pad2(String(s))}`;
}

export interface TimeInputContext extends Neighbors {
  durationMs: number;
}

export type TimeInputResult = { startMs: number; endMs: number } | { error: string };

/** 입력 칸 하나 — 사용자가 친 자리수, 또는 안 건드린 칸의 초안 ms 그대로 (초 단위로 내리면 이웃 경계에 맞춘 값이 겹침으로 오판된다) */
export type TimeField = string | { ms: number };

function fieldMs(f: TimeField): number | null {
  if (typeof f !== "string") return f.ms;
  const sec = parseClockDigits(f);
  return sec === null ? null : sec * 1000;
}

/** 디자인의 검증 순서와 문구. 통과하면 ms 범위 */
export function validateTimeInput(start: TimeField, end: TimeField, ctx: TimeInputContext): TimeInputResult {
  const startMs = fieldMs(start);
  const endMs = fieldMs(end);
  if (startMs === null || endMs === null) return { error: "Use m:ss or h:mm:ss, like 12:30." };
  if (endMs - startMs < 1000) return { error: "End has to be at least 1 second after start." };
  if (ctx.prevEndMs !== null && startMs < ctx.prevEndMs) {
    return { error: `Start overlaps the previous take (ends ${secToClockInput(Math.ceil(ctx.prevEndMs / 1000))}).` };
  }
  const hi = Math.min(ctx.nextStartMs ?? ctx.durationMs, ctx.durationMs);
  if (endMs > hi) {
    return hi >= ctx.durationMs
      ? { error: `End is past the end of the recording (${secToClockInput(ctx.durationMs / 1000)}).` }
      : { error: `End overlaps the next take (starts ${secToClockInput(hi / 1000)}).` };
  }
  return { startMs, endMs };
}
