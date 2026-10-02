import type { Take } from "@bandapp/types";
import { View } from "react-native";
import { fmtClock } from "@/lib/time";
import { useTheme } from "@/theme";
import { AppText, BottomSheet, SheetRow } from "@/ui";

/**
 * take의 "···" 시트 (2026-10-02 디자인). 제목 줄은 `이름 · 범위`, 아래로 Edit take / Rename take / Delete take.
 * Edit take는 Take Feedback 화면에서만 — onEdit을 넘긴 쪽에만 뜬다 (타임라인은 이미 편집 화면이다).
 * take가 null이면 닫힌 상태.
 */
export function TakeActionSheet({
  take,
  onClose,
  onEdit,
  onRename,
  onDelete,
}: {
  take: Take | null;
  onClose: () => void;
  onEdit?: (take: Take) => void;
  onRename: (take: Take) => void;
  onDelete: (take: Take) => void;
}) {
  const { colors } = useTheme();
  return (
    <BottomSheet visible={take !== null} onClose={onClose}>
      {take ? (
        <>
          <View style={{ paddingHorizontal: 12, paddingBottom: 10, marginBottom: 8, borderBottomWidth: 1, borderBottomColor: colors.border }}>
            <AppText numberOfLines={1} style={{ fontSize: 13, color: colors.textMuted }}>
              {`${take.name} · ${fmtClock(take.startMs / 1000)} – ${fmtClock(take.endMs / 1000)}`}
            </AppText>
          </View>
          {onEdit ? <SheetRow title="Edit take" onPress={() => onEdit(take)} /> : null}
          <SheetRow title="Rename take" onPress={() => onRename(take)} />
          <SheetRow title="Delete take" danger onPress={() => onDelete(take)} />
        </>
      ) : null}
    </BottomSheet>
  );
}
