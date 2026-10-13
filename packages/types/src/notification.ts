export type NotificationType = "session_ready" | "comment" | "reply";
export type CommentScope = "all" | "mine";

export interface NotificationItem {
  id: string;
  type: NotificationType;
  /** null = 탈퇴한 멤버. name이 null이면 이름 없는 계정 */
  actor: { id: string; name: string | null } | null;
  session: { id: string; title: string; name: string | null; startedAt: string; takeCount: number; durationSec: number };
  /** 원본 녹음 코멘트·session_ready면 null */
  take: { id: string; index: number; name: string } | null;
  /** session_ready면 null */
  comment: { id: string; atSec: number; text: string } | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPage {
  items: NotificationItem[];
  /** 더 없으면 null */
  nextCursor: string | null;
  /** 이 페이지 뒤에 남은 개수 — "Show older (n)" */
  remaining: number;
  /** 밴드 기준 미읽음 수 */
  unreadCount: number;
}

export interface NotificationSettings {
  bandId: string;
  sessionReady: boolean;
  comments: boolean;
  commentScope: CommentScope;
}

export type UpdateNotificationSettingsInput = Omit<NotificationSettings, "bandId">;

export const DEFAULT_NOTIFICATION_SETTINGS: UpdateNotificationSettingsInput = { sessionReady: true, comments: true, commentScope: "all" };

export interface RegisterPushTokenInput {
  token: string;
  platform: "ios" | "android";
  /** 기기 언어 태그 (예: "ko-KR", "en") */
  locale: string;
}

export const NOTIFICATIONS_PAGE_SIZE = 6;
export const NOTIFICATIONS_PAGE_MAX = 50;
