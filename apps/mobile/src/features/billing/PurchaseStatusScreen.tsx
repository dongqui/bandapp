import type { BandBilling } from "@bandapp/types";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, ScrollView, View } from "react-native";
import { useApi } from "@/api";
import { useCurrentBand } from "@/features/band/useCurrentBand";
import { apiErrorMessage } from "@/i18n/apiErrorMessage";
import { purchases, type ProductKey, type StorePrice } from "@/services/purchases";
import { space, useTheme } from "@/theme";
import { AppText, PressableOpacity, Screen, useToast } from "@/ui";
import { ctxToParams, paramsToCtx } from "./billingContext";
import { fmtH, monthDay, phaseAfterSync, PLAN_SEC, type PurchasePhase } from "./billingView";
import { useOpenLink } from "./FooterLinks";
import { KeyValueRows } from "./KeyValueRows";
import { outline, primaryBtn } from "./PlanScreen";
import { useBandBilling } from "./useBandBilling";

const PHASES: PurchasePhase[] = ["checking", "success", "failed", "pending", "delayed", "canceled", "resumed"];
const PRODUCTS: ProductKey[] = ["band", "plus", "extra"];
type RetPath = "/billing/plan" | "/billing/plans" | "/billing/extra";
const RETS: RetPath[] = ["/billing/plan", "/billing/plans", "/billing/extra"];

