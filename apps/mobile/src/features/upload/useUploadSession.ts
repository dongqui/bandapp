import type { Session } from "@bandapp/types";
import { resumeRecordingUpload, UploadRecordingError } from "@bandapp/api-client";
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
/** 이만큼 연속으로 폴링이 실패하면 조용히 계속 두지 않고 실패로 알린다. */
const MAX_POLL_FAILURES = 5;

const UPLOAD_ERROR = "Couldn’t upload this recording — check your connection and try again";
const RETRY_ERROR = "Couldn’t retry — please try again";
const ANALYZE_ERROR = "Couldn’t analyze this recording";
const POLL_ERROR = "Lost contact with the server — try again";

/**
 * 업로드 → 서버 상태 폴링. 업로드 실패(네트워크)와 분석 실패(서버 failed)를 같은 phase로
 * 보여주되, retry()는 셋을 구분한다: 서버가 failed면 서버 retry, 만들다 만 세션이 있으면
 * 그 세션을 이어 올리기, 둘 다 아니면 처음부터 업로드.
 */
export function useUploadSession(params: UploadParams | null) {
  const api = useApi();
  const { band } = useCurrentBand();
  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [progress, setProgress] = useState(0);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);
  // create까지는 됐는데 업로드가 끊긴 세션 id — 있으면 재시도는 새로 만들지 않고 이어 올린다.
  const pendingSessionIdRef = useRef<string | null>(null);

  // 업로드가 끝난 뒤 처리는 첫 시도든 재시도든 같다
  const settle = useCallback((created: Session) => {
    pendingSessionIdRef.current = null;
    setSession(created);
    if (created.status === "failed") {
      setError(ANALYZE_ERROR);
      setPhase("failed");
    } else {
      setPhase("analyzing");
    }
  }, []);

  const onProgress = useCallback(
    (p: { uploadedBytes: number; totalBytes: number }) =>
      setProgress(p.totalBytes ? p.uploadedBytes / p.totalBytes : 0),
    [],
  );

  const upload = useCallback(async () => {
    if (!params || !band) return;
    setPhase("uploading");
    setProgress(0);
    setError(null);
    try {
      const source = await fileUploadSource(params.fileUri);
      settle(
        await api.sessions.upload(
          band.id,
          {
            startedAt: params.startedAt,
            durationMs: params.durationMs,
            sizeBytes: source.sizeBytes,
            contentType: "audio/mp4",
            source: params.source,
          },
          source,
          onProgress,
        ),
      );
    } catch (e) {
      if (e instanceof UploadRecordingError) pendingSessionIdRef.current = e.sessionId;
      console.warn("[upload] failed:", e instanceof Error ? e.message : e);
      setError(UPLOAD_ERROR);
      setPhase("failed");
    }
  }, [api, band, params, settle, onProgress]);

  useEffect(() => {
    if (!params || !band || startedRef.current) return;
    startedRef.current = true;
    void upload();
  }, [params, band, upload]);

  // 서버 상태 폴링 — 세션이 analyzing인 동안만, 세션 id가 바뀔 때만 새 interval을 만든다
  const sessionId = session?.id ?? null;
  useEffect(() => {
    if (phase !== "analyzing" || !sessionId) return;
    let failures = 0;
    const t = setInterval(() => {
      void api.sessions
        .get(sessionId)
        .then((s) => {
          failures = 0;
          setSession(s);
          if (s.status === "ready") setPhase("ready");
          if (s.status === "failed") {
            setError(ANALYZE_ERROR);
            setPhase("failed");
          }
        })
        .catch((e: unknown) => {
          // 폴링이 몇 번 튀는 건 정상이지만 계속 실패하면 영원히 analyzing으로 두지 않는다
          if (++failures < MAX_POLL_FAILURES) return;
          console.warn("[upload] polling failed:", e instanceof Error ? e.message : e);
          setError(POLL_ERROR);
          setPhase("failed");
        });
    }, POLL_MS);
    return () => clearInterval(t);
  }, [api, phase, sessionId]);

  const retry = useCallback(() => {
    if (session && session.status === "failed") {
      setPhase("analyzing");
      setError(null);
      void api.sessions
        .retryAnalysis(session.id)
        .then(setSession)
        .catch((e: unknown) => {
          console.warn("[upload] retryAnalysis failed:", e instanceof Error ? e.message : e);
          setError(RETRY_ERROR);
          setPhase("failed");
        });
      return;
    }
    const pendingId = pendingSessionIdRef.current;
    if (pendingId && params) {
      setPhase("uploading");
      setError(null);
      void (async () => {
        try {
          settle(
            await resumeRecordingUpload({
              client: api,
              sessionId: pendingId,
              source: await fileUploadSource(params.fileUri),
              onProgress,
            }),
          );
        } catch (e) {
          console.warn("[upload] resume failed:", e instanceof Error ? e.message : e);
          setError(RETRY_ERROR);
          setPhase("failed");
        }
      })();
      return;
    }
    void upload();
  }, [api, session, params, upload, settle, onProgress]);

  return { phase, progress, session, error, retry };
}
