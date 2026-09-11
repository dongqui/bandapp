import type { Take } from "@bandapp/types";
import { View } from "react-native";
import { fmtClock } from "@/lib/time";
import { useTheme } from "@/theme";
import { AppText, BottomSheet, SheetRow } from "@/ui";

/** 선택 카드의 "···" — 지금은 Delete take 하나 (스펙 B). take가 null이면 닫힌 상태 */
export function TakeActionSheet({ take, onClose, onDelete }: { take: Take | null; onClose: () => void; onDelete: (take: Take) => void }) {
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
          <SheetRow title="Delete take" danger onPress={() => onDelete(take)} />
        </>
      ) : null}
    </BottomSheet>
  );
}
