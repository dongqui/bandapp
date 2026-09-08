import type { BandMember } from "@bandapp/types";
import { useTranslation } from "react-i18next";
import { BottomSheet } from "@/ui";
import { MemberHeader } from "./MemberHeader";
import { partLabel } from "./partValue";
import { SheetRow } from "./SheetRow";

/** owner가 다른 멤버를 눌렀을 때. member가 null이면 닫힌 상태로 취급한다. */
export function MemberSheet({
  visible,
  onClose,
  member,
  onMakeOwner,
  onRemove,
}: {
  visible: boolean;
  onClose: () => void;
  member: BandMember | null;
  onMakeOwner: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  return (
    <BottomSheet visible={visible && member !== null} onClose={onClose}>
      {member ? (
        <>
          <MemberHeader name={member.name} subtitle={partLabel(member.part, t)} />
          <SheetRow title={t("band.member.makeOwner")} subtitle={t("band.member.makeOwnerSubtitle")} onPress={onMakeOwner} />
          <SheetRow title={t("band.member.remove")} danger onPress={onRemove} />
        </>
      ) : null}
    </BottomSheet>
  );
}
