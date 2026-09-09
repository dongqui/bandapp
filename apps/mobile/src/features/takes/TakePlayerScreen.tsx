import type { CommentTarget, TakeComment } from "@bandapp/types";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, View } from "react-native";
import { useApi } from "@/api";
import { useAuth } from "@/features/auth/AuthProvider";
import { seedOf } from "@/lib/seed";
import { fmtClock, fmtDuration } from "@/lib/time";
import { space, useTheme } from "@/theme";
import { AppText, ConfirmDialog, MonoLabel, PlayerWaveform, PressableOpacity, Screen, useToast } from "@/ui";
import { CommentActionSheet } from "./CommentActionSheet";
import { CommentInput, type EditTarget, type ReplyTarget } from "./CommentInput";
import { CommentThread } from "./CommentThread";
import { groupThreads, type CommentThread as Thread } from "./threads";
import { useAudioUrl } from "./useAudioUrl";
import { useComments } from "./useComments";
import { usePlayback } from "./usePlayback";
import { useSession } from "./useSession";
import { useTakes } from "./useTakes";

/** 디자인의 페이징 단위 — 코멘트 4개, 답글 3개씩 더 보기 */
const COMMENT_PAGE = 4;
const REPLY_PAGE = 3;
/** −/＋ 버튼이 재생 위치를 옮기는 폭 */
const NUDGE_SEC = 1;

interface ReplyState extends ReplyTarget {
  parentId: string;
}

