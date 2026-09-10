import type { Session } from "@bandapp/types";
import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { SectionList, View } from "react-native";
import { useApi } from "@/api";
import { BandSwitchSheet } from "@/features/band/BandSwitchSheet";
import { useCurrentBand } from "@/features/band/useCurrentBand";
import { inFlightUploads } from "@/features/upload/inFlightUploads";
import { usePendingUploadIds } from "@/features/upload/usePendingUploadIds";
import { monthLabel } from "@/lib/time";
import { space, useTheme } from "@/theme";
import { AppText, Chip, MonoLabel, Screen, useToast } from "@/ui";
import { SessionRow } from "./SessionRow";
import { useSessions } from "./useSessions";

export function SessionsScreen() {
  const { band } = useCurrentBand();
  const { data: sessions } = useSessions(band?.id);
  const pendingIds = usePendingUploadIds(sessions);
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
    else if (s.status === "failed")
      void api.sessions.retryAnalysis(s.id).catch(() => toast.show("Something went wrong"));
    else if (s.status === "uploading") {
      // 로컬 레코드가 있으면 이어 올린다. 없고 지금 이 프로세스에서 실제로 업로드 중이면(finding A)
      // 새 요청을 또 시작하지 않고 안내만 한다. 둘 다 아니면 다른 기기에서 시작한 업로드다.
      if (pendingIds.has(s.id)) router.push({ pathname: "/processing", params: { sessionId: s.id } });
      else if (inFlightUploads.has(s.id)) toast.show("This upload is still running");
      else toast.show("This upload was started on another device");
    } else toast.show("Still finding takes…");
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
        renderItem={({ item }) => (
          <SessionRow session={item} resumable={pendingIds.has(item.id)} onPress={() => onRowPress(item)} />
        )}
        stickySectionHeadersEnabled={false}
      />
      <BandSwitchSheet visible={bandsOpen} onClose={() => setBandsOpen(false)} />
    </Screen>
  );
}
