import type { NotificationSettings, UpdateNotificationSettingsInput } from "@bandapp/types";
import { DEFAULT_NOTIFICATION_SETTINGS } from "@bandapp/types";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, View } from "react-native";
import { useApi } from "@/api";
import { useCurrentBand } from "@/features/band/useCurrentBand";
import { push } from "@/services/push";
import { font, radius, space, useTheme } from "@/theme";
import { AppText, Avatar, BottomSheet, MonoLabel, PressableOpacity, Screen, SheetActionRow, Toggle, useToast } from "@/ui";
import { useNotifications } from "./NotificationsProvider";
import { settingsSummary } from "./settingsView";
import { useNotificationSettings } from "./useNotificationSettings";

/** 디자인 "Notifications" 설정 화면 (2026-10-12). 밴드별 설정, OS 권한 카드 3종, 토글 즉시 저장 */
export function NotificationSettingsScreen() {
  const { from } = useLocalSearchParams<{ from?: string }>();
  const router = useRouter();
  const api = useApi();
  const toast = useToast();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { band, bands } = useCurrentBand();
  const { permission, requestPermission, setSheetOpen } = useNotifications();
  const { data: all, reload } = useNotificationSettings();
  const [bandId, setBandId] = useState<string | null>(null);
  const [bandsSheet, setBandsSheet] = useState(false);
  /** 낙관적 반영 오버레이 — 저장이 진행 중인 동안만 서버 값 위에 얹는다 (밴드별) */
  const [local, setLocal] = useState<Record<string, UpdateNotificationSettingsInput>>({});
  /** 밴드별 진행 중인 PUT 개수. 0이 되고 성공했을 때만 오버레이를 걷어 서버 값이 다시 이기게 한다 */
  const inFlight = useRef<Record<string, number>>({});
  /** 마지막 PUT이 성공한 밴드 — reload 결과(all)가 도착하면 오버레이를 제거한다 (깜빡임 방지) */
  const settled = useRef<Set<string>>(new Set());
  const loaded = all !== undefined;

  useEffect(() => {
    if (!bandId && band) setBandId(band.id);
  }, [band, bandId]);

  useEffect(() => {
    const ids = [...settled.current].filter((id) => !inFlight.current[id]);
    if (!ids.length) return;
    ids.forEach((id) => settled.current.delete(id));
    setLocal((l) => {
      const n = { ...l };
      ids.forEach((id) => delete n[id]);
      return n;
    });
  }, [all]);

  const settingsOf = (id: string): UpdateNotificationSettingsInput => local[id] ?? stripBand(all?.find((s) => s.bandId === id)) ?? DEFAULT_NOTIFICATION_SETTINGS;
  const current = bandId ? settingsOf(bandId) : DEFAULT_NOTIFICATION_SETTINGS;
  const currentBand = bands.find((b) => b.id === bandId) ?? band;

  const save = async (patch: Partial<UpdateNotificationSettingsInput>) => {
    if (!bandId || !loaded) return; // 불러오기 전에 PUT하면 기본값이 서버 값을 덮어쓴다
    const next = { ...settingsOf(bandId), ...patch }; // PUT은 세 필드 모두 — scope는 바뀌지 않아도 같이 보낸다
    setLocal((l) => ({ ...l, [bandId]: next }));
    inFlight.current[bandId] = (inFlight.current[bandId] ?? 0) + 1;
    let failed = false;
    try {
      await api.notifications.updateSettings(bandId, next);
    } catch {
      failed = true;
    }
    const left = --inFlight.current[bandId];
    if (failed) {
      // 실패하면 오버레이를 버리고 서버 값을 다시 읽는다
      setLocal((l) => {
        const n = { ...l };
        delete n[bandId];
        return n;
      });
      reload();
      toast.show(t("notificationSettings.saveFailed"));
    } else if (left === 0) {
      settled.current.add(bandId);
      reload();
    }
  };

  const back = () => {
    router.back();
    if (from === "sheet") setSheetOpen(true);
  };
  const ok = permission === "allowed";

  return (
    <Screen>
      <View style={{ paddingHorizontal: 16 }}>
        <PressableOpacity onPress={back} style={{ flexDirection: "row", alignItems: "center", gap: 6, padding: 8, alignSelf: "flex-start" }}>
          <AppText style={{ fontSize: 18, lineHeight: 18, color: colors.textMuted }}>‹</AppText>
          <AppText style={{ fontSize: 14, color: colors.textMuted }}>{t(from === "sheet" ? "notificationSettings.back" : "notificationSettings.backMe")}</AppText>
        </PressableOpacity>
      </View>
      <View style={{ paddingHorizontal: space.screenX, paddingTop: 6, paddingBottom: 18, gap: 6 }}>
        <AppText variant="title">{t("notificationSettings.title")}</AppText>
        <AppText variant="body" style={{ color: colors.textMuted }}>{t("notificationSettings.subtitle")}</AppText>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.screenX, paddingBottom: 60 }}>
        {permission === "ask" ? (
          <Card title={t("notificationSettings.offTitle")} body={t("notificationSettings.offBody")} cta={t("notificationSettings.turnOn")} primary onPress={() => void requestPermission()} />
        ) : permission === "denied" ? (
          <Card title={t("notificationSettings.deniedTitle")} body={t("notificationSettings.deniedBody")} cta={t("notificationSettings.openSettings")} onPress={() => push.openSystemSettings()} />
        ) : permission === "unavailable" ? (
          <Card title={t("notificationSettings.unavailableTitle")} body={t("notificationSettings.unavailableBody")} />
        ) : null}

        <View style={{ opacity: ok ? 1 : 0.35 }} pointerEvents={ok ? "auto" : "none"}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingBottom: 22 }}>
            <PressableOpacity onPress={() => setBandsSheet(true)} accessibilityRole="button" accessibilityLabel={currentBand?.name} style={{ flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 16, paddingVertical: 7, paddingHorizontal: 12 }}>
              <AppText style={{ fontFamily: font.mono, fontSize: 11, letterSpacing: 1.8, color: colors.textSecondary }}>{currentBand?.name.toUpperCase()}</AppText>
              <AppText accessibilityElementsHidden importantForAccessibility="no" style={{ fontSize: 8, color: colors.textFaint }}>▼</AppText>
            </PressableOpacity>
            <AppText variant="caption">{t("notificationSettings.forThisBand")}</AppText>
          </View>
          <MonoLabel style={{ paddingBottom: 4, letterSpacing: 1.6 }}>{t("notificationSettings.notifyWhen")}</MonoLabel>
          <Row title={t("notificationSettings.sessionReady")} hint={t("notificationSettings.sessionReadyHint")} value={current.sessionReady} disabled={!loaded} onChange={(v) => void save({ sessionReady: v })} />
          <Row title={t("notificationSettings.comments")} hint={t("notificationSettings.commentsHint")} value={current.comments} disabled={!loaded} onChange={(v) => void save({ comments: v })} />
          {current.comments ? (
            <View style={{ paddingLeft: 14, paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: colors.border }}>
              {(["all", "mine"] as const).map((scope) => (
                <PressableOpacity key={scope} onPress={() => void save({ commentScope: scope })} disabled={!loaded} accessibilityRole="radio" accessibilityState={{ selected: current.commentScope === scope, disabled: !loaded }} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingVertical: 12 }}>
                  <AppText style={{ fontSize: 14, color: current.commentScope === scope ? colors.text : colors.textMuted }}>{t(scope === "all" ? "notificationSettings.scopeAll" : "notificationSettings.scopeMine")}</AppText>
                  <AppText accessibilityElementsHidden importantForAccessibility="no" style={{ fontSize: 15, color: colors.accent, opacity: current.commentScope === scope ? 1 : 0 }}>✓</AppText>
                </PressableOpacity>
              ))}
            </View>
          ) : null}
        </View>
      </ScrollView>

      <BottomSheet visible={bandsSheet} onClose={() => setBandsSheet(false)} title={t("notificationSettings.bandsSheet")}>
        {bands.map((b) => (
          <SheetActionRow
            key={b.id}
            icon={<Avatar label={b.name[0] ?? "?"} size={40} />}
            title={b.name}
            subtitle={t(`notificationSettings.summary.${settingsSummary(settingsOf(b.id))}`)}
            onPress={() => { setBandId(b.id); setBandsSheet(false); }}
            trailing={b.id === bandId ? <AppText style={{ fontSize: 16, color: colors.accent }}>✓</AppText> : undefined}
          />
        ))}
      </BottomSheet>
    </Screen>
  );
}

