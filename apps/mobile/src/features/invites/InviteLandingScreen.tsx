import type { InvitePreview } from "@bandapp/types";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useApi } from "@/api";
import { useAuth } from "@/features/auth/AuthProvider";
import { useCurrentBandContext } from "@/features/band/CurrentBandProvider";
import { AppText, PressableOpacity, Screen, useToast } from "@/ui";
import { savePendingInviteToken } from "./pendingInvite";

export function InviteLandingScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const api = useApi();
  const router = useRouter();
  const toast = useToast();
  const { state } = useAuth();
  const { setCurrentBand, refreshBands } = useCurrentBandContext();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [joining, setJoining] = useState(false);
  const [alreadyMember, setAlreadyMember] = useState(false);
  const [joinedBandId, setJoinedBandId] = useState<string | null>(null);

  // useApiData는 오류를 상태로 노출하지 않으므로(콘솔 경고 후 data만 유지) 만료 안내(기획서 13장)를
  // 보여주려면 직접 로드해서 실패를 구분해야 한다.
  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setNotFound(false);
    api.invites
      .preview(token)
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch(() => {
        if (!cancelled) setNotFound(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api, token]);

  async function join() {
    if (state.status !== "authenticated") {
      // 로그인 후 원래 하려던 참가를 이어간다 (기획서 14장)
      await savePendingInviteToken(token);
      router.push("/login");
      return;
    }
    if (joining) return;
    setJoining(true);
    try {
      const result = await api.invites.join(token);
      setJoinedBandId(result.bandId);
      if (result.alreadyMember) {
        setAlreadyMember(true); // "이미 멤버예요" 상태로 전환 (기획서 15장)
        return;
      }
      setCurrentBand(result.bandId); // 참가한 밴드가 현재 밴드로 (기획서 14장)
      await refreshBands(); // bandGate가 새 밴드를 보고 온보딩으로 되돌리지 않도록 리스트를 먼저 갱신
      toast.show(`${preview?.band.name ?? "팀"}에 참가했어요.`);
      router.replace("/");
    } catch {
      toast.show("팀 참가에 실패했어요. 다시 시도해 주세요.");
    } finally {
      setJoining(false);
    }
  }

  if (notFound) {
    return (
      <Screen>
        <View style={{ flex: 1, justifyContent: "center", gap: 12, paddingHorizontal: 24 }}>
          <AppText>초대장을 찾을 수 없어요.{"\n"}링크가 만료됐을 수 있어요.</AppText>
        </View>
      </Screen>
    );
  }
  if (!preview) return <Screen>{null}</Screen>; // 로딩

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: "center", gap: 12, paddingHorizontal: 24 }}>
        <AppText variant="title">{preview.band.name}</AppText>
        {alreadyMember ? (
          <>
            <AppText>이미 {preview.band.name}의 멤버예요.</AppText>
            <PressableOpacity
              onPress={() => {
                if (joinedBandId) setCurrentBand(joinedBandId);
                router.replace("/");
              }}
            >
              <AppText>팀으로 이동</AppText>
            </PressableOpacity>
          </>
        ) : (
          <>
            <AppText>
              {preview.invitedBy.displayName ?? "멤버"}님이{"\n"}
              {preview.band.name}에 초대했어요.
            </AppText>
            <AppText variant="caption">멤버 {preview.band.memberCount}명</AppText>
            {state.status !== "authenticated" && (
              <AppText variant="caption">팀에 참가하려면 로그인해 주세요.</AppText>
            )}
            <PressableOpacity onPress={join} disabled={joining}>
              <AppText>{state.status === "authenticated" ? "팀 참가하기" : "로그인하고 참가하기"}</AppText>
            </PressableOpacity>
          </>
        )}
      </View>
    </Screen>
  );
}
