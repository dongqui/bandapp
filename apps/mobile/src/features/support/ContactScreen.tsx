import { SUPPORT_BODY_MAX, SUPPORT_TOPICS, type SupportTopic } from "@bandapp/types";
import { useRouter } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApi } from "@/api";
import { useAuth } from "@/features/auth/AuthProvider";
import { BillingHeader } from "@/features/billing/BillingHeader";
import { apiErrorMessage } from "@/i18n/apiErrorMessage";
import { radius, space, useTheme } from "@/theme";
import { AppText, MonoLabel, PressableOpacity, Screen, useToast } from "@/ui";
import { appVersionLabel, deviceLabel } from "./deviceInfo";

const SELECTED_BG = "rgba(91,157,255,0.12)";

/** 디자인 "Contact us" (2026-10-06): 주제 칩 + 본문 → Send. 보내면 Me로 돌아가고 토스트 */
export function ContactScreen() {
  const { state } = useAuth();
  const email = state.status === "authenticated" ? state.user.email : null;
  const api = useApi();
  const router = useRouter();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [topic, setTopic] = useState<SupportTopic | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const canSend = topic !== null && text.trim().length > 0 && !busy;
  const placeholder =
    topic === "billing" ? t("contact.placeholder.billing") : topic === "broken" ? t("contact.placeholder.broken") : t("contact.placeholder.default");

  const send = async () => {
    if (!canSend || !topic) return;
    setBusy(true);
    try {
      await api.support.send({ topic, body: text.trim(), appVersion: appVersionLabel(), device: deviceLabel() });
      router.back();
      toast.show(t("contact.sent"));
    } catch (err) {
      toast.show(apiErrorMessage(err, t));
      setBusy(false);
    }
  };

  return (
    <Screen>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <BillingHeader back={t("contact.back")} onBack={() => router.back()} />
        <View style={{ paddingHorizontal: space.screenX, paddingTop: 2, paddingBottom: 20, gap: 6 }}>
          <AppText variant="title">{t("contact.title")}</AppText>
          <AppText variant="body" color={colors.textMuted} style={{ lineHeight: 21 }}>
            {email ? t("contact.sub", { email }) : t("contact.subNoEmail")}
          </AppText>
        </View>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: space.screenX, paddingBottom: 140, gap: 12 }}
        >
          <MonoLabel style={{ letterSpacing: 1.6 }}>{t("contact.topic")}</MonoLabel>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {SUPPORT_TOPICS.map((key) => {
              const on = topic === key;
              return (
                <PressableOpacity
                  key={key}
                  onPress={() => setTopic(key)}
                  style={{
                    paddingVertical: 9,
                    paddingHorizontal: 14,
                    borderRadius: 18,
                    borderWidth: 1,
                    borderColor: on ? colors.accent : colors.borderStrong,
                    backgroundColor: on ? SELECTED_BG : "transparent",
                  }}
                >
                  <AppText style={{ fontSize: 14, color: on ? colors.text : colors.textSecondary }}>{t(`contact.topics.${key}`)}</AppText>
                </PressableOpacity>
              );
            })}
          </View>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={placeholder}
            placeholderTextColor={colors.textFaint}
            multiline
            textAlignVertical="top"
            maxLength={SUPPORT_BODY_MAX}
            editable={!busy}
            style={{
              marginTop: 10,
              height: 180,
              backgroundColor: colors.surfaceSunken,
              borderWidth: 1,
              borderColor: colors.borderStrong,
              borderRadius: radius.row,
              padding: 14,
              color: colors.text,
              fontSize: 15,
              lineHeight: 22,
            }}
          />
          <AppText variant="caption" style={{ lineHeight: 19 }}>{t("contact.note")}</AppText>
        </ScrollView>
        <View
          style={{
            paddingHorizontal: space.screenX,
            paddingTop: 14,
            paddingBottom: Math.max(34, insets.bottom + 14),
            backgroundColor: colors.bg,
            borderTopWidth: 1,
            borderTopColor: colors.surfaceRaised,
          }}
        >
          <PressableOpacity
            onPress={() => void send()}
            disabled={!canSend}
            style={{
              backgroundColor: canSend ? colors.accent : "#1F2227",
              borderRadius: radius.input,
              paddingVertical: 14,
              alignItems: "center",
            }}
          >
            <AppText style={{ fontSize: 15, fontWeight: "600", color: canSend ? colors.bg : colors.textFaint }}>{t("contact.send")}</AppText>
          </PressableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
