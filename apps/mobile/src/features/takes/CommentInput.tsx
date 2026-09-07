import { useEffect, useRef } from "react";
import { TextInput, View } from "react-native";
import { radius, space, useTheme } from "@/theme";
import { AppText, PressableOpacity } from "@/ui";

export interface ReplyTarget {
  name: string;
  onCancel: () => void;
}

export function CommentInput({
  value,
  onChangeText,
  placeholder,
  onSubmit,
  replyingTo,
}: {
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  onSubmit: () => void;
  /** 답글 모드 — 입력창 위에 "Replying to 이름" 배너가 뜨고 입력창에 포커스가 간다 */
  replyingTo?: ReplyTarget | null;
}) {
  const { colors } = useTheme();
  const inputRef = useRef<TextInput>(null);
  // 같은 사람에게 다시 답글을 시작해도 포커스가 가도록 replyingTo 객체 자체를 의존성으로 둔다 —
  // 호출자가 답글 시작마다 새 객체를 만든다.
  useEffect(() => {
    if (replyingTo) inputRef.current?.focus();
  }, [replyingTo]);

  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.surfaceRaised, backgroundColor: colors.bg }}>
      {replyingTo ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingVertical: 9,
            paddingHorizontal: 20,
            backgroundColor: colors.surfaceSunken,
          }}
        >
          <AppText variant="small" color={colors.textMuted}>
            Replying to{" "}
            <AppText variant="small" color={colors.textSecondary} style={{ fontWeight: "600" }}>
              {replyingTo.name}
            </AppText>
          </AppText>
          <PressableOpacity onPress={replyingTo.onCancel} hitSlop={8} style={{ paddingVertical: 2, paddingHorizontal: 6 }}>
            <AppText variant="small" color={colors.textFaint}>
              ✕
            </AppText>
          </PressableOpacity>
        </View>
      ) : null}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: space.sheetX,
          paddingTop: 12,
          paddingBottom: 30,
        }}
      >
        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={onChangeText}
          onSubmitEditing={onSubmit}
          placeholder={placeholder}
          placeholderTextColor={colors.textFaint}
          style={{
            flex: 1,
            minWidth: 0,
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
          onPress={onSubmit}
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
    </View>
  );
}
