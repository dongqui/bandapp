import { useLocalSearchParams, useRouter } from "expo-router";
import { useMemo } from "react";
import { FlatList, KeyboardAvoidingView, Platform, View } from "react-native";
import { useApi } from "@/api";
import { seedOf } from "@/lib/seed";
import { fmtClock, fmtDuration } from "@/lib/time";
import { space, useTheme } from "@/theme";
import { AppText, MonoLabel, PlayerWaveform, PressableOpacity, Screen, useToast } from "@/ui";
import { CommentInput } from "./CommentInput";
import { CommentRow } from "./CommentRow";
import { useComments } from "./useComments";
import { usePlayback } from "./usePlayback";
import { useSession } from "./useSession";
import { useTakes } from "./useTakes";

export function TakePlayerScreen() {
  const { id, takeId } = useLocalSearchParams<{ id: string; takeId: string }>();
  const { data: session } = useSession(id);
  const { data: takes } = useTakes(id);
  const router = useRouter();
  const api = useApi();
  const toast = useToast();
  const { colors } = useTheme();

  const isOriginal = takeId === "orig";
  const take = useMemo(() => {
    if (!session) return undefined;
    if (isOriginal) {
      return { name: "Original recording", durationSec: session.durationSec, commentKey: `${session.id}-orig` };
    }
    const t = (takes ?? []).find((x) => x.id === takeId);
    return t ? { name: t.name, durationSec: t.durationSec, commentKey: t.id } : undefined;
  }, [session, takes, takeId, isOriginal]);

  const { data: comments, reload } = useComments(take?.commentKey);
  const playback = usePlayback(take?.durationSec ?? 0);

  if (!session || !take) return <Screen>{null}</Screen>;
  const sub = `${session.title} · ${isOriginal ? fmtDuration(take.durationSec) : fmtClock(take.durationSec)}`;

  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <View style={{ paddingHorizontal: space.sheetX }}>
          <PressableOpacity
            onPress={() => router.back()}
            style={{ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", padding: 8 }}
          >
            <AppText style={{ fontSize: 18, lineHeight: 20, color: colors.textMuted }}>‹</AppText>
            <AppText variant="body" color={colors.textMuted}>
              Session
            </AppText>
          </PressableOpacity>
        </View>
        <View style={{ paddingHorizontal: space.screenX, paddingTop: 4, paddingBottom: 10 }}>
          <AppText variant="heading">{take.name}</AppText>
          <AppText variant="caption" style={{ marginTop: 4 }}>
            {sub}
          </AppText>
        </View>
        <View style={{ paddingHorizontal: space.screenX, paddingTop: 18, paddingBottom: 8, alignItems: "center", gap: 16 }}>
          <PlayerWaveform
            seed={seedOf(take.commentKey)}
            durationSec={take.durationSec}
            positionSec={playback.positionSec}
            markers={(comments ?? []).map((c) => c.atSec)}
            onSeek={(sec) => playback.seekTo(sec)}
          />
          <AppText variant="monoMeta">{`${fmtClock(playback.positionSec)} / ${fmtClock(take.durationSec)}`}</AppText>
          <PressableOpacity
            onPress={playback.toggle}
            style={{
              width: 60,
              height: 60,
              borderRadius: 30,
              borderWidth: 1,
              borderColor: playback.playing ? colors.accent : colors.borderStronger,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {playback.playing ? (
              <View style={{ flexDirection: "row", gap: 5 }}>
                <View style={{ width: 5, height: 18, backgroundColor: colors.text, borderRadius: 1 }} />
                <View style={{ width: 5, height: 18, backgroundColor: colors.text, borderRadius: 1 }} />
              </View>
            ) : (
              <View
                style={{
                  width: 0,
                  height: 0,
                  borderTopWidth: 10,
                  borderBottomWidth: 10,
                  borderLeftWidth: 16,
                  borderTopColor: "transparent",
                  borderBottomColor: "transparent",
                  borderLeftColor: colors.text,
                  marginLeft: 4,
                }}
              />
            )}
          </PressableOpacity>
        </View>
        <FlatList
          data={comments ?? []}
          keyExtractor={(c) => c.id}
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: space.screenX, paddingTop: 10, paddingBottom: 16 }}
          ListHeaderComponent={<MonoLabel style={{ paddingTop: 8, paddingBottom: 2 }}>FEEDBACK</MonoLabel>}
          ListEmptyComponent={
            <AppText variant="caption" color={colors.textFaint} style={{ paddingVertical: 18 }}>
              No feedback yet. Say something at the right moment — it lands on the timeline.
            </AppText>
          }
          renderItem={({ item }) => (
            <CommentRow comment={item} onPress={() => playback.seekTo(Math.max(0, item.atSec - 5), true)} />
          )}
        />
        <CommentInput
          placeholder={`Leave feedback at ${fmtClock(playback.positionSec)}…`}
          onSubmit={(text) => {
            void api.comments
              .create(take.commentKey, { atSec: Math.floor(playback.positionSec), text })
              .then(() => reload())
              .catch(() => toast.show("Something went wrong"));
          }}
        />
      </KeyboardAvoidingView>
    </Screen>
  );
}
