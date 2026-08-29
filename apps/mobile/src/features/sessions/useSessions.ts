import { useApiData } from "@/api";

export function useSessions(bandId: string | undefined) {
  return useApiData(async (api) => (bandId ? api.sessions.list(bandId) : []), [bandId]);
}
