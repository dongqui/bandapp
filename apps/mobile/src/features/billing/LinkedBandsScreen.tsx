import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, View } from "react-native";
import { useApi } from "@/api";
import { apiErrorMessage } from "@/i18n/apiErrorMessage";
import { space, useTheme } from "@/theme";
import { AppText, ConfirmDialog, MonoLabel, PressableOpacity, Screen, useToast } from "@/ui";
import { BillingHeader } from "./BillingHeader";
import { fmtH, PLAN_SEC } from "./billingView";
import { useBandBilling } from "./useBandBilling";

type PoolBand = { id: string; name: string; memberCount: number; linked: boolean };

/** B01a — 내 플랜에 연결된 밴드 목록, 제거/추가 */
export function LinkedBandsScreen() {
  const params = useLocalSearchParams<Record<string, string>>();
  const bandId = params.bandId;
  const { data: b } = useBandBilling(bandId);
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();
  const api = useApi();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<PoolBand | null>(null);

  const pool = b?.myPool ?? null;
  const linked = pool?.bands.filter((x) => x.linked) ?? [];
  const others = pool?.bands.filter((x) => !x.linked) ?? [];
  const planKey = pool?.plan ?? null;
  const planLabel = planKey ? t(`billing.planName.${planKey}`) : t("billing.planName.free");
  const time = planKey ? fmtH(PLAN_SEC[planKey]) : "";

  const run = async (fn: () => Promise<unknown>, onDone?: () => void) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      onDone?.();
    } catch (err) {
      toast.show(apiErrorMessage(err, t));
    } finally {
      setBusy(false);
    }
  };
  const confirmRemove = async () => {
    const target = removing;
    if (!target) return;
    await run(() => api.bands.unlinkPool(target.id));
    setRemoving(null);
  };
  const add = (x: PoolBand) => run(() => api.bands.linkPool(x.id), () => toast.show(t("billing.b01a.addedToast", { band: x.name })));

  const row = (x: PoolBand, action: "remove" | "add") => {
    const isThis = x.id === bandId;
    return (
      <View key={x.id} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center" }}>
          <AppText style={{ fontWeight: "600", color: colors.text }}>{x.name.charAt(0).toUpperCase()}</AppText>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <AppText variant="rowTitle" style={{ flexShrink: 1 }}>{x.name}</AppText>
            {isThis ? <MonoLabel>{t("billing.b01a.thisBand")}</MonoLabel> : null}
          </View>
          <AppText variant="caption">{isThis ? t("billing.b01a.thisBandMeta", { n: x.memberCount }) : t("billing.b01a.members", { n: x.memberCount })}</AppText>
        </View>
        <PressableOpacity disabled={busy} onPress={() => (action === "remove" ? setRemoving(x) : add(x))} style={{ padding: 8 }}>
          <AppText style={{ color: action === "remove" ? colors.danger : colors.accent, fontSize: 14 }}>{t(`billing.b01a.${action}`)}</AppText>
        </PressableOpacity>
      </View>
    );
  };

  return (
    <Screen>
      <BillingHeader back={t("billing.b01a.back")} onBack={() => router.back()} />
      <View style={{ paddingHorizontal: space.screenX, gap: 6, paddingBottom: 14 }}>
        <AppText variant="title">{t("billing.b01a.title")}</AppText>
        <AppText variant="caption">{t("billing.b01a.sub", { plan: planLabel, time })}</AppText>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.screenX, paddingBottom: 40 }}>
        <MonoLabel>{t("billing.b01a.onPlan", { n: linked.length })}</MonoLabel>
        {linked.length ? linked.map((x) => row(x, "remove")) : <AppText variant="caption" style={{ paddingVertical: 12 }}>{t("billing.b01a.none")}</AppText>}
        {others.length ? (
          <View style={{ paddingTop: 20 }}>
            <MonoLabel>{t("billing.b01a.others")}</MonoLabel>
            {others.map((x) => row(x, "add"))}
          </View>
        ) : null}
        <AppText variant="small" style={{ paddingTop: 16 }}>{t("billing.b01a.footer")}</AppText>
      </ScrollView>
      <ConfirmDialog
        visible={removing !== null}
        title={t("billing.b01a.removeTitle", { band: removing?.name ?? "" })}
        body={t("billing.b01a.removeBody", { band: removing?.name ?? "" })}
        primary={{ label: t("billing.b01a.removePrimary"), onPress: confirmRemove, danger: true }}
        cancelLabel={t("common.cancel")}
        onCancel={() => setRemoving(null)}
        busy={busy}
      />
    </Screen>
  );
}
