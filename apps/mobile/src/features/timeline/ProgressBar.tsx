import { useState } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useTheme } from "@/theme";

/** 디자인 Timeline 화면의 프로그레스바 높이 — 트랙 3px를 가운데 두고 위아래가 터치 영역이다 */
export const PROGRESS_H = 20;
/** 디자인의 트랙 색 — 테마 토큰에 없는 값 */
const TRACK_BG = "#1F2227";
const TRACK_TOP = 9;
const TRACK_H = 3;
const KNOB = 13;

/**
 * 전체 녹음 기준 재생 위치 (2026-10-02 디자인 추가). 트랙·노브는 playhead shared value로 매 프레임 움직이고,
 * 끄는 동안은 손가락 x를 따라가다 놓을 때 한 번 seek한다 — 매 프레임 player.seekTo를 부르지 않는다.
 * 팬 제스처의 onBegin/onFinalize는 탭에서도 불리므로 탭 = 그 자리로 seek가 된다.
 */
export function ProgressBar({ playheadMs, durationMs, onSeek }: { playheadMs: SharedValue<number>; durationMs: number; onSeek: (ms: number) => void }) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);
  const pxPerMs = width > 0 && durationMs > 0 ? width / durationMs : 0;
  /** 끄는 중인 손가락 x. 음수면 안 끄는 중 */
  const dragX = useSharedValue(-1);

  const headX = () => {
    "worklet";
    const d = dragX.value;
    const px = d >= 0 ? d : playheadMs.value * pxPerMs;
    return Math.max(0, Math.min(width, px));
  };
  const fillStyle = useAnimatedStyle(() => ({ width: headX() }));
  const knobStyle = useAnimatedStyle(() => ({ transform: [{ translateX: headX() }] }));

  const pan = usePanGesture({
    onBegin: (e) => {
      "worklet";
      dragX.value = e.x;
    },
    onUpdate: (e) => {
      "worklet";
      dragX.value = e.x;
    },
    onFinalize: () => {
      "worklet";
      const px = dragX.value;
      dragX.value = -1;
      if (px < 0 || pxPerMs === 0) return;
      scheduleOnRN(onSeek, Math.max(0, Math.min(width, px)) / pxPerMs);
    },
  });

  return (
    <GestureDetector gesture={pan}>
      <View onLayout={onLayout} style={{ height: PROGRESS_H }}>
        <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: TRACK_TOP, height: TRACK_H, borderRadius: 2, backgroundColor: TRACK_BG }} />
        <Animated.View pointerEvents="none" style={[{ position: "absolute", left: 0, top: TRACK_TOP, height: TRACK_H, borderRadius: 2, backgroundColor: colors.accent }, fillStyle]} />
        <Animated.View
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
