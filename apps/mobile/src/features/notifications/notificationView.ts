import type { NotificationItem } from "@bandapp/types";
import { fmtClock } from "../../lib/time";
import { targetOf, type PendingTarget } from "./pushTarget";

export type NotificationKind = "session_ready_self" | "session_ready" | "comment" | "reply";

/** 인박스 한 줄의 표시 모델. 문구 조립은 컴포넌트가 t()로 한다 — 이 파일은 RN을 모른다 */
export interface NotificationView {
  id: string;
  kind: NotificationKind;
  /** null = 탈퇴한 멤버(formerMember 문구), "?" = 이름 없음 */
  actorName: string | null;
  initial: string;
  /** 코멘트형: take 이름, 원본 녹음이면 null(original 문구) */
  targetName: string | null;
  /** 코멘트형: “본문”, 세션형: 세션 이름(없으면 title) */
  body: string;
  takeCount: number;
  meta: string;
  when: string;
  unread: boolean;
  /** groupByDay가 로컬 날짜를 판정하는 원본 타임스탬프 */
  createdAt: string;
  /** bandId는 ""로 비어 있다 — 시트가 현재 밴드 id로 채운다 */
  target: PendingTarget;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (d: Date) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;
const hm = (sec: number) => { const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60); return h ? `${h}H ${m}M` : `${m}M`; };

export function notificationView(item: NotificationItem, meId: string, now: Date): NotificationView {
  const sessionLabel = item.session.name ?? item.session.title;
  const actorName = item.actor === null ? null : item.actor.name?.trim() || "?";
  const initial = (actorName ?? "?")[0]!.toUpperCase();
  const common = { id: item.id, actorName, initial, takeCount: item.session.takeCount, when: whenLabel(item.createdAt, now), unread: item.readAt === null, createdAt: item.createdAt, target: targetOf(item, "") };
  if (item.type === "session_ready") {
    return {
      ...common,
      kind: item.actor?.id === meId ? "session_ready_self" : "session_ready",
      targetName: null,
      body: sessionLabel,
      meta: `${shortDate(new Date(item.session.startedAt)).toUpperCase()} · ${hm(item.session.durationSec)}`,
    };
  }
  return {
    ...common,
    kind: item.type,
    targetName: item.take?.name ?? null,
    body: `“${item.comment?.text ?? ""}”`,
    meta: `${sessionLabel.toUpperCase()} · ${fmtClock(item.comment?.atSec ?? 0)}`,
  };
}

const sameLocalDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** 디자인 when: 오늘(로컬)이면 1분 미만 now, 1시간 미만 Nm, 그 외 Nh. 어제 이전은 "Aug 28" — groupByDay의 EARLIER와 같은 기준 */
export function whenLabel(createdAtIso: string, now: Date): string {
  const created = new Date(createdAtIso);
  if (!sameLocalDay(created, now)) return shortDate(created);
  const diffMin = Math.max(0, Math.floor((now.getTime() - created.getTime()) / 60_000));
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}m`;
  return `${Math.floor(diffMin / 60)}h`;
}

/** 로컬 날짜 기준 TODAY / EARLIER. 어제 23:50은 1시간 전이어도 EARLIER */
export function groupByDay(views: NotificationView[], now: Date): Array<{ label: "today" | "earlier"; items: NotificationView[] }> {
  const today = views.filter((v) => sameLocalDay(new Date(v.createdAt), now));
  const earlier = views.filter((v) => !sameLocalDay(new Date(v.createdAt), now));
  const out: Array<{ label: "today" | "earlier"; items: NotificationView[] }> = [];
  if (today.length) out.push({ label: "today", items: today });
  if (earlier.length) out.push({ label: "earlier", items: earlier });
  return out;
}
