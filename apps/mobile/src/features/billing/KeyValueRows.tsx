import { View } from "react-native";
import { useTheme } from "@/theme";
import { AppText } from "@/ui";

/** 라벨/값 한 줄씩 — B01·B04·B05·B06 공용 */
export function KeyValueRows({ rows }: { rows: Array<{ k: string; v: string }> }) {
  const { colors } = useTheme();
  return (
    <View>
      {rows.map((r, i) => (
        <View
          key={r.k}
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            paddingVertical: 10,
            borderBottomWidth: i === rows.length - 1 ? 0 : 1,
            borderBottomColor: colors.border,
          }}
        >
          <AppText variant="caption">{r.k}</AppText>
          <AppText style={{ fontSize: 14, color: colors.text }}>{r.v}</AppText>
        </View>
      ))}
    </View>
  );
}
