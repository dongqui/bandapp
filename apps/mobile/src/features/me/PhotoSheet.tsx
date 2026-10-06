import { useTranslation } from "react-i18next";
import { BottomSheet, SheetRow } from "@/ui";

/** 디자인 "Profile photo" 시트: 촬영 / 라이브러리 / (사진 있을 때) 제거 */
export function PhotoSheet({
  visible,
  hasPhoto,
  busy,
  onClose,
  onPick,
  onRemove,
}: {
  visible: boolean;
  hasPhoto: boolean;
  busy: boolean;
  onClose: () => void;
  onPick: (source: "camera" | "library") => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  return (
    <BottomSheet visible={visible} onClose={onClose} title={t("me.photo.title")}>
      <SheetRow title={t("me.photo.take")} onPress={() => !busy && onPick("camera")} />
      <SheetRow title={t("me.photo.choose")} onPress={() => !busy && onPick("library")} />
      {hasPhoto ? <SheetRow title={t("me.photo.remove")} danger onPress={() => !busy && onRemove()} /> : null}
    </BottomSheet>
  );
}
