import type { BandBilling } from "@bandapp/types";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, View } from "react-native";
import { useCurrentBand } from "@/features/band/useCurrentBand";
import { purchases, type StorePrice } from "@/services/purchases";
import { space, useTheme } from "@/theme";
import { AppText, MonoLabel, PressableOpacity, Screen } from "@/ui";
import { BillingHeader } from "./BillingHeader";
import { paramsToCtx } from "./billingContext";
import { fmtH, monthDay, PLAN_SEC } from "./billingView";
import { FooterLinks } from "./FooterLinks";
import { KeyValueRows } from "./KeyValueRows";
import { card, outline, primaryBtn } from "./PlanScreen";
import { useBandBilling } from "./useBandBilling";
import { usePurchaseFlow } from "./usePurchaseFlow";

export function ReviewScreen() {
  const params = useLocalSearchParams<Record<string, string>>();
  const bandId = params.bandId;
  const sel: "band" | "plus" = params.sel === "plus" ? "plus" : "band";
  const ctx = paramsToCtx(params);
  const { bands } = useCurrentBand();
  const band = bands.find((x) => x.id === bandId) ?? null;
  const { data: b, failed, reload } = useBandBilling(bandId);
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();

  return (
    <Screen>
      <BillingHeader back={t("billing.b04.back")} onBack={() => router.back()} />
      {!b && !failed ? (
        <AppText variant="caption" style={{ paddingHorizontal: space.screenX }}>{t("billing.b01.loading")}</AppText>
      ) : failed || !b ? (
        <View style={{ paddingHorizontal: space.screenX, gap: 10 }}>
          <AppText variant="sheetTitle">{t("billing.b01.failTitle")}</AppText>
          <AppText variant="body">{t("billing.b01.failBody")}</AppText>
          <PressableOpacity onPress={reload} style={outline(colors)}><AppText>{t("billing.b01.retry")}</AppText></PressableOpacity>
        </View>
      ) : (
        <ReviewBody b={b} bandId={bandId} bandName={band?.name ?? ""} memberCount={band?.memberCount ?? 0} sel={sel} ctx={ctx} />
      )}
    </Screen>
  );
}

function ReviewBody({ b, bandId, bandName, memberCount, sel, ctx }: {
  b: BandBilling; bandId: string; bandName: string; memberCount: number; sel: "band" | "plus"; ctx: ReturnType<typeof paramsToCtx>;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const flow = usePurchaseFlow(bandId);
  const [prices, setPrices] = useState<StorePrice[] | null>(null);
  useEffect(() => { purchases.prices().then(setPrices).catch(() => setPrices([])); }, []);
  const store = purchases.storeName();
  const change = b.state === "linked";
  const price = (k: "band" | "plus" | null) => prices?.find((p) => p.key === k)?.priceString ?? "";
  const planName = (p: "band" | "plus" | null) => (p ? t(`billing.planName.${p}`) : t("billing.planName.free"));
  const ready = prices !== null && price(sel) !== "";
  const next = new Date();
  next.setMonth(next.getMonth() + 1);

  const rows = change
    ? [
        { k: t("billing.b04.rowCurrent"), v: `${planName(b.plan)} · ${t("billing.b04.vMonthly", { price: price(b.plan) })}` },
        { k: t("billing.b04.rowNew"), v: `${planName(sel)} · ${t("billing.b04.vTime", { time: fmtH(PLAN_SEC[sel]) })}` },
        { k: t("billing.b04.rowBilledThrough"), v: store },
      ]
    : [
        { k: t("billing.b04.rowTime"), v: t("billing.b04.vTime", { time: fmtH(PLAN_SEC[sel]) }) },
        { k: t("billing.b04.rowBilling"), v: t("billing.b04.vBilling") },
        { k: t("billing.b04.rowRenewal"), v: monthDay(next.toISOString()) },
      ];

  let ctxLine: { text: string; ok: boolean } | null = null;
  if (ctx.from === "analysis") {
    const after = (change ? Math.max(0, PLAN_SEC[sel] - b.monthlyUsedSec) : PLAN_SEC[sel]) + b.extraSec;
    ctxLine = after >= ctx.durationSec
      ? { ok: true, text: t("billing.b04.ctxOk", { session: ctx.title, time: fmtH(ctx.durationSec) }) }
      : { ok: false, text: t("billing.b04.ctxShort", { session: ctx.title, time: fmtH(ctx.durationSec - after) }) };
  }

  const cta = change ? t("billing.b04.ctaChange", { plan: planName(sel) }) : t("billing.b04.ctaNew", { price: price(sel) });
  const canBuy = ready && b.isOwner && !flow.busy;

  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: space.screenX, paddingBottom: 40, gap: 12 }}>
      <AppText variant="title">{change ? t("billing.b04.titleChange", { plan: planName(sel) }) : t("billing.b04.titleNew")}</AppText>
      <View style={card(colors)}>
        <MonoLabel>{t("billing.b04.label", { plan: planName(sel).toUpperCase() })}</MonoLabel>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, paddingVertical: 8 }}>
          <AppText style={{ fontSize: 34, fontWeight: "700", color: colors.text }}>{price(sel) || "—"}</AppText>
          <AppText variant="caption">{t("billing.b04.perMonth")}</AppText>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingBottom: 8 }}>
          <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: colors.border, alignItems: "center", justifyContent: "center" }}>
            <AppText style={{ fontWeight: "700", color: colors.text }}>{bandName.slice(0, 1).toUpperCase()}</AppText>
          </View>
          <View style={{ flexShrink: 1 }}>
            <AppText variant="rowTitle">{t("billing.b04.forBand", { band: bandName })}</AppText>
            <AppText variant="small">{t("billing.b04.sharedBy", { n: memberCount })}</AppText>
          </View>
        </View>
        <KeyValueRows rows={rows} />
      </View>

      {ctxLine ? <AppText variant="caption" color={ctxLine.ok ? undefined : colors.danger}>{ctxLine.text}</AppText> : null}
      <AppText variant="caption">{change ? t("billing.b04.noteChange", { store }) : t("billing.b04.noteNew", { store })}</AppText>

      <View style={{ gap: 10, paddingTop: 4 }}>
        <PressableOpacity disabled={!canBuy} onPress={() => flow.buy(sel, b, ctx, "/billing/plans")} style={[primaryBtn(colors), { opacity: canBuy ? 1 : 0.4 }]}>
          <AppText style={{ color: colors.bg, fontWeight: "600", fontSize: 15 }}>{cta}</AppText>
        </PressableOpacity>
        <FooterLinks items={[
          { key: "terms", label: t("billing.b02.terms") },
          { key: "privacy", label: t("billing.b02.privacy") },
          { key: "help", label: t("billing.b04.help") },
        ]} />
      </View>
    </ScrollView>
  );
}
