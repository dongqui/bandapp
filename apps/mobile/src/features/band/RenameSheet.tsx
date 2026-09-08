import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { TextInput } from "react-native";
import { radius, useTheme } from "@/theme";
import { AppText, PressableOpacity } from "@/ui";

/**
 * 이름 입력. trim 후 빈 값이면 무시. 길이 제한은 입력에서 client-side로 막는다(서버 400은 방어선).
 * BandScreen의 공용 BottomSheet 안에서만 렌더된다 — sheet.kind === "rename"일 때만 마운트되므로
 * 마운트 시점의 초기 state가 곧 "열릴 때 리셋"이다.
 */
export function RenameSheet({
  initial,
  onSave,
}: {
  initial: string;
  onSave: (name: string) => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [value, setValue] = useState(initial);
  const inputRef = useRef<TextInput>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const save = () => {
    const name = value.trim();
    if (name.length === 0) return;
    onSave(name);
  };

  return (
    <>
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={setValue}
        onSubmitEditing={save}
        returnKeyType="done"
        maxLength={50}
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
    </>
  );
}
