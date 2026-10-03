import type { Session } from "@bandapp/types";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { useApi } from "@/api";
import { apiErrorMessage } from "@/i18n/apiErrorMessage";
import { purchases } from "@/services/purchases";
import { useTheme } from "@/theme";
import { AppText, BottomSheet, PressableOpacity, useToast } from "@/ui";
import { ctxToParams, type BillingCtx } from "./billingContext";
import { fmtH, monthDay, noTimeActions, type NoTimeAction } from "./billingView";
import { primaryBtn, outline } from "./PlanScreen";
import { useBandBilling } from "./useBandBilling";

// B03 — 분석 시간이 모자랄 때 뜨는 시트. session이 null이면 닫힌다.
export function NoTimeSheet({ session: sessionProp, bandName, onClose }: { session: Session | null; bandName: string; onClose: () => void }) {
  // 닫히는 애니메이션 동안 내용이 비지 않도록 마지막 세션을 기억한다.
  const last = useRef<Session | null>(null);
  if (sessionProp) last.current = sessionProp;
  const session = sessionProp ?? last.current;
  const { data: b } = useBandBilling(session?.bandId);
  const [extraPrice, setExtraPrice] = useState("");
  useEffect(() => { purchases.prices().then((p) => setExtraPrice(p.find((x) => x.key === "extra")?.priceString ?? "")).catch(() => {}); }, []);
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();
  const api = useApi();
  const toast = useToast();

  // 닫기(바깥 탭/뒤로)는 "Not now"와 같다 — 저장됐다는 토스트를 보여준다.
  const notNow = () => { onClose(); toast.show(t("billing.b03.savedToast")); };

  const body = (() => {
    if (!session || !b) return null;
    const need = Math.max(0, session.durationSec - b.availableSec);
    const ctx: BillingCtx = { from: "analysis", sessionId: session.id, title: session.name ?? session.title, durationSec: session.durationSec };
    const go = (path: string, extra: Record<string, string> = {}) => { onClose(); router.push({ pathname: path, params: { bandId: session.bandId, ...ctxToParams(ctx), ...extra } }); };
    const addToPlan = async () => {
      try {
        await api.bands.linkPool(session.bandId);
        await api.sessions.retryAnalysis(session.id);
        onClose();
      } catch (err) {
        toast.show(apiErrorMessage(err, t));
      }
    };
    const onAction = (a: NoTimeAction) => {
      switch (a) {
        case "viewPlans": return go("/billing/plans", { sel: "band" });
        case "resubscribe": return go("/billing/plans", { sel: b.plan ?? "band" });
        case "viewPlus": return go("/billing/plans", { sel: "plus" });
        case "buyExtra": return go("/billing/extra");
        case "addToPlan": return void addToPlan();
        case "notNow": return notNow();
      }
    };
    const label = (a: NoTimeAction) => ({
      viewPlans: t("billing.b03.viewPlans"), resubscribe: t("billing.b03.resubscribe"), viewPlus: t("billing.b03.viewPlus"),
      buyExtra: t("billing.b03.buyExtra", { price: extraPrice }), addToPlan: t("billing.b03.addToPlan", { time: fmtH(b.myPool?.monthlyLeftSec ?? 0) }), notNow: t("billing.b03.notNow"),
    })[a];
    const actions = noTimeActions(b, need);
    const onPlan = b.state === "linked";

    return (
      <>
        <View style={{ gap: 4 }}>
          <AppText variant="body">{t("billing.b03.session", { session: ctx.title, time: fmtH(session.durationSec) })}</AppText>
          <AppText variant="caption">{t("billing.b03.avail", { time: fmtH(b.availableSec), band: bandName })}</AppText>
          <AppText variant="caption">{onPlan ? t("billing.b03.resetMonthly", { date: monthDay(b.periodEnd) }) : t("billing.b03.resetFree")}</AppText>
          {!b.isOwner ? <AppText variant="caption">{onPlan ? t("billing.b03.hintOnlyOwner", { owner: b.owner.displayName }) : t("billing.b03.hintAsk", { owner: b.owner.displayName, band: bandName })}</AppText> : null}
        </View>
        {onPlan && need > 3 * 3600 ? <AppText variant="caption" color={colors.danger} style={{ paddingTop: 8 }}>{t("billing.b03.short", { time: fmtH(need - 3 * 3600) })}</AppText> : null}
        <View style={{ gap: 10, paddingTop: 16 }}>
          {actions.map((a, i) => (
            <PressableOpacity key={a} onPress={() => onAction(a)} style={a === "notNow" ? { padding: 12, alignItems: "center" } : i === 0 ? primaryBtn(colors) : outline(colors)}>
              <AppText style={{ fontSize: 15, color: a === "notNow" ? colors.textMuted : i === 0 ? colors.bg : colors.text, fontWeight: i === 0 && a !== "notNow" ? "600" : "400" }}>{label(a)}</AppText>
            </PressableOpacity>
          ))}
        </View>
        <AppText variant="small" style={{ paddingTop: 14, textAlign: "center" }}>{t("billing.b03.footer")}</AppText>
      </>
    );
  })();

  const need = session && b ? Math.max(0, session.durationSec - b.availableSec) : 0;
  return (
    <BottomSheet visible={sessionProp !== null && !!b} onClose={notNow} title={t("billing.b03.title", { time: fmtH(need) })}>
      {body}
    </BottomSheet>
  );
}
