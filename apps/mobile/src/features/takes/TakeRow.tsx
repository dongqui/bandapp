import type { Take } from "@bandapp/types";
import { View } from "react-native";
import { seedOf } from "@/lib/seed";
import { fmtClock } from "@/lib/time";
import { useTheme } from "@/theme";
import { AppText, PressableOpacity, StaticWaveform } from "@/ui";

export function TakeRow({ take, onPress }: { take: Take; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <PressableOpacity
      onPress={onPress}
      style={{
        flexDirection: "row",
        gap: 14,
        paddingVertical: 18,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      }}
    >
      <AppText variant="monoMeta" color={colors.textFaint} style={{ paddingTop: 4 }}>
        {String(take.index + 1).padStart(2, "0")}
      </AppText>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
          <AppText variant="rowTitle" style={{ fontSize: 16 }}>
            {take.name}
          </AppText>
          <AppText variant="monoMeta">{fmtClock(take.durationSec)}</AppText>
        </View>
        <View style={{ marginTop: 10 }}>
          <StaticWaveform seed={seedOf(take.id)} />
        </View>
        {take.commentCount > 0 ? (
          <AppText variant="small" color={colors.accent} style={{ marginTop: 9 }}>
            {`${take.commentCount} ${take.commentCount === 1 ? "comment" : "comments"}`}
          </AppText>
        ) : null}
      </View>
    </PressableOpacity>
  );
}
