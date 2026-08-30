import { useApiData } from "@/api";

export function useComments(takeId: string | undefined) {
  return useApiData(async (api) => (takeId ? api.comments.list(takeId) : []), [takeId]);
}
