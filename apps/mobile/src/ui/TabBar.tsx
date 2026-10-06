import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Path } from "react-native-svg";
import { useTheme } from "@/theme";
import { AppText } from "./AppText";
import { Avatar } from "./Avatar";
import { PressableOpacity } from "./PressableOpacity";

export type TabKey = "sessions" | "band" | "me";

// 디자인(2026-10-06): 플로팅 필 3탭 + 오른쪽 녹음 버튼. backdrop blur는 RN 기본 뷰로 못 만들어
// 반투명 배경만 쓴다. 활성 탭 배경/글자색은 디자인 상수 그대로.
const PILL_BG = "rgba(26,28,33,0.94)";
const PILL_BORDER = "rgba(255,255,255,0.07)";
const ACTIVE_BG = "rgba(255,255,255,0.09)";
const INACTIVE_FG = "#7A7F88";
const RING = "rgba(255,255,255,0.85)";

export function TabBar({
  active,
  me,
  onPressTab,
  onPressRecord,
}: {
  active: TabKey;
  /** Me 탭 아이콘: 사진이 있으면 사진, 없으면 이니셜 */
  me: { initial: string; photoUri: string | null };
  onPressTab: (tab: TabKey) => void;
  onPressRecord: () => void;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const fg = (tab: TabKey) => (active === tab ? colors.text : INACTIVE_FG);

  const cell = (tab: TabKey, label: string, icon: React.ReactNode) => (
    <PressableOpacity
      onPress={() => onPressTab(tab)}
      style={{
        flex: 1,
        height: 52,
        borderRadius: 26,
        alignItems: "center",
        justifyContent: "center",
        gap: 3,
        backgroundColor: active === tab ? ACTIVE_BG : "transparent",
      }}
    >
      {icon}
      <AppText style={{ fontSize: 10, fontWeight: "500", letterSpacing: 0.2, color: fg(tab) }}>{label}</AppText>
    </PressableOpacity>
  );

  const frame = {
    backgroundColor: PILL_BG,
    borderWidth: 1,
    borderColor: PILL_BORDER,
    shadowColor: "#000",
    shadowOpacity: 0.55,
    shadowRadius: 32,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12,
  } as const;

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: 16,
        right: 16,
        bottom: Math.max(26, insets.bottom + 8),
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
      }}
    >
      <View style={[frame, { flex: 1, flexDirection: "row", gap: 2, padding: 5, borderRadius: 31 }]}>
        {cell(
          "sessions",
          "Sessions",
          <Svg width={22} height={20} viewBox="0 0 22 20" fill="none">
            <Path d="M3 8v4M7 5v10M11 2v16M15 6v8M19 9v2" stroke={fg("sessions")} strokeWidth={1.8} strokeLinecap="round" />
          </Svg>,
        )}
        {cell(
          "band",
          "Band",
          <Svg width={22} height={20} viewBox="0 0 22 20" fill="none">
            <Circle cx={8.5} cy={6.5} r={3.2} stroke={fg("band")} strokeWidth={1.7} />
            <Path
              d="M2.6 17.5c.6-3.1 3-5 5.9-5s5.3 1.9 5.9 5M14.6 3.6a3 3 0 0 1 0 5.8M16.8 12.7c1.5.7 2.4 2.2 2.7 4.8"
              stroke={fg("band")}
              strokeWidth={1.7}
              strokeLinecap="round"
            />
          </Svg>,
        )}
        {cell(
          "me",
          "Me",
          <View
            style={{
              borderRadius: 13,
              padding: 1.5,
              marginBottom: -1,
              backgroundColor: active === "me" ? colors.text : "transparent",
            }}
          >
            <Avatar label={me.initial} uri={me.photoUri} size={22} fontSize={10} />
          </View>,
        )}
      </View>
      <PressableOpacity
        onPress={onPressRecord}
        accessibilityLabel="New session"
        style={[frame, { width: 62, height: 62, borderRadius: 31, alignItems: "center", justifyContent: "center" }]}
      >
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            borderWidth: 2,
            borderColor: RING,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: colors.recording }} />
        </View>
      </PressableOpacity>
    </View>
  );
}

/** Me 탭·화면의 이니셜 — 이름이 없으면 "?" (디자인 meInitial) */
export function initialOf(name: string | null | undefined): string {
  return (name?.trim()[0] ?? "?").toUpperCase();
}
