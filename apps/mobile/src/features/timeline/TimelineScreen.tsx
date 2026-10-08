import { ApiError } from "@bandapp/api-client";
import { defaultTakeName, type Take } from "@bandapp/types";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TextInput, View } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAnimatedReaction, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import Svg, { Path } from "react-native-svg";
import { useApi } from "@/api";
import { TakeActionSheet } from "@/features/takes/TakeActionSheet";
import { TakeDeleteDialog } from "@/features/takes/TakeDeleteDialog";
import { TakeMoreButton } from "@/features/takes/TakeMoreButton";
import { TakeRenameSheet } from "@/features/takes/TakeRenameSheet";
import { useAudioUrl } from "@/features/takes/useAudioUrl";
import { useSession } from "@/features/takes/useSession";
import { useTakes } from "@/features/takes/useTakes";
import { useTakesPolling } from "@/features/takes/useTakesPolling";
import { fmtClock, fmtDuration } from "@/lib/time";
import { newTakeAt } from "@/lib/timeline/addTake";
import { previewSeekMs, type Draft, type Handle } from "@/lib/timeline/edit";
import { clockDigits, formatClockDigits, secToClockInput, validateTimeInput } from "@/lib/timeline/timeInput";
import { viewportEndMs, xToTime } from "@/lib/timeline/viewport";
import { font, radius, space, useTheme } from "@/theme";
import { AppText, ConfirmDialog, PressableOpacity, Screen, useToast } from "@/ui";
import { OverviewStrip } from "./OverviewStrip";
import { Playhead } from "./Playhead";
import { ProgressBar } from "./ProgressBar";
import { TakeHandles } from "./TakeHandles";
import { TakeLane } from "./TakeLane";
import { TimeRuler } from "./TimeRuler";
import { TimelineDebugOverlay } from "./TimelineDebugOverlay";
import { WaveformCanvas, WAVE_H } from "./WaveformCanvas";
import { useFollowPlayhead } from "./useFollowPlayhead";
import { usePlaybackClock } from "./usePlaybackClock";
import { useSessionPeaks } from "./useSessionPeaks";
import { useTakeDraft } from "./useTakeDraft";
import { useTimelineViewport, type TimelineViewportState } from "./useTimelineViewport";

/** ±버튼이 재생 위치를 옮기는 폭 — Take Feedback 화면과 같다 */
const NUDGE_MS = 1000;
/** take 선택 시 좌우 여백 (2026-09-11 스펙 결정 11, 디자인 dur/0.6) */
const FIT_PAD = 0.2;
/** 디자인 Timeline 화면의 오버레이 색 — 테마 토큰에 없는 값 */
const BADGE_BG = "rgba(11,12,14,0.7)";
const PILL_BG = "#1A1D22";
/** take 내비의 비활성 화살표 색 (디자인 #3A3E45) — 테마 토큰에 없는 값 */
const NAV_DISABLED = "#3A3E45";

/** take 내비의 34px 원형 화살표 (디자인 ‹ ›) */
function NavButton({ label, enabled, onPress }: { label: string; enabled: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <PressableOpacity
      onPress={onPress}
      disabled={!enabled}
      hitSlop={6}
      style={{ width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center", paddingBottom: 2 }}
    >
      <AppText style={{ fontSize: 17, lineHeight: 20, color: enabled ? colors.textSecondary : NAV_DISABLED }}>{label}</AppText>
    </PressableOpacity>
  );
}

/** 편집 카드의 accent 버튼 (Save / Retry) */
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

/** 편집 카드의 아웃라인 버튼 (Cancel / Retry) */
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

/** 헤더의 "+ Add take" accent 필 (2026-10-08 디자인) */
function AddTakeButton({ onPress }: { onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <PressableOpacity
      onPress={onPress}
      hitSlop={6}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        backgroundColor: colors.accent,
        borderRadius: 18,
        paddingVertical: 9,
        paddingLeft: 13,
        paddingRight: 16,
        shadowColor: "#000",
        shadowOpacity: 0.35,
        shadowRadius: 9,
        shadowOffset: { width: 0, height: 6 },
        elevation: 4,
      }}
    >
      <Svg width={13} height={13} viewBox="0 0 12 12" fill="none" stroke={colors.bg} strokeWidth={2} strokeLinecap="round">
        <Path d="M6 1.5v9M1.5 6h9" />
      </Svg>
      <AppText style={{ fontSize: 14, lineHeight: 17, fontWeight: "600", color: colors.bg }}>Add take</AppText>
    </PressableOpacity>
  );
}

