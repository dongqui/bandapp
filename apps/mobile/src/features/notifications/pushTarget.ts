import type { NotificationItem } from "@bandapp/types";

/** 푸시 data / 인박스 항목 → 이동 목적지. takeId "orig" = 원본 녹음(기존 /take/orig 라우트) */
export interface PendingTarget {
  notificationId: string | null;
  bandId: string;
  sessionId: string;
  takeId: string | null;
  atSec: number | null;
}

/**
 * 인박스 항목 → 목적지. 항목에는 bandId가 없으므로 호출 쪽이 현재 밴드 id를 넘긴다
 * (notificationView는 ""로 만들고, 시트가 `{ ...v.target, bandId }`로 채운다).
 */
export function targetOf(item: NotificationItem, bandId: string): PendingTarget {
  if (item.type === "session_ready") return { notificationId: item.id, bandId, sessionId: item.session.id, takeId: null, atSec: null };
  return { notificationId: item.id, bandId, sessionId: item.session.id, takeId: item.take?.id ?? "orig", atSec: item.comment?.atSec ?? null };
}

/** FCM data는 전부 문자열. 필수 키가 빠지면 null — 모르는 푸시는 무시한다 */
export function parsePushData(data: Record<string, unknown> | undefined | null): PendingTarget | null {
  if (!data) return null;
  const str = (k: string) => (typeof data[k] === "string" && (data[k] as string).length > 0 ? (data[k] as string) : null);
  const bandId = str("bandId"), sessionId = str("sessionId"), type = str("type");
  if (!bandId || !sessionId || !type) return null;
  if (type === "session_ready") return { notificationId: str("notificationId"), bandId, sessionId, takeId: null, atSec: null };
  const atMs = str("atMs");
  return { notificationId: str("notificationId"), bandId, sessionId, takeId: str("takeId") ?? "orig", atSec: atMs !== null && Number.isFinite(Number(atMs)) ? Number(atMs) / 1000 : null };
}

export function routeFor(t: PendingTarget): string {
  if (t.takeId === null) return `/session/${t.sessionId}`;
  const at = t.atSec === null ? "" : `?at=${t.atSec}`;
  return `/session/${t.sessionId}/take/${t.takeId}${at}`;
}
