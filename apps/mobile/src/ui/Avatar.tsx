import { Image, View } from "react-native";
import { useTheme } from "@/theme";
import { AppText } from "./AppText";

export function Avatar({
  label,
  uri,
  size = 40,
  dashed = false,
  fontSize,
}: {
  label: string;
  /** 프로필 사진 URL. 있으면 이니셜 대신 사진을 꽉 채운다 */
  uri?: string | null;
  size?: number;
  dashed?: boolean;
  /** 작은 아바타(코멘트 30 / 답글 24)용. 기본은 monoAvatar 크기 */
  fontSize?: number;
}) {
  const { colors } = useTheme();
  if (uri) {
    return (
      <Image
        source={{ uri }}
        style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.surfaceRaised }}
        accessibilityLabel={label}
      />
    );
  }
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: dashed ? undefined : colors.surfaceRaised,
        borderWidth: dashed ? 1 : 0,
        borderStyle: dashed ? "dashed" : undefined,
        borderColor: colors.borderStronger,
      }}
    >
      <AppText
        variant="monoAvatar"
        color={dashed ? colors.textMuted : colors.textSecondary}
        style={fontSize ? { fontSize } : null}
      >
        {label}
      </AppText>
    </View>
  );
}
