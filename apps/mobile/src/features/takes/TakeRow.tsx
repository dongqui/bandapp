import type { Take } from "@bandapp/types";
import { View } from "react-native";
import { fmtClock } from "@/lib/time";
import { useTheme } from "@/theme";
import { AppText, PressableOpacity, StaticWaveform } from "@/ui";

export function TakeRow({ take, onPress, onRetry }: { take: Take; onPress: () => void; onRetry?: () => void }) {
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
          <StaticWaveform peaks={take.peaks} />
        </View>
        {/* 재컷 상태는 코멘트 수 줄 자리에 온다 (디자인 노트) */}
        {take.audioStatus === "updating" ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 9 }}>
            <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: colors.accent }} />
            <AppText style={{ fontSize: 12, color: colors.accent }}>Updating…</AppText>
          </View>
        ) : take.audioStatus === "failed" ? (
          <View style={{ flexDirection: "row", marginTop: 9 }}>
            {/* 행 전체 탭(플레이어 열기)과 겹치지 않게 텍스트에만 건다 */}
            <PressableOpacity onPress={onRetry} disabled={!onRetry} hitSlop={6}>
              <AppText style={{ fontSize: 12, color: colors.danger }}>Audio not updated · Retry</AppText>
            </PressableOpacity>
          </View>
        ) : take.commentCount > 0 ? (
          <AppText variant="small" color={colors.accent} style={{ marginTop: 9 }}>
            {`${take.commentCount} ${take.commentCount === 1 ? "comment" : "comments"}`}
          </AppText>
        ) : null}
      </View>
    </PressableOpacity>
  );
}
