import type { Session } from "@bandapp/types";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { pendingUploads } from "./pendingUploads";

/**
 * 세션 목록이 "이어 올릴 수 있는" uploading 행을 표시하려고 쓰는 로컬 레코드 id 집합.
 * 화면이 포커스될 때마다 다시 읽고(재개 화면에서 돌아오면 레코드가 사라져 있다), 목록에 있으면서
 * 더 이상 uploading이 아닌 세션의 레코드는 지운다 (2026-09-10 업로드 재개 스펙 결정 7). 목록에 없는
 * 레코드는 다른 밴드의 것일 수 있어 건드리지 않는다.
 */
export function usePendingUploadIds(sessions: Session[] | undefined): Set<string> {
  const [ids, setIds] = useState<Set<string>>(() => new Set());

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void pendingUploads.list().then((list) => {
        if (active) setIds(new Set(list.map((r) => r.sessionId)));
      });
      return () => {
        active = false;
      };
    }, []),
  );

  useEffect(() => {
    if (!sessions || ids.size === 0) return;
    const stale = sessions.filter((s) => ids.has(s.id) && s.status !== "uploading").map((s) => s.id);
    if (stale.length === 0) return;
    void Promise.all(stale.map((id) => pendingUploads.discard(id))).then(() =>
      setIds((prev) => {
        const next = new Set(prev);
        for (const id of stale) next.delete(id);
        return next;
      }),
    );
  }, [sessions, ids]);

  return ids;
}
