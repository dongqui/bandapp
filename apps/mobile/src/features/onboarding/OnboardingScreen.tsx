import { useRouter } from "expo-router";
import { useState } from "react";
import { TextInput, View } from "react-native";
import { useApi } from "@/api";
import { useCurrentBandContext } from "@/features/band/CurrentBandProvider";
import { parseInviteToken } from "@/features/invites/parseInviteToken";
import { radius, useTheme } from "@/theme";
import { AppText, PressableOpacity, Screen, useToast } from "@/ui";

type Mode = "menu" | "create" | "join";

export function OnboardingScreen() {
  const api = useApi();
  const router = useRouter();
  const toast = useToast();
  const { colors } = useTheme();
  const { setCurrentBand } = useCurrentBandContext();
  const [mode, setMode] = useState<Mode>("menu");
  const [name, setName] = useState("");
  const [inviteInput, setInviteInput] = useState("");
  const [busy, setBusy] = useState(false);

  async function createBand() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const band = await api.bands.create(trimmed);
      setCurrentBand(band.id);
      router.replace("/");
    } catch {
      toast.show("팀 만들기에 실패했어요. 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  function openInvite() {
    const token = parseInviteToken(inviteInput);
    if (!token) {
      toast.show("초대 링크를 확인해 주세요.");
      return;
    }
    router.push(`/invite/${token}`);
  }

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: "center", gap: 12, paddingHorizontal: 24 }}>
        {mode === "menu" && (
          <>
            <AppText variant="title">함께 연습할{"\n"}팀을 만들어볼까요?</AppText>
            <View style={{ height: 20 }} />
            <PressableOpacity
              onPress={() => setMode("create")}
              style={{
                height: 48,
                borderRadius: radius.input,
                backgroundColor: colors.accent,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <AppText style={{ fontSize: 14, fontWeight: "600", color: colors.bg }}>
                새 팀 만들기
              </AppText>
            </PressableOpacity>
            <PressableOpacity
              onPress={() => setMode("join")}
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
                초대 링크로 참가
              </AppText>
            </PressableOpacity>
          </>
        )}
        {mode === "create" && (
          <>
            <PressableOpacity onPress={() => setMode("menu")} style={{ alignSelf: "flex-start" }}>
              <AppText variant="caption">← 뒤로</AppText>
            </PressableOpacity>
            <AppText variant="title">팀 이름을 정해주세요</AppText>
            <TextInput
              value={name}
              onChangeText={setName}
              onSubmitEditing={createBand}
              placeholder="FRIDAY NIGHT"
              placeholderTextColor={colors.textFaint}
              autoFocus
              style={{
                backgroundColor: colors.surface,
                borderWidth: 1,
                borderColor: colors.borderStrong,
                borderRadius: radius.input,
                paddingVertical: 11,
                paddingHorizontal: 14,
                color: colors.text,
                fontSize: 14,
              }}
            />
            <PressableOpacity
              onPress={createBand}
              disabled={busy}
              style={{
                height: 48,
                borderRadius: radius.input,
                backgroundColor: colors.accent,
                alignItems: "center",
                justifyContent: "center",
                opacity: busy ? 0.6 : 1,
              }}
            >
              <AppText style={{ fontSize: 14, fontWeight: "600", color: colors.bg }}>
                만들기
              </AppText>
            </PressableOpacity>
          </>
        )}
        {mode === "join" && (
          <>
            <PressableOpacity onPress={() => setMode("menu")} style={{ alignSelf: "flex-start" }}>
              <AppText variant="caption">← 뒤로</AppText>
            </PressableOpacity>
            <AppText variant="title">초대 링크를 붙여넣어 주세요</AppText>
            <TextInput
              value={inviteInput}
              onChangeText={setInviteInput}
              onSubmitEditing={openInvite}
              placeholder="https://bandapp.app/invite/..."
              placeholderTextColor={colors.textFaint}
              autoFocus
              style={{
                backgroundColor: colors.surface,
                borderWidth: 1,
                borderColor: colors.borderStrong,
                borderRadius: radius.input,
                paddingVertical: 11,
                paddingHorizontal: 14,
                color: colors.text,
                fontSize: 14,
              }}
            />
            <PressableOpacity
              onPress={openInvite}
              style={{
                height: 48,
                borderRadius: radius.input,
                backgroundColor: colors.accent,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <AppText style={{ fontSize: 14, fontWeight: "600", color: colors.bg }}>
                참가하기
              </AppText>
            </PressableOpacity>
          </>
        )}
      </View>
    </Screen>
  );
}
