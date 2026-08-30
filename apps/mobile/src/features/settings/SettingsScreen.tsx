import { ApiError } from "@bandapp/api-client";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert, View } from "react-native";
import { useAuth } from "@/features/auth/AuthProvider";
import { AppText, PressableOpacity, Screen, useToast } from "@/ui";

export function SettingsScreen() {
  const { state, signOut, deleteAccount } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const displayName = state.status === "authenticated" ? state.user.displayName : null;

  function confirmSignOut() {
    Alert.alert("로그아웃할까요?", undefined, [
      { text: "취소", style: "cancel" },
      {
        text: "로그아웃",
        style: "destructive",
        onPress: () => void runSignOut(),
      },
    ]);
  }

  async function runSignOut() {
    if (busy) return;
    setBusy(true);
    try {
      await signOut(); // 서버 refresh 세션 revoke + SecureStore 삭제 → 가드가 /login으로
    } catch {
      toast.show("로그아웃에 실패했어요. 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  function confirmDelete() {
    Alert.alert("정말 탈퇴할까요?", "모든 기기에서 로그아웃되고 계정 정보가 삭제돼요.", [
      { text: "취소", style: "cancel" },
      { text: "탈퇴하기", style: "destructive", onPress: () => void runDelete() },
    ]);
  }

  async function runDelete() {
    if (busy) return;
    setBusy(true);
    try {
      await deleteAccount();
    } catch (err) {
      // 유일 owner인 밴드가 있으면 서버가 409로 막는다 (기획서 18장)
      const message =
        err instanceof ApiError && err.status === 409
          ? err.message
          : "탈퇴에 실패했어요. 잠시 후 다시 시도해 주세요.";
      toast.show(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <View style={{ flex: 1, gap: 12, paddingHorizontal: 24, paddingTop: 24 }}>
        <AppText variant="title">설정</AppText>
        {displayName && <AppText>{displayName}</AppText>}
        <PressableOpacity onPress={confirmSignOut} disabled={busy}>
          <AppText>로그아웃</AppText>
        </PressableOpacity>
        <PressableOpacity onPress={confirmDelete} disabled={busy}>
          <AppText>회원 탈퇴</AppText>
        </PressableOpacity>
        <PressableOpacity onPress={() => router.back()}>
          <AppText>닫기</AppText>
        </PressableOpacity>
      </View>
    </Screen>
  );
}
