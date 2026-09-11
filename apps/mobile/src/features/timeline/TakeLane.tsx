import type { Take } from "@bandapp/types";
import { Pressable, View } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { timeToX } from "@/lib/timeline/viewport";
import { font, useTheme } from "@/theme";
import { AppText } from "@/ui";
import type { TimelineViewportState } from "./useTimelineViewport";

/** 디자인 Timeline 화면의 take 레인 높이 */
export const LANE_H = 40;
/** 디자인의 레인 필 색 — 테마 토큰에 없는 값 */
const PILL_BG = "#171A1F";
const PILL_MIN_W = 12;

/**
 * take 필 하나. 위치·폭은 shared value에서 매 프레임 계산한다(리렌더 없음). 선택 색은 React prop.
 * 필 자체가 Pressable이라 파형 제스처와 겹치지 않는다 — 레인 탭은 선택, 파형 탭은 seek (스펙 결정 11).
 */
function TakePill({ take, vp, selected, onPress }: { take: Take; vp: TimelineViewportState; selected: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  const style = useAnimatedStyle(() => {
    const v = { startMs: vp.startMs.value, msPerPx: vp.msPerPx.value, widthPx: vp.widthPx.value };
    const x0 = timeToX(v, take.startMs);
    const x1 = timeToX(v, take.endMs);
    const visible = v.widthPx > 0 && x1 > 0 && x0 < v.widthPx;
    const left = Math.max(-2, x0);
    const right = Math.min(v.widthPx + 2, x1);
    return { left, width: Math.max(PILL_MIN_W, right - left), opacity: visible ? 1 : 0 };
  });
  return (
    <Animated.View style={[{ position: "absolute", top: 4, bottom: 4 }, style]}>
      <Pressable
        onPress={onPress}
        style={{
          flex: 1,
          borderRadius: 7,
          backgroundColor: selected ? `${colors.accent}2E` : PILL_BG,
          borderWidth: 1,
          borderColor: selected ? colors.accent : colors.borderStronger,
          justifyContent: "center",
          paddingHorizontal: 8,
          overflow: "hidden",
        }}
      >
        <AppText numberOfLines={1} style={{ fontFamily: font.mono, fontSize: 10, letterSpacing: 0.6, color: selected ? colors.text : colors.textMuted }}>
          {take.name.toUpperCase()}
        </AppText>
      </Pressable>
    </Animated.View>
  );
}

export function TakeLane({
  takes,
  vp,
  selectedTakeId,
  onSelect,
}: {
  takes: Take[];
  vp: TimelineViewportState;
  selectedTakeId: string | null;
  onSelect: (take: Take) => void;
}) {
  const { colors } = useTheme();
  if (takes.length === 0) {
    return (
      <View style={{ height: LANE_H, alignItems: "center", justifyContent: "center", borderWidth: 1, borderStyle: "dashed", borderColor: colors.borderStrong, borderRadius: 8 }}>
        <AppText style={{ fontFamily: font.mono, fontSize: 10, letterSpacing: 1.4, color: colors.textFaint }}>NO TAKES IN THIS RECORDING</AppText>
      </View>
    );
  }
  return (
    <View style={{ height: LANE_H, overflow: "hidden" }}>
      {takes.map((t) => (
        <TakePill key={t.id} take={t} vp={vp} selected={t.id === selectedTakeId} onPress={() => onSelect(t)} />
      ))}
    </View>
  );
}
