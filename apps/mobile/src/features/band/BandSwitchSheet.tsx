import { useRouter } from "expo-router";
import { useTheme } from "@/theme";
import { AppText, Avatar, BottomSheet, SheetActionRow } from "@/ui";
import { useCurrentBand } from "./useCurrentBand";

export function BandSwitchSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { band, bands, setCurrentBand } = useCurrentBand();
  const { colors } = useTheme();
  const router = useRouter();
  if (!band) return null;
  return (
    <BottomSheet visible={visible} onClose={onClose} title="Switch band">
      {bands.map((b) => (
        <SheetActionRow
          key={b.id}
          icon={<Avatar label={b.name[0]} size={44} />}
          title={b.name}
          subtitle={`${b.memberCount} members`}
          onPress={() => {
            setCurrentBand(b.id);
            onClose();
          }}
          trailing={
            b.id === band.id ? (
              <AppText style={{ fontSize: 16, color: colors.accent }}>✓</AppText>
            ) : undefined
          }
        />
      ))}
      <SheetActionRow
        icon={<Avatar label="+" size={44} dashed />}
        title="Create or join a band"
        onPress={() => {
          onClose();
          router.push("/onboarding");
        }}
      />
    </BottomSheet>
  );
}
