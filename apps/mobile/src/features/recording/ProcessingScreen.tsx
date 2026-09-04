import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo } from "react";
import { View } from "react-native";
import { useUploadSession } from "@/features/upload/useUploadSession";
import { fmtDuration } from "@/lib/time";
import { space, useTheme } from "@/theme";
import { AppText, Chip, MonoLabel, ProgressBar, Screen } from "@/ui";

export function ProcessingScreen() {
  const raw = useLocalSearchParams<{ fileUri: string; source: "recording" | "import"; startedAt: string; durationMs?: string }>();
  const params = useMemo(
    () =>
      raw.fileUri
        ? { fileUri: raw.fileUri, source: raw.source ?? "import", startedAt: raw.startedAt, durationMs: raw.durationMs ? Number(raw.durationMs) : undefined }
        : null,
    [raw.fileUri, raw.source, raw.startedAt, raw.durationMs],
  );
  const { phase, progress, session, error, retry } = useUploadSession(params);
  const router = useRouter();
  const { colors } = useTheme();

  useEffect(() => {
    if (phase !== "ready" || !session) return;
    const t = setTimeout(() => router.replace(`/session/${session.id}`), 1100);
    return () => clearTimeout(t);
  }, [phase, session, router]);

  const durationSec = session?.durationSec || (params?.durationMs ? Math.round(params.durationMs / 1000) : 0);
  const bar = phase === "uploading" ? progress * 0.6 : phase === "analyzing" ? 0.6 + 0.35 * 0.5 : phase === "ready" ? 1 : progress * 0.6;
  const caption =
    phase === "uploading"
      ? `Uploading… ${Math.round(progress * 100)}%`
      : phase === "analyzing"
        ? "Finding the parts you played…"
        : phase === "ready"
          ? `${session?.takeCount ?? 0} Takes found`
          : phase === "failed"
            ? (error ?? "Couldn’t analyze this recording")
            : "Preparing the recording…";

  return (
    <Screen>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 18, paddingHorizontal: 40 }}>
        <AppText variant="heading" style={{ textAlign: "center" }}>
          Organizing your rehearsal
        </AppText>
        <MonoLabel color={colors.textMuted} style={{ fontSize: 12, letterSpacing: 0 }}>
          {durationSec ? `${fmtDuration(durationSec)} recording` : "Imported recording"}
        </MonoLabel>
        <ProgressBar progress={bar} />
        <AppText variant="caption" color={phase === "ready" ? colors.accent : phase === "failed" ? colors.danger : colors.textMuted} style={{ minHeight: 18, textAlign: "center" }}>
          {caption}
        </AppText>
        {phase === "failed" ? <Chip label="Try again" onPress={retry} /> : null}
      </View>
      <AppText variant="small" style={{ textAlign: "center", paddingHorizontal: space.screenX + 16, paddingBottom: 64, lineHeight: 18 }}>
        {phase === "uploading" ? "Keep the app open until the upload finishes." : "You can close the app — your takes will be ready when you're back."}
      </AppText>
    </Screen>
  );
}
