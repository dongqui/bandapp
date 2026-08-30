import { useState } from "react";
import { Platform, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";
import { AppText, PressableOpacity, Screen, useToast } from "@/ui";
import { useTheme } from "@/theme";
import { seededUnit } from "@/lib/seed";
import { useAuth } from "./AuthProvider";
import { AuthCancelledError } from "./errors";
import { resolvePendingInvite } from "@/features/invites/pendingInvite";

// 시안의 인증 화면 웨이브: 21개 바 중 가운데(8~12번)만 액센트 색
function AuthWave() {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 3, height: 56, marginBottom: 8 }}>
      {Array.from({ length: 21 }, (_, i) => (
        <View
          key={i}
          style={{
            width: 3,
            borderRadius: 1.5,
            backgroundColor: i >= 8 && i <= 12 ? colors.accent : colors.borderStronger,
            height: Math.round(8 + seededUnit(i * 11.7 + 4) * 44),
          }}
        />
      ))}
    </View>
  );
}

function GoogleLogo() {
  return (
    <Svg width={18} height={18} viewBox="0 0 18 18">
      <Path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92a8.78 8.78 0 0 0 2.68-6.62z"
      />
      <Path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.32A9 9 0 0 0 9 18z"
      />
      <Path
        fill="#FBBC05"
        d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.96H.96a9 9 0 0 0 0 8.08l3.01-2.32z"
      />
      <Path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59A9 9 0 0 0 .96 4.96l3.01 2.32C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </Svg>
  );
}

function AppleLogo({ color }: { color: string }) {
  return (
    <Svg width={16} height={19} viewBox="0 0 16 19" fill={color}>
      <Path d="M13.06 10.05c-.02-2.13 1.74-3.15 1.82-3.2-1-1.45-2.54-1.65-3.08-1.67-1.3-.13-2.55.77-3.21.77-.67 0-1.69-.75-2.78-.73-1.43.02-2.75.83-3.48 2.11-1.49 2.58-.38 6.39 1.07 8.48.71 1.02 1.55 2.17 2.65 2.13 1.07-.04 1.47-.69 2.76-.69 1.28 0 1.65.69 2.77.67 1.15-.02 1.87-1.04 2.57-2.07.81-1.19 1.14-2.34 1.16-2.4-.03-.01-2.23-.86-2.25-3.4z" />
      <Path d="M10.95 3.81c.59-.71.98-1.7.87-2.69-.84.03-1.87.56-2.47 1.27-.54.63-1.02 1.63-.89 2.6.94.07 1.9-.48 2.49-1.18z" />
    </Svg>
  );
}

export function LoginScreen() {
  const { signInWithGoogle, signInWithApple } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const insets = useSafeAreaInsets();
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

  const buttonBase = {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    borderRadius: 12,
    paddingVertical: 15,
  } as const;

  return (
    <Screen padTop={false}>
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          gap: 22,
          paddingHorizontal: 36,
        }}
      >
        <AuthWave />
        <View style={{ alignItems: "center", gap: 10 }}>
          <AppText
            style={{
              fontSize: 30,
              fontWeight: "700",
              letterSpacing: -0.3,
              color: colors.text,
              textAlign: "center",
            }}
          >
            Every rehearsal,{"\n"}on the record.
          </AppText>
          <AppText style={{ fontSize: 14, color: colors.textMuted, lineHeight: 21, textAlign: "center" }}>
            Record or import a rehearsal —{"\n"}we find the takes, your band leaves feedback.
          </AppText>
        </View>
      </View>
      <View
        style={{
          paddingHorizontal: 24,
          paddingBottom: insets.bottom + 24,
          gap: 12,
        }}
      >
        <PressableOpacity
          onPress={() => run(signInWithGoogle)}
          disabled={busy}
          style={{ ...buttonBase, backgroundColor: colors.text }}
        >
          <GoogleLogo />
          <AppText style={{ fontSize: 15, fontWeight: "600", color: colors.bg }}>
            Continue with Google
          </AppText>
        </PressableOpacity>
        {Platform.OS === "ios" && (
          <PressableOpacity
            onPress={() => run(signInWithApple)}
            disabled={busy}
            style={{
              ...buttonBase,
              backgroundColor: colors.surface,
              borderWidth: 1,
              borderColor: colors.borderStrong,
            }}
          >
            <AppleLogo color={colors.text} />
            <AppText style={{ fontSize: 15, fontWeight: "600", color: colors.text }}>
              Continue with Apple
            </AppText>
          </PressableOpacity>
        )}
        <AppText
          style={{
            fontSize: 11,
            color: colors.textFaint,
            lineHeight: 16.5,
            textAlign: "center",
            marginTop: 6,
          }}
        >
          By continuing you agree to the <AppText style={{ fontSize: 11, color: colors.accent }}>Terms</AppText> and{" "}
          <AppText style={{ fontSize: 11, color: colors.accent }}>Privacy Policy</AppText>.
        </AppText>
      </View>
    </Screen>
  );
}
