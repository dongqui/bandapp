import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useApi, useApiData } from "@/api";
import { useCurrentBand } from "@/features/band/useCurrentBand";
import { fmtDuration } from "@/lib/time";
import { space, useTheme } from "@/theme";
import { AppText, MonoLabel, ProgressBar, Screen } from "@/ui";

const ANALYSIS_MS = 4500;

export function ProcessingScreen() {
  const { durationSec: durParam, source } = useLocalSearchParams<{
    durationSec: string;
    source: "recording" | "import";
  }>();
  const durationSec = Number(durParam ?? 0);
  const api = useApi();
  const router = useRouter();
  const { band } = useCurrentBand();
  const { colors } = useTheme();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const startedRef = useRef(false);

  useEffect(() => {
    if (!band || startedRef.current) return;
    startedRef.current = true;
    void api.sessions
      .create(band.id, { durationSec, source: source ?? "recording" })
      .then((s) => setSessionId(s.id));
  }, [api, band, durationSec, source]);

  useEffect(() => {
    const t = setInterval(() => {
      setProgress((p) => (p >= 1 ? p : Math.min(0.95, p + 200 / ANALYSIS_MS)));
    }, 200);
    return () => clearInterval(t);
  }, []);

  const { data: session } = useApiData(
    async (a) => (sessionId ? a.sessions.get(sessionId) : undefined),
    [sessionId],
  );
  const done = session?.status === "ready";

  useEffect(() => {
    if (!done || !sessionId) return;
    setProgress(1);
    const t = setTimeout(() => router.replace(`/session/${sessionId}`), 1100);
    return () => clearTimeout(t);
  }, [done, sessionId, router]);

  const phase = done
    ? `${session?.takeCount ?? 0} Takes found`
    : progress < 0.3
      ? "Preparing the recording…"
      : progress < 0.78
        ? "Finding the parts you played…"
        : "Organizing takes…";

  return (
    <Screen>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 18, paddingHorizontal: 40 }}>
        <AppText variant="heading" style={{ textAlign: "center" }}>
          Organizing your rehearsal
        </AppText>
        <MonoLabel color={colors.textMuted} style={{ fontSize: 12, letterSpacing: 0 }}>
          {`${fmtDuration(durationSec)} recording`}
        </MonoLabel>
        <ProgressBar progress={progress} />
        <AppText variant="caption" color={done ? colors.accent : colors.textMuted} style={{ minHeight: 18 }}>
          {phase}
        </AppText>
      </View>
      <AppText
        variant="small"
        style={{ textAlign: "center", paddingHorizontal: space.screenX + 16, paddingBottom: 64, lineHeight: 18 }}
      >
        You can close the app — your takes will be ready when you're back.
      </AppText>
    </Screen>
  );
}
