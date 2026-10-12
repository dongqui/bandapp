import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationType, type UpdateNotificationSettingsInput } from "@bandapp/types";

/** 알림을 만들 사건. 서비스가 DB에서 채워 넘긴다 */
export type NotificationEvent =
  | { kind: "session_ready"; bandId: string; sessionId: string; actorId: string }
  | {
      kind: "comment";
      bandId: string;
      sessionId: string;
      actorId: string;
      commentId: string;
      takeId: string | null;
      /** 답글이면 부모(최상위) 코멘트 작성자 */
      parentAuthorId: string | null;
    };

export interface Recipient {
  userId: string;
  type: NotificationType;
}

/**
 * 수신자 계산 (스펙 서버 절). 순수 함수 — DB 없음.
 * session_ready: 밴드 전원(업로더 포함), sessionReady=false 제외.
 * comment: 작성자 제외. 부모 작성자에게는 reply, 나머지는 comment. comments=false 제외, scope=mine이면 reply만.
 */
export function fanout(event: NotificationEvent, memberIds: readonly string[], settingsByUser: ReadonlyMap<string, UpdateNotificationSettingsInput>): Recipient[] {
  const out: Recipient[] = [];
  for (const userId of memberIds) {
    const s = settingsByUser.get(userId) ?? DEFAULT_NOTIFICATION_SETTINGS;
    if (event.kind === "session_ready") {
      if (s.sessionReady) out.push({ userId, type: "session_ready" });
      continue;
    }
    if (userId === event.actorId || !s.comments) continue;
    const type: NotificationType = event.parentAuthorId === userId ? "reply" : "comment";
    if (s.commentScope === "mine" && type !== "reply") continue;
    out.push({ userId, type });
  }
  return out;
}
