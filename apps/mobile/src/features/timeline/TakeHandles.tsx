import { View } from "react-native";
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import type { Draft } from "@/lib/timeline/edit";
import { timeToX } from "@/lib/timeline/viewport";
import { useTheme } from "@/theme";
import { WAVE_H } from "./WaveformCanvas";
import type { TimelineViewportState } from "./useTimelineViewport";

/** 핸들 컬럼 폭 — 중심이 핸들 x (디자인 노트) */
const COL_W = 24;
/** 그립 크기 */
const GRIP_W = 13;
const GRIP_H = 28;
/** 그립 가운데 홈 색 — 테마 토큰에 없는 디자인 리터럴 */
const GRIP_NOTCH = "rgba(11,12,14,0.5)";

/** 핸들 하나 — 세로선 + 가운데 그립. 드래그 중이면 그립만 살짝 넓어진다 */
function Handle({ vp, draft, which }: { vp: TimelineViewportState; draft: SharedValue<Draft | null>; which: "start" | "end" }) {
  const { colors } = useTheme();
  const mode = which === "start" ? "handle-start" : "handle-end";
  const column = useAnimatedStyle(() => {
    const d = draft.value;
    if (!d) return { opacity: 0, transform: [{ translateX: 0 }] };
    const v = { startMs: vp.startMs.value, msPerPx: vp.msPerPx.value, widthPx: vp.widthPx.value };
    const x = timeToX(v, which === "start" ? d.startMs : d.endMs);
    // 화면 밖 핸들은 숨긴다 (디자인 노트)
    const on = x >= 0 && x <= v.widthPx;
    return { opacity: on ? 1 : 0, transform: [{ translateX: x - COL_W / 2 }] };
  });
  const grip = useAnimatedStyle(() => ({ transform: [{ scaleX: vp.editMode.value === mode ? 1.15 : 1 }] }));
  return (
    <Animated.View pointerEvents="none" style={[{ position: "absolute", top: 0, width: COL_W, height: WAVE_H }, column]}>
      <View style={{ position: "absolute", top: 0, left: (COL_W - 3) / 2, width: 3, height: WAVE_H, borderRadius: 1.5, backgroundColor: colors.accent }} />
      <Animated.View
        style={[
          {
            position: "absolute",
            top: (WAVE_H - GRIP_H) / 2,
            left: (COL_W - GRIP_W) / 2,
            width: GRIP_W,
            height: GRIP_H,
            borderRadius: 7,
            backgroundColor: colors.accent,
            alignItems: "center",
            justifyContent: "center",
            shadowColor: "#000",
            shadowOpacity: 0.4,
            shadowRadius: 5,
            shadowOffset: { width: 0, height: 1 },
            elevation: 3,
          },
          grip,
        ]}
      >
        <View style={{ width: 1.5, height: 12, borderRadius: 1, backgroundColor: GRIP_NOTCH }} />
      </Animated.View>
    </Animated.View>
  );
}

/**
 * 선택 take의 초안 구간 + start/end 핸들. 시각만 그린다 — 터치는 useTimelineViewport의 hit-test가 맡는다 (스펙 B 결정 8).
 * `enabled`가 false면(ready가 아니거나 피크 로딩 중) 아무것도 안 그린다 (디자인 노트 editOn).
 */
export function TakeHandles({ vp, draft, enabled }: { vp: TimelineViewportState; draft: SharedValue<Draft | null>; enabled: boolean }) {
  const { colors } = useTheme();
  const region = useAnimatedStyle(() => {
    const d = draft.value;
    if (!d) return { opacity: 0, transform: [{ translateX: 0 }], width: 0 };
    const v = { startMs: vp.startMs.value, msPerPx: vp.msPerPx.value, widthPx: vp.widthPx.value };
    const x0 = Math.max(0, timeToX(v, d.startMs));
    const x1 = Math.min(v.widthPx, timeToX(v, d.endMs));
    return { opacity: x1 > x0 ? 0.1 : 0, transform: [{ translateX: x0 }], width: Math.max(0, x1 - x0) };
  });
  if (!enabled) return null;
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: 0, height: WAVE_H }}>
      <Animated.View style={[{ position: "absolute", top: 0, height: WAVE_H, backgroundColor: colors.accent }, region]} />
      <Handle vp={vp} draft={draft} which="start" />
      <Handle vp={vp} draft={draft} which="end" />
    </View>
  );
}
