import type { Take } from "@bandapp/types";
import { Pressable, View } from "react-native";
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import type { Draft } from "@/lib/timeline/edit";
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
 * 선택된 필은 저장된 경계 대신 초안을 따라간다 — 핸들을 끄는 동안 필도 같이 움직인다 (스펙 B).
 * 라벨은 "T1"처럼 번호만 — 전체 이름은 아래 take 내비("TAKE 1 / 13")가 보여 준다 (2026-09-20 디자인 개정).
 * 길게 누르면 take 메뉴(삭제) — 개정 디자인에서 카드의 ··· 버튼이 빠져 진입점을 여기로 옮겼다.
 */
function TakePill({
  take,
  vp,
  draft,
  selected,
  onPress,
  onLongPress,
}: {
  take: Take;
  vp: TimelineViewportState;
  draft: SharedValue<Draft | null>;
  selected: boolean;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const { colors } = useTheme();
  const style = useAnimatedStyle(() => {
    const v = { startMs: vp.startMs.value, msPerPx: vp.msPerPx.value, widthPx: vp.widthPx.value };
    const d = selected ? draft.value : null;
    const x0 = timeToX(v, d ? d.startMs : take.startMs);
    const x1 = timeToX(v, d ? d.endMs : take.endMs);
    const visible = v.widthPx > 0 && x1 > 0 && x0 < v.widthPx;
    const left = Math.max(-2, x0);
    const right = Math.min(v.widthPx + 2, x1);
    return { left, width: Math.max(PILL_MIN_W, right - left), opacity: visible ? 1 : 0 };
  });
  return (
    <Animated.View style={[{ position: "absolute", top: 4, bottom: 4 }, style]}>
      <Pressable
        onPress={onPress}
        onLongPress={onLongPress}
        style={{
          flex: 1,
          borderRadius: 7,
          backgroundColor: selected ? `${colors.accent}2E` : PILL_BG,
          borderWidth: 1,
          borderColor: selected ? colors.accent : colors.borderStronger,
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: 4,
          overflow: "hidden",
        }}
      >
        <AppText numberOfLines={1} style={{ fontFamily: font.mono, fontSize: 10, letterSpacing: 0.6, color: selected ? colors.text : colors.textMuted }}>
          {`T${take.index + 1}`}
        </AppText>
      </Pressable>
    </Animated.View>
  );
}

export function TakeLane({
  takes,
  vp,
  draft,
  selectedTakeId,
  onSelect,
  onMenu,
}: {
  takes: Take[];
  vp: TimelineViewportState;
  draft: SharedValue<Draft | null>;
  selectedTakeId: string | null;
  onSelect: (take: Take) => void;
  /** 필을 길게 눌렀다 — take 메뉴 */
  onMenu: (take: Take) => void;
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
        <TakePill key={t.id} take={t} vp={vp} draft={draft} selected={t.id === selectedTakeId} onPress={() => onSelect(t)} onLongPress={() => onMenu(t)} />
      ))}
    </View>
  );
}