function stripBand(s: NotificationSettings | undefined): UpdateNotificationSettingsInput | undefined {
  return s ? { sessionReady: s.sessionReady, comments: s.comments, commentScope: s.commentScope } : undefined;
}

function Row({ title, hint, value, disabled, onChange }: { title: string; hint: string; value: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 16, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: colors.border }}>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <AppText style={{ fontSize: 15, color: colors.text }}>{title}</AppText>
        <AppText style={{ fontSize: 13, lineHeight: 19, color: colors.textMuted }}>{hint}</AppText>
      </View>
      <Toggle value={value} onChange={onChange} disabled={disabled} label={title} />
    </View>
  );
}

function Card({ title, body, cta, primary = false, onPress }: { title: string; body: string; cta?: string; primary?: boolean; onPress?: () => void }) {
  const { colors } = useTheme();
  return (
    <View style={{ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 14, padding: 18, gap: 12, marginBottom: 22 }}>
      <AppText style={{ fontSize: 16, fontWeight: "600", color: colors.text }}>{title}</AppText>
      <AppText style={{ fontSize: 14, lineHeight: 21, color: colors.textSecondary }}>{body}</AppText>
      {cta && onPress ? (
        <PressableOpacity onPress={onPress} style={{ borderRadius: radius.input, padding: 13, alignItems: "center", backgroundColor: primary ? colors.accent : "transparent", borderWidth: primary ? 0 : 1, borderColor: colors.borderStronger }}>
          <AppText style={{ fontSize: 14, fontWeight: "600", color: primary ? "#0B0C0E" : colors.text }}>{cta}</AppText>
        </PressableOpacity>
      ) : null}
    </View>
  );
}
