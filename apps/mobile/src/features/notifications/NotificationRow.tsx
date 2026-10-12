import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { font, useTheme } from "@/theme";
import { AppText, PressableOpacity } from "@/ui";
import type { NotificationView } from "./notificationView";

/** 인박스 한 줄 (디자인 Notification sheet 항목). 문구는 kind별 i18n 키로 조립 */
export function NotificationRow({ view, onPress }: { view: NotificationView; onPress: () => void }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const actor = view.actorName ?? t("notifications.formerMember");
  const target = view.targetName ?? t("notifications.original");
  const title =
    view.kind === "session_ready_self" ? t("notifications.sessionReadySelf")
    : view.kind === "session_ready" ? t("notifications.sessionReady", { actor })
    : view.kind === "reply" ? t("notifications.replied", { actor, target })
    : t("notifications.commented", { actor, target });
  const body = view.kind.startsWith("session_ready") ? `${view.body} · ${view.takeCount === 1 ? t("notifications.takeFound") : t("notifications.takesFound", { n: view.takeCount })}` : view.body;
  return (
    <PressableOpacity onPress={onPress} style={{ flexDirection: "row", gap: 12, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: colors.border }}>
      <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors.borderStrong, alignItems: "center", justifyContent: "center" }}>
        <AppText style={{ fontFamily: font.mono, fontSize: 13, color: colors.textSecondary }}>{view.initial}</AppText>
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
          <AppText style={{ flex: 1, fontSize: 15, lineHeight: 20, color: view.unread ? colors.text : colors.textSecondary, fontWeight: view.unread ? "600" : "400" }}>{title}</AppText>
          <AppText style={{ fontFamily: font.mono, fontSize: 11, color: colors.textFaint }}>{view.when === "now" ? t("notifications.now") : view.when}</AppText>
        </View>
        <AppText style={{ fontSize: 14, lineHeight: 20, color: colors.textSecondary }}>{body}</AppText>
        <AppText style={{ fontFamily: font.mono, fontSize: 11, color: colors.textFaint }}>{view.meta}</AppText>
      </View>
      <View style={{ width: 8, paddingTop: 7 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent, opacity: view.unread ? 1 : 0 }} />
      </View>
    </PressableOpacity>
  );
}
