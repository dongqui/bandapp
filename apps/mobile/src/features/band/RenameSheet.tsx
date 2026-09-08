import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { TextInput } from "react-native";
import { radius, useTheme } from "@/theme";
import { AppText, BottomSheet, PressableOpacity } from "@/ui";

/** 이름 입력. trim 후 빈 값이면 무시. 길이 제한(50)은 서버 400 → 토스트. */
export function RenameSheet({
  visible,
  onClose,
  initial,
  onSave,
}: {
  visible: boolean;
  onClose: () => void;
  initial: string;
  onSave: (name: string) => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [value, setValue] = useState(initial);
  useEffect(() => {
    if (visible) setValue(initial);
  }, [visible, initial]);

  const save = () => {
    const name = value.trim();
    if (name.length === 0) return;
    onSave(name);
  };

  return (
    <BottomSheet visible={visible} onClose={onClose} title={t("band.rename.title")}>
      <TextInput
        value={value}
        onChangeText={setValue}
        onSubmitEditing={save}
        autoFocus
        returnKeyType="done"
        style={{
          marginTop: 2,
          marginHorizontal: 4,
          backgroundColor: colors.surfaceSunken,
          borderWidth: 1,
          borderColor: colors.borderStrong,
          borderRadius: radius.input,
          paddingVertical: 12,
          paddingHorizontal: 14,
          color: colors.text,
          fontSize: 15,
        }}
      />
      <PressableOpacity
        onPress={save}
        style={{
          marginTop: 12,
          marginHorizontal: 4,
          backgroundColor: colors.accent,
          borderRadius: radius.input,
          paddingVertical: 13,
          alignItems: "center",
        }}
      >
        <AppText style={{ fontSize: 14, fontWeight: "600", color: colors.bg }}>{t("common.save")}</AppText>
      </PressableOpacity>
    </BottomSheet>
  );
}
