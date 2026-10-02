import { defaultTakeName, TAKE_NAME_MAX, type Take } from "@bandapp/types";
import { useEffect, useState } from "react";
import { TextInput, View } from "react-native";
import { useApi } from "@/api";
import { radius, useTheme } from "@/theme";
import { AppText, BottomSheet, PressableOpacity, useToast } from "@/ui";

/**
 * "Rename take" 시트 (2026-10-02 디자인 "Take name"). 입력을 비우거나 기본 이름 그대로 두고 저장하면 서버가
 * 기본 이름 "Take n"으로 되돌린다(null 전송). 저장 뒤 onSaved로 목록을 새로 읽는다. take가 null이면 닫힌 상태.
 */
export function TakeRenameSheet({ take, onClose, onSaved }: { take: Take | null; onClose: () => void; onSaved: () => void }) {
  const api = useApi();
  const toast = useToast();
  const { colors } = useTheme();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  // 열 때마다 현재 이름으로 채운다 — take는 열 때 잡아 둔 객체라 폴링으로 목록이 바뀌어도 입력이 리셋되지 않는다
  useEffect(() => {
    if (take) setValue(take.name);
  }, [take]);
  const placeholder = take ? defaultTakeName(take.index) : "";

  const save = async () => {
    if (!take || saving) return;
    const trimmed = value.trim();
    setSaving(true);
    try {
      await api.takes.rename(take.id, trimmed.length === 0 || trimmed === placeholder ? null : trimmed);
      toast.show("Take renamed");
      onSaved();
      onClose();
    } catch {
      toast.show("Something went wrong");
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet visible={take !== null} onClose={onClose} title="Take name">
      <View style={{ paddingHorizontal: 4 }}>
        <TextInput
          value={value}
          onChangeText={setValue}
          placeholder={placeholder}
          placeholderTextColor={colors.textFaint}
          autoFocus
          selectTextOnFocus
          maxLength={TAKE_NAME_MAX}
          returnKeyType="done"
          onSubmitEditing={() => void save()}
          style={{
            backgroundColor: colors.surfaceSunken,
            borderWidth: 1,
            borderColor: colors.borderStrong,
            borderRadius: radius.input,
            paddingVertical: 12,
            paddingHorizontal: 14,
            fontSize: 15,
            color: colors.text,
          }}
        />
        <AppText variant="small" style={{ marginTop: 8 }}>{`Leave empty to use ${placeholder}.`}</AppText>
        <PressableOpacity
          onPress={() => void save()}
          disabled={saving}
          style={{ marginTop: 14, backgroundColor: colors.accent, borderRadius: radius.input, paddingVertical: 13, alignItems: "center", opacity: saving ? 0.6 : 1 }}
        >
          <AppText style={{ fontSize: 14, fontWeight: "600", color: colors.bg }}>{saving ? "Saving…" : "Save"}</AppText>
        </PressableOpacity>
      </View>
    </BottomSheet>
  );
}
