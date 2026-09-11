import { useLocalSearchParams, useRouter } from "expo-router";
import { FlatList, View } from "react-native";
import { clockRange, fmtDuration } from "@/lib/time";
import { space, useTheme } from "@/theme";
import { AppText, Chip, PressableOpacity, Screen } from "@/ui";
import { TakeRow } from "./TakeRow";
import { useSession } from "./useSession";
import { useTakes } from "./useTakes";

export function SessionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: session } = useSession(id);
  const { data: takes } = useTakes(id);
  const router = useRouter();
  const { colors } = useTheme();
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
        {/* 스펙 A 동안은 읽기 전용 타임라인이라 "Timeline". 편집(스펙 B)이 들어오면 디자인대로 "Edit takes"로 되돌린다 (2026-09-11 스펙 결정 1) */}
        <Chip label="Timeline" onPress={() => router.push(`/session/${session.id}/timeline`)} />
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
          <TakeRow take={item} onPress={() => router.push(`/session/${session.id}/take/${item.id}`)} />
        )}
      />
    </Screen>
  );
}
