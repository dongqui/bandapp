import type { Session } from "@bandapp/types";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { inFlightUploads } from "./inFlightUploads";
import { pendingUploads } from "./pendingUploads";

/**
 * 세션 목록이 "이어 올릴 수 있는" uploading 행을 표시하려고 쓰는 로컬 레코드 id 집합.
 * 화면이 포커스될 때마다 다시 읽고(재개 화면에서 돌아오면 레코드가 사라져 있다), 목록에 있으면서
 * 더 이상 uploading이 아닌 세션의 레코드는 지운다 (2026-09-10 업로드 재개 스펙 결정 7). 목록에 없는
 * 레코드는 다른 밴드의 것일 수 있어 건드리지 않는다.
 *
 * 레코드가 있어도 inFlightUploads에 올라 있는 id(이 프로세스에서 지금 실제로 업로드 중인 세션)는
 * 제외한다 (finding A) — 화면을 벗어나도 그 업로드의 네트워크 요청은 계속 진행 중이라, 여기 포함시키면
 * "이어 올리기"를 눌러 같은 세션에 두 번째 resumeUpload를 동시에 시작시키게 된다. 제외된 행은 그냥
 * "Uploading…"으로 보이고, 눌러도 새 업로드를 시작하지 않는다(SessionsScreen의 토스트).
 */
export function usePendingUploadIds(sessions: Session[] | undefined): Set<string> {
  const [ids, setIds] = useState<Set<string>>(() => new Set());

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void pendingUploads.list().then((list) => {
        if (active) setIds(new Set(list.filter((r) => !inFlightUploads.has(r.sessionId)).map((r) => r.sessionId)));
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
