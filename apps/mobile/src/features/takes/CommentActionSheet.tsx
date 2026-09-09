import type { TakeComment } from "@bandapp/types";
import { View } from "react-native";
import { useTheme } from "@/theme";
import { AppText, BottomSheet, SheetRow } from "@/ui";

/**
 * 본인 코멘트의 "···" 시트 — 인용문 한 줄 아래 Edit / Delete (디자인 "Take Feedback").
 * comment가 null이면 닫힌 상태.
 */
export function CommentActionSheet({
  comment,
  onClose,
  onEdit,
  onDelete,
}: {
  comment: TakeComment | null;
  onClose: () => void;
  onEdit: (comment: TakeComment) => void;
  onDelete: (comment: TakeComment) => void;
}) {
  const { colors } = useTheme();
  const isReply = comment !== null && comment.parentId !== null;
  const kind = isReply ? "reply" : "comment";
  return (
    <BottomSheet visible={comment !== null} onClose={onClose}>
      {comment ? (
        <>
          <View style={{ paddingHorizontal: 12, paddingBottom: 10, marginBottom: 8, borderBottomWidth: 1, borderBottomColor: colors.border }}>
            <AppText variant="caption" numberOfLines={1}>
              {`"${comment.text}"`}
            </AppText>
          </View>
          <SheetRow title={`Edit ${kind}`} onPress={() => onEdit(comment)} />
          <SheetRow title={`Delete ${kind}`} danger onPress={() => onDelete(comment)} />
        </>
      ) : null}
    </BottomSheet>
  );
}
