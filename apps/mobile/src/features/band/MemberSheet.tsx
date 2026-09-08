import type { BandMember } from "@bandapp/types";
import { useTranslation } from "react-i18next";
import { MemberHeader } from "./MemberHeader";
import { partLabel } from "./partValue";
import { SheetRow } from "./SheetRow";

/**
 * owner가 다른 멤버를 눌렀을 때. member가 null이면 아무것도 렌더하지 않는다.
 * BandScreen의 공용 BottomSheet 안에서만 렌더된다.
 */
export function MemberSheet({
  member,
  onMakeOwner,
  onRemove,
}: {
  member: BandMember | null;
  onMakeOwner: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  if (!member) return null;
  return (
    <>
      <MemberHeader name={member.name} subtitle={partLabel(member.part, t)} />
      <SheetRow title={t("band.member.makeOwner")} subtitle={t("band.member.makeOwnerSubtitle")} onPress={onMakeOwner} />
      <SheetRow title={t("band.member.remove")} danger onPress={onRemove} />
    </>
  );
}
