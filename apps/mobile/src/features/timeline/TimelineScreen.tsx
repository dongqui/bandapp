import type { Take } from "@bandapp/types";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import { useSharedValue } from "react-native-reanimated";
import { useAudioUrl } from "@/features/takes/useAudioUrl";
import { useSession } from "@/features/takes/useSession";
import { useTakes } from "@/features/takes/useTakes";
import { fmtClock, fmtDuration } from "@/lib/time";
import { fitRange, xToTime } from "@/lib/timeline/viewport";
import { font, space, useTheme } from "@/theme";
import { AppText, PressableOpacity, Screen, useToast } from "@/ui";
import { OverviewStrip } from "./OverviewStrip";
import { TakeLane } from "./TakeLane";
import { TimeRuler } from "./TimeRuler";
import { TimelineDebugOverlay } from "./TimelineDebugOverlay";
import { WaveformCanvas, WAVE_H } from "./WaveformCanvas";
import { useFollowPlayhead } from "./useFollowPlayhead";
import { usePlaybackClock } from "./usePlaybackClock";
import { useSessionPeaks } from "./useSessionPeaks";
import { useTimelineViewport } from "./useTimelineViewport";

/** ±버튼이 재생 위치를 옮기는 폭 — Take Feedback 화면과 같다 */
const NUDGE_MS = 1000;
/** take 선택 시 좌우 여백 (2026-09-11 스펙 결정 11, 디자인 dur/0.6) */
const FIT_PAD = 0.2;
/** 디자인의 −/+ 버튼 줌 배율 */
const ZOOM_STEP = 1.5;
/** 디자인 Timeline 화면의 오버레이 색 — 테마 토큰에 없는 값 */
const OVERLAY_BG = "rgba(26,29,34,0.85)";
const PILL_BG = "#1A1D22";
const BADGE_BG = "rgba(11,12,14,0.7)";

/** 파형 위에 겹치는 30px 원형 버튼 (디자인 −/+) */
function RoundButton({ label, onPress }: { label: string; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <PressableOpacity
      onPress={onPress}
      hitSlop={4}
      style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: OVERLAY_BG, borderWidth: 1, borderColor: colors.borderStronger, alignItems: "center", justifyContent: "center" }}
    >
      <AppText style={{ fontSize: 15, lineHeight: 18, color: colors.textSecondary }}>{label}</AppText>
    </PressableOpacity>
  );
}

/** 디자인의 −1s / +1s 필 */
function NudgeButton({ label, onPress }: { label: string; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <PressableOpacity onPress={onPress} hitSlop={6} style={{ borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 15, paddingVertical: 8, paddingHorizontal: 13 }}>
      <AppText style={{ fontFamily: font.mono, fontSize: 11, lineHeight: 13, color: colors.textMuted }}>{label}</AppText>
    </PressableOpacity>
  );
}

/**
 * 타임라인 뷰어 (2026-09-11 스펙 A, Claude Design "Timeline" 화면). 데이터·제스처·재생은 전부 훅에 있고
 * 이 컴포넌트는 디자인대로 조립하고 탭 판정만 한다. 파형 탭은 seek, take 필 탭은 선택 + fit (결정 11).
 */
