const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS_SHORT = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const MONTHS_LONG = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

export function fmtClock(totalSec: number): string {
  const t = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

export function startLabel(startedAtIso: string): string {
  const d = new Date(startedAtIso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function clockRange(startedAtIso: string, durationSec: number): string {
  const d = new Date(startedAtIso);
  const total = (d.getHours() * 60 + d.getMinutes() + Math.round(durationSec / 60)) % 1440;
  return `${startLabel(startedAtIso)} – ${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

export function dateLabel(startedAtIso: string): string {
  const d = new Date(startedAtIso);
  return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()} · ${WEEKDAYS[d.getDay()]}`;
}

export function monthLabel(startedAtIso: string): string {
  const d = new Date(startedAtIso);
  return `${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`;
}
