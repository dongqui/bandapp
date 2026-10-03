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
import { paramsToCtx, type BillingCtx } from "./billingContext";
import { fmtH } from "./billingView";
import { KeyValueRows } from "./KeyValueRows";
import { card, outline, primaryBtn } from "./PlanScreen";
import { useBandBilling } from "./useBandBilling";
import { usePurchaseFlow } from "./usePurchaseFlow";

const EXTRA_SEC = 3 * 3600;

export function ExtraScreen() {
  const params = useLocalSearchParams<Record<string, string>>();
  const bandId = params.bandId;
  const ctx = paramsToCtx(params);
  const { bands } = useCurrentBand();
  const band = bands.find((x) => x.id === bandId) ?? null;
  const { data: b, failed, reload } = useBandBilling(bandId);
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();

  // 딥링크로 들어왔지만 살 수 없는 상태면 돌아간다
  const blocked = !!b && !b.canBuyExtra;
  useEffect(() => { if (blocked) router.back(); }, [blocked, router]);

  return (
    <Screen>
      <BillingHeader back={t("billing.b05.back")} onBack={() => router.back()} />
      {!b && !failed ? (
        <AppText variant="caption" style={{ paddingHorizontal: space.screenX }}>{t("billing.b01.loading")}</AppText>
      ) : failed || !b ? (
        <View style={{ paddingHorizontal: space.screenX, gap: 10 }}>
          <AppText variant="sheetTitle">{t("billing.b01.failTitle")}</AppText>
          <AppText variant="body">{t("billing.b01.failBody")}</AppText>
          <PressableOpacity onPress={reload} style={outline(colors)}><AppText>{t("billing.b01.retry")}</AppText></PressableOpacity>
        </View>
      ) : blocked ? null : (
        <ExtraBody b={b} bandId={bandId} bandName={band?.name ?? ""} ctx={ctx} />
      )}
    </Screen>
  );
}

function ExtraBody({ b, bandId, bandName, ctx }: { b: BandBilling; bandId: string; bandName: string; ctx: BillingCtx }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const flow = usePurchaseFlow(bandId);
  const [prices, setPrices] = useState<StorePrice[] | null>(null);
  useEffect(() => { purchases.prices().then(setPrices).catch(() => setPrices([])); }, []);
  const price = prices?.find((p) => p.key === "extra")?.priceString ?? "";
  const avail = b.availableSec;
  const analysis = ctx.from === "analysis" ? ctx : null;
  const exAfter = analysis ? avail + EXTRA_SEC - analysis.durationSec : 0;
  const ok = !!analysis && exAfter >= 0;
  const canBuy = price !== "" && !flow.busy;

  const rows = [
    { k: t("billing.b05.rowNow"), v: fmtH(avail) },
    { k: t("billing.b05.rowExtra"), v: fmtH(b.extraSec) },
    { k: t("billing.b05.rowAfter"), v: fmtH(avail + EXTRA_SEC) },
  ];

  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: space.screenX, paddingBottom: 40, gap: 12 }}>
      <AppText variant="title">{t("billing.b05.title")}</AppText>
      <View style={card(colors)}>
        <MonoLabel>{t("billing.b05.forBand", { band: bandName })}</MonoLabel>
        <View style={{ paddingVertical: 8, gap: 2 }}>
          <AppText style={{ fontSize: 34, fontWeight: "700", color: colors.text }}>{t("billing.b05.hours")}</AppText>
          <AppText variant="caption">{t("billing.b05.oneTime", { price: price || "—" })}</AppText>
        </View>
        <KeyValueRows rows={rows} />
      </View>

      {analysis ? (
        <View style={{ gap: 2 }}>
          <AppText variant="rowTitle">{`${analysis.title} · ${fmtH(analysis.durationSec)}`}</AppText>
          <AppText variant="caption" color={ok ? undefined : colors.danger}>
            {ok ? t("billing.b05.ctxOk", { time: fmtH(exAfter) }) : t("billing.b05.ctxShort", { time: fmtH(-exAfter) })}
          </AppText>
        </View>
      ) : null}
      <AppText variant="caption">{t("billing.b05.note")}</AppText>

      <View style={{ gap: 8, paddingTop: 4 }}>
        <PressableOpacity disabled={!canBuy} onPress={() => flow.buy("extra", b, ctx, "/billing/extra")} style={[primaryBtn(colors), { opacity: canBuy ? 1 : 0.4 }]}>
          <AppText style={{ color: colors.bg, fontWeight: "600", fontSize: 15 }}>
            {analysis && ok ? t("billing.b05.ctaAnalyze") : t("billing.b05.cta", { price })}
          </AppText>
        </PressableOpacity>
        <AppText variant="caption" style={{ textAlign: "center" }}>
          {analysis && ok
            ? t("billing.b05.ctaSubAnalyze", { price, time: fmtH(analysis.durationSec), session: analysis.title })
            : t("billing.b05.ctaSub")}
        </AppText>
      </View>
    </ScrollView>
  );
}