export function TimelineScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const { colors } = useTheme();
  const { data: session } = useSession(id);
  const { data: takes } = useTakes(id);
  const takeList = useMemo(() => takes ?? [], [takes]);
  const durationMs = (session?.durationSec ?? 0) * 1000;
  const url = useAudioUrl("session", session?.id);
  const peaks = useSessionPeaks(session?.id, session?.peaks, durationMs);
  const clock = usePlaybackClock(url, durationMs);

  const level = useSharedValue(-1);
  const [selectedTakeId, setSelectedTakeId] = useState<string | null>(null);
  const [debug, setDebug] = useState(false);

  // 파형 탭 → seek. onTap이 vp를 필요로 하고 vp가 onTap을 받으니 ref로 순환을 끊는다
  const vpRef = useRef<ReturnType<typeof useTimelineViewport> | null>(null);
  const onTap = useCallback(
    (x: number) => {
      const current = vpRef.current;
      if (!current) return;
      clock.seekTo(xToTime(current.snapshot(), x));
    },
    [clock],
  );
  const vp = useTimelineViewport(durationMs, onTap);
  vpRef.current = vp;
  const follow = useFollowPlayhead(vp, clock.playheadMs, durationMs, clock.playing);

  const selectTake = useCallback(
    (t: Take) => {
      setSelectedTakeId(t.id);
      vp.follow.value = false;
      vp.setViewport(fitRange(vp.snapshot().widthPx, t.startMs, t.endMs, FIT_PAD, durationMs));
    },
    [vp, durationMs],
  );

  const shownErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!clock.error || clock.error === shownErrorRef.current) return;
    shownErrorRef.current = clock.error;
    toast.show("Couldn’t play this recording — try again");
  }, [clock.error, toast]);

  const selectedTake = useMemo(() => takeList.find((t) => t.id === selectedTakeId) ?? null, [takeList, selectedTakeId]);

  if (!session) return <Screen>{null}</Screen>;
  const durLabel = `${fmtDuration(session.durationSec)} · ${takeList.length === 0 ? "No takes" : `${takeList.length} Takes`}`;

  return (
    <Screen>
      <View style={{ paddingHorizontal: space.sheetX }}>
        <PressableOpacity onPress={() => router.back()} style={{ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", padding: 8 }}>
          <AppText style={{ fontSize: 18, lineHeight: 20, color: colors.textMuted }}>‹</AppText>
          <AppText variant="body" color={colors.textMuted}>
            Session
          </AppText>
        </PressableOpacity>
      </View>
      <View style={{ paddingHorizontal: space.screenX, paddingTop: 2, paddingBottom: 4, gap: 5 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <AppText style={{ fontFamily: font.mono, fontSize: 10, letterSpacing: 1.8, color: colors.textFaint }}>TIMELINE</AppText>
          {__DEV__ ? (
            <PressableOpacity onPress={() => setDebug((d) => !d)} hitSlop={8}>
              <AppText style={{ fontFamily: font.mono, fontSize: 10, letterSpacing: 1.8, color: debug ? colors.accent : colors.textFaint }}>DEBUG</AppText>
            </PressableOpacity>
          ) : null}
        </View>
        <AppText variant="heading">{session.name ?? session.title}</AppText>
        <AppText variant="monoMeta">{durLabel}</AppText>
      </View>

      <View style={{ marginTop: 10, marginHorizontal: space.screenX }}>
        <TimeRuler vp={vp} />
      </View>
      <View style={{ marginTop: 2, marginHorizontal: space.screenX }}>
        <GestureDetector gesture={vp.gesture}>
          <View>
            <WaveformCanvas levels={peaks.levels} vp={vp} playheadMs={clock.playheadMs} level={level} />
          </View>
        </GestureDetector>
        {peaks.loading ? (
          <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: 0, height: WAVE_H, alignItems: "center", justifyContent: "center", gap: 12, backgroundColor: colors.bg }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4, height: 32 }}>
              {[14, 26, 20, 30, 16].map((h, i) => (
                <View key={i} style={{ width: 3, height: h, borderRadius: 1.5, backgroundColor: colors.borderStronger }} />
              ))}
            </View>
            <AppText style={{ fontFamily: font.mono, fontSize: 10, letterSpacing: 1.6, color: colors.textFaint }}>LOADING WAVEFORM…</AppText>
          </View>
        ) : null}
        {!peaks.loading && peaks.source !== "hires" ? (
          <View pointerEvents="none" style={{ position: "absolute", left: 8, top: 8, backgroundColor: BADGE_BG, paddingVertical: 3, paddingHorizontal: 7, borderRadius: 8 }}>
            <AppText style={{ fontFamily: font.mono, fontSize: 9, letterSpacing: 1.3, color: colors.textFaint }}>
              {peaks.source === "buckets" ? "ROUGH WAVEFORM" : "NO WAVEFORM"}
            </AppText>
          </View>
        ) : null}
        <View style={{ position: "absolute", right: 8, top: 8, flexDirection: "row", gap: 6 }}>
          <RoundButton label="−" onPress={() => vp.zoomBy(1 / ZOOM_STEP)} />
          <RoundButton label="+" onPress={() => vp.zoomBy(ZOOM_STEP)} />
        </View>
        {!follow.following ? (
          <PressableOpacity
            onPress={follow.returnToPlayhead}
            style={{ position: "absolute", right: 8, bottom: 10, backgroundColor: PILL_BG, borderWidth: 1, borderColor: colors.borderStronger, borderRadius: 15, paddingVertical: 7, paddingHorizontal: 12 }}
          >
            <AppText style={{ fontFamily: font.mono, fontSize: 10, lineHeight: 12, letterSpacing: 1, color: colors.textSecondary }}>⟲ PLAYHEAD</AppText>
          </PressableOpacity>
        ) : null}
      </View>
      <View style={{ marginTop: 10, marginHorizontal: space.screenX }}>
        <TakeLane takes={takeList} vp={vp} selectedTakeId={selectedTakeId} onSelect={selectTake} />
      </View>
      <View style={{ marginTop: 14, marginHorizontal: space.screenX }}>
        <OverviewStrip levels={peaks.levels} vp={vp} takes={takeList} durationMs={durationMs} playheadMs={clock.playheadMs} />
      </View>

      <View style={{ flex: 1 }} />

      {selectedTake ? (
        <View style={{ marginHorizontal: space.screenX, marginVertical: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", gap: 12 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <AppText variant="rowTitle">{selectedTake.name}</AppText>
            <AppText style={{ fontFamily: font.mono, fontSize: 11, color: colors.textMuted, marginTop: 5 }}>
              {`${fmtClock(selectedTake.startMs / 1000)} – ${fmtClock(selectedTake.endMs / 1000)} · ${fmtClock(selectedTake.durationSec)}`}
            </AppText>
          </View>
          <PressableOpacity
            onPress={() => router.push(`/session/${session.id}/take/${selectedTake.id}`)}
            style={{ backgroundColor: colors.accent, borderRadius: 9, paddingVertical: 10, paddingHorizontal: 14 }}
          >
            <AppText style={{ fontSize: 13, fontWeight: "600", color: colors.bg }}>Open take</AppText>
          </PressableOpacity>
        </View>
      ) : null}

      <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 14, paddingBottom: 42, paddingHorizontal: space.screenX, alignItems: "center", gap: 12 }}>
        <AppText variant="monoMeta">
          <AppText variant="monoMeta" color={colors.text}>
            {fmtClock(clock.positionMs / 1000)}
          </AppText>
          {` / ${fmtClock(session.durationSec)}`}
        </AppText>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 18 }}>
          <NudgeButton label="−1s" onPress={() => clock.seekTo(clock.positionMs - NUDGE_MS)} />
          <PressableOpacity
            onPress={clock.toggle}
            style={{ width: 58, height: 58, borderRadius: 29, borderWidth: 1, borderColor: clock.playing ? colors.accent : colors.borderStronger, alignItems: "center", justifyContent: "center" }}
          >
            {clock.playing ? (
              <View style={{ flexDirection: "row", gap: 5 }}>
                <View style={{ width: 5, height: 17, backgroundColor: colors.text, borderRadius: 1 }} />
                <View style={{ width: 5, height: 17, backgroundColor: colors.text, borderRadius: 1 }} />
              </View>
            ) : (
              <View style={{ width: 0, height: 0, borderTopWidth: 9, borderBottomWidth: 9, borderLeftWidth: 15, borderTopColor: "transparent", borderBottomColor: "transparent", borderLeftColor: colors.text, marginLeft: 4 }} />
            )}
          </PressableOpacity>
          <NudgeButton label="+1s" onPress={() => clock.seekTo(clock.positionMs + NUDGE_MS)} />
        </View>
      </View>

      {debug ? <TimelineDebugOverlay vp={vp} playheadMs={clock.playheadMs} level={level} source={peaks.source} selectedTakeId={selectedTakeId} /> : null}
    </Screen>
  );
}
