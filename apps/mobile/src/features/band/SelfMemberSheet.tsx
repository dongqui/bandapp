import type { BandMember } from "@bandapp/types";
import { useTranslation } from "react-i18next";
import { AppText, BottomSheet } from "@/ui";
import { useTheme } from "@/theme";
import { MemberHeader } from "./MemberHeader";
import { partLabel } from "./partValue";
import { SheetRow } from "./SheetRow";

/** 본인 행을 눌렀을 때. 파트 변경, owner면 소유권 이전. */
export function SelfMemberSheet({
  visible,
  onClose,
  me,
  isOwner,
  onChangePart,
  onTransfer,
}: {
  visible: boolean;
  onClose: () => void;
  me: BandMember;
  isOwner: boolean;
  onChangePart: () => void;
  onTransfer: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <MemberHeader name={me.name} subtitle={t(isOwner ? "band.role.owner" : "band.role.member")} />
      <SheetRow
        title={t("band.self.changePart")}
        onPress={onChangePart}
        trailing={<AppText style={{ fontSize: 14, color: colors.textMuted }}>{partLabel(me.part, t)}</AppText>}
      />
      {isOwner ? (
        <SheetRow title={t("band.self.transfer")} subtitle={t("band.self.transferSubtitle")} onPress={onTransfer} />
      ) : null}
    </BottomSheet>
  );
}
