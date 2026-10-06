import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { radius, useTheme } from "@/theme";
import { AppText, BottomSheet, PressableOpacity } from "@/ui";

/** 디자인 daConfirm 버튼: 녹음 빨강 배경에 흰 글자 (danger 텍스트색과 다르다) */
const CONFIRM_BG = "#FF4545";

/**
 * 디자인 "Delete account?" 시트 (2026-10-06 추가).
 * blocked: 현재 밴드의 오너이고 다른 멤버가 있으면 소유권을 먼저 넘기라고 안내하고 Band로 보낸다.
 * 그 외: 결과 3줄 + (구독이 갱신 예정이면) 구독은 따로 해지하라는 경고 + 빨간 확인 버튼.
 */
export function DeleteAccountSheet({
  visible,
  blockedBand,
  subscriptionStore,
  busy,
  onClose,
  onGoBand,
  onConfirm,
}: {
  visible: boolean;
  /** 소유권을 먼저 넘겨야 하는 밴드 이름. null이면 삭제 가능 */
  blockedBand: string | null;
  /** 갱신 예정인 구독이 있으면 그 스토어 이름 — 경고 박스를 띄운다 */
  subscriptionStore: string | null;
  busy: boolean;
  onClose: () => void;
  onGoBand: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const cancel = (
    <PressableOpacity onPress={onClose} disabled={busy} style={{ padding: 4, alignItems: "center" }}>
      <AppText style={{ fontSize: 14, color: colors.textMuted }}>{t("common.cancel")}</AppText>
    </PressableOpacity>
  );
  return (
    <BottomSheet visible={visible} onClose={busy ? () => undefined : onClose}>
      <View style={{ paddingHorizontal: 4, gap: 14 }}>
        <AppText variant="sheetTitle">{t("me.delete.title")}</AppText>
        {blockedBand !== null ? (
          <>
            <AppText style={{ fontSize: 14, color: colors.textSecondary, lineHeight: 22 }}>
              {t("me.delete.blocked", { band: blockedBand })}
            </AppText>
            <PressableOpacity
              onPress={onGoBand}
              style={{ backgroundColor: colors.accent, borderRadius: radius.input, paddingVertical: 13, alignItems: "center" }}
            >
              <AppText style={{ fontSize: 14, fontWeight: "600", color: colors.bg }}>{t("me.delete.goToBand")}</AppText>
            </PressableOpacity>
            {cancel}
          </>
        ) : (
          <>
            <View style={{ gap: 8 }}>
              {(["bullet1", "bullet2", "bullet3"] as const).map((key) => (
                <View key={key} style={{ flexDirection: "row", gap: 10 }}>
                  <AppText style={{ fontSize: 14, color: colors.textFaint, lineHeight: 21 }}>–</AppText>
                  <AppText style={{ flex: 1, fontSize: 14, color: colors.textSecondary, lineHeight: 21 }}>{t(`me.delete.${key}`)}</AppText>
                </View>
              ))}
            </View>
            {subscriptionStore ? (
              <View style={{ backgroundColor: "#1C1F24", borderRadius: radius.input, paddingVertical: 12, paddingHorizontal: 14 }}>
                <AppText style={{ fontSize: 13, color: colors.textSecondary, lineHeight: 20 }}>
                  {t("me.delete.subscriptionWarn", { store: subscriptionStore })}
                </AppText>
              </View>
            ) : null}
            <PressableOpacity
              onPress={onConfirm}
              disabled={busy}
              style={{
                marginTop: 4,
                backgroundColor: CONFIRM_BG,
                borderRadius: radius.input,
                paddingVertical: 13,
                alignItems: "center",
                opacity: busy ? 0.6 : 1,
              }}
            >
              <AppText style={{ fontSize: 14, fontWeight: "600", color: "#FFFFFF" }}>{t("me.delete.primary")}</AppText>
            </PressableOpacity>
            {cancel}
          </>
        )}
      </View>
    </BottomSheet>
  );
}
