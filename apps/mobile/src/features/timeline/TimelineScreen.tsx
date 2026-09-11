import { ApiError } from "@bandapp/api-client";
import type { Take } from "@bandapp/types";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import { useAnimatedReaction, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useApi } from "@/api";
import { useAudioUrl } from "@/features/takes/useAudioUrl";
import { useSession } from "@/features/takes/useSession";
import { useTakes } from "@/features/takes/useTakes";
import { useTakesPolling } from "@/features/takes/useTakesPolling";
import { fmtClock, fmtDuration } from "@/lib/time";
import { previewSeekMs, type Draft, type Handle } from "@/lib/timeline/edit";
import { fitRange, xToTime } from "@/lib/timeline/viewport";
import { font, space, useTheme } from "@/theme";
import { AppText, ConfirmDialog, PressableOpacity, Screen, useToast } from "@/ui";
import { OverviewStrip } from "./OverviewStrip";
import { TakeActionSheet } from "./TakeActionSheet";
import { TakeHandles } from "./TakeHandles";
import { TakeLane } from "./TakeLane";
import { TimeRuler } from "./TimeRuler";
import { TimelineDebugOverlay } from "./TimelineDebugOverlay";
import { WaveformCanvas, WAVE_H } from "./WaveformCanvas";
import { useFollowPlayhead } from "./useFollowPlayhead";
import { usePlaybackClock } from "./usePlaybackClock";
import { useSessionPeaks } from "./useSessionPeaks";
import { useTakeDraft } from "./useTakeDraft";
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

/** 선택 카드의 accent 버튼 (Open take / Save / Retry) */
function CardButton({ label, onPress, wide = false }: { label: string; onPress?: () => void; wide?: boolean }) {
  const { colors } = useTheme();
  return (
    <PressableOpacity
      onPress={onPress}
      disabled={!onPress}
      style={{ backgroundColor: colors.accent, borderRadius: 9, paddingVertical: 10, paddingHorizontal: wide ? 16 : 14, opacity: onPress ? 1 : 0.6 }}
    >
      <AppText style={{ fontSize: 13, fontWeight: "600", color: colors.bg }}>{label}</AppText>
    </PressableOpacity>
  );
}

/** 선택 카드의 아웃라인 버튼 (Cancel) */
function CardOutlineButton({ label, onPress }: { label: string; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <PressableOpacity style={{ borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 9, paddingVertical: 10, paddingHorizontal: 14 }} onPress={onPress}>
      <AppText style={{ fontSize: 13, color: colors.textSecondary }}>{label}</AppText>
    </PressableOpacity>
  );
}

