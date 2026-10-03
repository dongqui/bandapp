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
import { ctxToParams, paramsToCtx } from "./billingContext";
import { currentPlanOf, fmtH, monthDay, PLAN_SEC } from "./billingView";
import { FooterLinks } from "./FooterLinks";
import { card, outline, primaryBtn } from "./PlanScreen";
import { useBandBilling } from "./useBandBilling";
import { usePurchaseFlow } from "./usePurchaseFlow";

type Sel = "band" | "plus";

export function PlansScreen() {
  const params = useLocalSearchParams<Record<string, string>>();
  const bandId = params.bandId;
  const ctx = paramsToCtx(params);
  const { bands } = useCurrentBand();
  const band = bands.find((x) => x.id === bandId) ?? null;
  const { data: b, failed, reload } = useBandBilling(bandId);
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();
  const paramSel: Sel | null = params.sel === "plus" || params.sel === "band" ? params.sel : null;
  // null이면 아직 안 고름 — 데이터가 오면 기본값을 정한다
  const [picked, setSel] = useState<Sel | null>(null);

  return (
    <Screen>
      <BillingHeader back={t("billing.b02.back")} onBack={() => router.back()} />
      {!b && !failed ? (
        <AppText variant="caption" style={{ paddingHorizontal: space.screenX }}>{t("billing.b01.loading")}</AppText>
      ) : failed || !b ? (
        <View style={{ paddingHorizontal: space.screenX, gap: 10 }}>
          <AppText variant="sheetTitle">{t("billing.b01.failTitle")}</AppText>
          <AppText variant="body">{t("billing.b01.failBody")}</AppText>
          <PressableOpacity onPress={reload} style={outline(colors)}><AppText>{t("billing.b01.retry")}</AppText></PressableOpacity>
        </View>
      ) : (
        <PlansBody b={b} bandId={bandId} bandName={band?.name ?? ""} sel={picked ?? defaultSel(b, paramSel)} setSel={setSel} ctx={ctx} />
      )}
    </Screen>
  );
}

/** 구독 중이면 기본 선택은 다른 플랜 — param이 없거나 현재 플랜을 가리킬 때 */
function defaultSel(b: BandBilling, param: Sel | null): Sel {
  const current = currentPlanOf(b);
  if (current && (param === null || param === current)) return current === "band" ? "plus" : "band";
  return param ?? "band";
}

