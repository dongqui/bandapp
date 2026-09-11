import { ApiError } from "@bandapp/api-client";
import { useEffect, useState } from "react";
import { useApi } from "@/api";
import { bucketsToLevels, buildLevels, type PeakLevels } from "@/lib/timeline/levels";
import { parsePeaksFile } from "@/lib/timeline/peaksFile";

export type PeaksSource = "hires" | "buckets" | "none";

export interface SessionPeaks {
  loading: boolean;
  levels: PeakLevels | null;
  source: PeaksSource;
}

/**
 * 사이드카(peaks.bin)를 받아 LOD 피라미드를 만든다 (2026-09-11 스펙 결정 3·13). 404(옛 세션)·빈 URL(Mock)·
 * 파싱 실패면 128버킷으로, 그것도 없으면 none. 화면에 있는 동안만 메모리에 둔다 — 디스크 캐시는 범위 밖.
 */
export function useSessionPeaks(sessionId: string | undefined, buckets: number[] | null | undefined, durationMs: number): SessionPeaks {
  const api = useApi();
  const [state, setState] = useState<SessionPeaks>({ loading: true, levels: null, source: "none" });

  useEffect(() => {
    if (!sessionId || durationMs <= 0) return;
    let cancelled = false;
    const fallback = (): SessionPeaks =>
      buckets && buckets.length > 0
        ? { loading: false, levels: bucketsToLevels(buckets, durationMs), source: "buckets" }
        : { loading: false, levels: null, source: "none" };

    const load = async (): Promise<SessionPeaks> => {
      try {
        const { url } = await api.sessions.peaksUrl(sessionId);
        if (!url) return fallback();
        const res = await fetch(url);
        if (!res.ok) throw new Error(`peaks fetch failed: ${res.status}`);
        const file = parsePeaksFile(await res.arrayBuffer());
        return { loading: false, levels: buildLevels(file.peaks, file.peaksPerSec), source: "hires" };
      } catch (err) {
        // 404는 정상 경로(옛 세션)라 조용히, 나머지는 원인을 남긴다
        if (!(err instanceof ApiError && err.status === 404)) console.warn("useSessionPeaks: falling back to buckets", err);
        return fallback();
      }
    };

    void load().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [api, sessionId, buckets, durationMs]);

  return state;
}