export function PurchaseStatusScreen() {
  const params = useLocalSearchParams<Record<string, string>>();
  const bandId = params.bandId;
  const ctx = paramsToCtx(params);
  const product: ProductKey = PRODUCTS.includes(params.product as ProductKey) ? (params.product as ProductKey) : "band";
  const ret: RetPath = RETS.includes(params.ret as RetPath) ? (params.ret as RetPath) : "/billing/plan";
  // 알 수 없는 phase는 delayed로 본다
  const initial: PurchasePhase = PHASES.includes(params.phase as PurchasePhase) ? (params.phase as PurchasePhase) : "delayed";
  const [phase, setPhase] = useState<PurchasePhase>(initial);
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();
  const api = useApi();
  const toast = useToast();
  const openLink = useOpenLink();
  const { bands } = useCurrentBand();
  const bandName = bands.find((x) => x.id === bandId)?.name ?? "";
  const { data: b } = useBandBilling(bandId);
  // "Check status" 비교용 — 화면 진입 시 처음 받은 상태를 고정한다
  const beforeRef = useRef<BandBilling | undefined>(undefined);
  if (b && !beforeRef.current) beforeRef.current = b;
  const [prices, setPrices] = useState<StorePrice[]>([]);
  useEffect(() => { purchases.prices().then(setPrices).catch(() => setPrices([])); }, []);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const price = (k: ProductKey) => prices.find((p) => p.key === k)?.priceString ?? "";
  const planName = t(`billing.planName.${product === "plus" ? "plus" : "band"}`);
  const productLabel = product === "extra" ? t("billing.b06.productExtra") : t("billing.b06.productPlan", { plan: planName });
  const avail = b?.availableSec ?? 0;
  const date = monthDay(b?.periodEnd ?? null);

  const goPlan = () => router.replace({ pathname: "/billing/plan", params: { bandId, from: "band" } });
  const done = () => (ctx.from === "analysis" ? router.replace("/") : goPlan());
  const tryAgain = () => router.replace({ pathname: ret, params: { bandId, ...ctxToParams(ctx) } });
  const continueAnalysis = async () => {
    // 연타 방지는 렌더 클로저가 아니라 ref로 동기 검사한다
    if (ctx.from !== "analysis" || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await api.sessions.retryAnalysis(ctx.sessionId);
      router.replace("/");
    } catch (err) {
      toast.show(apiErrorMessage(err, t));
      busyRef.current = false;
      setBusy(false);
    }
  };
  const checkStatus = async () => {
    // 비교 기준은 구매 전 값이어야 한다. 이 화면이 처음 받은 서버 상태엔 이미 구매가 반영됐을 수 있어
    // (웹훅/일시적 sync 실패) 그걸 기준으로 삼으면 delayed에서 영영 못 벗어난다 — route param이 있으면 덮어쓴다
    const base = beforeRef.current ?? b;
    const num = Number(params.beforeExtraSec);
    const plan = params.beforePlan === "band" || params.beforePlan === "plus" ? params.beforePlan : params.beforePlan === "" ? null : undefined;
    const st = params.beforeState;
    const before: BandBilling | undefined = base && {
      ...base,
      extraSec: params.beforeExtraSec !== undefined && Number.isFinite(num) ? num : base.extraSec,
      plan: plan === undefined ? base.plan : plan,
      state: st === "free" || st === "linked" || st === "expired" ? st : base.state,
    };
    setPhase("checking");
    const after = await api.billing.sync(bandId).catch(() => null);
    // before를 못 구했으면 비교할 수 없다 — delayed 유지
    setPhase(before ? phaseAfterSync("success", before, after, product) : "delayed");
  };

  const canContinue = ctx.from === "analysis" && avail >= ctx.durationSec;

  let icon: { glyph: string; bg: string; fg: string } | null = null;
  let title = "";
  let body = "";
  let rows: Array<{ k: string; v: string }> = [];
  let primary: { label: string; onPress: () => void } | null = null;
  let secondary: { label: string; onPress: () => void } | null = null;
  const productRows = [{ k: t("billing.b06.rowProduct"), v: productLabel }, { k: t("billing.b06.rowBand"), v: bandName }];
  const doneBtn = { label: t("billing.b06.done"), onPress: done };
  const accent = { bg: colors.accent, fg: colors.bg };
  const muted = { bg: colors.border, fg: colors.textMuted };

  switch (phase) {
    case "checking":
      title = t("billing.b06.checking");
      body = t("billing.b06.checkingBody", { product: productLabel, band: bandName });
      break;
    case "success":
      icon = { glyph: "✓", ...accent };
      if (product === "extra") {
        title = t("billing.b06.successExtra");
        body = t("billing.b06.successExtraBody", { band: bandName });
        rows = [
          { k: t("billing.b06.rowPurchase"), v: t("billing.b06.vOneTime", { price: price("extra") }) },
          { k: t("billing.b06.rowAvailable"), v: fmtH(avail) },
        ];
      } else {
        title = t("billing.b06.successPlan", { plan: planName });
        body = t("billing.b06.successPlanBody", { band: bandName });
        rows = [
          { k: t("billing.b06.rowTime"), v: t("billing.b04.vTime", { time: fmtH(PLAN_SEC[product]) }) },
          { k: t("billing.b06.rowRenews"), v: t("billing.b06.vRenews", { date, price: price(product) }) },
          { k: t("billing.b06.rowAvailable"), v: fmtH(avail) },
        ];
      }
      primary = canContinue ? { label: t("billing.b06.continueAnalysis"), onPress: continueAnalysis } : doneBtn;
      break;
    case "failed":
      icon = { glyph: "!", bg: colors.danger, fg: colors.bg };
      title = t("billing.b06.failed");
      body = t("billing.b06.failedBody", { store: purchases.storeName(), band: bandName });
      primary = { label: t("billing.b06.tryAgain"), onPress: tryAgain };
      secondary = { label: t("billing.b06.back"), onPress: goPlan };
      break;
    case "pending":
      icon = { glyph: "…", ...muted };
      title = t("billing.b06.pending");
      body = t("billing.b06.pendingBody");
      rows = productRows;
      primary = doneBtn;
      break;
    case "delayed":
      icon = { glyph: "…", ...muted };
      title = t("billing.b06.delayed");
      body = t("billing.b06.delayedBody");
      rows = productRows;
      primary = { label: t("billing.b06.checkStatus"), onPress: checkStatus };
      secondary = { label: t("billing.b04.help"), onPress: () => openLink("help") };
      break;
    case "canceled":
      icon = { glyph: "✓", ...muted };
      title = t("billing.b06.canceled");
      body = t("billing.b06.canceledBody", { plan: planName, band: bandName, date });
      rows = [{ k: t("billing.b06.rowActiveUntil"), v: date }, { k: t("billing.b06.rowAfter"), v: t("billing.b06.vAfter") }];
      primary = doneBtn;
      break;
    case "resumed":
      icon = { glyph: "✓", ...accent };
      title = t("billing.b06.resumed");
      body = t("billing.b06.resumedBody", { plan: planName, date });
      rows = [{ k: t("billing.b06.rowRenews"), v: t("billing.b06.vRenews", { date, price: price(product) }) }];
      primary = doneBtn;
      break;
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.screenX, paddingTop: 40, paddingBottom: 40, gap: 14, alignItems: "center" }}>
        {icon ? (
          <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: icon.bg, alignItems: "center", justifyContent: "center" }}>
            <AppText style={{ fontSize: 26, fontWeight: "700", color: icon.fg }}>{icon.glyph}</AppText>
          </View>
        ) : (
          <ActivityIndicator size="large" color={colors.accent} />
        )}
        <AppText variant="title" style={{ textAlign: "center" }}>{title}</AppText>
        <AppText variant="body" style={{ textAlign: "center" }}>{body}</AppText>
        {rows.length ? <View style={{ alignSelf: "stretch" }}><KeyValueRows rows={rows} /></View> : null}
        <View style={{ alignSelf: "stretch", gap: 10, paddingTop: 8 }}>
          {primary ? (
            <PressableOpacity disabled={busy} onPress={primary.onPress} style={[primaryBtn(colors), { opacity: busy ? 0.4 : 1 }]}>
              <AppText style={{ color: colors.bg, fontWeight: "600", fontSize: 15 }}>{primary.label}</AppText>
            </PressableOpacity>
          ) : null}
          {secondary ? (
            <PressableOpacity onPress={secondary.onPress} style={outline(colors)}><AppText>{secondary.label}</AppText></PressableOpacity>
          ) : null}
        </View>
      </ScrollView>
    </Screen>
  );
}
