import type { BandMember } from "@bandapp/types";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { radius, useTheme } from "@/theme";
import { AppText, Avatar, MonoLabel, PressableOpacity } from "@/ui";
import { partLabel } from "./partValue";

/** 멤버 행: 이름(본인은 "(You)"), 파트, OWNER 배지, 탭 가능하면 chevron. */
export function MemberRow({
  member,
  isMe,
  tappable,
  onPress,
}: {
  member: BandMember;
  isMe: boolean;
  tappable: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  return (
    <PressableOpacity
      onPress={onPress}
      disabled={!tappable}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        paddingVertical: 14,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      }}
    >
      <Avatar label={member.name[0] ?? "?"} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText style={{ fontSize: 15, color: colors.text }}>
          {isMe ? `${member.name} ${t("common.you")}` : member.name}
        </AppText>
        <AppText variant="small" style={{ marginTop: 3, color: colors.textMuted }}>
          {partLabel(member.part, t)}
        </AppText>
      </View>
      {member.role === "owner" ? (
        <MonoLabel
          color={colors.textMuted}
          style={{
            fontSize: 10,
            letterSpacing: 1.2,
            borderWidth: 1,
            borderColor: colors.borderStronger,
            borderRadius: radius.chipSm,
            paddingVertical: 3,
            paddingHorizontal: 8,
          }}
        >
          {t("band.role.owner").toUpperCase()}
        </MonoLabel>
      ) : null}
      {tappable ? <AppText style={{ fontSize: 18, color: colors.borderHover }}>›</AppText> : null}
    </PressableOpacity>
  );
}
