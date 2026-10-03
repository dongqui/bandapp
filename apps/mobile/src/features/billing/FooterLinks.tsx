import { Linking, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/theme";
import { AppText, PressableOpacity, useToast } from "@/ui";

export type FooterLink = "terms" | "privacy" | "help";

// 빌드 타임에 인라인되는 env는 정적 접근만 가능하다
const URLS: Record<FooterLink, string> = {
  terms: process.env.EXPO_PUBLIC_TERMS_URL ?? "",
  privacy: process.env.EXPO_PUBLIC_PRIVACY_URL ?? "",
  help: process.env.EXPO_PUBLIC_BILLING_HELP_URL ?? "",
};

/** 링크 열기. URL이 없거나 열 수 없으면 "준비 중" 토스트 */
export function useOpenLink() {
  const { t } = useTranslation();
  const toast = useToast();
  return (key: FooterLink) => {
    const url = URLS[key];
    if (!url) return toast.show(t("billing.links.comingSoon"));
    Linking.openURL(url).catch(() => toast.show(t("billing.links.comingSoon")));
  };
}

/** B02/B04 하단 약관·개인정보·결제 문의 링크 */
export function FooterLinks({ items }: { items: Array<{ key: FooterLink; label: string }> }) {
  const { colors } = useTheme();
  const open = useOpenLink();
  return (
    <View style={{ flexDirection: "row", justifyContent: "center", gap: 20, paddingTop: 4 }}>
      {items.map((i) => (
        <PressableOpacity key={i.key} onPress={() => open(i.key)} style={{ padding: 6 }}>
          <AppText variant="caption" style={{ textDecorationLine: "underline", color: colors.textMuted }}>{i.label}</AppText>
        </PressableOpacity>
      ))}
    </View>
  );
}