function PlansBody({ b, bandId, bandName, sel, setSel, ctx }: {
  b: BandBilling; bandId: string; bandName: string; sel: Sel; setSel: (s: Sel) => void; ctx: ReturnType<typeof paramsToCtx>;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();
  const flow = usePurchaseFlow(bandId);
  const [prices, setPrices] = useState<StorePrice[] | null>(null);
  useEffect(() => { purchases.prices().then(setPrices).catch(() => setPrices([])); }, []);
  const store = purchases.storeName();
  // 현재 플랜은 밴드가 아니라 오너의 풀 기준 (미연결 밴드에서 들어와도 이미 구독 중이면 "변경")
  const currentPlan = currentPlanOf(b);
  const paid = currentPlan !== null;
  const pricesReady = prices !== null && prices.length > 0;
  const price = (k: Sel) => prices?.find((p) => p.key === k)?.priceString ?? "";
  const planName = (p: Sel | null) => (p ? t(`billing.planName.${p}`) : t("billing.planName.free"));
  const canGo = pricesReady && sel !== currentPlan && !flow.busy;
  const date = monthDay(b.periodEnd);

  const goReview = () => router.push({ pathname: "/billing/review", params: { bandId, sel, ...ctxToParams(ctx) } });

  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: space.screenX, paddingBottom: 40, gap: 12 }}>
      <View style={{ gap: 6, paddingBottom: 6 }}>
        <AppText variant="title">{t("billing.b02.title")}</AppText>
        <AppText variant="caption">{t("billing.b02.sub", { band: bandName })}</AppText>
      </View>

      {(["band", "plus"] as const).map((k) => {
        const current = currentPlan === k;
        const selected = sel === k;
        return (
          <PressableOpacity
            key={k}
            disabled={current}
            onPress={() => setSel(k)}
            style={[card(colors), selected ? { borderColor: colors.accent, borderWidth: 2 } : null]}
          >
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <AppText variant="sheetTitle">{planName(k)}</AppText>
                {current ? <MonoLabel>{t("billing.b02.current")}</MonoLabel> : null}
              </View>
              {selected ? <AppText style={{ color: colors.accent, fontSize: 18, fontWeight: "700" }}>✓</AppText> : null}
            </View>
            <View style={{ paddingTop: 10, gap: 2 }}>
              <AppText style={{ fontSize: 28, fontWeight: "700", color: colors.text }}>{fmtH(PLAN_SEC[k])}</AppText>
              <AppText variant="caption">{t("billing.b02.perMonth")}</AppText>
            </View>
            <View style={{ paddingTop: 10 }}>
              {pricesReady ? (
                <AppText style={{ fontSize: 15, color: colors.text }}>{t("billing.b02.price", { price: price(k) })}</AppText>
              ) : (
                <View style={{ width: 90, height: 18, borderRadius: 4, backgroundColor: colors.border }} />
              )}
            </View>
          </PressableOpacity>
        );
      })}

      <AppText variant="caption">{t("billing.b02.note")}</AppText>

      {/* 해지·재개는 이 밴드가 풀에 연결돼 있을 때만 — willRenew·periodEnd는 연결된 풀 값만 내려온다 */}
      {paid && b.state === "linked" && b.isOwner ? (
        b.willRenew ? (
          <PressableOpacity disabled={flow.busy} onPress={() => flow.manage("cancel", b, ctx)} style={[card(colors), { gap: 4 }]}>
            <AppText variant="rowTitle">{t("billing.b02.cancel")}</AppText>
            <AppText variant="caption">{t("billing.b02.cancelSub", { store, plan: planName(b.plan), date })}</AppText>
          </PressableOpacity>
        ) : (
          <View style={[card(colors), { gap: 8 }]}>
            <AppText variant="caption">{t("billing.b02.resumeNote", { plan: planName(b.plan), date })}</AppText>
            <PressableOpacity disabled={flow.busy} onPress={() => flow.manage("resume", b, ctx)}>
              <AppText variant="rowTitle" color={colors.accent}>{t("billing.b02.resume")}</AppText>
            </PressableOpacity>
          </View>
        )
      ) : null}

      <View style={{ gap: 10, paddingTop: 4 }}>
        {b.isOwner ? (
          <PressableOpacity disabled={!canGo} onPress={goReview} style={[primaryBtn(colors), { opacity: canGo ? 1 : 0.4 }]}>
            <AppText style={{ color: colors.bg, fontWeight: "600", fontSize: 15 }}>{t("billing.b02.cta", { plan: planName(sel) })}</AppText>
          </PressableOpacity>
        ) : (
          // 멤버는 이 화면에 올 수 없지만 딥링크 대비
          <AppText variant="caption" style={{ textAlign: "center" }}>{t("billing.b01.noteOnlyOwner", { owner: b.owner.displayName })}</AppText>
        )}
        <AppText variant="small" style={{ textAlign: "center" }}>
          {prices === null ? t("billing.b02.loadingPrices", { store }) : t("billing.b02.fine", { store })}
        </AppText>
        <FooterLinks items={[{ key: "terms", label: t("billing.b02.terms") }, { key: "privacy", label: t("billing.b02.privacy") }]} />
        {!paid ? (
          <PressableOpacity onPress={() => router.back()} style={{ padding: 8, alignItems: "center" }}>
            <AppText variant="caption">{t("billing.b02.keepFree")}</AppText>
          </PressableOpacity>
        ) : null}
      </View>
    </ScrollView>
  );
}
