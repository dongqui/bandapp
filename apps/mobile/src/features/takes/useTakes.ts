import { useApiData } from "@/api";

export function useTakes(sessionId: string | undefined) {
  return useApiData(async (api) => (sessionId ? api.takes.list(sessionId) : []), [sessionId]);
}
