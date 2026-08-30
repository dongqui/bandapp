import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { View } from "react-native";
import { useApiData } from "@/api";
import { font, radius, useTheme } from "@/theme";
import { AppText, BottomSheet, PressableOpacity } from "@/ui";

export function InviteSheet({
  visible,
  onClose,
  bandId,
}: {
  visible: boolean;
  onClose: () => void;
  bandId: string;
}) {
  const { colors } = useTheme();
  const [copied, setCopied] = useState(false);
  const { data: invite } = useApiData((api) => api.bands.createInvite(bandId), [bandId]);
  const link = invite?.url;
  const copy = async () => {
    if (!link) return;
    await Clipboard.setStringAsync(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="Invite your band"
      subtitle="Send a link to invite members."
    >
      <View
        style={{
          marginTop: 6,
          marginHorizontal: 4,
          backgroundColor: colors.surfaceSunken,
          borderWidth: 1,
          borderColor: colors.borderStrong,
          borderRadius: radius.input,
          paddingVertical: 13,
          paddingHorizontal: 14,
        }}
      >
        <AppText style={{ fontFamily: font.mono, fontSize: 13, color: colors.textSecondary }}>
          {link ?? ""}
        </AppText>
      </View>
      <PressableOpacity
        onPress={copy}
        style={{
          marginTop: 12,
          marginHorizontal: 4,
          backgroundColor: colors.accent,
          borderRadius: radius.input,
          paddingVertical: 13,
          alignItems: "center",
        }}
      >
        <AppText style={{ fontSize: 14, fontWeight: "600", color: colors.bg }}>
          {copied ? "Copied" : "Copy link"}
        </AppText>
      </PressableOpacity>
    </BottomSheet>
  );
}
