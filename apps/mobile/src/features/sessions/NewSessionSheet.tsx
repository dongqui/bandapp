import { useRouter } from "expo-router";
import { View } from "react-native";
import { font, useTheme } from "@/theme";
import { AppText, BottomSheet, IconCircle, SheetActionRow } from "@/ui";

export function NewSessionSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const router = useRouter();
  const { colors } = useTheme();
  return (
    <BottomSheet visible={visible} onClose={onClose} title="New session">
      <SheetActionRow
        icon={
          <IconCircle>
            <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: colors.recording }} />
          </IconCircle>
        }
        title="Record now"
        subtitle="Start recording this rehearsal"
        onPress={() => {
          onClose();
          router.push("/record");
        }}
      />
      <SheetActionRow
        icon={
          <IconCircle>
            <AppText style={{ fontFamily: font.mono, fontSize: 16, color: colors.textSecondary }}>↓</AppText>
          </IconCircle>
        }
        title="Import a recording"
        subtitle="Find the takes in an existing recording"
        onPress={() => {
          onClose();
          router.push({ pathname: "/processing", params: { durationSec: "6720", source: "import" } });
        }}
      />
    </BottomSheet>
  );
}
