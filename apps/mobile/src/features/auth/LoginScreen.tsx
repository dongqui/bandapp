import * as AppleAuthentication from "expo-apple-authentication";
import { useState } from "react";
import { Platform, View } from "react-native";
import { useRouter } from "expo-router";
import { AppText, PressableOpacity, Screen, useToast } from "@/ui";
import { radius, useTheme } from "@/theme";
import { useAuth } from "./AuthProvider";
import { AuthCancelledError } from "./errors";
import { resolvePendingInvite } from "@/features/invites/pendingInvite";

export function LoginScreen() {
  const { signInWithGoogle, signInWithApple } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);

  async function run(signIn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    try {
      await signIn();
      // 로그인 때문에 원래 하려던 초대 참가를 잃어버리면 안 된다 (기획서 14장)
      const invite = await resolvePendingInvite();
      router.replace(invite ? `/invite/${invite}` : "/");
    } catch (err) {
      if (err instanceof AuthCancelledError) return; // 취소 → Toast 없이 화면 유지
      // 오류 문구는 기획서 19장
      const message =
        err instanceof TypeError
          ? "연결을 확인하고 다시 시도해 주세요."
          : "로그인에 실패했어요. 다시 시도해 주세요.";
      toast.show(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: "center", gap: 12, paddingHorizontal: 24 }}>
        <AppText variant="title">BANDAPP</AppText>
        <AppText>합주를 기록하고{"\n"}함께 다시 들어보세요.</AppText>
        <View style={{ height: 32 }} />
        {Platform.OS === "ios" && (
          <AppleAuthentication.AppleAuthenticationButton
            buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
            buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
            cornerRadius={radius.input}
            style={{ height: 48 }}
            onPress={() => run(signInWithApple)}
          />
        )}
        <PressableOpacity
          onPress={() => run(signInWithGoogle)}
          disabled={busy}
          style={{
            height: 48,
            borderRadius: radius.input,
            borderWidth: 1,
            borderColor: colors.borderStrong,
            backgroundColor: colors.surfaceRaised,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <AppText style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>
            Google로 계속하기
          </AppText>
        </PressableOpacity>
        <AppText variant="caption">계속하면 이용약관 및{"\n"}개인정보처리방침에 동의합니다.</AppText>
      </View>
    </Screen>
  );
}
