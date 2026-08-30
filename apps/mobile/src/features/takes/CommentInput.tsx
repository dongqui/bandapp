import { useState } from "react";
import { TextInput, View } from "react-native";
import { radius, space, useTheme } from "@/theme";
import { AppText, PressableOpacity } from "@/ui";

export function CommentInput({
  placeholder,
  onSubmit,
}: {
  placeholder: string;
  onSubmit: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const { colors } = useTheme();
  const send = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setText("");
  };
  return (
    <View
      style={{
        flexDirection: "row",
        gap: 10,
        paddingHorizontal: space.sheetX,
        paddingTop: 12,
        paddingBottom: 30,
        borderTopWidth: 1,
        borderTopColor: colors.surfaceRaised,
        backgroundColor: colors.bg,
      }}
    >
      <TextInput
        value={text}
        onChangeText={setText}
        onSubmitEditing={send}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        style={{
          flex: 1,
          backgroundColor: colors.surface,
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
        onPress={send}
        style={{
          width: 42,
          height: 42,
          borderRadius: 21,
          backgroundColor: colors.accent,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <AppText style={{ fontSize: 18, color: colors.bg }}>↑</AppText>
      </PressableOpacity>
    </View>
  );
}
