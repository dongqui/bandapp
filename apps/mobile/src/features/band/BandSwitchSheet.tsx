import { View } from "react-native";
import { useTheme } from "@/theme";
import { AppText, Avatar, BottomSheet, SheetActionRow } from "@/ui";
import { useToast } from "@/ui";
import { useCurrentBand } from "./useCurrentBand";

export function BandSwitchSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { band } = useCurrentBand();
  const { colors } = useTheme();
  const toast = useToast();
  if (!band) return null;
  return (
    <BottomSheet visible={visible} onClose={onClose} title="Switch band">
      <SheetActionRow
        icon={<Avatar label={band.name[0]} size={44} />}
        title={band.name}
        subtitle={`${band.memberCount} members`}
        onPress={onClose}
        trailing={<AppText style={{ fontSize: 16, color: colors.accent }}>✓</AppText>}
      />
      <SheetActionRow
        icon={<Avatar label="+" size={44} dashed />}
        title="Create or join a band"
        onPress={() => {
          onClose();
          toast.show("Not in this prototype");
        }}
      />
      <View style={{ height: 0 }} />
    </BottomSheet>
  );
}
