import type { ReactNode } from "react";
import { Modal, Pressable, View } from "react-native";
import { radius, space, useTheme } from "@/theme";
import { AppText } from "./AppText";

export function BottomSheet({
  visible,
  onClose,
  title,
  subtitle,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)" }} onPress={onClose} />
      <View
        style={{
          backgroundColor: colors.surface,
          borderTopLeftRadius: radius.sheet,
          borderTopRightRadius: radius.sheet,
          paddingTop: space.sheetTop,
          paddingHorizontal: space.sheetX,
          paddingBottom: space.sheetBottom,
        }}
      >
        <View
          style={{
            width: 36,
            height: 4,
            borderRadius: 2,
            backgroundColor: colors.borderStronger,
            alignSelf: "center",
            marginBottom: 18,
          }}
        />
        {title ? (
          <AppText variant="sheetTitle" style={{ paddingHorizontal: 8, paddingBottom: subtitle ? 0 : 12 }}>
            {title}
          </AppText>
        ) : null}
        {subtitle ? (
          <AppText variant="caption" style={{ paddingHorizontal: 8, paddingTop: 4, paddingBottom: 12 }}>
            {subtitle}
          </AppText>
        ) : null}
        {children}
      </View>
    </Modal>
  );
}
