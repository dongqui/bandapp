import { Modal, Pressable, View } from "react-native";
import { radius, useTheme } from "@/theme";
import { AppText } from "./AppText";
import { PressableOpacity } from "./PressableOpacity";

export interface ConfirmAction {
  label: string;
  onPress: () => void;
}

/**
 * 디자인의 중앙 확인 다이얼로그. Alert.alert로는 보조 버튼 색과 본문 스타일을 못 맞춰 직접 만든다
 * (2026-09-08 스펙 결정 10). 주 버튼은 danger(빨강)/safe(accent), 보조는 빨간 텍스트, 취소는 회색 텍스트.
 */
export function ConfirmDialog({
  visible,
  title,
  body,
  primary,
  secondary,
  cancelLabel,
  onCancel,
  busy = false,
}: {
  visible: boolean;
  title: string;
  body: string;
  primary: ConfirmAction & { danger?: boolean };
  secondary?: ConfirmAction;
  cancelLabel: string;
  onCancel: () => void;
  busy?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onCancel}>
      <Pressable
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", paddingHorizontal: 32 }}
        onPress={busy ? undefined : onCancel}
      >
        <Pressable
          onPress={() => undefined}
          style={{
            backgroundColor: colors.surfaceRaised,
            borderRadius: radius.chipLg,
            paddingTop: 24,
            paddingHorizontal: 20,
            paddingBottom: 14,
            gap: 8,
          }}
        >
          <AppText variant="sheetTitle">{title}</AppText>
          <AppText variant="caption" style={{ lineHeight: 20 }}>
            {body}
          </AppText>
          <View style={{ gap: 4, marginTop: 14 }}>
            <PressableOpacity
              onPress={primary.onPress}
              disabled={busy}
              style={{
                backgroundColor: primary.danger ? colors.danger : colors.accent,
                borderRadius: radius.input,
                paddingVertical: 13,
                alignItems: "center",
                opacity: busy ? 0.6 : 1,
              }}
            >
              <AppText style={{ fontSize: 14, fontWeight: "600", color: colors.bg }}>{primary.label}</AppText>
            </PressableOpacity>
            {secondary ? (
              <PressableOpacity
                onPress={secondary.onPress}
                disabled={busy}
                style={{ paddingVertical: 12, alignItems: "center", borderRadius: radius.input }}
              >
                <AppText style={{ fontSize: 14, color: colors.danger }}>{secondary.label}</AppText>
              </PressableOpacity>
            ) : null}
            <PressableOpacity
              onPress={onCancel}
              disabled={busy}
              style={{ paddingVertical: 12, alignItems: "center", borderRadius: radius.input }}
            >
              <AppText style={{ fontSize: 14, color: colors.textMuted }}>{cancelLabel}</AppText>
            </PressableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
