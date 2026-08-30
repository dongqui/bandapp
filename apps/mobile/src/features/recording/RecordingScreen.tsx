import { useRouter } from "expo-router";
import { View } from "react-native";
import { fmtClock } from "@/lib/time";
import { radius, useTheme } from "@/theme";
import { AppText, Chip, LiveWaveform, MonoLabel, PressableOpacity, Screen, StatusDot, useToast } from "@/ui";
import { useRecordingTimer } from "./useRecordingTimer";

export function RecordingScreen() {
  const { seconds } = useRecordingTimer();
  const router = useRouter();
  const toast = useToast();
  const { colors } = useTheme();
  const stop = () => {
    const durationSec = String(Math.max(8, Math.floor(seconds)));
    router.replace({ pathname: "/processing", params: { durationSec, source: "recording" } });
  };
  return (
    <Screen>
      <MonoLabel style={{ textAlign: "center", letterSpacing: 2, paddingTop: 8 }}>REHEARSAL</MonoLabel>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 30 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <StatusDot color={colors.recording} size={10} />
          <MonoLabel color={colors.recording} style={{ fontSize: 12, letterSpacing: 2.4 }}>
            REC
          </MonoLabel>
        </View>
        <AppText variant="monoTimer">{fmtClock(seconds)}</AppText>
        <LiveWaveform />
        <Chip
          label="+ MARK"
          mono
          style={{ borderRadius: radius.chipLg + 4, paddingVertical: 10, paddingHorizontal: 22, marginTop: 6 }}
          onPress={() => toast.show(`Marked at ${fmtClock(seconds)}`)}
        />
      </View>
      <View style={{ alignItems: "center", gap: 10, paddingBottom: 60 }}>
        <PressableOpacity
          onPress={stop}
          style={{
            width: 72,
            height: 72,
            borderRadius: 36,
            borderWidth: 1,
            borderColor: colors.borderStronger,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <View style={{ width: 22, height: 22, borderRadius: 4, backgroundColor: colors.recording }} />
        </PressableOpacity>
        <AppText variant="small">Stop</AppText>
      </View>
    </Screen>
  );
}
