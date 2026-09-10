import type { Session } from "@bandapp/types";
import { UploadRecordingError } from "@bandapp/api-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "@/api";
import { useCurrentBand } from "@/features/band/useCurrentBand";
import { classifyUploadFailure } from "./classifyUploadFailure";
import { pendingUploads } from "./pendingUploads";
import { fileUploadSource } from "./readFilePart";
import { MissingUploadFileError } from "./uploadErrors";

export interface UploadParams {
  fileUri: string;
  source: "recording" | "import";
  /** toLocalIso() 결과 */
  startedAt: string;
  durationMs?: number;
}

/** 세션 목록의 uploading 행에서 들어온 이어 올리기 — 파일은 로컬 레코드가 가리킨다 */
export interface ResumeParams {
  sessionId: string;
}

export type UploadPhase = "idle" | "uploading" | "analyzing" | "ready" | "failed";

const POLL_MS = 3000;
/** 이만큼 연속으로 폴링이 실패하면 조용히 계속 두지 않고 실패로 알린다. */
const MAX_POLL_FAILURES = 5;

const RETRY_ERROR = "Couldn’t retry — please try again";
const ANALYZE_ERROR = "Couldn’t analyze this recording";
const POLL_ERROR = "Lost contact with the server — try again";

const isResume = (p: UploadParams | ResumeParams | null): p is ResumeParams => p !== null && "sessionId" in p;

/**
 * 업로드(또는 이어 올리기) → 서버 상태 폴링. 이어 올리기의 단일 진실은 pendingUploads 스토어다
 * (2026-09-10 업로드 재개 스펙 결정 5): create가 끝나면 레코드를 남기고, complete가 끝나면 지운다.
 * retry()는 셋을 구분한다: 서버가 failed면 서버 retry, create까지 된 세션이 있으면 이어 올리기,
 * 둘 다 아니면 처음부터 업로드.
 */
