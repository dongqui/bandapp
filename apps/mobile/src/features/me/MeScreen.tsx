import type { PoolPlan } from "@bandapp/types";
import { ApiError } from "@bandapp/api-client";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { useApi } from "@/api";
import { useAuth } from "@/features/auth/AuthProvider";
import { useCurrentBand } from "@/features/band/useCurrentBand";
import { RenameSheet } from "@/features/band/RenameSheet";
import { monthDay } from "@/features/billing/billingView";
import { useBandBilling } from "@/features/billing/useBandBilling";
import { apiErrorMessage } from "@/i18n/apiErrorMessage";
import { purchases, type StorePrice } from "@/services/purchases";
import { font, radius, space, useTheme } from "@/theme";
import { AppText, Avatar, BottomSheet, ConfirmDialog, MonoLabel, PressableOpacity, Screen, initialOf, useToast } from "@/ui";
import { mePlanModel } from "./mePlanView";
import { PhotoSheet } from "./PhotoSheet";
import { PhotoPermissionDeniedError, pickProfilePhoto } from "./pickProfilePhoto";

type Sheet = "name" | "photo" | null;

/** 디자인 "Me" 화면 (2026-10-06): 프로필 · 구독 카드 · 지원 · 로그아웃 */
export function MeScreen() {
  const { state, signOut, deleteAccount, updateUser } = useAuth();
  const user = state.status === "authenticated" ? state.user : null;
  const { band } = useCurrentBand();
  const { data: billing, failed: billingFailed } = useBandBilling(band?.id);
  const [prices, setPrices] = useState<StorePrice[]>([]);
  useEffect(() => { purchases.prices().then(setPrices).catch(() => setPrices([])); }, []);
  const api = useApi();
  const router = useRouter();
  const toast = useToast();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [sheet, setSheet] = useState<Sheet>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const name = user?.displayName ?? "";
  const photoUri = user?.profileImageUrl ?? null;
  const close = () => setSheet(null);

  const run = async (fn: () => Promise<void>, failMessage?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast.show(failMessage ?? apiErrorMessage(err, t));
    } finally {
      setBusy(false);
    }
  };

  const saveName = (displayName: string) => {
    close();
    void run(async () => {
      updateUser(await api.auth.updateMe({ displayName }));
      toast.show(t("me.name.saved"));
    });
  };

  const pickPhoto = (source: "camera" | "library") => {
    close();
    void run(async () => {
      let photo;
      try {
        photo = await pickProfilePhoto(source);
      } catch (err) {
        toast.show(err instanceof PhotoPermissionDeniedError ? t("me.photo.permission") : t("me.photo.failed"));
        return;
      }
      if (!photo) return; // 사용자가 취소
      try {
        updateUser(await api.auth.setPhoto(photo));
        toast.show(t("me.photo.updated"));
      } catch (err) {
        toast.show(err instanceof ApiError ? apiErrorMessage(err, t) : t("me.photo.failed"));
      }
    });
  };

  const removePhoto = () => {
    close();
    void run(async () => {
      await api.auth.removePhoto();
      if (user) updateUser({ ...user, profileImageUrl: null });
      toast.show(t("me.photo.removed"));
    });
  };

  // 디자인은 확인 없이 바로 로그아웃한다. signOut이 guest로 바꾸면 authGate가 /login으로 보낸다
  const onSignOut = () => void run(() => signOut(), t("me.signOutFailed"));

  const onDelete = () => {
    setConfirmDelete(false);
    void run(
      () => deleteAccount(),
      undefined, // 유일 owner 밴드가 있으면 서버 409 메시지를 그대로 보여준다 (기획서 18장)
    );
  };

  const price = (plan: PoolPlan) => prices.find((p) => p.key === plan)?.priceString ?? "";
  const planName = (p: PoolPlan) => t(`billing.planName.${p}`);
  const model = billing ? mePlanModel(billing) : null;
  const goPlans = (sel: PoolPlan) =>
    band && router.push({ pathname: "/billing/plans", params: { bandId: band.id, from: "me", sel } });

  const card = (() => {
    if (billingFailed) return { title: t("me.plan.unavailable"), price: "", meta: "", bands: null, cta: null };
    if (!model) return { title: t("me.plan.loading"), price: "", meta: "", bands: null, cta: null };
    switch (model.kind) {
      case "active": {
        const date = monthDay(model.periodEnd);
        return {
          title: t("me.plan.active", { plan: planName(model.plan) }),
          price: price(model.plan) ? t("me.plan.price", { price: price(model.plan) }) : "",
          meta: model.willRenew
            ? t("me.plan.metaRenews", { date, store: purchases.storeName() })
            : t("me.plan.metaCanceled", { date }),
          bands: model.linkedCount,
          cta: { label: t("me.plan.changePlan"), go: () => goPlans(model.nextSel) },
        };
      }
      case "expired":
        return {
          title: t("me.plan.ended", { plan: planName(model.plan) }),
          price: "",
          meta: t("me.plan.metaEnded", { date: monthDay(model.periodEnd) }),
          bands: null,
          cta: { label: t("me.plan.resubscribe"), go: () => goPlans(model.plan) },
        };
      case "othersPlan":
        return {
          title: t("me.plan.none"),
          price: "",
          meta: t("me.plan.metaOthers", { band: band?.name ?? "", owner: model.ownerName }),
          bands: null,
          cta: { label: t("me.plan.viewPlans"), go: () => goPlans("band") },
        };
      case "free":
        return {
          title: t("me.plan.free"),
          price: "",
          meta: t("me.plan.metaFree"),
          bands: null,
          cta: { label: t("me.plan.viewPlans"), go: () => goPlans("band") },
        };
    }
  })();

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.screenX, paddingTop: 12, paddingBottom: 160 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 16, paddingBottom: 26 }}>
          <PressableOpacity onPress={() => setSheet("photo")} accessibilityLabel={t("me.photo.title")}>
            <Avatar label={initialOf(name)} uri={photoUri} size={68} fontSize={22} />
            <View
              style={{
                position: "absolute",
                right: -2,
                bottom: -2,
                width: 24,
                height: 24,
                borderRadius: 12,
                backgroundColor: colors.toastBg,
                borderWidth: 2,
                borderColor: colors.bg,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Svg width={12} height={12} viewBox="0 0 12 12" fill="none">
                <Path d="M1.5 4h2l1-1.5h3l1 1.5h2v5.5h-9z" stroke={colors.textSecondary} strokeWidth={1.4} strokeLinejoin="round" />
                <Circle cx={6} cy={6.5} r={1.6} stroke={colors.textSecondary} strokeWidth={1.4} />
              </Svg>
            </View>
          </PressableOpacity>
          <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
            <PressableOpacity
              onPress={() => setSheet("name")}
              accessibilityLabel={t("me.name.title")}
              style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
            >
              <AppText numberOfLines={1} style={{ fontSize: 24, fontWeight: "700", letterSpacing: -0.2, color: colors.text, flexShrink: 1 }}>
                {name}
              </AppText>
              <Svg width={14} height={14} viewBox="0 0 14 14" fill="none">
                <Path d="M9.5 2.5l2 2L5 11l-2.5.5L3 9z" stroke={colors.textFaint} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
              </Svg>
            </PressableOpacity>
            {user?.email ? <AppText style={{ fontFamily: font.mono, fontSize: 12, color: colors.textMuted }}>{user.email}</AppText> : null}
          </View>
        </View>

        <MonoLabel style={{ paddingBottom: 10, letterSpacing: 1.6 }}>{t("me.subscription")}</MonoLabel>
        <View style={{ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 14, paddingHorizontal: 16 }}>
          <View style={{ gap: 5, paddingVertical: 16 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
              <AppText variant="sheetTitle" style={{ flexShrink: 1 }}>{card.title}</AppText>
              {card.price ? <AppText style={{ fontSize: 14, color: colors.textSecondary }}>{card.price}</AppText> : null}
            </View>
            {card.meta ? <AppText variant="caption" style={{ lineHeight: 19 }}>{card.meta}</AppText> : null}
          </View>
          {card.bands !== null ? (
            <CardRow
              title={t("me.plan.bands")}
              value={card.bands === 1 ? t("me.plan.bandsOne") : t("me.plan.bandsMany", { n: card.bands })}
              onPress={() => band && router.push({ pathname: "/billing/linked", params: { bandId: band.id, from: "me" } })}
            />
          ) : null}
          {card.cta ? <CardRow title={card.cta.label} accent onPress={card.cta.go} /> : null}
        </View>

        <MonoLabel style={{ paddingTop: 32, paddingBottom: 4, letterSpacing: 1.6 }}>{t("me.support")}</MonoLabel>
        <ListRow title={t("me.contact")} chevron onPress={() => router.push("/contact")} />
        <ListRow title={t("me.signOut")} muted onPress={onSignOut} />
        {/* 디자인에는 없지만 스토어 심사상 앱 안에서 탈퇴할 수 있어야 한다 (2026-10-06 스펙 "디자인 갭") */}
        <ListRow title={t("me.deleteAccount")} danger onPress={() => setConfirmDelete(true)} />
      </ScrollView>

      <BottomSheet
        visible={sheet === "name"}
        onClose={close}
        title={t("me.name.title")}
        subtitle={t("me.name.subtitle")}
      >
        {sheet === "name" ? <RenameSheet initial={name} onSave={saveName} /> : null}
      </BottomSheet>
      <PhotoSheet
        visible={sheet === "photo"}
        hasPhoto={photoUri !== null}
        busy={busy}
        onClose={close}
        onPick={pickPhoto}
        onRemove={removePhoto}
      />
      <ConfirmDialog
        visible={confirmDelete}
        title={t("me.delete.title")}
        body={t("me.delete.body")}
        primary={{ label: t("me.delete.primary"), danger: true, onPress: onDelete }}
        cancelLabel={t("common.cancel")}
        onCancel={() => setConfirmDelete(false)}
        busy={busy}
      />
    </Screen>
  );
}

/** 구독 카드 안의 행 — 위 구분선, 우측 값 + › */
function CardRow({ title, value, accent = false, onPress }: { title: string; value?: string; accent?: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <PressableOpacity
      onPress={onPress}
      style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 14, borderTopWidth: 1, borderTopColor: colors.border }}
    >
      <AppText style={{ fontSize: 15, color: accent ? colors.accent : colors.text }}>{title}</AppText>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {value ? <AppText style={{ fontSize: 14, color: colors.textMuted }}>{value}</AppText> : null}
        <AppText style={{ fontSize: 18, lineHeight: 18, color: colors.borderHover }}>›</AppText>
      </View>
    </PressableOpacity>
  );
}

/** SUPPORT 아래 행 — Contact us(›, 아래 구분선), Sign out(회색), Delete account(빨강) */
function ListRow({ title, chevron = false, muted = false, danger = false, onPress }: {
  title: string; chevron?: boolean; muted?: boolean; danger?: boolean; onPress: () => void;
}) {
  const { colors } = useTheme();
  const color = danger ? colors.danger : muted ? colors.textMuted : colors.text;
  return (
    <PressableOpacity
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingVertical: 16,
        borderBottomWidth: chevron ? 1 : 0,
        borderBottomColor: colors.border,
        borderRadius: radius.row,
      }}
    >
      <AppText style={{ fontSize: 15, color }}>{title}</AppText>
      {chevron ? <AppText style={{ fontSize: 18, lineHeight: 18, color: colors.borderHover }}>›</AppText> : null}
    </PressableOpacity>
  );
}
