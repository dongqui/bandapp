import { View } from "react-native";
import { rulerTicks } from "@/lib/timeline/ruler";
import { font, useTheme } from "@/theme";
import { AppText } from "@/ui";
import type { TimelineViewportState } from "./useTimelineViewport";
import { useViewportMirror } from "./useUiMirror";

/** 디자인 Timeline 화면의 눈금 줄 높이 */
export const RULER_H = 18;
/** 라벨 박스 폭 — "1:00:00"이 9px 모노로 들어가는 크기 */
const LABEL_W = 56;

/**
 * 시간 눈금 — 라벨을 눈금 위치에 가운데 정렬(디자인 translateX(-50%)). 라벨 텍스트는 UI 스레드에서 못 바꾸므로
 * viewport 미러(React state)로 그린다. 제스처 중에만 바뀌는 작은 컴포넌트라 리렌더 비용이 무시할 만하다.
 */
export function TimeRuler({ vp }: { vp: TimelineViewportState }) {
  const { colors } = useTheme();
  const view = useViewportMirror(vp);

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
