import type { CommentTarget } from "@bandapp/types";
import { useApiData } from "@/api";

export function useComments(target: CommentTarget | undefined) {
  // 객체 identity 대신 id로 의존성을 잡아 렌더마다 다시 불러오지 않게
  const takeId = target && "takeId" in target ? target.takeId : undefined;
  const sessionId = target && "sessionId" in target ? target.sessionId : undefined;
  return useApiData(
    async (api) => {
      if (takeId) return api.comments.list({ takeId });
      if (sessionId) return api.comments.list({ sessionId });
      return [];
    },
    [takeId, sessionId],
  );
}
