import type { Session } from "@bandapp/types";
import { View } from "react-native";
import { dateLabel, fmtDuration, startLabel } from "@/lib/time";
import { useTheme } from "@/theme";
import { AppText, PressableOpacity, StatusDot } from "@/ui";

export function SessionRow({ session, onPress }: { session: Session; onPress: () => void }) {
  const { colors } = useTheme();
  const s = session;
  const ready = s.status === "ready";
  const primary = ready ? (s.name ?? `${s.takeCount} Takes`) : fmtDuration(s.durationSec);
  const commentLabel = s.commentCount
    ? `${s.commentCount} ${s.commentCount === 1 ? "comment" : "comments"}`
    : "No comments yet";
  const meta = `${s.name ? `${s.takeCount} Takes · ` : ""}${fmtDuration(s.durationSec)} · ${commentLabel}`;
  return (
    <PressableOpacity
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingVertical: 19,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      }}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 8 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
          <AppText variant="monoLabel" color={colors.textMuted} style={{ letterSpacing: 1.3 }}>
            {dateLabel(s.startedAt)}
          </AppText>
          <AppText variant="monoLabel" color={colors.textFaint} style={{ letterSpacing: 0 }}>
            {startLabel(s.startedAt)}
          </AppText>
        </View>
        <AppText variant="itemTitle">{primary}</AppText>
        {s.status === "analyzing" || s.status === "uploading" ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <StatusDot color={colors.accent} />
            <AppText variant="caption" color={colors.accent}>
              {s.status === "uploading" ? "Uploading…" : "Finding takes…"}
            </AppText>
          </View>
        ) : s.status === "failed" ? (
          <AppText variant="caption" color={colors.danger}>
            Couldn’t analyze this recording — tap to retry
          </AppText>
        ) : (
          <AppText variant="caption">{meta}</AppText>
        )}
      </View>
      <AppText style={{ color: colors.borderHover, fontSize: 20, lineHeight: 22 }}>›</AppText>
    </PressableOpacity>
  );
}
