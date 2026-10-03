import { View } from "react-native";
import { useRouter } from "expo-router";
import { space, useTheme } from "@/theme";
import { AppText, PressableOpacity } from "@/ui";

/** 디자인 B01~B05 상단 "‹ Back" 줄 */
export function BillingHeader({ back, onBack }: { back: string; onBack?: () => void }) {
  const router = useRouter();
  const { colors } = useTheme();
  return (
    <View style={{ paddingHorizontal: space.screenX - 8, paddingBottom: 4 }}>
      <PressableOpacity onPress={onBack ?? (() => router.back())} style={{ flexDirection: "row", alignItems: "center", gap: 6, padding: 8, alignSelf: "flex-start" }}>
        <AppText style={{ fontSize: 18, lineHeight: 18, color: colors.textMuted }}>‹</AppText>
        <AppText style={{ fontSize: 14, color: colors.textMuted }}>{back}</AppText>
      </PressableOpacity>
    </View>
  );
}
