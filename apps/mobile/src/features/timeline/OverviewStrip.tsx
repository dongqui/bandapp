import type { Take } from "@bandapp/types";
import { useMemo, useState } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { GestureDetector, useCompetingGestures, usePanGesture, useTapGesture } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { barsForViewport, type PeakLevels } from "@/lib/timeline/levels";
import { clampViewport } from "@/lib/timeline/viewport";
import { useTheme } from "@/theme";
import type { TimelineViewportState } from "./useTimelineViewport";

/** 디자인 Timeline 화면의 오버뷰 높이 */
export const OVERVIEW_H = 44;
/** 디자인의 오버뷰 색 — 테마 토큰에 없는 값 */
const OVERVIEW_BG = "#101216";
const OVERVIEW_FILL = "#272B31";
const WINDOW_BORDER = "#A9AFB8";
const OVERVIEW_BAR_PX = 2;
const AMP_FLOOR = 0.1;

/**
 * 전체 녹음 개요 (2026-09-11 스펙 §파형 렌더링, 초안 21절). 파형은 최저 LOD를 폭이 정해질 때 한 번만 그리고,
 * viewport 창과 playhead만 shared value로 움직인다. take는 아래쪽 3px 마커다 — 3시간 위에서 1~2분을 정확히
 * 그리려 하지 않는다. 탭·드래그는 그 시각을 viewport 중앙으로 옮긴다 (seek 아님) — 사용자 이동이라 follow를 끈다.
 */
export function OverviewStrip({
  levels,
  vp,
  takes,
  durationMs,
  playheadMs,
}: {
  levels: PeakLevels | null;
  vp: TimelineViewportState;
  takes: Take[];
  durationMs: number;
  playheadMs: SharedValue<number>;
}) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);
  const mid = OVERVIEW_H / 2;

  const wavePath = useMemo(() => {
    if (!levels || width === 0 || durationMs <= 0) return "";
    const full = { startMs: 0, msPerPx: durationMs / width, widthPx: width };
    const units = barsForViewport(levels, levels.levels.length - 1, full, OVERVIEW_BAR_PX);
    if (units.length === 0) return "";
    let top = "";
    let bottom = "";
    units.forEach((u, i) => {
      const x = i * OVERVIEW_BAR_PX;
      const y = (AMP_FLOOR + (1 - AMP_FLOOR) * u) * (mid - 2);
      top += `${i === 0 ? "M" : "L"}${x} ${(mid - y).toFixed(1)}`;
      bottom = `L${x} ${(mid + y).toFixed(1)}` + bottom;
    });
    return `${top}${bottom}Z`;
  }, [levels, width, durationMs, mid]);

  const pxPerMs = durationMs > 0 && width > 0 ? width / durationMs : 0;
  const windowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: vp.startMs.value * pxPerMs }],
    width: Math.max(4, vp.widthPx.value * vp.msPerPx.value * pxPerMs),
  }));
  const headStyle = useAnimatedStyle(() => ({ transform: [{ translateX: playheadMs.value * pxPerMs }] }));

  const centerOn = (x: number) => {
    "worklet";
    if (pxPerMs === 0) return;
    vp.follow.value = false;
    const half = (vp.widthPx.value * vp.msPerPx.value) / 2;
    const v = clampViewport({ startMs: x / pxPerMs - half, msPerPx: vp.msPerPx.value, widthPx: vp.widthPx.value }, durationMs);
    vp.startMs.value = v.startMs;
  };
  const pan = usePanGesture({
    onBegin: (e) => {
      "worklet";
      centerOn(e.x);
    },
    onUpdate: (e) => {
      "worklet";
      centerOn(e.x);
    },
  });
  const tap = useTapGesture({
    onActivate: (e) => {
      "worklet";
      centerOn(e.x);
    },
  });
  const gesture = useCompetingGestures(pan, tap);

  return (
    <GestureDetector gesture={gesture}>
      <View onLayout={onLayout} style={{ width: "100%", height: OVERVIEW_H, backgroundColor: OVERVIEW_BG, borderRadius: 8, overflow: "hidden" }}>
        <Svg width="100%" height={OVERVIEW_H} pointerEvents="none">
          <Path d={wavePath} fill={OVERVIEW_FILL} />
        </Svg>
        {takes.map((t) => (
          <View
            key={t.id}
            pointerEvents="none"
            style={{
              position: "absolute",
              bottom: 3,
              left: t.startMs * pxPerMs,
              width: Math.max(3, (t.endMs - t.startMs) * pxPerMs),
              height: 3,
              borderRadius: 1.5,
              backgroundColor: colors.accent,
              opacity: 0.75,
            }}
          />
        ))}
        <Animated.View pointerEvents="none" style={[{ position: "absolute", top: 0, bottom: 0, left: 0, width: 1, backgroundColor: colors.accent }, headStyle]} />
        <Animated.View
          pointerEvents="none"
          style={[
            { position: "absolute", top: 0, bottom: 0, left: 0, borderWidth: 1.5, borderColor: WINDOW_BORDER, borderRadius: 5, backgroundColor: "rgba(255,255,255,0.05)" },
            windowStyle,
          ]}
        />
      </View>
    </GestureDetector>
  );
}
