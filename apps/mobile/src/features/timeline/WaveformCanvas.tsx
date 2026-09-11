import { View } from "react-native";
import Animated, { useAnimatedProps, useAnimatedStyle, useDerivedValue, type SharedValue } from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { playheadEdge } from "@/lib/timeline/follow";
import { BAR_PX, barsForViewport, selectLevel, type PeakLevels } from "@/lib/timeline/levels";
import { timeToX } from "@/lib/timeline/viewport";
import { useTheme } from "@/theme";
import { AppText } from "@/ui";
import type { TimelineViewportState } from "./useTimelineViewport";

/** 디자인 Timeline 화면의 파형 상자 높이 */
export const WAVE_H = 150;
/** 디자인의 파형 채움색 — 테마 토큰에 없는 값이라 여기서만 쓴다 */
export const WAVE_FILL = "#33383F";
/** 파형 진폭 바닥 — 무음 구간도 10%는 그린다 (디자인 tlAmp의 0.1 + 0.9·b) */
const AMP_FLOOR = 0.1;

const APath = Animated.createAnimatedComponent(Path);

/**
 * 좌우 대칭 폴리곤 파형 + playhead. 모든 기하는 shared value에서 매 프레임 UI 스레드가 계산해 animatedProps로 흘린다 —
 * 팬·줌·재생 중 이 컴포넌트는 리렌더되지 않는다 (2026-09-11 스펙 결정 7, §파형 렌더링).
 * 로딩·저해상도 배지·줌 버튼·돌아가기 필은 화면이 이 위에 겹친다.
 */
export function WaveformCanvas({
  levels,
  vp,
  playheadMs,
  level,
}: {
  levels: PeakLevels | null;
  vp: TimelineViewportState;
  playheadMs: SharedValue<number>;
  /** 현재 LOD — 디버그 오버레이용 출력 */
  level: SharedValue<number>;
}) {
  const { colors } = useTheme();
  const mid = WAVE_H / 2;

  // 컬럼마다 진폭 → 위쪽 윤곽 + 아래쪽 윤곽(역순) 폴리곤. 레벨은 hysteresis 상태라 shared value에 기억한다
  const pathProps = useAnimatedProps(() => {
    const v = { startMs: vp.startMs.value, msPerPx: vp.msPerPx.value, widthPx: vp.widthPx.value };
    if (!levels || v.widthPx === 0) return { d: "" };
    const k = selectLevel(levels, v.msPerPx, BAR_PX, level.value);
    level.value = k;
    const units = barsForViewport(levels, k, v, BAR_PX);
    if (units.length === 0) return { d: "" };
    let top = "";
    let bottom = "";
    for (let b = 0; b < units.length; b++) {
      const x = b * BAR_PX;
      const y = (AMP_FLOOR + (1 - AMP_FLOOR) * units[b]!) * (mid - 2);
      top += `${b === 0 ? "M" : "L"}${x} ${(mid - y).toFixed(1)}`;
      bottom = `L${x} ${(mid + y).toFixed(1)}` + bottom;
    }
    // 마지막 컬럼의 오른쪽 끝까지 채운다
    const lastX = units.length * BAR_PX;
    const lastY = (AMP_FLOOR + (1 - AMP_FLOOR) * units[units.length - 1]!) * (mid - 2);
    return { d: `${top}L${lastX} ${(mid - lastY).toFixed(1)}L${lastX} ${(mid + lastY).toFixed(1)}${bottom}Z` };
  }, [levels]);

  const playheadX = useDerivedValue(() =>
    timeToX({ startMs: vp.startMs.value, msPerPx: vp.msPerPx.value, widthPx: vp.widthPx.value }, playheadMs.value),
  );
  const playheadStyle = useAnimatedStyle(() => {
    const x = playheadX.value;
    const on = x >= 0 && x <= vp.widthPx.value;
    return { transform: [{ translateX: on ? x : 0 }], opacity: on ? 1 : 0 };
  });
  const leftEdge = useAnimatedStyle(() => ({
    opacity: playheadEdge({ startMs: vp.startMs.value, msPerPx: vp.msPerPx.value, widthPx: vp.widthPx.value }, playheadMs.value) === "left" ? 1 : 0,
  }));
  const rightEdge = useAnimatedStyle(() => ({
    opacity: playheadEdge({ startMs: vp.startMs.value, msPerPx: vp.msPerPx.value, widthPx: vp.widthPx.value }, playheadMs.value) === "right" ? 1 : 0,
  }));

  return (
    <View
      onLayout={vp.onLayout}
      style={{ width: "100%", height: WAVE_H, overflow: "hidden", borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.border }}
    >
      <Svg width="100%" height={WAVE_H} pointerEvents="none">
        <APath animatedProps={pathProps} fill={WAVE_FILL} />
      </Svg>
      {/* playhead — 1.5px 선 + 위쪽 9px 점 (디자인) */}
      <Animated.View pointerEvents="none" style={[{ position: "absolute", top: 0, left: 0, height: WAVE_H, width: 1.5, backgroundColor: colors.accent }, playheadStyle]}>
        <View style={{ position: "absolute", top: 0, left: -3.75, width: 9, height: 9, borderRadius: 5, backgroundColor: colors.accent }} />
      </Animated.View>
      {/* 화면 밖 playhead 표시 */}
      <Animated.View pointerEvents="none" style={[{ position: "absolute", left: 6, top: mid - 8 }, leftEdge]}>
        <AppText style={{ fontSize: 11, lineHeight: 16, color: colors.accent }}>◀</AppText>
      </Animated.View>
      <Animated.View pointerEvents="none" style={[{ position: "absolute", right: 6, top: mid - 8 }, rightEdge]}>
        <AppText style={{ fontSize: 11, lineHeight: 16, color: colors.accent }}>▶</AppText>
      </Animated.View>
    </View>
  );
}
