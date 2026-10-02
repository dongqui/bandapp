import { View } from "react-native";
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { playheadEdge } from "@/lib/timeline/follow";
import { timeToX } from "@/lib/timeline/viewport";
import { useTheme } from "@/theme";
import { AppText } from "@/ui";
import { WAVE_H } from "./WaveformCanvas";
import type { TimelineViewportState } from "./useTimelineViewport";
import { useRemountKey } from "./useRemountKey";

/**
 * 파형 위의 playhead — 1.5px 선 + 위쪽 9px 점 (디자인), 화면 밖이면 가장자리에 ◀ ▶. 재생 중에는 shared value가
 * 매 프레임 움직인다. WaveformCanvas와 분리한 이유: `key`로 다시 붙일 때 파형 path까지 다시 만들지 않으려고.
 * `key={kick}-{seekEpoch}` — JS가 viewport를 바꾸거나 seek할 때마다 뷰를 다시 붙인다 (useTimelineViewport의 kick 설명 참고).
 */
export function Playhead({
  vp,
  kick,
  playheadMs,
  seekEpoch,
}: {
  vp: TimelineViewportState;
  kick: number;
  playheadMs: SharedValue<number>;
  /** JS가 seek한 횟수 (usePlaybackClock) */
  seekEpoch: number;
}) {
  const { colors } = useTheme();
  const remount = useRemountKey(`${kick}-${seekEpoch}`);
  const mid = WAVE_H / 2;

  const line = useAnimatedStyle(() => {
    const x = timeToX({ startMs: vp.startMs.value, msPerPx: vp.msPerPx.value, widthPx: vp.widthPx.value }, playheadMs.value);
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
    <View key={remount} pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: 0, height: WAVE_H, overflow: "hidden" }}>
      <Animated.View style={[{ position: "absolute", top: 0, left: 0, height: WAVE_H, width: 1.5, backgroundColor: colors.accent }, line]}>
        <View style={{ position: "absolute", top: 0, left: -3.75, width: 9, height: 9, borderRadius: 5, backgroundColor: colors.accent }} />
      </Animated.View>
      <Animated.View style={[{ position: "absolute", left: 6, top: mid - 8 }, leftEdge]}>
        <AppText style={{ fontSize: 11, lineHeight: 16, color: colors.accent }}>◀</AppText>
      </Animated.View>
      <Animated.View style={[{ position: "absolute", right: 6, top: mid - 8 }, rightEdge]}>
        <AppText style={{ fontSize: 11, lineHeight: 16, color: colors.accent }}>▶</AppText>
      </Animated.View>
    </View>
  );
}
