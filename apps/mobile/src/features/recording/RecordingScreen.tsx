import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder, useAudioRecorderState } from "expo-audio";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { fmtClock, toLocalIso } from "@/lib/time";
import { radius, useTheme } from "@/theme";
import { AppText, Chip, LiveWaveform, MonoLabel, PressableOpacity, Screen, StatusDot, useToast } from "@/ui";

export function RecordingScreen() {
  // HIGH_QUALITY = .m4a, AAC, 44.1kHz, 2ch, 128kbps — 스펙 결정 1과 일치한다
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const state = useAudioRecorderState(recorder, 200);
  const router = useRouter();
  const toast = useToast();
  const { colors } = useTheme();
  const [ready, setReady] = useState(false);
  const startedAtRef = useRef<Date | null>(null);
  const stoppingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        toast.show("Microphone access is needed to record");
        router.back();
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      if (cancelled) return;
      startedAtRef.current = new Date();
      recorder.record();
      setReady(true);
    })().catch(() => {
      toast.show("Couldn’t start recording");
      router.back();
    });
    return () => {
      cancelled = true;
      // 녹음 화면이 언마운트될 때 녹음 중이면 중지
      if (recorder.isRecording) void recorder.stop().catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const seconds = state.durationMillis / 1000;

  const stop = async () => {
    if (stoppingRef.current || !ready) return;
    stoppingRef.current = true;
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) throw new Error("no recording file");
      const durationMs = Math.max(1000, Math.round(state.durationMillis));
      router.replace({
        pathname: "/processing",
        params: {
          fileUri: uri,
          source: "recording",
          startedAt: toLocalIso(startedAtRef.current ?? new Date(Date.now() - durationMs)),
          durationMs: String(durationMs),
        },
      });
    } catch {
      stoppingRef.current = false;
      toast.show("Couldn’t save the recording");
    }
  };

  return (
    <Screen>
      <MonoLabel style={{ textAlign: "center", letterSpacing: 2, paddingTop: 8 }}>REHEARSAL</MonoLabel>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 30 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <StatusDot color={ready ? colors.recording : colors.textFaint} size={10} />
          <MonoLabel color={ready ? colors.recording : colors.textFaint} style={{ fontSize: 12, letterSpacing: 2.4 }}>
            {ready ? "REC" : "PREPARING"}
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
          onPress={() => void stop()}
          style={{ width: 72, height: 72, borderRadius: 36, borderWidth: 1, borderColor: colors.borderStronger, alignItems: "center", justifyContent: "center" }}
        >
          <View style={{ width: 22, height: 22, borderRadius: 4, backgroundColor: colors.recording }} />
        </PressableOpacity>
        <AppText variant="small">Stop</AppText>
      </View>
    </Screen>
  );
}
