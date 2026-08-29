import type { Session } from "@bandapp/types";
import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { SectionList, View } from "react-native";
import { useApi } from "@/api";
import { BandSwitchSheet } from "@/features/band/BandSwitchSheet";
import { useCurrentBand } from "@/features/band/useCurrentBand";
import { monthLabel } from "@/lib/time";
import { space, useTheme } from "@/theme";
import { AppText, Chip, MonoLabel, Screen, useToast } from "@/ui";
import { SessionRow } from "./SessionRow";
import { useSessions } from "./useSessions";

export function SessionsScreen() {
  const { band } = useCurrentBand();
  const { data: sessions } = useSessions(band?.id);
  const [bandsOpen, setBandsOpen] = useState(false);
  const router = useRouter();
  const api = useApi();
  const toast = useToast();
  const { colors } = useTheme();

  const sections = useMemo(() => {
    const groups = new Map<string, Session[]>();
    for (const s of sessions ?? []) {
      const key = monthLabel(s.startedAt);
      const list = groups.get(key) ?? [];
      list.push(s);
      groups.set(key, list);
    }
    return [...groups.entries()].map(([title, data]) => ({ title, data }));
  }, [sessions]);

  const onRowPress = (s: Session) => {
    if (s.status === "ready") router.push(`/session/${s.id}`);
    else if (s.status === "failed") void api.sessions.retryAnalysis(s.id);
    else toast.show("Still finding takes…");
  };

  return (
    <Screen>
      <View style={{ paddingHorizontal: space.screenX, paddingBottom: 10, gap: 8 }}>
        <Chip
          size="lg"
          mono
          label={band?.name ?? ""}
          trailing={<AppText style={{ fontSize: 8, color: colors.textFaint }}>▼</AppText>}
          onPress={() => setBandsOpen(true)}
        />
        <AppText variant="titleXL">Sessions</AppText>
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(s) => s.id}
        contentContainerStyle={{ paddingHorizontal: space.screenX, paddingBottom: 160 }}
        renderSectionHeader={({ section }) => (
          <MonoLabel style={{ paddingTop: 14, paddingBottom: 4 }}>{section.title}</MonoLabel>
        )}
        renderItem={({ item }) => <SessionRow session={item} onPress={() => onRowPress(item)} />}
        stickySectionHeadersEnabled={false}
      />
      <BandSwitchSheet visible={bandsOpen} onClose={() => setBandsOpen(false)} />
    </Screen>
  );
}
