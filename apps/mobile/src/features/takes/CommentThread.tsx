import type { TakeComment } from "@bandapp/types";
import { View } from "react-native";
import { fmtClock } from "@/lib/time";
import { useTheme } from "@/theme";
import { AppText, Avatar, PressableOpacity } from "@/ui";
import type { CommentThread as Thread } from "./threads";

function ReplyLink({ onPress }: { onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <PressableOpacity onPress={onPress} style={{ paddingVertical: 2 }}>
      <AppText variant="small" color={colors.textFaint}>
        Reply
      </AppText>
    </PressableOpacity>
  );
}

/** 본인 코멘트에만 — 수정·삭제 시트를 연다 (디자인의 "···") */
function ActionsLink({ onPress }: { onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <PressableOpacity onPress={onPress} hitSlop={6} style={{ paddingVertical: 2, paddingHorizontal: 4 }}>
      <AppText variant="small" color={colors.textFaint} style={{ letterSpacing: 2 }}>
        ···
      </AppText>
    </PressableOpacity>
  );
}

/** "Reply" (+ 본인이면 "···") 한 줄 */
function ActionRow({ mine, onReply, onActions, marginTop }: { mine: boolean; onReply: () => void; onActions: () => void; marginTop: number }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 16, marginTop }}>
      <ReplyLink onPress={onReply} />
      {mine ? <ActionsLink onPress={onActions} /> : null}
    </View>
  );
}

/** updatedAt이 있으면 "· edited" (2026-09-09 스펙 결정 10) */
function EditedMark() {
  const { colors } = useTheme();
  return (
    <AppText variant="small" color={colors.textFaint}>
      · edited
    </AppText>
  );
}

/** "View replies (N)" / "View more replies (N)" — 짧은 선 뒤에 라벨 */
function RepliesLink({ label, onPress, marginTop }: { label: string; onPress: () => void; marginTop: number }) {
  const { colors } = useTheme();
  return (
    <PressableOpacity onPress={onPress} style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop }}>
      <View style={{ width: 24, height: 1, backgroundColor: colors.borderStronger }} />
      <AppText variant="small" color={colors.textMuted}>
        {label}
      </AppText>
    </PressableOpacity>
  );
}

function ReplyRow({ reply, mine, onReply, onActions }: { reply: TakeComment; mine: boolean; onReply: () => void; onActions: () => void }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: 10, marginTop: 12 }}>
      <Avatar label={reply.authorName.slice(0, 1)} size={24} fontSize={10} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
          <AppText variant="caption" color={colors.text} style={{ fontWeight: "600" }}>
            {reply.authorName}
          </AppText>
          {reply.updatedAt ? <EditedMark /> : null}
        </View>
        <AppText variant="body" style={{ marginTop: 3, lineHeight: 20 }}>
          {reply.text}
        </AppText>
        <ActionRow mine={mine} onReply={onReply} onActions={onActions} marginTop={4} />
      </View>
    </View>
  );
}

export function CommentThread({
  thread,
  shownReplies,
  meId,
  onSeek,
  onReply,
  onActions,
  onMoreReplies,
}: {
  thread: Thread;
  /** 보이는 답글 수. 0이면 접힌 상태 */
  shownReplies: number;
  /** 현재 사용자 id — 본인 코멘트에만 "···"가 보인다 */
  meId: string | undefined;
  onSeek: () => void;
  /** target은 답글 대상 — 최상위 코멘트 자신이거나 그 아래 답글 */
  onReply: (target: TakeComment) => void;
  /** 본인 코멘트·답글의 수정·삭제 시트 */
  onActions: (target: TakeComment) => void;
  onMoreReplies: () => void;
}) {
  const { colors } = useTheme();
  const { comment, replies } = thread;
  const visible = replies.slice(0, shownReplies);
  const hidden = replies.length - visible.length;
  const mine = (c: TakeComment) => meId !== undefined && c.authorId === meId;
  return (
    <View style={{ flexDirection: "row", gap: 12, paddingVertical: 14 }}>
      <Avatar label={comment.authorName.slice(0, 1)} size={30} fontSize={12} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <PressableOpacity onPress={onSeek} activeOpacity={0.8}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
            <AppText variant="caption" color={colors.text} style={{ fontWeight: "600" }}>
              {comment.authorName}
            </AppText>
            <AppText variant="monoMeta" color={colors.accent}>
              {fmtClock(comment.atSec)}
            </AppText>
            {comment.updatedAt ? <EditedMark /> : null}
          </View>
          <AppText variant="body" style={{ marginTop: 4, lineHeight: 20 }}>
            {comment.text}
          </AppText>
        </PressableOpacity>
        <ActionRow mine={mine(comment)} onReply={() => onReply(comment)} onActions={() => onActions(comment)} marginTop={6} />
        {replies.length > 0 && visible.length === 0 ? (
          <RepliesLink label={`View replies (${replies.length})`} onPress={onMoreReplies} marginTop={10} />
        ) : null}
        {visible.map((r) => (
          <ReplyRow key={r.id} reply={r} mine={mine(r)} onReply={() => onReply(r)} onActions={() => onActions(r)} />
        ))}
        {visible.length > 0 && hidden > 0 ? (
          <RepliesLink label={`View more replies (${hidden})`} onPress={onMoreReplies} marginTop={12} />
        ) : null}
      </View>
    </View>
  );
}
