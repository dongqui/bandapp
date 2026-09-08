import type { BandMember } from "@bandapp/types";
import { useTranslation } from "react-i18next";
import { AppText } from "@/ui";
import { useTheme } from "@/theme";
import { MemberHeader } from "./MemberHeader";
import { partLabel } from "./partValue";
import { SheetRow } from "./SheetRow";

/** 본인 행을 눌렀을 때. 파트 변경, owner면 소유권 이전. BandScreen의 공용 BottomSheet 안에서만 렌더된다. */
export function SelfMemberSheet({
  me,
  isOwner,
  onChangePart,
  onTransfer,
}: {
  me: BandMember;
  isOwner: boolean;
  onChangePart: () => void;
  onTransfer: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <>
      <MemberHeader name={me.name} subtitle={t(isOwner ? "band.role.owner" : "band.role.member")} />
      <SheetRow
        title={t("band.self.changePart")}
        onPress={onChangePart}
        trailing={<AppText style={{ fontSize: 14, color: colors.textMuted }}>{partLabel(me.part, t)}</AppText>}
      />
      {isOwner ? (
        <SheetRow title={t("band.self.transfer")} subtitle={t("band.self.transferSubtitle")} onPress={onTransfer} />
      ) : null}
    </>
  );
}
