import * as DocumentPicker from "expo-document-picker";
import { useRouter } from "expo-router";
import { View } from "react-native";
import { toLocalIso } from "@/lib/time";
import { font, useTheme } from "@/theme";
import { AppText, BottomSheet, IconCircle, SheetActionRow, useToast } from "@/ui";

const SUPPORTED_MIME_TYPES = ["audio/mp4", "audio/x-m4a", "audio/m4a"];

export function NewSessionSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const router = useRouter();
  const { colors } = useTheme();
  const toast = useToast();
  return (
    <BottomSheet visible={visible} onClose={onClose} title="New session">
      <SheetActionRow
        icon={
          <IconCircle>
            <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: colors.recording }} />
          </IconCircle>
        }
        title="Record now"
        subtitle="Start recording this rehearsal"
        onPress={() => {
          onClose();
          router.push("/record");
        }}
      />
      <SheetActionRow
        icon={
          <IconCircle>
            <AppText style={{ fontFamily: font.mono, fontSize: 16, color: colors.textSecondary }}>↓</AppText>
          </IconCircle>
        }
        title="Import a recording"
        subtitle="Find the takes in an existing recording"
        onPress={async () => {
          onClose();
          let picked;
          try {
            picked = await DocumentPicker.getDocumentAsync({
              type: SUPPORTED_MIME_TYPES,
              copyToCacheDirectory: true,
              multiple: false,
            });
          } catch (error) {
            toast.show("Couldn't open the file picker");
            return;
          }
          if (picked.canceled || !picked.assets[0]) return;
          const asset = picked.assets[0];
          // 원본 wav/영상 가져오기는 백로그: 지금은 m4a만 허용한다
          if (asset.mimeType && !SUPPORTED_MIME_TYPES.includes(asset.mimeType)) {
            toast.show("Only .m4a recordings are supported for now");
            return;
          }
          router.push({
            pathname: "/processing",
            params: { fileUri: asset.uri, source: "import", startedAt: toLocalIso(new Date()) },
          });
        }}
      />
    </BottomSheet>
  );
}
