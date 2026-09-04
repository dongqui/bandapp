import type { Session } from "@bandapp/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "@/api";
import { useCurrentBand } from "@/features/band/useCurrentBand";
import { fileUploadSource } from "./readFilePart";

export interface UploadParams {
  fileUri: string;
  source: "recording" | "import";
  /** toLocalIso() 결과 */
  startedAt: string;
  durationMs?: number;
}

export type UploadPhase = "idle" | "uploading" | "analyzing" | "ready" | "failed";

const POLL_MS = 3000;

/**
 * 업로드 → 서버 상태 폴링. 업로드 실패(네트워크)와 분석 실패(서버 failed)를 같은 phase로
 * 보여주되, retry()는 둘을 구분한다: 세션이 아직 없으면 업로드부터, 있으면 서버 retry.
 */
export function useUploadSession(params: UploadParams | null) {
  const api = useApi();
  const { band } = useCurrentBand();
  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [progress, setProgress] = useState(0);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  const upload = useCallback(async () => {
    if (!params || !band) return;
    setPhase("uploading");
    setError(null);
    try {
      const source = await fileUploadSource(params.fileUri);
      const created = await api.sessions.upload(
        band.id,
        {
          startedAt: params.startedAt,
          durationMs: params.durationMs,
          sizeBytes: source.sizeBytes,
          contentType: "audio/mp4",
          source: params.source,
        },
        source,
        (p) => setProgress(p.totalBytes ? p.uploadedBytes / p.totalBytes : 0),
      );
      setSession(created);
      setPhase(created.status === "failed" ? "failed" : "analyzing");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
      setPhase("failed");
    }
  }, [api, band, params]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void upload();
  }, [upload]);

  // 서버 상태 폴링 — 세션이 analyzing인 동안만
  useEffect(() => {
    if (phase !== "analyzing" || !session) return;
    const t = setInterval(() => {
      void api.sessions
        .get(session.id)
        .then((s) => {
          setSession(s);
          if (s.status === "ready") setPhase("ready");
          if (s.status === "failed") setPhase("failed");
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [api, phase, session]);

  const retry = useCallback(() => {
    if (session && session.status === "failed") {
      setPhase("analyzing");
      void api.sessions.retryAnalysis(session.id).then(setSession).catch(() => setPhase("failed"));
      return;
    }
    void upload();
  }, [api, session, upload]);

  return { phase, progress, session, error, retry };
}
