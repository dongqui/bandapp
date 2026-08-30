import { useRouter } from "expo-router";
import { useState } from "react";
import { FlatList, View } from "react-native";
import { useApiData } from "@/api";
import { radius, space, useTheme } from "@/theme";
import { AppText, MonoLabel, PressableOpacity, Screen } from "@/ui";
import { InviteSheet } from "./InviteSheet";
import { MemberRow } from "./MemberRow";
import { useCurrentBand } from "./useCurrentBand";

export function BandScreen() {
  const { band } = useCurrentBand();
  const { data: members } = useApiData(
    async (api) => (band ? api.bands.members(band.id) : []),
    [band?.id],
  );
  const [inviteOpen, setInviteOpen] = useState(false);
  const { colors } = useTheme();
  const router = useRouter();
  return (
    <Screen>
      <View style={{ paddingHorizontal: space.screenX, paddingBottom: 10, gap: 8 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <MonoLabel color={colors.textMuted} style={{ letterSpacing: 1.8 }}>
            YOUR BAND
          </MonoLabel>
          <PressableOpacity onPress={() => router.push("/settings")} style={{ padding: 4 }}>
            <AppText style={{ fontSize: 16, color: colors.textMuted }}>⚙</AppText>
          </PressableOpacity>
        </View>
        <AppText variant="titleXL">{band?.name ?? ""}</AppText>
        <MonoLabel>{`MEMBERS · ${band?.memberCount ?? 0}`}</MonoLabel>
      </View>
      <FlatList
        data={members ?? []}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ paddingHorizontal: space.screenX, paddingBottom: 160 }}
        renderItem={({ item }) => <MemberRow member={item} />}
        ListFooterComponent={
          <PressableOpacity
            onPress={() => setInviteOpen(true)}
            style={{
              marginTop: 20,
              borderWidth: 1,
              borderColor: colors.borderStrong,
              borderRadius: radius.input,
              padding: 14,
              alignItems: "center",
            }}
          >
            <AppText style={{ fontSize: 14, color: colors.accent }}>+ Invite member</AppText>
          </PressableOpacity>
        }
      />
      {band ? (
        <InviteSheet visible={inviteOpen} onClose={() => setInviteOpen(false)} bandId={band.id} />
      ) : null}
    </Screen>
  );
}
