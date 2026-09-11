import type { Take } from "@bandapp/types";
import { useLocalSearchParams, useRouter } from "expo-router";
import { FlatList, View } from "react-native";
import { useApi } from "@/api";
import { clockRange, fmtDuration } from "@/lib/time";
import { space, useTheme } from "@/theme";
import { AppText, Chip, PressableOpacity, Screen, useToast } from "@/ui";
import { TakeRow } from "./TakeRow";
import { useSession } from "./useSession";
import { useTakes } from "./useTakes";
import { useTakesPolling } from "./useTakesPolling";

export function SessionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: session } = useSession(id);
  const { data: takes, reload } = useTakes(id);
  useTakesPolling(takes, reload);
  const router = useRouter();
  const api = useApi();
  const toast = useToast();
  const { colors } = useTheme();
  // 재컷 실패 행의 Retry — 저장된 경계를 그대로 다시 보낸다 (스펙 B)
  const retry = (take: Take) => {
    void api.takes
      .update(take.id, { startMs: take.startMs, endMs: take.endMs, version: take.version })
      .then(() => reload())
      .catch(() => toast.show("Something went wrong"));
  };
  if (!session) return <Screen>{null}</Screen>;
  return (
    <Screen>
      <View style={{ paddingHorizontal: space.sheetX, paddingBottom: 4 }}>
        <PressableOpacity
          onPress={() => router.back()}
          style={{ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", padding: 8 }}
        >
          <AppText style={{ fontSize: 18, lineHeight: 20, color: colors.textMuted }}>‹</AppText>
          <AppText variant="body" color={colors.textMuted}>
            Sessions
          </AppText>
        </PressableOpacity>
      </View>
      <View style={{ paddingHorizontal: space.screenX, paddingTop: 6, paddingBottom: 14, gap: 8 }}>
        <AppText variant="title">{session.name ?? session.title}</AppText>
        <AppText variant="monoMeta">{clockRange(session.startedAt, session.durationSec)}</AppText>
        <AppText variant="caption" color={colors.textSecondary}>
          {`${fmtDuration(session.durationSec)} · ${session.takeCount} Takes`}
        </AppText>
      </View>
      <View style={{ flexDirection: "row", gap: 10, paddingHorizontal: space.screenX, paddingBottom: 6 }}>
        <Chip label="Original recording" onPress={() => router.push(`/session/${session.id}/take/orig`)} />
        {/* 디자인대로 Edit takes — 타임라인에서 편집·삭제 (2026-09-11 스펙 B) */}
        <Chip label="Edit takes" onPress={() => router.push(`/session/${session.id}/timeline`)} />
      </View>
      <FlatList
        data={takes ?? []}
        keyExtractor={(t) => t.id}
        contentContainerStyle={{ paddingHorizontal: space.screenX, paddingTop: 6, paddingBottom: 48 }}
        ListEmptyComponent={
          <AppText variant="caption" color={colors.textFaint} style={{ paddingVertical: 18 }}>
            No takes were found in this recording. You can still listen to the original.
          </AppText>
        }
        renderItem={({ item }) => (
          <TakeRow take={item} onPress={() => router.push(`/session/${session.id}/take/${item.id}`)} onRetry={() => retry(item)} />
        )}
      />
    </Screen>
  );
}
