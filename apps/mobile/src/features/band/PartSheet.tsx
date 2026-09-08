import { BAND_PART_PRESETS } from "@bandapp/types";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { TextInput, View } from "react-native";
import { radius, useTheme } from "@/theme";
import { AppText, BottomSheet, PressableOpacity } from "@/ui";
import { normalizePartInput } from "./partValue";
import { SheetRow } from "./SheetRow";

/** 프리셋 5개 + 직접 입력. onSubmit은 정규화된 값(프리셋 키 또는 trim된 자유 문자열)만 받는다. */
export function PartSheet({
  visible,
  onClose,
  current,
  onSubmit,
}: {
  visible: boolean;
  onClose: () => void;
  current: string | null;
  onSubmit: (part: string) => void;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  useEffect(() => {
    if (visible) setInput("");
  }, [visible]);

  const submitCustom = () => {
    const value = normalizePartInput(input, t);
    if (value === null) return; // 빈 입력은 무시
    onSubmit(value);
  };

  return (
    <BottomSheet visible={visible} onClose={onClose} title={t("band.part.title")} subtitle={t("band.part.subtitle")}>
      {BAND_PART_PRESETS.map((key) => (
        <SheetRow
          key={key}
          title={t(`band.part.preset.${key}`)}
          onPress={() => onSubmit(key)}
          trailing={current === key ? <AppText style={{ color: colors.accent, fontSize: 16 }}>✓</AppText> : null}
        />
      ))}
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center", marginTop: 10, paddingHorizontal: 4 }}>
        <TextInput
          value={input}
          onChangeText={setInput}
          onSubmitEditing={submitCustom}
          placeholder={t("band.part.placeholder")}
          placeholderTextColor={colors.textFaint}
          returnKeyType="done"
          style={{
            flex: 1,
            backgroundColor: colors.surfaceSunken,
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
          onPress={submitCustom}
          style={{
            width: 42,
            height: 42,
            borderRadius: 21,
            backgroundColor: colors.accent,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <AppText style={{ color: colors.bg, fontSize: 16 }}>✓</AppText>
        </PressableOpacity>
      </View>
    </BottomSheet>
  );
}
