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

/** Me 행 값 (디자인 meNfValue): ask/denied 또는 전부 off → off, 전부 on → on, 아니면 n of m. unavailable(Firebase 없는 빌드)은 설정이 인박스 행도 거르므로 설정 그대로 (결정 14) */
export function meNfValue(permission: PushPermission, settings: NotificationSettings[]): { kind: "off" } | { kind: "on" } | { kind: "partial"; on: number; total: number } {
  const on = settings.filter((s) => s.sessionReady || s.comments).length;
  if (permission === "ask" || permission === "denied" || on === 0) return { kind: "off" };
  if (on === settings.length) return { kind: "on" };
  return { kind: "partial", on, total: settings.length };
}
