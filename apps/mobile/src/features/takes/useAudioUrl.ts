import { useEffect, useState } from "react";
import { useApi } from "@/api";

/**
 * presigned URL은 1시간 유효 — 화면에 머무는 동안은 재조회하지 않는다. Mock은 ""를 준다 → null.
 * resolved는 "지금 이 id의 조회가 끝났는지" — url이 null이어도 Mock(끝남)과 아직 받는 중(안 끝남)이 다르다.
 * id가 바뀌면 이전 결과는 resolved로 치지 않는다.
 *
 * 일부러 useApiData를 쓰지 않고 api.subscribe도 구독하지 않는다: useApiData는 데이터 변경 통지마다 다시 불러오는데,
 * 테이크 화면을 열 때마다 comments.markRead가 통지를 내보내고, 그때마다 새 presigned URL(X-Amz-Date가 다름)을 받으면
 * expo-audio가 플레이어를 새로 만들어 ?at= 시킹과 재생이 끊긴다. kind:id당 한 번만 받는다.
 */
export function useAudioSource(kind: "take" | "session", id: string | undefined): { url: string | null; resolved: boolean } {
  const api = useApi();
  const key = id ? `${kind}:${id}` : null;
  const [data, setData] = useState<{ key: string; url: string | null } | undefined>(undefined);

  useEffect(() => {
    if (!id) return;
    let cancelled = false; // id가 바뀌거나 언마운트되면 늦게 온 응답을 버린다
    const k = `${kind}:${id}`;
    void (kind === "take" ? api.takes.audioUrl(id) : api.sessions.audioUrl(id))
      .then((res) => {
        if (!cancelled) setData({ key: k, url: res.url || null });
      })
      .catch((e) => {
        if (!cancelled) console.warn("audio url load failed", e);
      });
    return () => {
      cancelled = true;
    };
  }, [api, kind, id]);

  if (key === null || data?.key !== key) return { url: null, resolved: false };
  return { url: data.url, resolved: true };
}

export function useAudioUrl(kind: "take" | "session", id: string | undefined): string | null {
  return useAudioSource(kind, id).url;
}
