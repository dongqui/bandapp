import { useState } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useTheme } from "@/theme";
import { useRemountKey } from "./useRemountKey";

/** 디자인 Timeline 화면의 프로그레스바 높이 — 트랙 3px를 가운데 두고 위아래가 터치 영역이다 */
export const PROGRESS_H = 20;
/** 디자인의 트랙 색 — 테마 토큰에 없는 값 */
const TRACK_BG = "#1F2227";
const TRACK_TOP = 9;
const TRACK_H = 3;
const KNOB = 13;

/**
 * 전체 녹음 기준 재생 위치 (2026-10-02 디자인 추가). 트랙·노브는 playhead shared value로 매 프레임 움직인다.
 * 끄는 동안은 `scrubMs`에 손가락 아래 시각을 써서 playhead(파형·오버뷰·노브)가 UI 스레드에서 바로 따라오고, JS에는
 * `onScrub`으로 알려 소리도 (150ms마다) 따라오게 한다. 놓으면 `onSeek`. 팬 제스처의 onBegin/onFinalize는 탭에서도
 * 불리므로 탭 = 그 자리로 seek가 된다.
 */
export function ProgressBar({
  playheadMs,
  scrubMs,
  seekEpoch,
  durationMs,
  onScrub,
  onSeek,
}: {
  playheadMs: SharedValue<number>;
  /** usePlaybackClock.scrubMs — 끄는 동안 여기에 쓴다 */
  scrubMs: SharedValue<number>;
  /** JS가 seek한 횟수 — 노브·채움 뷰를 다시 붙이는 key (useTimelineViewport의 kick 설명 참고) */
  seekEpoch: number;
  durationMs: number;
  /** 끄는 중 (매 프레임, JS) */
  onScrub: (ms: number) => void;
  /** 놓았다 */
  onSeek: (ms: number) => void;
}) {
  const { colors } = useTheme();
  const remount = useRemountKey(seekEpoch);
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);
  const pxPerMs = width > 0 && durationMs > 0 ? width / durationMs : 0;
  const headX = () => {
    "worklet";
    const s = scrubMs.value;
    const px = (s >= 0 ? s : playheadMs.value) * pxPerMs;
    return Math.max(0, Math.min(width, px));
  };
  const msAt = (x: number) => {
    "worklet";
    return Math.max(0, Math.min(width, x)) / pxPerMs;
  };
  const fillStyle = useAnimatedStyle(() => ({ width: headX() }));
  const knobStyle = useAnimatedStyle(() => ({ transform: [{ translateX: headX() }] }));

  const pan = usePanGesture({
    onBegin: (e) => {
      "worklet";
      if (pxPerMs === 0) return;
      scrubMs.value = msAt(e.x);
    },
    onUpdate: (e) => {
      "worklet";
      if (pxPerMs === 0) return;
      const ms = msAt(e.x);
      scrubMs.value = ms;
      scheduleOnRN(onScrub, ms);
    },
    onFinalize: () => {
      "worklet";
      const ms = scrubMs.value;
      if (ms < 0 || pxPerMs === 0) return;
      // scrubMs는 seekTo가 anchor를 세운 뒤 지운다 (usePlaybackClock)
      scheduleOnRN(onSeek, ms);
    },
  });

  return (
    <GestureDetector gesture={pan}>
      <View onLayout={onLayout} style={{ height: PROGRESS_H }}>
        <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: TRACK_TOP, height: TRACK_H, borderRadius: 2, backgroundColor: TRACK_BG }} />
        <Animated.View key={`f${remount}`} pointerEvents="none" style={[{ position: "absolute", left: 0, top: TRACK_TOP, height: TRACK_H, borderRadius: 2, backgroundColor: colors.accent }, fillStyle]} />
        <Animated.View
          key={`k${remount}`}
          pointerEvents="none"
          style={[
            {
              position: "absolute",
              top: (PROGRESS_H - KNOB) / 2,
              left: -KNOB / 2,
              width: KNOB,
              height: KNOB,
              borderRadius: KNOB / 2,
              backgroundColor: colors.text,
              shadowColor: "#000",
              shadowOpacity: 0.5,
              shadowRadius: 4,
              shadowOffset: { width: 0, height: 1 },
              elevation: 3,
            },
            knobStyle,
          ]}
        />
      </View>
    </GestureDetector>
  );
}