/** 재컷 진행/실패 줄 — 5px accent 점 + 문구 */
function StatusLine({ text, color, dot }: { text: string; color: string; dot: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 7 }}>
      {dot ? <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: color }} /> : null}
      <AppText style={{ fontSize: 12, color }}>{text}</AppText>
    </View>
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
  const navigation = useNavigation();
  const api = useApi();
  const toast = useToast();
  const { colors } = useTheme();
  const { data: session } = useSession(id);
  const { data: takes, reload: reloadTakes } = useTakes(id);
  useTakesPolling(takes, reloadTakes);
  const takeList = useMemo(() => takes ?? [], [takes]);
  const durationMs = (session?.durationSec ?? 0) * 1000;
  const url = useAudioUrl("session", session?.id);
  const peaks = useSessionPeaks(session?.id, session?.peaks, durationMs);
  const clock = usePlaybackClock(url, durationMs);

  const level = useSharedValue(-1);
  const [selectedTakeId, setSelectedTakeId] = useState<string | null>(null);
  const [debug, setDebug] = useState(false);
  const draftState = useTakeDraft();
  const [saving, setSaving] = useState(false);
  const [actionTake, setActionTake] = useState<Take | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Take | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** 초안을 버릴지 묻는 중 — 확인하면 실행할 동작 */
  const [pendingDiscard, setPendingDiscard] = useState<(() => void) | null>(null);
  /** 카드의 범위 텍스트용 초안 미러. 초 단위라 초가 바뀔 때만 React로 넘긴다 (매 프레임 리렌더 방지) */
  const [draftRange, setDraftRange] = useState<Draft | null>(null);

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
  // 핸들을 놓으면 그 경계를 미리 들려준다 (스펙 B)
  const onHandleRelease = useCallback((handle: Handle, d: Draft) => clock.seekTo(previewSeekMs(d, handle)), [clock]);
  const editing = useMemo(
    () => ({ draft: draftState.draft, neighbors: draftState.neighbors, onHandleRelease }),
    [draftState.draft, draftState.neighbors, onHandleRelease],
  );
  const vp = useTimelineViewport(durationMs, onTap, editing);
  vpRef.current = vp;
  const follow = useFollowPlayhead(vp, clock.playheadMs, durationMs, clock.playing);

  useAnimatedReaction(
    () => {
      const d = draftState.draft.value;
      return d ? { startMs: Math.floor(d.startMs / 1000) * 1000, endMs: Math.floor(d.endMs / 1000) * 1000 } : null;
    },
    (cur, prev) => {
      if (cur?.startMs === prev?.startMs && cur?.endMs === prev?.endMs) return;
      scheduleOnRN(setDraftRange, cur);
    },
  );

  const applySelect = useCallback(
    (t: Take) => {
      setSelectedTakeId(t.id);
      vp.follow.value = false;
      vp.setViewport(fitRange(vp.snapshot().widthPx, t.startMs, t.endMs, FIT_PAD, durationMs));
    },
    [vp, durationMs],
  );
  // 초안이 dirty면 먼저 버릴지 묻는다
  const selectTake = useCallback(
    (t: Take) => {
      if (t.id === selectedTakeId) return;
      if (draftState.dirty) setPendingDiscard(() => () => applySelect(t));
      else applySelect(t);
    },
    [selectedTakeId, draftState.dirty, applySelect],
  );

  const shownErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!clock.error || clock.error === shownErrorRef.current) return;
    shownErrorRef.current = clock.error;
    toast.show("Couldn’t play this recording — try again");
  }, [clock.error, toast]);

  const selectedTake = useMemo(() => takeList.find((t) => t.id === selectedTakeId) ?? null, [takeList, selectedTakeId]);
  /** 핸들·초안은 선택 take가 ready이고 피크가 다 로드된 뒤에만 산다 (디자인 노트 editOn) */
  const editOn = selectedTake !== null && selectedTake.audioStatus === "ready" && !peaks.loading;

  // 목록이 새로고침되면(폴링·저장 후) 선택 take의 최신 값으로 original을 맞추되 dirty 초안은 유지한다.
  // 편집할 수 없는 상태(updating/failed·피크 로딩 중)면 초안을 비워 핸들과 hit-test를 같이 끈다.
  useEffect(() => {
    if (selectedTakeId === null) return;
    if (!selectedTake) {
      // 다른 멤버가 지웠다
      setSelectedTakeId(null);
      draftState.clear();
      return;
    }
    if (!editOn) {
      if (!draftState.dirty) draftState.clear();
      return;
    }
    if (!draftState.dirty) draftState.begin(selectedTake, takeList);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTakeId, selectedTake?.version, selectedTake?.audioStatus, editOn, takeList]);

  // 저장하지 않은 초안을 두고 화면을 떠나려 하면 먼저 묻는다
  useEffect(() => {
    if (!draftState.dirty) return;
    const off = navigation.addListener("beforeRemove", (e) => {
      e.preventDefault();
      // 리스너를 먼저 떼야 한다 — reset()의 state 갱신은 dispatch보다 늦게 커밋되므로 그대로 두면 다시 막힌다
      setPendingDiscard(() => () => {
        off();
        navigation.dispatch(e.data.action);
      });
    });
    return off;
  }, [navigation, draftState.dirty]);

  const save = useCallback(async () => {
    const t = selectedTake;
    if (!t || saving) return;
    // Retry(초안 없음)면 저장된 값 그대로 다시 보낸다
    const d = draftState.current() ?? { startMs: t.startMs, endMs: t.endMs };
    setSaving(true);
    try {
      await api.takes.update(t.id, { startMs: d.startMs, endMs: d.endMs, version: t.version });
      toast.show("Take updated");
      // 경계는 저장됐다 — 재컷이 끝나면 폴링이 새 값으로 초안을 다시 연다
      draftState.clear();
      reloadTakes();
    } catch (err) {
      if (err instanceof ApiError && err.code === "take_version_conflict") {
        toast.show("Someone else edited this take — showing the latest");
        draftState.clear();
        setSelectedTakeId(null);
        reloadTakes();
      } else if (err instanceof ApiError && (err.code === "take_overlap" || err.code === "take_range_invalid")) {
        toast.show(err.code === "take_overlap" ? "Can’t overlap the next take" : "Invalid take range");
      } else {
        toast.show("Something went wrong");
      }
    } finally {
      setSaving(false);
    }
  }, [api, draftState, reloadTakes, saving, selectedTake, toast]);

  const doDelete = () => {
    const t = confirmDelete;
    if (!t || deleting) return;
    setDeleting(true);
    void api.takes
      .remove(t.id)
      .then(() => {
        toast.show(`Take ${t.index + 1} deleted`);
        if (selectedTakeId === t.id) {
          setSelectedTakeId(null);
          draftState.clear();
        }
        reloadTakes();
      })
      .catch(() => toast.show("Something went wrong"))
      .finally(() => {
        setDeleting(false);
        setConfirmDelete(null);
      });
  };

  if (!session) return <Screen>{null}</Screen>;
  const durLabel = `${fmtDuration(session.durationSec)} · ${takeList.length === 0 ? "No takes" : `${takeList.length} Takes`}`;
  // 카드의 범위 텍스트 — 초안이 dirty면 초안 값, 아니면 저장된 값 (디자인 노트)
  const edited = draftState.dirty ? draftRange : null;
  const rangeLabel = !selectedTake
    ? ""
    : edited
      ? `${fmtClock(edited.startMs / 1000)} – ${fmtClock(edited.endMs / 1000)} · ${fmtClock((edited.endMs - edited.startMs) / 1000)}`
      : `${fmtClock(selectedTake.startMs / 1000)} – ${fmtClock(selectedTake.endMs / 1000)} · ${fmtClock(selectedTake.durationSec)}`;

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
        <TakeHandles vp={vp} draft={draftState.draft} enabled={editOn} />
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
        <TakeLane takes={takeList} vp={vp} draft={draftState.draft} selectedTakeId={selectedTakeId} onSelect={selectTake} />
      </View>
      <View style={{ marginTop: 14, marginHorizontal: space.screenX }}>
        <OverviewStrip levels={peaks.levels} vp={vp} takes={takeList} durationMs={durationMs} playheadMs={clock.playheadMs} />
      </View>

      <View style={{ flex: 1 }} />

      {selectedTake ? (
        <View style={{ marginHorizontal: space.screenX, marginVertical: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <AppText variant="rowTitle">{selectedTake.name}</AppText>
            <AppText style={{ fontFamily: font.mono, fontSize: 11, color: colors.textMuted, marginTop: 5 }}>{rangeLabel}</AppText>
            {selectedTake.audioStatus === "updating" ? <StatusLine text="Updating…" color={colors.accent} dot /> : null}
            {/* 경계는 이미 저장됐고 재컷만 실패한 상태다 (디자인 노트) */}
            {selectedTake.audioStatus === "failed" ? <StatusLine text="Couldn’t update audio" color={colors.danger} dot={false} /> : null}
          </View>
          {draftState.dirty ? (
            <>
              <CardOutlineButton label="Cancel" onPress={() => setPendingDiscard(() => () => undefined)} />
              <CardButton label={saving ? "Saving…" : "Save"} onPress={saving ? undefined : () => void save()} wide />
            </>
          ) : selectedTake.audioStatus === "failed" ? (
            <CardButton label={saving ? "Saving…" : "Retry"} onPress={saving ? undefined : () => void save()} />
          ) : selectedTake.audioStatus === "updating" ? null : (
            <>
              <PressableOpacity
                onPress={() => setActionTake(selectedTake)}
                hitSlop={6}
                style={{ width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center" }}
              >
                <AppText style={{ fontSize: 14, lineHeight: 16, color: colors.textMuted }}>···</AppText>
              </PressableOpacity>
              <CardButton label="Open take" onPress={() => router.push(`/session/${session.id}/take/${selectedTake.id}`)} />
            </>
          )}
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

      <TakeActionSheet
        take={actionTake}
        onClose={() => setActionTake(null)}
        onDelete={(t) => {
          setActionTake(null);
          setConfirmDelete(t);
        }}
      />
      {confirmDelete ? (
        <ConfirmDialog
          visible
          title={`Delete Take ${confirmDelete.index + 1}?`}
          body={
            (confirmDelete.commentCount > 0
              ? `Its ${confirmDelete.commentCount} ${confirmDelete.commentCount === 1 ? "comment" : "comments"} will be deleted too. `
              : "") + "Other takes keep their numbers. This can’t be undone."
          }
          primary={{ label: "Delete take", danger: true, onPress: doDelete }}
          cancelLabel="Cancel"
          onCancel={() => (deleting ? undefined : setConfirmDelete(null))}
          busy={deleting}
        />
      ) : null}
      {pendingDiscard ? (
        <ConfirmDialog
          visible
          title="Discard changes?"
          body={`Take ${(selectedTake?.index ?? 0) + 1} keeps its current start and end.`}
          primary={{
            label: "Discard changes",
            danger: true,
            onPress: () => {
              const go = pendingDiscard;
              setPendingDiscard(null);
              draftState.reset();
              go();
            },
          }}
          cancelLabel="Keep editing"
          onCancel={() => setPendingDiscard(null)}
        />
      ) : null}

      {debug ? <TimelineDebugOverlay vp={vp} playheadMs={clock.playheadMs} level={level} source={peaks.source} selectedTakeId={selectedTakeId} /> : null}
    </Screen>
  );
}
