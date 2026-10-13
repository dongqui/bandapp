import { View } from "react-native";
import { useTheme } from "@/theme";
import { PressableOpacity } from "./PressableOpacity";

/** 디자인 스위치 46×28 */
export function Toggle({ value, onChange, disabled = false, label }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  const { colors } = useTheme();
  return (
    <PressableOpacity onPress={() => onChange(!value)} disabled={disabled} accessibilityRole="switch" accessibilityLabel={label} accessibilityState={{ checked: value, disabled }} style={{ width: 46, height: 28, borderRadius: 14, backgroundColor: value ? colors.accent : colors.borderStronger }}>
      <View style={{ position: "absolute", top: 3, left: value ? 21 : 3, width: 22, height: 22, borderRadius: 11, backgroundColor: "#FFFFFF" }} />
    </PressableOpacity>
  );
}