/** 삭제 확인 본문 인용 — 디자인은 60자에서 자른다 */
function quote(text: string): string {
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

export function TakePlayerScreen() {
  const { id, takeId } = useLocalSearchParams<{ id: string; takeId: string }>();
  const { data: session } = useSession(id);
  const { data: takes } = useTakes(id);
  const router = useRouter();
  const api = useApi();
  const toast = useToast();
  const { colors } = useTheme();
  const { state: authState } = useAuth();
  const meId = authState.status === "authenticated" ? authState.user.id : undefined;

  const isOriginal = takeId === "orig";
  const take = useMemo(() => {
    if (!session) return undefined;
    if (isOriginal) {
      return { id: "orig", name: "Original recording", durationSec: session.durationSec };
    }
    const t = (takes ?? []).find((x) => x.id === takeId);
    return t ? { id: t.id, name: t.name, durationSec: t.durationSec } : undefined;
  }, [session, takes, takeId, isOriginal]);

  // 원본 녹음도 같은 목록·입력을 쓴다 — 대상만 다르다 (2026-09-09 스펙 결정 4, 8)
  const target: CommentTarget | undefined = !session || !take ? undefined : isOriginal ? { sessionId: session.id } : { takeId: take.id };
  const { data: comments, reload } = useComments(target);
  const url = useAudioUrl(isOriginal ? "session" : "take", isOriginal ? session?.id : take?.id);
  const playback = usePlayback(take?.durationSec ?? 0, url);

  const threads = useMemo(() => groupThreads(comments ?? []), [comments]);
  const [shownThreads, setShownThreads] = useState(COMMENT_PAGE);
  // parentId → 보이는 답글 수. 없으면 접힌 상태. 답글을 보내면 전부 펼친다.
  const [shownReplies, setShownReplies] = useState<Record<string, number>>({});
  const [input, setInput] = useState("");
  const [replyTo, setReplyTo] = useState<ReplyState | null>(null);
  /** "···"로 연 코멘트 (시트) */
  const [actionTarget, setActionTarget] = useState<TakeComment | null>(null);
  /** 편집 중인 코멘트 — 입력창에 본문이 프리필된다 */
  const [editTarget, setEditTarget] = useState<TakeComment | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TakeComment | null>(null);
  const [deleting, setDeleting] = useState(false);

  const cancelEdit = () => {
    setEditTarget(null);
    setInput("");
  };
  // 편집을 시작하면 답글 모드는 끊는다 (디자인 caEdit)
  const startEdit = (c: TakeComment) => {
    setActionTarget(null);
    setReplyTo(null);
    setEditTarget(c);
    setInput(c.text);
  };
  const askDelete = (c: TakeComment) => {
    setActionTarget(null);
    setConfirmDelete(c);
  };
  const doDelete = () => {
    const c = confirmDelete;
    if (!c || deleting) return;
    setDeleting(true);
    void api.comments
      .remove(c.id)
      .then(() => {
        toast.show(c.parentId ? "Reply deleted" : "Comment deleted");
        if (editTarget?.id === c.id) cancelEdit();
        reload();
      })
      .catch(() => toast.show("Something went wrong"))
      .finally(() => {
        setDeleting(false);
        setConfirmDelete(null);
      });
  };
  const editing: EditTarget | null = editTarget ? { isReply: editTarget.parentId !== null, onCancel: cancelEdit } : null;

  const cancelReply = () => {
    setReplyTo(null);
    setInput("");
  };
  const startReply = (thread: Thread, target: TakeComment) => {
    const parent = thread.comment;
    // 답글에 답하면 같은 스레드에 붙고 `@이름 `을 미리 채운다 — 부모 작성자 본인이면 생략 (스레드 스펙 결정 1)
    const mention = target.id !== parent.id && target.authorName !== parent.authorName;
    setEditTarget(null);
    setReplyTo({ parentId: parent.id, name: target.authorName, onCancel: cancelReply });
    setInput(mention ? `@${target.authorName} ` : "");
  };
  const showMoreReplies = (parentId: string) =>
    setShownReplies((s) => ({ ...s, [parentId]: (s[parentId] ?? 0) + REPLY_PAGE }));

  // 재생 실패는 소리가 안 나는 것 말고는 티가 안 난다 — 같은 에러로 토스트가 반복되지 않게
  // 마지막으로 보여준 값을 기억한다.
  const shownErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!playback.error || playback.error === shownErrorRef.current) return;
    shownErrorRef.current = playback.error;
    toast.show("Couldn’t play this audio");
  }, [playback.error, toast]);

  if (!session || !take) return <Screen>{null}</Screen>;
  const sub = `${session.title} · ${isOriginal ? fmtDuration(take.durationSec) : fmtClock(take.durationSec)}`;
  const hiddenThreads = Math.max(0, threads.length - shownThreads);

  const send = () => {
    const text = input.trim();
    if (!text || !target) return;
    if (editTarget) {
      const id = editTarget.id;
      setInput("");
      setEditTarget(null);
      void api.comments
        .update(id, { text })
        .then(() => reload())
        .catch(() => toast.show("Something went wrong"));
      return;
    }
    const parentId = replyTo?.parentId;
    setInput("");
    setReplyTo(null);
    // 새 코멘트가 화면 밖 페이지로 밀리지 않게 표시 범위를 넓혀 둔다
    if (parentId) setShownReplies((s) => ({ ...s, [parentId]: Number.POSITIVE_INFINITY }));
    else setShownThreads((n) => n + 1);
    const create = parentId
      ? api.comments.create(target, { parentId, text })
      : // 재생 위치가 실제 길이를 넘길 수 있다(디코딩된 길이가 메타데이터보다 길 때) — 타임라인 밖 코멘트를 막는다
        api.comments.create(target, { atSec: Math.min(playback.positionSec, take.durationSec), text });
    void create.then(() => reload()).catch(() => toast.show("Something went wrong"));
  };

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
            seed={seedOf(isOriginal ? `${session.id}-orig` : take.id)}
            durationSec={take.durationSec}
            positionSec={playback.positionSec}
            markers={threads.map((t) => t.comment.atSec)}
            onSeek={(sec) => playback.seekTo(sec)}
          />
          {/* 피드백 시점 미세 조정 — 1초씩 앞뒤로. 재생 상태는 건드리지 않는다 */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <PressableOpacity
              onPress={() => playback.seekTo(playback.positionSec - NUDGE_SEC)}
              hitSlop={6}
              style={{ paddingVertical: 8, paddingHorizontal: 14 }}
            >
              <AppText style={{ fontSize: 16, lineHeight: 18, color: colors.textMuted }}>−</AppText>
            </PressableOpacity>
            <AppText variant="monoMeta">
              <AppText variant="monoMeta" color={colors.text}>
                {fmtClock(playback.positionSec)}
              </AppText>
              {` / ${fmtClock(take.durationSec)}`}
            </AppText>
            <PressableOpacity
              onPress={() => playback.seekTo(playback.positionSec + NUDGE_SEC)}
              hitSlop={6}
              style={{ paddingVertical: 8, paddingHorizontal: 14 }}
            >
              <AppText style={{ fontSize: 16, lineHeight: 18, color: colors.textMuted }}>＋</AppText>
            </PressableOpacity>
          </View>
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
          data={threads.slice(0, shownThreads)}
          keyExtractor={(t) => t.comment.id}
          style={{ flex: 1 }}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: space.screenX, paddingTop: 10, paddingBottom: 16 }}
          ListHeaderComponent={<MonoLabel style={{ paddingTop: 8, paddingBottom: 2 }}>FEEDBACK</MonoLabel>}
          ListEmptyComponent={
            <AppText variant="caption" color={colors.textFaint} style={{ paddingVertical: 18 }}>
              No feedback yet. Say something at the right moment — it lands on the timeline.
            </AppText>
          }
          ListFooterComponent={
            hiddenThreads > 0 ? (
              <PressableOpacity
                onPress={() => setShownThreads((n) => n + COMMENT_PAGE)}
                style={{ alignItems: "center", paddingTop: 14, paddingBottom: 6 }}
              >
                <AppText variant="caption">{`View more comments (${hiddenThreads})`}</AppText>
              </PressableOpacity>
            ) : null
          }
          renderItem={({ item }) => (
            <CommentThread
              thread={item}
              shownReplies={shownReplies[item.comment.id] ?? 0}
              meId={meId}
              onSeek={() => playback.seekTo(Math.max(0, item.comment.atSec - 5), true)}
              onReply={(target) => startReply(item, target)}
              onActions={setActionTarget}
              onMoreReplies={() => showMoreReplies(item.comment.id)}
            />
          )}
        />
        <CommentInput
          value={input}
          onChangeText={setInput}
          replyingTo={replyTo}
          editing={editing}
          placeholder={replyTo ? "Add a reply…" : `Leave feedback at ${fmtClock(playback.positionSec)}…`}
          onSubmit={send}
        />
      </KeyboardAvoidingView>
      <CommentActionSheet comment={actionTarget} onClose={() => setActionTarget(null)} onEdit={startEdit} onDelete={askDelete} />
      <ConfirmDialog
        visible={confirmDelete !== null}
        title={confirmDelete?.parentId ? "Delete reply?" : "Delete comment?"}
        body={`“${quote(confirmDelete?.text ?? "")}” will be removed for everyone in the band.`}
        primary={{ label: confirmDelete?.parentId ? "Delete reply" : "Delete comment", danger: true, onPress: doDelete }}
        cancelLabel="Cancel"
        onCancel={() => (deleting ? undefined : setConfirmDelete(null))}
        busy={deleting}
      />
    </Screen>
  );
}
