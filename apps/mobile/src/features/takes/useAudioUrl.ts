import { useApiData } from "@/api";

/** presigned URL은 1시간 유효 — 화면에 머무는 동안은 재조회하지 않는다. Mock은 ""를 준다 → null. */
export function useAudioUrl(kind: "take" | "session", id: string | undefined): string | null {
  const { data } = useApiData(
    async (api) => {
      if (!id) return null;
      const res = kind === "take" ? await api.takes.audioUrl(id) : await api.sessions.audioUrl(id);
      return res.url || null;
    },
    [kind, id],
  );
  return data ?? null;
}
