import type { BandBilling } from "@bandapp/types";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, View } from "react-native";
import { useApi } from "@/api";
import { useCurrentBand } from "@/features/band/useCurrentBand";
import { apiErrorMessage } from "@/i18n/apiErrorMessage";
import { purchases, type StorePrice } from "@/services/purchases";
import { radius, space, useTheme } from "@/theme";
import { AppText, MonoLabel, PressableOpacity, Screen, useToast } from "@/ui";
import { BillingHeader } from "./BillingHeader";
import { ctxToParams, paramsToCtx } from "./billingContext";
import { fmtH, monthDay } from "./billingView";
import { KeyValueRows } from "./KeyValueRows";
import { UsageBar } from "./UsageBar";
import { useBandBilling } from "./useBandBilling";

export function PlanScreen() {
  const params = useLocalSearchParams<Record<string, string>>();
  const bandId = params.bandId;
  const ctx = paramsToCtx(params);
  const { bands } = useCurrentBand();
  const band = bands.find((b) => b.id === bandId) ?? null;
  const { data: b, failed, reload } = useBandBilling(bandId);
  const [prices, setPrices] = useState<StorePrice[]>([]);
  useEffect(() => { purchases.prices().then(setPrices).catch(() => setPrices([])); }, []);
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();
  const api = useApi();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const go = (path: string, extra: Record<string, string> = {}) => router.push({ pathname: path, params: { bandId, ...ctxToParams(ctx), ...extra } });
  const price = (plan: "band" | "plus" | null) => prices.find((p) => p.key === plan)?.priceString ?? "";
  const planName = (p: "band" | "plus" | null) => (p ? t(`billing.planName.${p}`) : t("billing.planName.free"));

  const addThisBand = async () => {
    if (!bandId || busy) return;
    setBusy(true);
    try {
      await api.bands.linkPool(bandId);
      toast.show(t("billing.b01a.addedToast", { band: band?.name ?? "" }));
    } catch (err) {
      toast.show(apiErrorMessage(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <BillingHeader back={t("billing.b01.back")} onBack={() => router.back()} />
      <View style={{ paddingHorizontal: space.screenX, gap: 6, paddingBottom: 14 }}>
        <AppText variant="title">{t("billing.b01.title")}</AppText>
        <MonoLabel>{t("billing.b01.membersMeta", { band: band?.name ?? "", n: band?.memberCount ?? 0 })}</MonoLabel>
      </View>
      {!b && !failed ? (
        <AppText variant="caption" style={{ paddingHorizontal: space.screenX }}>{t("billing.b01.loading")}</AppText>
      ) : failed || !b ? (
        <View style={{ paddingHorizontal: space.screenX, gap: 10 }}>
          <AppText variant="sheetTitle">{t("billing.b01.failTitle")}</AppText>
          <AppText variant="body">{t("billing.b01.failBody")}</AppText>
          <PressableOpacity onPress={reload} style={outline(colors)}><AppText>{t("billing.b01.retry")}</AppText></PressableOpacity>
        </View>
      ) : (
        <PlanBody b={b} bandName={band?.name ?? ""} price={price} planName={planName} go={go} addThisBand={addThisBand} />
      )}
    </Screen>
  );
}

function PlanBody({ b, bandName, price, planName, go, addThisBand }: {
  b: BandBilling; bandName: string; price: (p: "band" | "plus" | null) => string; planName: (p: "band" | "plus" | null) => string;
  go: (path: string, extra?: Record<string, string>) => void; addThisBand: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const onPlan = b.state === "linked";
  const owner = b.isOwner;
  const ownerName = b.owner.displayName;
  const date = monthDay(b.periodEnd);
  const meta = onPlan
    ? owner
      ? b.willRenew ? t("billing.b01.metaRenews", { price: price(b.plan), date }) : t("billing.b01.metaCanceled", { date })
      : t("billing.b01.metaOwnersPlan", { owner: ownerName })
    : b.state === "expired" ? t("billing.b01.metaEnded", { plan: planName(b.plan), date }) : t("billing.b01.metaFree");
  const availSub = onPlan
    ? b.extraSec ? t("billing.b01.subMonthlyExtra", { time: fmtH(b.monthlyLeftSec), extra: fmtH(b.extraSec) }) : t("billing.b01.subMonthly")
    : b.extraSec ? t("billing.b01.subFreeExtra", { time: fmtH(b.freeLeftSec), extra: fmtH(b.extraSec) }) : t("billing.b01.subFree");
  const pct = (x: number) => (b.monthlyTotalSec ? Math.min(100, (x / b.monthlyTotalSec) * 100) : 0);
  const showAdd = owner && !onPlan && b.myPool !== null && b.myPool.status !== "expired" && b.myPool.plan !== null;
  const hasPrimary = owner ? b.state === "free" || b.state === "expired" || onPlan : onPlan;
  const primaryLabel = onPlan ? t("billing.b01.buyExtra") : b.state === "expired" ? t("billing.b01.resubscribe") : t("billing.b01.viewPlans");
  const primaryGo = () => (onPlan ? go("/billing/extra") : go("/billing/plans", { sel: b.state === "free" ? "band" : (b.plan ?? "band") }));
  const note = onPlan ? t("billing.b01.noteOnlyOwner", { owner: ownerName }) : b.state === "expired" ? t("billing.b01.noteEnded", { owner: ownerName }) : t("billing.b01.noteAsk", { owner: ownerName, band: bandName });

  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: space.screenX, paddingBottom: 40, gap: 12 }}>
      <View style={card(colors)}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <AppText variant="sheetTitle">{onPlan ? t("billing.b01.planSuffix", { plan: planName(b.plan) }) : t("billing.planName.free")}</AppText>
          <AppText variant="caption" style={{ textAlign: "right", flexShrink: 1 }}>{meta}</AppText>
        </View>
        {onPlan ? (
          <PressableOpacity disabled={!owner} onPress={() => go("/billing/linked")} style={{ flexDirection: "row", justifyContent: "space-between", paddingTop: 10 }}>
            <AppText variant="caption">{owner ? t("billing.b01.shareOwner", { n: b.linkedBandCount }) : t("billing.b01.shareMember", { owner: ownerName, n: b.linkedBandCount })}</AppText>
            {owner ? <AppText variant="caption" color={colors.accent}>{t("billing.b01.manage")} ›</AppText> : null}
          </PressableOpacity>
        ) : null}
        <View style={{ paddingTop: 14, gap: 4 }}>
          <MonoLabel>{t("billing.b01.availableNow")}</MonoLabel>
          <AppText style={{ fontSize: 34, fontWeight: "700", letterSpacing: -0.5, color: colors.text }}>{fmtH(b.availableSec)}</AppText>
          <AppText variant="caption">{availSub}</AppText>
        </View>
      </View>

      {showAdd ? (
        <View style={card(colors)}>
          <AppText variant="rowTitle">{t("billing.b01.addTitle")}</AppText>
          <AppText variant="caption" style={{ paddingTop: 4 }}>{t("billing.b01.addBody", { plan: planName(b.myPool!.plan), time: fmtH(b.myPool!.monthlyLeftSec) })}</AppText>
          <PressableOpacity onPress={addThisBand} style={[primaryBtn(colors), { marginTop: 12 }]}><AppText style={{ color: colors.bg, fontWeight: "600" }}>{t("billing.b01.addCta")}</AppText></PressableOpacity>
        </View>
      ) : null}

      {onPlan ? (
        <View style={card(colors)}>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <AppText variant="rowTitle">{t("billing.b01.monthly")}</AppText>
            <AppText variant="caption">{t("billing.b01.leftOf", { time: fmtH(b.monthlyLeftSec), total: fmtH(b.monthlyTotalSec) })}</AppText>
          </View>
          <View style={{ paddingVertical: 12 }}><UsageBar usedPct={pct(b.monthlyUsedSec)} leftPct={pct(b.monthlyLeftSec)} /></View>
          <KeyValueRows rows={[{ k: t("billing.b01.used"), v: fmtH(b.monthlyUsedSec) }, { k: t("billing.b01.left"), v: fmtH(b.monthlyLeftSec) }]} />
          <AppText variant="small" style={{ paddingTop: 10 }}>{t("billing.b01.resetNote", { n: b.linkedBandCount, date })}</AppText>
        </View>
      ) : (
        <View style={card(colors)}>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <AppText variant="rowTitle">{t("billing.b01.freeTime")}</AppText>
            <AppText variant="caption">{t("billing.b01.freeLeftOf", { time: fmtH(b.freeLeftSec) })}</AppText>
          </View>
          <AppText variant="small" style={{ paddingTop: 10 }}>{t("billing.b01.freeNote")}</AppText>
        </View>
      )}

      {onPlan || b.extraSec > 0 ? (
        <View style={card(colors)}>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <AppText variant="rowTitle">{t("billing.b01.extra")}</AppText>
            <AppText variant="caption">{fmtH(b.extraSec)}</AppText>
          </View>
          <AppText variant="small" style={{ paddingTop: 10 }}>
            {b.state === "expired" ? t("billing.b01.extraNoteExpired") : onPlan ? t("billing.b01.extraNoteLinked") : t("billing.b01.extraNoteFree")}
          </AppText>
        </View>
      ) : null}

      <View style={{ gap: 10, paddingTop: 4 }}>
        {hasPrimary ? <PressableOpacity onPress={primaryGo} style={primaryBtn(colors)}><AppText style={{ color: colors.bg, fontWeight: "600", fontSize: 15 }}>{primaryLabel}</AppText></PressableOpacity> : null}
        {owner && onPlan ? <PressableOpacity onPress={() => go("/billing/plans", { sel: b.plan === "band" ? "plus" : "band" })} style={outline(colors)}><AppText style={{ fontSize: 15 }}>{t("billing.b01.changePlan")}</AppText></PressableOpacity> : null}
        {!owner ? <AppText variant="caption" style={{ textAlign: "center" }}>{note}</AppText> : null}
      </View>
    </ScrollView>
  );
}

export const card = (c: ReturnType<typeof useTheme>["colors"]) => ({ backgroundColor: c.surface, borderWidth: 1, borderColor: c.borderStrong, borderRadius: radius.input, padding: 16 });
export const primaryBtn = (c: ReturnType<typeof useTheme>["colors"]) => ({ backgroundColor: c.accent, borderRadius: radius.input, padding: 14, alignItems: "center" as const });
export const outline = (c: ReturnType<typeof useTheme>["colors"]) => ({ borderWidth: 1, borderColor: c.borderStrong, borderRadius: radius.input, padding: 13, alignItems: "center" as const });
