import type { NotificationItem } from "@bandapp/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal, Pressable, ScrollView, View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { useApi } from "@/api";
import { useAuth } from "@/features/auth/AuthProvider";
import { useCurrentBand } from "@/features/band/useCurrentBand";
import { font, radius, useTheme } from "@/theme";
import { AppText, MonoLabel, PressableOpacity } from "@/ui";
import { NotificationRow } from "./NotificationRow";
import { useNotifications } from "./NotificationsProvider";
import { groupByDay, notificationView } from "./notificationView";

const SHEET_HEIGHT = 640;

/** 디자인 "Notification sheet" (2026-10-12): 현재 밴드 인박스, TODAY/EARLIER, 6개씩 더 보기 */
export function NotificationSheet({ visible, onClose, onOpenSettings }: { visible: boolean; onClose: () => void; onOpenSettings: () => void }) {
  const api = useApi();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { band } = useCurrentBand();
  const { state } = useAuth();
  const meId = state.status === "authenticated" ? state.user.id : "";
  const { open, refresh } = useNotifications();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [unread, setUnread] = useState(0);
  const [loaded, setLoaded] = useState(false);
  // 세대 번호: 시트가 닫히거나 밴드가 바뀌거나 언마운트되면 올려서, 늦게 도착한 응답이 상태를 덮어쓰지 못하게 한다
  const generation = useRef(0);
  const loadingMore = useRef(false);
  const markingAll = useRef(false);
  // band 객체는 API 변경 통지마다 새 참조가 되므로, 효과 의존성에는 id만 쓴다 (헤더 이름만 band에서 읽음)
  const bandId = band?.id ?? "";

  const load = useCallback(
    async (next?: string) => {
      if (!bandId) return;
      const mine = generation.current;
      const page = await api.notifications.list(bandId, next);
      if (mine !== generation.current) return;
      setItems((prev) => (next ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setRemaining(page.remaining);
      setUnread(page.unreadCount);
      setLoaded(true);
    },
    [api, bandId],
  );

  // 열릴 때마다 첫 페이지부터 다시 읽는다. 이전 밴드의 항목이 잠깐 비치지 않도록 먼저 비운다
  useEffect(() => {
    if (!visible) return;
    setLoaded(false);
    setItems([]);
    setCursor(null);
    load().catch((e) => console.warn("notifications load failed", e));
    return () => {
      generation.current += 1;
    };
  }, [visible, load]);

  const loadMore = (next: string) => {
    if (loadingMore.current) return;
    loadingMore.current = true;
    load(next)
      .catch((e) => console.warn("notifications load more failed", e))
      .finally(() => {
        loadingMore.current = false;
      });
  };

  // items가 바뀔 때(열기·더 보기)만 기준 시각을 갱신한다 — when 라벨과 TODAY/EARLIER 판정이 같은 now를 쓴다
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => new Date(), [items]);
  const groups = useMemo(() => groupByDay(items.map((i) => notificationView(i, meId, now)), now), [items, meId, now]);

  const markAllRead = async () => {
    if (markingAll.current) return;
    markingAll.current = true;
    const mine = generation.current;
    try {
      await api.notifications.markAllRead(bandId);
      // 그 사이 시트가 닫히거나 밴드가 바뀌었으면 로컬 목록은 건드리지 않는다 (다음 열기에서 다시 읽음)
      if (mine === generation.current) {
        const at = new Date().toISOString();
        setItems((prev) => prev.map((i) => (i.readAt ? i : { ...i, readAt: at })));
        setUnread(0);
      }
      refresh();
    } finally {
      markingAll.current = false;
    }
  };

  return (
    <Modal transparent visible={visible} animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)" }} onPress={onClose} />
      <View style={{ height: SHEET_HEIGHT, backgroundColor: colors.surface, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet }}>
        <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: colors.borderStronger, alignSelf: "center", marginTop: 10 }} />
        <View style={{ paddingHorizontal: 20, paddingTop: 14, paddingBottom: 8, flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <View style={{ gap: 4 }}>
            <AppText style={{ fontSize: 20, fontWeight: "700", color: colors.text }}>{t("notifications.title")}</AppText>
            <AppText style={{ fontFamily: font.mono, fontSize: 11, letterSpacing: 1.8, color: colors.textMuted }}>{band?.name.toUpperCase()}</AppText>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
            {unread > 0 ? (
              <PressableOpacity onPress={() => void markAllRead().catch((e) => console.warn("mark all read failed", e))}>
                <AppText style={{ fontSize: 14, color: colors.accent }}>{t("notifications.markAllRead")}</AppText>
              </PressableOpacity>
            ) : null}
            <PressableOpacity onPress={onOpenSettings} accessibilityLabel={t("notifications.settings")} style={{ width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: colors.borderStronger, alignItems: "center", justifyContent: "center" }}>
              <Svg width={16} height={16} viewBox="0 0 16 16" fill="none">
                <Path d="M2.5 4.5h11M2.5 11.5h11" stroke={colors.textSecondary} strokeWidth={1.4} strokeLinecap="round" />
                <Circle cx={10.5} cy={4.5} r={1.8} stroke={colors.textSecondary} strokeWidth={1.4} fill={colors.surface} />
                <Circle cx={5.5} cy={11.5} r={1.8} stroke={colors.textSecondary} strokeWidth={1.4} fill={colors.surface} />
              </Svg>
            </PressableOpacity>
          </View>
        </View>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }}>
          {loaded && items.length === 0 ? (
            <View style={{ paddingVertical: 80, paddingHorizontal: 20, alignItems: "center", gap: 8 }}>
              <AppText style={{ fontSize: 16, fontWeight: "600", color: colors.text }}>{t("notifications.emptyTitle")}</AppText>
              <AppText style={{ fontSize: 14, lineHeight: 21, color: colors.textMuted, textAlign: "center" }}>{t("notifications.emptyBody", { band: band?.name ?? "" })}</AppText>
            </View>
          ) : null}
          {groups.map((g) => (
            <View key={g.label}>
              <MonoLabel style={{ paddingTop: 18, paddingBottom: 4, letterSpacing: 1.6 }}>{t(g.label === "today" ? "notifications.today" : "notifications.earlier")}</MonoLabel>
              {g.items.map((v) => (
                <NotificationRow key={v.id} view={v} onPress={() => void open({ ...v.target, bandId })} />
              ))}
            </View>
          ))}
          {cursor ? (
            <PressableOpacity onPress={() => loadMore(cursor)} style={{ marginTop: 16, borderWidth: 1, borderColor: colors.borderStronger, borderRadius: radius.input, padding: 12, alignItems: "center" }}>
              <AppText style={{ fontSize: 14, color: colors.textSecondary }}>{t("notifications.showOlder", { n: remaining })}</AppText>
            </PressableOpacity>
          ) : loaded && items.length > 6 ? (
            <AppText style={{ paddingTop: 18, textAlign: "center", fontSize: 13, color: colors.textFaint }}>{t("notifications.last30")}</AppText>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}
