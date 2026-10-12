import type { NotificationType } from "@bandapp/types";

export interface PushTextInput {
  type: NotificationType;
  /** null = 탈퇴한 멤버, "" = 이름 없는 계정 */
  actorName: string | null;
  /** session_ready를 업로더 본인이 받을 때 */
  isSelf: boolean;
  /** session.name ?? session.title */
  sessionLabel: string;
  takeCount: number;
  /** 원본 녹음 코멘트면 null */
  takeName: string | null;
  commentText: string | null;
}

const BODY_MAX = 200;

/** 푸시 문구 (스펙 서버 절 표). 인박스 문구는 모바일 i18n이 같은 규칙으로 만든다 */
export function pushText(locale: string, input: PushTextInput): { title: string; body: string } {
  const ko = locale.toLowerCase().startsWith("ko");
  const actor = input.actorName === null ? (ko ? "탈퇴한 멤버" : "A former member") : input.actorName.trim() || "?";
  const target = input.takeName ?? (ko ? "원본 녹음" : "the original recording");
  const quote = `“${truncate(input.commentText ?? "")}”`;
  switch (input.type) {
    case "session_ready": {
      const title = input.isSelf ? (ko ? "내 녹음이 준비됐어요" : "Your recording is ready") : ko ? `${actor}님의 녹음이 준비됐어요` : `${actor}'s recording is ready`;
      const takes = ko ? `테이크 ${input.takeCount}개` : `${input.takeCount} ${input.takeCount === 1 ? "take" : "takes"} found`;
      return { title, body: `${input.sessionLabel} · ${takes}` };
    }
    case "comment":
      return { title: ko ? `${actor}님이 ${target}에 코멘트를 남겼어요` : `${actor} commented on ${target}`, body: quote };
    case "reply":
      return { title: ko ? `${actor}님이 ${target}의 내 코멘트에 답글을 남겼어요` : `${actor} replied to you on ${target}`, body: quote };
  }
}

function truncate(text: string): string {
  return text.length > BODY_MAX ? `${text.slice(0, BODY_MAX - 1)}…` : text;
}
