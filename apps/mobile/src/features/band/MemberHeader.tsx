import { View } from "react-native";
import { useTheme } from "@/theme";
import { AppText, Avatar } from "@/ui";

/** 시트 상단: 아바타 · 이름 · 부제(역할 또는 파트). 아래 구분선. */
export function MemberHeader({ name, subtitle }: { name: string; subtitle: string }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        paddingHorizontal: 8,
        paddingTop: 2,
        paddingBottom: 14,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      }}
    >
      <Avatar label={name[0] ?? "?"} size={44} />
      <View>
        <AppText variant="rowTitle">{name}</AppText>
        <AppText variant="caption" style={{ marginTop: 2 }}>
          {subtitle}
        </AppText>
      </View>
    </View>
  );
}
