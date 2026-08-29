import type { TakeComment } from "@bandapp/types";
import { View } from "react-native";
import { fmtClock } from "@/lib/time";
import { useTheme } from "@/theme";
import { AppText, PressableOpacity } from "@/ui";

export function CommentRow({ comment, onPress }: { comment: TakeComment; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <PressableOpacity
      onPress={onPress}
      style={{ paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.border }}
    >
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
        <AppText variant="caption" color={colors.text} style={{ fontWeight: "600" }}>
          {comment.authorName}
        </AppText>
        <AppText variant="monoMeta" color={colors.accent}>
          {fmtClock(comment.atSec)}
        </AppText>
      </View>
      <AppText variant="body" style={{ marginTop: 5, lineHeight: 20 }}>
        {comment.text}
      </AppText>
    </PressableOpacity>
  );
}
