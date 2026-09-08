import type { BandMember } from "@bandapp/types";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { radius, useTheme } from "@/theme";
import { AppText, Avatar, BottomSheet, PressableOpacity } from "@/ui";
import { partLabel } from "./partValue";

/** 본인을 제외한 멤버 중 새 owner를 고른다. 선택 → 확인 다이얼로그는 호출자가 띄운다. */
export function TransferSheet({
  visible,
  onClose,
  candidates,
  onPick,
}: {
  visible: boolean;
  onClose: () => void;
  candidates: BandMember[];
  onPick: (member: BandMember) => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <BottomSheet visible={visible} onClose={onClose} title={t("band.transfer.title")} subtitle={t("band.transfer.subtitle")}>
      {candidates.map((m) => (
        <PressableOpacity
          key={m.id}
          onPress={() => onPick(m)}
          style={{ flexDirection: "row", alignItems: "center", gap: 14, padding: 12, borderRadius: radius.row }}
        >
          <Avatar label={m.name[0] ?? "?"} />
          <View style={{ flex: 1 }}>
            <AppText style={{ fontSize: 15, color: colors.text }}>{m.name}</AppText>
            <AppText variant="small" style={{ marginTop: 2, color: colors.textMuted }}>
              {partLabel(m.part, t)}
            </AppText>
          </View>
          <AppText style={{ fontSize: 18, color: colors.borderHover }}>›</AppText>
        </PressableOpacity>
      ))}
    </BottomSheet>
  );
}
