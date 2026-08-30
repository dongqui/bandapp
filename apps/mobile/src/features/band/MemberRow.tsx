import type { BandMember } from "@bandapp/types";
import { View } from "react-native";
import { useTheme } from "@/theme";
import { AppText, Avatar, MonoLabel } from "@/ui";

export function MemberRow({ member }: { member: BandMember }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        paddingVertical: 15,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      }}
    >
      <Avatar label={member.name[0]} />
      <AppText style={{ flex: 1, fontSize: 15, color: colors.text }}>{member.name}</AppText>
      <MonoLabel style={{ letterSpacing: 1.1 }}>{member.role.toUpperCase()}</MonoLabel>
    </View>
  );
}
