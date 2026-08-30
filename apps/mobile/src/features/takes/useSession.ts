import { useApiData } from "@/api";

export function useSession(id: string | undefined) {
  return useApiData(async (api) => (id ? api.sessions.get(id) : undefined), [id]);
}
