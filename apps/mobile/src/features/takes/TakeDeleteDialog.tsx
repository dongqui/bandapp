import type { Take } from "@bandapp/types";
import { ConfirmDialog } from "@/ui";

/**
 * "Delete {이름}?" 확인 (스펙 B 결정 6 — 남은 take의 번호는 그대로, 코멘트는 함께 삭제). 2026-10-02 디자인부터 제목에
 * 번호 대신 이름. 타임라인과 Take Feedback 둘 다 쓴다. take가 null이면 닫힌 상태.
 */
export function TakeDeleteDialog({ take, busy, onConfirm, onCancel }: { take: Take | null; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  if (!take) return null;
  const comments = take.commentCount > 0 ? `Its ${take.commentCount} ${take.commentCount === 1 ? "comment" : "comments"} will be deleted too. ` : "";
  return (
    <ConfirmDialog
      visible
      title={`Delete ${take.name}?`}
      body={`${comments}Other takes keep their numbers. This can’t be undone.`}
      primary={{ label: "Delete take", danger: true, onPress: onConfirm }}
      cancelLabel="Cancel"
      onCancel={() => (busy ? undefined : onCancel())}
      busy={busy}
    />
  );
}