export function useUploadSession(params: UploadParams | ResumeParams | null) {
  const api = useApi();
  const { band } = useCurrentBand();
  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [progress, setProgress] = useState(0);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(true);
  const startedRef = useRef(false);
  // 첫 업로드에서 create까지 성공한 세션 id — 같은 화면의 "Try again"이 새 세션을 만들지 않고 이어 올리게 한다
  const createdIdRef = useRef<string | null>(null);
  // uploads/로 옮긴 파일 URI. stage가 실패하면 원래 URI가 들어간다.
  const stagedRef = useRef<string | null>(null);
  // stage()가 실패해 원래 URI 그대로 업로드 중이면 true — 언마운트 시 "옮긴 파일"이 아니므로 지우면 안 된다.
  const stagedInPlaceRef = useRef(false);
  // upload()가 create 응답(sessionId)을 받기 전에 실패했으면 true — 이때만 옮겨 둔 파일이 고아가 된다.
  const failedBeforeCreateRef = useRef(false);

  // 업로드가 끝난 뒤 처리는 첫 시도든 재시도든 같다 — 파일과 레코드는 여기서 지운다 (스펙 결정 7)
  const settle = useCallback((created: Session) => {
    void pendingUploads.discard(created.id);
    setSession(created);
    if (created.status === "failed") {
      setError(ANALYZE_ERROR);
      setRetryable(true);
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

  const fail = useCallback(
    async (err: unknown, mode: "upload" | "resume", sessionId: string | null) => {
      console.warn(`[upload] ${mode} failed:`, err instanceof Error ? err.message : err);
      const outcome = classifyUploadFailure(err, mode);
      if (outcome.discard && sessionId) await pendingUploads.discard(sessionId);
      if (outcome.refetch && sessionId) {
        // 다른 경로로 이미 업로드가 끝난 세션 — 현재 상태를 받아 analyzing/ready 흐름에 합류한다
        try {
          settle(await api.sessions.get(sessionId));
          return;
        } catch (e) {
          console.warn("[upload] refetch failed:", e instanceof Error ? e.message : e);
        }
      }
      setError(outcome.message || RETRY_ERROR);
      setRetryable(outcome.retryable);
      setPhase("failed");
    },
    [api, settle],
  );

  const begin = useCallback(() => {
    setPhase("uploading");
    setProgress(0);
    setError(null);
    setRetryable(true);
  }, []);

  /** fileUri를 알면(같은 화면의 재시도) 레코드를 거치지 않는다 — 레코드 기록이 실패했어도 파일은 있다 */
  const resume = useCallback(
    async (sessionId: string, fileUri?: string) => {
      begin();
      try {
        const uri = fileUri ?? (await pendingUploads.get(sessionId))?.fileUri;
        if (!uri) throw new MissingUploadFileError();
        const source = await fileUploadSource(uri);
        settle(await api.sessions.resumeUpload(sessionId, source, onProgress));
      } catch (e) {
        await fail(e, "resume", sessionId);
      }
    },
    [api, begin, settle, onProgress, fail],
  );

  const upload = useCallback(async () => {
    if (!params || isResume(params) || !band) return;
    begin();
    // 매 시도마다 초기화 — 이번 시도가 create 전에 실패했는지는 아래 catch에서 다시 판단한다
    failedBeforeCreateRef.current = false;
    try {
      if (!stagedRef.current) {
        // 캐시는 OS가 지울 수 있어 앱 소유 폴더로 옮긴다 (스펙 결정 2). 못 옮기면 원래 URI로 그대로 간다 —
        // 재개는 못 하지만 업로드는 막지 않는다 (스펙 결정 8).
        stagedRef.current = await pendingUploads.stage(params.fileUri).catch((e: unknown) => {
          console.warn("[upload] stage failed, uploading in place:", e instanceof Error ? e.message : e);
          stagedInPlaceRef.current = true;
          return params.fileUri;
        });
      }
      const fileUri = stagedRef.current;
      const source = await fileUploadSource(fileUri);
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
          async (sessionId) => {
            createdIdRef.current = sessionId;
            await pendingUploads.add({ sessionId, bandId: band.id, fileUri, source: params.source, createdAt: new Date().toISOString() });
          },
        ),
      );
    } catch (e) {
      const sessionId = e instanceof UploadRecordingError ? e.sessionId : null;
      if (sessionId) createdIdRef.current = sessionId;
      // create 응답을 못 받았다면(sessionId 없음) 옮겨 둔 파일이 아무 레코드도 가리키지 못한다 — 언마운트 시 지워야 한다
      else failedBeforeCreateRef.current = true;
      await fail(e, "upload", sessionId);
    }
  }, [api, band, params, begin, settle, onProgress, fail]);

  useEffect(() => {
    if (!params || startedRef.current) return;
    if (isResume(params)) {
      startedRef.current = true;
      void resume(params.sessionId);
      return;
    }
    if (!band) return;
    startedRef.current = true;
    void upload();
  }, [params, band, upload, resume]);

  // create 전에 실패하고 화면을 떠나면 옮겨 둔 파일은 아무 레코드도 가리키지 않는다 — 여기서 지운다.
  // (남겨도 다음 앱 시작의 sweepOrphans가 지우지만, 바로 지우는 편이 디스크에 낫다.)
  // createdIdRef만으로는 부족하다: stage()와 create() 사이에 화면을 떠나면 create는 아직 진행 중이라
  // createdIdRef가 비어 있어도 업로드 자체는 살아 있을 수 있다. failedBeforeCreateRef가 true일 때만
  // — 즉 이번 시도가 실제로 create 전에 실패했을 때만 — 지운다. stage가 실패해 원래 URI 그대로
  // 쓰는 중이면(stagedInPlaceRef) 옮긴 파일이 아니므로 대상이 아니다.
  useEffect(
    () => () => {
      const staged = stagedRef.current;
      if (staged && failedBeforeCreateRef.current && !stagedInPlaceRef.current) {
        void pendingUploads.dropFile(staged);
      }
    },
    [],
  );

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
    if (session) {
      if (session.status === "failed") {
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
      // settle()이 이미 실행돼 파일과 레코드가 지워진 뒤 폴링만 실패한 경우다(스펙 결정 7) — 업로드를
      // 다시 하거나 이어 올릴 파일이 이제 없으니, 유일하게 말이 되는 재시도는 폴링을 다시 시작하는 것뿐이다.
      setError(null);
      setRetryable(true);
      setPhase("analyzing");
      return;
    }
    if (isResume(params)) {
      void resume(params.sessionId);
      return;
    }
    if (createdIdRef.current) {
      void resume(createdIdRef.current, stagedRef.current ?? undefined);
      return;
    }
    void upload();
  }, [api, session, params, upload, resume]);

  return { phase, progress, session, error, retry, retryable };
}
