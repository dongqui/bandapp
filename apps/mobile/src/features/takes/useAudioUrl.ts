import { useApiData } from "@/api";

/**
 * presigned URL은 1시간 유효 — 화면에 머무는 동안은 재조회하지 않는다. Mock은 ""를 준다 → null.
 * resolved는 "지금 이 id의 조회가 끝났는지" — url이 null이어도 Mock(끝남)과 아직 받는 중(안 끝남)이 다르다.
 * id가 바뀌면 이전 결과는 resolved로 치지 않는다.
 */
export function useAudioSource(kind: "take" | "session", id: string | undefined): { url: string | null; resolved: boolean } {
  const key = id ? `${kind}:${id}` : null;
  const { data } = useApiData(
    async (api) => {
      if (!id) return null;
      const res = kind === "take" ? await api.takes.audioUrl(id) : await api.sessions.audioUrl(id);
      return { key: `${kind}:${id}`, url: res.url || null };
    },
    [kind, id],
  );
  if (key === null || data?.key !== key) return { url: null, resolved: false };
  return { url: data.url, resolved: true };
}

export function useAudioUrl(kind: "take" | "session", id: string | undefined): string | null {
  return useAudioSource(kind, id).url;
}
