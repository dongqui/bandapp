import type { NotificationSettings, UpdateNotificationSettingsInput } from "@bandapp/types";

export type PushPermission = "allowed" | "ask" | "denied" | "unavailable";
export type SummaryKey = "all" | "mine" | "sessionsOnly" | "commentsOnly" | "repliesOnly" | "off";

/** 밴드 시트의 한 줄 요약 (디자인 summ) */
export function settingsSummary(s: UpdateNotificationSettingsInput): SummaryKey {
  if (s.sessionReady && s.comments) return s.commentScope === "mine" ? "mine" : "all";
  if (s.sessionReady) return "sessionsOnly";
  if (s.comments) return s.commentScope === "mine" ? "repliesOnly" : "commentsOnly";
  return "off";
}

/** Me 행 값 (디자인 meNfValue): 권한 없거나 전부 off → off, 전부 on → on, 아니면 n of m */
export function meNfValue(permission: PushPermission, settings: NotificationSettings[]): { kind: "off" } | { kind: "on" } | { kind: "partial"; on: number; total: number } {
  const on = settings.filter((s) => s.sessionReady || s.comments).length;
  if (permission !== "allowed" || on === 0) return { kind: "off" };
  if (on === settings.length) return { kind: "on" };
  return { kind: "partial", on, total: settings.length };
}
