import { useState } from "react";
import { View } from "react-native";
import { useAnimatedReaction } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { rulerTicks } from "@/lib/timeline/ruler";
import type { Viewport } from "@/lib/timeline/viewport";
import { font, useTheme } from "@/theme";
import { AppText } from "@/ui";
import type { TimelineViewportState } from "./useTimelineViewport";

/** 디자인 Timeline 화면의 눈금 줄 높이 */
export const RULER_H = 18;
/** 라벨 박스 폭 — "1:00:00"이 9px 모노로 들어가는 크기 */
const LABEL_W = 56;

/**
 * 시간 눈금 — 라벨을 눈금 위치에 가운데 정렬(디자인 translateX(-50%)). 라벨 텍스트는 UI 스레드에서 못 바꾸므로
 * viewport 스냅샷을 React state로 받는다. 제스처 중에만 바뀌는 작은 컴포넌트라 리렌더 비용이 무시할 만하다.
 */
export function TimeRuler({ vp }: { vp: TimelineViewportState }) {
  const { colors } = useTheme();
  const [view, setView] = useState<Viewport | null>(null);

  useAnimatedReaction(
    () => ({ startMs: vp.startMs.value, msPerPx: vp.msPerPx.value, widthPx: vp.widthPx.value }),
    (cur, prev) => {
      if (prev && cur.startMs === prev.startMs && cur.msPerPx === prev.msPerPx && cur.widthPx === prev.widthPx) return;
      scheduleOnRN(setView, cur);
    },
  );

  const ticks = view && view.widthPx > 0 ? rulerTicks(view) : [];
  const width = view?.widthPx ?? 0;
  return (
    <View style={{ height: RULER_H, overflow: "hidden" }}>
      {ticks.map((t) => (
        // 라벨은 눈금에 가운데 정렬하되, 화면 가장자리에서는 잘리지 않게 안쪽으로 민다
        <View key={t.ms} style={{ position: "absolute", left: Math.min(Math.max(0, t.xPx - LABEL_W / 2), width - LABEL_W), width: LABEL_W, bottom: 0, alignItems: "center" }}>
          <AppText style={{ fontFamily: font.mono, fontSize: 9, lineHeight: 12, color: colors.textFaint }} numberOfLines={1}>
            {t.label}
          </AppText>
        </View>
      ))}
    </View>
  );
}