/**
 * 편집 카드의 START / END 시간 입력 (2026-10-08 디자인). 숫자 키패드만 쓰고 콜론은 오른쪽부터 자동으로 채운다 —
 * 모바일 숫자 키패드에는 ':'가 없다 (lib/timeline/timeInput 설명 참고). 커밋은 blur·Enter.
 */
function TimeField({ label, digits, fallback, error, onChange, onCommit }: { label: string; digits: string | null; fallback: string; error: boolean; onChange: (digits: string) => void; onCommit: () => void }) {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
      <AppText style={{ fontFamily: font.mono, fontSize: 9, letterSpacing: 1.3, color: colors.textFaint }}>{label}</AppText>
      <TextInput
        value={digits !== null ? formatClockDigits(digits) : fallback}
        onChangeText={(t) => onChange(clockDigits(t))}
        onBlur={onCommit}
        onSubmitEditing={onCommit}
        keyboardType="number-pad"
        returnKeyType="done"
        selectTextOnFocus
        placeholder="0:00"
        placeholderTextColor={colors.textFaint}
        style={{
          backgroundColor: colors.surfaceSunken,
          borderWidth: 1,
          borderColor: error ? colors.danger : colors.borderStrong,
          borderRadius: radius.chipSm,
          paddingVertical: 10,
          paddingHorizontal: 12,
          fontSize: 15,
          fontFamily: font.mono,
          color: colors.text,
        }}
      />
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
 *
 * 2026-09-20 디자인 개정: 화면은 첫 take를 선택한 채로 열리고, 오버뷰 아래 ‹ TAKE n / N › 내비로 take를 오간다.
 * 파형 위 −/+ 줌 버튼과 카드의 ··· / Open take가 빠졌다 — 카드는 초안이 dirty이거나 재컷 상태(updating/failed)일
 * 때만 뜬다. take를 고르면 재생 위치도 그 시작으로 옮긴다(재생을 누르면 그 take가 들린다).
 * 2026-10-02: 재생 컨트롤 위에 전체 녹음 기준 프로그레스바가 생겼고 "⟲ PLAYHEAD" 필이 돌아왔다. 내비 오른쪽 ··· 가 선택
 * take의 이름 변경·삭제 시트를 연다(레인 롱프레스 진입점은 뺐다). Take Feedback의 "Edit take"는 `?take=`로 그 take를 열어 준다.
 * 2026-10-08: 헤더의 "Add take"가 플레이헤드 위치에 새 take 초안(NEW 필·핸들)을 만든다 — 카드의 "Add take"가 POST로 저장한다.
 * 내비의 범위 텍스트를 누르면 카드에 START/END 입력이 열려 드래그 대신 시간을 직접 칠 수 있다 (초안이 dirty가 아니면 Done으로 닫는다).
 */
export function TimelineScreen() {
  const { id, take: initialTakeId } = useLocalSearchParams<{ id: string; take?: string }>();
  const router = useRouter();
  const navigation = useNavigation();
  const api = useApi();
  const toast = useToast();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
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
  const [renameTake, setRenameTake] = useState<Take | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** 초안을 버릴지 묻는 중 — 확인하면 실행할 동작 */
  const [pendingDiscard, setPendingDiscard] = useState<(() => void) | null>(null);
  /** 카드의 범위 텍스트용 초안 미러. 초 단위라 초가 바뀔 때만 React로 넘긴다 (매 프레임 리렌더 방지) */
  const [draftRange, setDraftRange] = useState<Draft | null>(null);
  /** 새 take 초안이 살아 있다 — 선택 take는 없고 초안만 있다 (2026-10-08). 항상 dirty로 친다 */
  const [newTake, setNewTake] = useState(false);
  const [adding, setAdding] = useState(false);
  /** 선택 take의 START/END 입력을 열어 둔 상태 (내비 범위 텍스트 탭) */
  const [timeEdit, setTimeEdit] = useState(false);
  /** 입력 칸에 친 자리수. null이면 초안 값을 보여 준다 — 핸들을 끌면 비운다 */
  const [typedStart, setTypedStart] = useState<string | null>(null);
  const [typedEnd, setTypedEnd] = useState<string | null>(null);
  const [inputError, setInputError] = useState("");
  const clearTyped = useCallback(() => {
    setTypedStart(null);
    setTypedEnd(null);
    setInputError("");
  }, []);
  const dirty = newTake || draftState.dirty;

  // 파형 탭 → seek. onTap이 vp를 필요로 하고 vp가 onTap을 받으니 ref로 순환을 끊는다
  const vpRef = useRef<TimelineViewportState | null>(null);
  const onTap = useCallback(
    (x: number) => {
      const current = vpRef.current;
      if (!current) return;
      clock.seekTo(xToTime(current.snapshot(), x));
      // 탭도 팬 onBegin을 거쳐 follow가 꺼진다 — seek한 위치는 화면 안이니 다시 따라가게 한다
      current.follow.value = true;
    },
    [clock],
  );
  // 핸들을 놓으면 그 경계를 미리 들려준다 (스펙 B). 입력 칸에 치던 값은 버린다 — 초안이 진실이다
  const onHandleRelease = useCallback(
    (handle: Handle, d: Draft) => {
      clearTyped();
      clock.seekTo(previewSeekMs(d, handle));
    },
    [clock, clearTyped],
  );
  const editing = useMemo(
    () => ({ draft: draftState.draft, neighbors: draftState.neighbors, onHandleRelease }),
    [draftState.draft, draftState.neighbors, onHandleRelease],
  );
  const { vp, gesture, kick } = useTimelineViewport(durationMs, onTap, editing);
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
      setTimeEdit(false);
      clearTyped();
      clock.seekTo(t.startMs);
      vp.fitTo(t.startMs, t.endMs, FIT_PAD);
      // playhead가 take 시작(화면 20% 지점)에 있으니 재생 중이어도 그대로 따라간다
      vp.follow.value = true;
    },
    [vp, clock, clearTyped],
  );
  // 초안이 dirty면(새 take 초안 포함) 먼저 버릴지 묻는다
  const selectTake = useCallback(
    (t: Take) => {
      if (t.id === selectedTakeId && !newTake) return;
      if (dirty) setPendingDiscard(() => () => applySelect(t));
      else applySelect(t);
    },
    [selectedTakeId, newTake, dirty, applySelect],
  );

  /** 초안이 화면 밖이면 보이게 맞춘다 (디자인: 밖일 때만 fit) */
  const ensureVisible = useCallback(
    (d: Draft) => {
      const v = vp.snapshot();
      if (d.startMs < v.startMs || d.endMs > viewportEndMs(v)) vp.fitTo(d.startMs, d.endMs, FIT_PAD);
    },
    [vp],
  );

  // "Add take" — 플레이헤드 위치에 새 take 초안. 기존 take 안이거나 자리가 없으면 토스트로 알린다 (2026-10-08 디자인)
  const addTake = useCallback(() => {
    const r = newTakeAt(clock.positionMs, takeList, durationMs);
    if ("error" in r) {
      toast.show(r.error === "inside" ? `Move the playhead outside ${r.take.name} first` : "Not enough room here for a take");
      return;
    }
    const start = () => {
      if (clock.playing) clock.toggle();
      setSelectedTakeId(null);
      setTimeEdit(false);
      clearTyped();
      setNewTake(true);
      draftState.beginNew(r.draft, takeList);
      ensureVisible(r.draft);
    };
    if (dirty) setPendingDiscard(() => start);
    else start();
  }, [clock, takeList, durationMs, toast, dirty, clearTyped, draftState, ensureVisible]);

  const discardNew = useCallback(() => {
    setNewTake(false);
    draftState.clear();
    clearTyped();
  }, [draftState, clearTyped]);

  // 새 take를 저장한 뒤 목록이 다시 오면 그 take를 선택한다 — 목록이 오기 전에 선택하면 "지워진 take" 분기가 선택을 풀어 버린다
  const pendingSelectRef = useRef<string | null>(null);
  useEffect(() => {
    const id = pendingSelectRef.current;
    if (!id) return;
    const t = takeList.find((x) => x.id === id);
    if (!t) return;
    pendingSelectRef.current = null;
    applySelect(t);
  }, [takeList, applySelect]);

  // 화면은 첫 take에서 시작한다 (2026-09-20 디자인 개정). Take Feedback의 "Edit take"로 왔으면(?take=) 그 take에서.
  // 한 번만 — 이후 선택 해제(삭제·409)는 그대로 둔다
  const autoSelectedRef = useRef(false);
  useEffect(() => {
    if (autoSelectedRef.current || !session || takeList.length === 0) return;
    autoSelectedRef.current = true;
    applySelect(takeList.find((t) => t.id === initialTakeId) ?? takeList[0]!);
  }, [session, takeList, applySelect, initialTakeId]);

  // ‹ › 내비 — 선택이 없으면 ›는 첫 take, ‹는 마지막 take로 간다
  const navPos = selectedTakeId === null ? -1 : takeList.findIndex((t) => t.id === selectedTakeId);
  const prevTake = navPos < 0 ? takeList[takeList.length - 1] : takeList[navPos - 1];
  const nextTake = navPos < 0 ? takeList[0] : takeList[navPos + 1];

  const shownErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!clock.error || clock.error === shownErrorRef.current) return;
    shownErrorRef.current = clock.error;
    toast.show("Couldn’t play this recording — try again");
  }, [clock.error, toast]);

  const selectedTake = useMemo(() => takeList.find((t) => t.id === selectedTakeId) ?? null, [takeList, selectedTakeId]);
  /** 핸들·초안은 선택 take가 ready이고 피크가 다 로드된 뒤에만 산다 (디자인 노트 editOn). 새 take 초안은 항상 */
  const editOn = newTake || (selectedTake !== null && selectedTake.audioStatus === "ready" && !peaks.loading);

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

  // 저장하지 않은 초안(새 take 포함)을 두고 화면을 떠나려 하면 먼저 묻는다
  useEffect(() => {
    if (!dirty) return;
    const off = navigation.addListener("beforeRemove", (e) => {
      e.preventDefault();
      // 리스너를 먼저 떼야 한다 — reset()의 state 갱신은 dispatch보다 늦게 커밋되므로 그대로 두면 다시 막힌다
      setPendingDiscard(() => () => {
        off();
        navigation.dispatch(e.data.action);
      });
    });
    return off;
  }, [navigation, dirty]);

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

  // 카드의 "Add take" — 초안을 POST로 저장한다. 응답은 updating이라 폴링이 ready를 기다린다
  const addNew = useCallback(async () => {
    const d = draftState.current();
    if (!d || !session || adding) return;
    setAdding(true);
    try {
      const created = await api.takes.create(session.id, { startMs: d.startMs, endMs: d.endMs });
      toast.show(`${created.name} added`);
      pendingSelectRef.current = created.id;
      discardNew();
      reloadTakes();
    } catch (err) {
      if (err instanceof ApiError && err.code === "take_overlap") toast.show("Can’t overlap another take");
      else if (err instanceof ApiError && err.code === "take_range_invalid") toast.show("Invalid take range");
      else if (err instanceof ApiError && err.code === "session_not_ready") toast.show("Can’t add a take while this session is analyzing");
      else toast.show("Something went wrong");
    } finally {
      setAdding(false);
    }
  }, [api, draftState, session, adding, toast, discardNew, reloadTakes]);

  // START/END 입력 커밋 (blur·Enter). 안 건드린 칸은 초안의 정확한 ms를 쓴다. 통과하면 초안을 바꾸고 화면 밖이면 보이게 맞춘다
  const commitInputs = useCallback(() => {
    const d = draftState.current();
    if (!d || (typedStart === null && typedEnd === null)) return;
    const r = validateTimeInput(typedStart ?? { ms: d.startMs }, typedEnd ?? { ms: d.endMs }, { ...draftState.neighbors.value, durationMs });
    if ("error" in r) {
      setInputError(r.error);
      return;
    }
    clearTyped();
    draftState.set(r);
    ensureVisible(r);
  }, [draftState, typedStart, typedEnd, durationMs, clearTyped, ensureVisible]);

  const doDelete = () => {
    const t = confirmDelete;
    if (!t || deleting) return;
    setDeleting(true);
    void api.takes
      .remove(t.id)
      .then(() => {
        toast.show(`${t.name} deleted`);
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
  // 내비의 범위 텍스트 — 초안이 dirty면(새 take 포함) 초안 값, 아니면 저장된 값 (디자인 노트)
  const edited = dirty ? draftRange : null;
  const navRange = edited
    ? `${fmtClock(edited.startMs / 1000)} – ${fmtClock(edited.endMs / 1000)}`
    : selectedTake
      ? `${fmtClock(selectedTake.startMs / 1000)} – ${fmtClock(selectedTake.endMs / 1000)}`
      : "";
  // 내비 라벨 — 기본 이름이면 `TAKE n / N`, 이름을 붙였으면 `T n · 이름` (2026-10-02 디자인). 새 take 초안은 NEW TAKE
  const navLabel = newTake
    ? "NEW TAKE"
    : !selectedTake
      ? `${takeList.length} TAKES`
      : selectedTake.name === defaultTakeName(selectedTake.index)
        ? `TAKE ${selectedTake.index + 1} / ${takeList.length}`
        : `T${selectedTake.index + 1} · ${selectedTake.name.toUpperCase()}`;
  // 새 take 초안 중에는 ‹ ›가 초안 앞뒤의 take로 간다 (시간 순)
  const draftStart = draftRange?.startMs ?? 0;
  const navPrev = newTake ? [...takeList].reverse().find((t) => t.startMs < draftStart) : prevTake;
  const navNext = newTake ? takeList.find((t) => t.startMs > draftStart) : nextTake;
  // 범위 텍스트 탭 → START/END 입력. 편집할 수 있는 take(또는 새 초안)일 때만
  const canEditTime = newTake || (selectedTake !== null && selectedTake.audioStatus === "ready" && editOn);
  const cardOn = newTake || (selectedTake !== null && (draftState.dirty || selectedTake.audioStatus !== "ready" || timeEdit));
  const inputsOn = editOn && draftRange !== null;
  const addOn = !peaks.loading && !newTake;

  return (
    <Screen>
      <View style={{ paddingHorizontal: space.sheetX, flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 34 }}>
        <PressableOpacity onPress={() => router.back()} style={{ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", padding: 8 }}>
          <AppText style={{ fontSize: 18, lineHeight: 20, color: colors.textMuted }}>‹</AppText>
          <AppText variant="body" color={colors.textMuted}>
            Session
          </AppText>
        </PressableOpacity>
        {/* 플레이헤드 위치에 새 take (2026-10-08 디자인). 파형 로딩 중이거나 이미 초안이 있으면 숨긴다 */}
        {addOn ? <AddTakeButton onPress={addTake} /> : null}
      </View>
      <View style={{ paddingHorizontal: space.screenX, paddingTop: 2, paddingBottom: 4, gap: 5 }}>
        {/* DEBUG는 왼쪽에 — 오른쪽 위는 Expo dev client의 톱니 버튼이 덮는다 */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
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
        <GestureDetector gesture={gesture}>
          <View>
            <WaveformCanvas levels={peaks.levels} vp={vp} level={level} />
          </View>
        </GestureDetector>
        <Playhead vp={vp} kick={kick} playheadMs={clock.playheadMs} seekEpoch={clock.seekEpoch} />
        <TakeHandles vp={vp} kick={kick} draft={draftState.draft} draftEpoch={draftState.epoch} enabled={editOn} />
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
        <TakeLane takes={takeList} vp={vp} kick={kick} draft={draftState.draft} selectedTakeId={selectedTakeId} newTake={newTake} onSelect={selectTake} />
      </View>
      <View style={{ marginTop: 14, marginHorizontal: space.screenX }}>
        <OverviewStrip levels={peaks.levels} vp={vp} takes={takeList} durationMs={durationMs} playheadMs={clock.playheadMs} kick={kick} seekEpoch={clock.seekEpoch} />
      </View>
      {takeList.length > 0 || newTake ? (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 12, marginTop: 14, marginHorizontal: space.screenX }}>
          {/* 선택 take의 메뉴(이름 변경·삭제) — 내비 줄 오른쪽 끝 (2026-10-02 디자인). 새 take 초안에는 없다 */}
          {selectedTake && !newTake ? <TakeMoreButton onPress={() => setActionTake(selectedTake)} style={{ position: "absolute", right: 0 }} /> : null}
          <NavButton label="‹" enabled={navPrev !== undefined} onPress={() => navPrev && selectTake(navPrev)} />
          <View style={{ minWidth: 132, alignItems: "center", gap: 4 }}>
            <AppText numberOfLines={1} style={{ maxWidth: 170, fontFamily: font.mono, fontSize: 11, letterSpacing: 1.3, color: colors.textSecondary }}>
              {navLabel}
            </AppText>
            {/* 선택 take의 범위 — 초안이 dirty면 초안 값을 accent로 (2026-10-02). 누르면 START/END 입력이 열린다 (2026-10-08, 점선 밑줄 + 연필) */}
            {navRange ? (
              <PressableOpacity
                onPress={canEditTime ? () => setTimeEdit(true) : undefined}
                disabled={!canEditTime}
                hitSlop={6}
                style={{ flexDirection: "row", alignItems: "center", gap: 5, borderBottomWidth: canEditTime ? 1 : 0, borderStyle: "dashed", borderBottomColor: NAV_DISABLED, paddingBottom: 2 }}
              >
                <AppText style={{ fontFamily: font.mono, fontSize: 11, color: dirty ? colors.accent : colors.textMuted }}>{navRange}</AppText>
                {canEditTime ? (
                  <Svg width={10} height={10} viewBox="0 0 14 14" fill="none" stroke={colors.textFaint} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                    <Path d="M9.5 2.5l2 2L5 11l-2.5.5L3 9z" />
                  </Svg>
                ) : null}
              </PressableOpacity>
            ) : null}
          </View>
          <NavButton label="›" enabled={navNext !== undefined} onPress={() => navNext && selectTake(navNext)} />
        </View>
      ) : null}

      <View style={{ flex: 1 }} />

      {cardOn ? (
        <View style={{ marginHorizontal: space.screenX, marginVertical: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 16, gap: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <AppText variant="rowTitle" numberOfLines={1}>
                {newTake ? "New take" : selectedTake?.name}
              </AppText>
              {selectedTake?.audioStatus === "updating" ? <StatusLine text="Updating…" color={colors.accent} dot /> : null}
              {/* 경계는 이미 저장됐고 재컷만 실패한 상태다 (디자인 노트) */}
              {selectedTake?.audioStatus === "failed" ? <StatusLine text="Couldn’t update audio" color={colors.danger} dot={false} /> : null}
            </View>
            {newTake ? (
              <>
                <CardOutlineButton label="Cancel" onPress={discardNew} />
                <CardButton label={adding ? "Adding…" : "Add take"} onPress={adding ? undefined : () => void addNew()} wide />
              </>
            ) : draftState.dirty ? (
              <>
                <CardOutlineButton label="Cancel" onPress={() => setPendingDiscard(() => () => undefined)} />
                <CardButton label={saving ? "Saving…" : "Save"} onPress={saving ? undefined : () => { setTimeEdit(false); void save(); }} wide />
              </>
            ) : selectedTake?.audioStatus === "failed" ? (
              <CardButton label={saving ? "Saving…" : "Retry"} onPress={saving ? undefined : () => void save()} />
            ) : selectedTake?.audioStatus === "updating" ? (
              // 재컷 메시지가 유실되면 서버가 failed로 바꿔 주지 않아(재전달 3회 후 DLQ로 빠질 뿐) 사용자가 직접
              // 재요청할 수 있어야 한다 — 최종 리뷰 결정. save()는 초안이 없으면 저장된 값 그대로 같은-값 PATCH를 보낸다
              <CardOutlineButton label={saving ? "Saving…" : "Retry"} onPress={() => { if (!saving) void save(); }} />
            ) : (
              // 시간 입력만 열어 둔 상태 — 바뀐 게 없으니 닫기만
              <CardOutlineButton label="Done" onPress={() => { setTimeEdit(false); clearTyped(); }} />
            )}
          </View>
          {inputsOn && draftRange ? (
            <>
              <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
                <TimeField label="START" digits={typedStart} fallback={secToClockInput(draftRange.startMs / 1000)} error={inputError !== ""} onChange={(d) => { setTypedStart(d); setInputError(""); }} onCommit={commitInputs} />
                <AppText style={{ color: colors.textFaint, paddingBottom: 11 }}>–</AppText>
                <TimeField label="END" digits={typedEnd} fallback={secToClockInput(draftRange.endMs / 1000)} error={inputError !== ""} onChange={(d) => { setTypedEnd(d); setInputError(""); }} onCommit={commitInputs} />
              </View>
              {inputError ? <AppText style={{ fontSize: 12, color: colors.danger, marginTop: -4 }}>{inputError}</AppText> : null}
              <AppText style={{ fontSize: 12, color: colors.textFaint, marginTop: -4 }}>Or drag the handles to set start and end.</AppText>
            </>
          ) : null}
        </View>
      ) : null}

      {/* 디자인: 바가 컨트롤 블록 위로 10px 겹친다. 끄는 동안 playhead·파형이 손가락을 따라가고 소리는 150ms마다 */}
      <View style={{ marginHorizontal: space.screenX, marginBottom: -10 }}>
        <ProgressBar
          playheadMs={clock.playheadMs}
          scrubMs={clock.scrubMs}
          seekEpoch={clock.seekEpoch}
          durationMs={durationMs}
          onScrub={(ms) => {
            // 스크럽 중에도 파형이 playhead를 따라가게 — follow 규칙(30% 지점)으로 viewport가 옮겨진다
            vp.follow.value = true;
            clock.scrubTo(ms);
          }}
          onSeek={(ms) => {
            clock.seekTo(ms);
            vp.follow.value = true;
          }}
        />
      </View>
      {/* 디자인의 42px는 iOS 홈 인디케이터 포함 — 안드로이드 내비 바(edge-to-edge)가 더 높으면 그만큼 올린다 */}
      <View style={{ paddingTop: 14, paddingBottom: Math.max(42, insets.bottom + 8), paddingHorizontal: space.screenX, alignItems: "center", gap: 12 }}>
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
        onRename={(t) => {
          setActionTake(null);
          setRenameTake(t);
        }}
        onDelete={(t) => {
          setActionTake(null);
          setConfirmDelete(t);
        }}
      />
      <TakeRenameSheet take={renameTake} onClose={() => setRenameTake(null)} onSaved={reloadTakes} />
      <TakeDeleteDialog take={confirmDelete} busy={deleting} onConfirm={doDelete} onCancel={() => setConfirmDelete(null)} />
      {pendingDiscard ? (
        <ConfirmDialog
          visible
          title={newTake ? "Discard new take?" : "Discard changes?"}
          body={newTake ? "The new take won’t be added." : `Take ${(selectedTake?.index ?? 0) + 1} keeps its current start and end.`}
          primary={{
            label: "Discard changes",
            danger: true,
            onPress: () => {
              const go = pendingDiscard;
              setPendingDiscard(null);
              if (newTake) discardNew();
              else {
                draftState.reset();
                clearTyped();
              }
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
