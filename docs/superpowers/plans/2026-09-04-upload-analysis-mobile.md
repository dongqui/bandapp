# 오디오 업로드 → 분석 → Take → 코멘트 (모바일) 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 앱에서 m4a를 고르거나 녹음해 서버에 올리고, 처리 상태를 보다가, 잘라낸 Take를 실제로 재생하며 코멘트를 남긴다.

**Architecture:** 파일 입력(가져오기·녹음)은 `/processing` 화면에 `fileUri`를 넘기고, 그 화면이 `api.sessions.upload()`로 업로드하며 진행률과 서버 상태를 보여준다. 재생은 `expo-audio` 플레이어로 presigned URL을 튼다. Mock 모드(`EXPO_PUBLIC_API_URL` 없음)는 기존처럼 가짜 데이터로 동작한다.

**Tech Stack:** Expo SDK 57 (dev build), expo-audio, expo-document-picker, React Native Blob, `@bandapp/api-client`.

**스펙:** [docs/superpowers/specs/2026-09-04-upload-analysis-takes-feedback-design.md](../specs/2026-09-04-upload-analysis-takes-feedback-design.md)
**선행 플랜:** [2026-09-04-upload-analysis-server.md](2026-09-04-upload-analysis-server.md) — Task 12까지 끝나 있어야 한다.

## Global Constraints

- Expo SDK 57 API만 쓴다 (`apps/mobile/AGENTS.md`: https://docs.expo.dev/versions/v57.0.0/). `expo-av`는 쓰지 않는다.
- 새 네이티브 모듈 추가 후에는 dev build를 다시 만들어야 한다 (`pnpm --filter mobile ios` 는 맥에서). Windows에서는 `pnpm --filter mobile typecheck`와 `pnpm --filter mobile test`, Expo 웹(`pnpm dev`)까지만 검증한다.
- 상태 관리는 React Context + hook. 새 상태 라이브러리 금지.
- UI 컴포넌트는 `@/ui`의 것을 쓰고 새 스타일 의존성을 추가하지 않는다.
- 문구는 기존 화면과 같은 영어 UI 카피 톤을 유지한다.
- 녹음 포맷: AAC-LC m4a, 44.1kHz, 스테레오, 128kbps = `RecordingPresets.HIGH_QUALITY`.
- 커밋 메시지는 영어 conventional commit, 본문 끝에 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## 파일 구조

```
apps/mobile/app.json                              expo-audio 플러그인(마이크 권한 문구)
apps/mobile/src/lib/time.ts (+test)               toLocalIso(date): 오프셋 붙은 ISO
apps/mobile/src/features/upload/readFilePart.ts   file uri → UploadSource (Blob slice)
apps/mobile/src/features/upload/useUploadSession.ts   업로드 + 상태 폴링 훅
apps/mobile/src/features/sessions/NewSessionSheet.tsx  가져오기 → document picker
apps/mobile/src/features/recording/RecordingScreen.tsx expo-audio 녹음
apps/mobile/src/features/recording/ProcessingScreen.tsx 업로드 진행률 + 분석 상태
apps/mobile/src/features/takes/usePlayback.ts     expo-audio 플레이어 (URL 없으면 시뮬레이션)
apps/mobile/src/features/takes/useAudioUrl.ts     take/원본 presigned URL 조회
apps/mobile/src/features/takes/TakePlayerScreen.tsx  실제 재생, 원본은 코멘트 입력 숨김
apps/mobile/src/features/takes/SessionDetailScreen.tsx  take 0개 빈 상태
```

---

### Task 1: 의존성·권한·로컬 ISO 헬퍼

**Files:**
- Modify: `apps/mobile/package.json`, `apps/mobile/app.json`
- Modify: `apps/mobile/src/lib/time.ts`, `apps/mobile/src/lib/time.test.ts`

**Interfaces:**
- Produces: `toLocalIso(date: Date): string` — `"2026-09-04T19:03:00+09:00"` 형태.

- [ ] **Step 1: 패키지 설치**

Run: `cd apps/mobile && npx expo install expo-audio expo-document-picker`
Expected: `package.json`에 `expo-audio ~57.x`, `expo-document-picker ~57.x` 추가.

- [ ] **Step 2: app.json 플러그인**

`"plugins"` 배열에 추가:

```json
      [
        "expo-audio",
        {
          "microphonePermission": "Take N records your rehearsal so it can find the takes."
        }
      ]
```

- [ ] **Step 3: 실패하는 테스트**

`apps/mobile/src/lib/time.test.ts`에 추가:

```ts
import { toLocalIso } from "./time";

describe("toLocalIso", () => {
  it("formats local wall-clock time with the device offset", () => {
    const d = new Date(2026, 8, 4, 19, 3, 0);
    const iso = toLocalIso(d);
    expect(iso.startsWith("2026-09-04T19:03:00")).toBe(true);
    expect(iso).toMatch(/[+-]\d{2}:\d{2}$/);
    // 서버는 이 문자열을 다시 파싱해도 같은 순간이어야 한다
    expect(new Date(iso).getTime()).toBe(d.getTime());
  });
});
```

- [ ] **Step 4: 실행해서 실패 확인**

Run: `pnpm --filter mobile test`
Expected: FAIL — `toLocalIso` export 없음.

- [ ] **Step 5: 구현**

`apps/mobile/src/lib/time.ts` 끝에:

```ts
/**
 * 서버는 startedAt의 날짜 부분으로 세션 제목("Sep 4 Rehearsal")을 만든다.
 * toISOString()은 UTC라 자정 근처에서 날짜가 어긋나므로 기기 오프셋을 붙여 보낸다.
 */
export function toLocalIso(date: Date): string {
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `pnpm --filter mobile test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/package.json apps/mobile/app.json apps/mobile/src/lib pnpm-lock.yaml
git commit -m "feat(mobile): add expo-audio and document picker, format local ISO timestamps"
```

---

### Task 2: 파일 파트 읽기와 업로드 훅

**Files:**
- Create: `apps/mobile/src/features/upload/readFilePart.ts`
- Create: `apps/mobile/src/features/upload/useUploadSession.ts`

**Interfaces:**
- Consumes: `UploadSource`, `UploadProgress`, `CreateSessionInput`, `api.sessions.upload` (api-client Task 12).
- Produces:

```ts
export async function fileUploadSource(uri: string): Promise<UploadSource>;   // readFilePart.ts
export interface UploadParams { fileUri: string; source: "recording" | "import"; startedAt: string; durationMs?: number }
export function useUploadSession(params: UploadParams | null): {
  phase: "idle" | "uploading" | "analyzing" | "ready" | "failed";
  progress: number;          // 0..1, uploading 단계에서만 의미
  session: Session | null;
  error: string | null;
  retry(): void;
}
```

- [ ] **Step 1: fileUploadSource**

`apps/mobile/src/features/upload/readFilePart.ts`:

```ts
import type { UploadSource } from "@bandapp/api-client";

/**
 * RN의 Blob은 네이티브 파일을 가리키는 핸들이라 fetch(uri).blob()이 파일을 JS 메모리에
 * 올리지 않는다. slice()도 범위만 바꾼 새 핸들을 돌려주고, fetch body로 넘기면 네이티브가
 * 그 범위만 읽어 보낸다 (스펙 결정 15). 3시간 170MB도 파트 단위로만 메모리를 쓴다.
 */
export async function fileUploadSource(uri: string): Promise<UploadSource> {
  const res = await fetch(uri);
  const blob = await res.blob();
  return {
    sizeBytes: blob.size,
    readPart: async ({ start, end }) => blob.slice(start, end, "audio/mp4"),
  };
}
```

- [ ] **Step 2: useUploadSession**

`apps/mobile/src/features/upload/useUploadSession.ts`:

```ts
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
```

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @bandapp/api-client build && pnpm --filter mobile typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/features/upload
git commit -m "feat(mobile): upload recordings from a file uri and track analysis state"
```

---

### Task 3: 처리 화면 — 업로드 진행률과 분석 상태

**Files:**
- Modify: `apps/mobile/src/features/recording/ProcessingScreen.tsx`

**Interfaces:**
- Consumes: `useUploadSession`. 라우트 파라미터: `fileUri`, `source`, `startedAt`, `durationMs?` (문자열).

- [ ] **Step 1: 화면 교체**

```tsx
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo } from "react";
import { View } from "react-native";
import { useUploadSession } from "@/features/upload/useUploadSession";
import { fmtDuration } from "@/lib/time";
import { space, useTheme } from "@/theme";
import { AppText, Chip, MonoLabel, ProgressBar, Screen } from "@/ui";

export function ProcessingScreen() {
  const raw = useLocalSearchParams<{ fileUri: string; source: "recording" | "import"; startedAt: string; durationMs?: string }>();
  const params = useMemo(
    () =>
      raw.fileUri
        ? { fileUri: raw.fileUri, source: raw.source ?? "import", startedAt: raw.startedAt, durationMs: raw.durationMs ? Number(raw.durationMs) : undefined }
        : null,
    [raw.fileUri, raw.source, raw.startedAt, raw.durationMs],
  );
  const { phase, progress, session, error, retry } = useUploadSession(params);
  const router = useRouter();
  const { colors } = useTheme();

  useEffect(() => {
    if (phase !== "ready" || !session) return;
    const t = setTimeout(() => router.replace(`/session/${session.id}`), 1100);
    return () => clearTimeout(t);
  }, [phase, session, router]);

  const durationSec = session?.durationSec || (params?.durationMs ? Math.round(params.durationMs / 1000) : 0);
  const bar = phase === "uploading" ? progress * 0.6 : phase === "analyzing" ? 0.6 + 0.35 * 0.5 : phase === "ready" ? 1 : progress * 0.6;
  const caption =
    phase === "uploading"
      ? `Uploading… ${Math.round(progress * 100)}%`
      : phase === "analyzing"
        ? "Finding the parts you played…"
        : phase === "ready"
          ? `${session?.takeCount ?? 0} Takes found`
          : phase === "failed"
            ? (error ?? "Couldn’t analyze this recording")
            : "Preparing the recording…";

  return (
    <Screen>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 18, paddingHorizontal: 40 }}>
        <AppText variant="heading" style={{ textAlign: "center" }}>
          Organizing your rehearsal
        </AppText>
        <MonoLabel color={colors.textMuted} style={{ fontSize: 12, letterSpacing: 0 }}>
          {durationSec ? `${fmtDuration(durationSec)} recording` : "Imported recording"}
        </MonoLabel>
        <ProgressBar progress={bar} />
        <AppText variant="caption" color={phase === "ready" ? colors.accent : phase === "failed" ? colors.danger : colors.textMuted} style={{ minHeight: 18, textAlign: "center" }}>
          {caption}
        </AppText>
        {phase === "failed" ? <Chip label="Try again" onPress={retry} /> : null}
      </View>
      <AppText variant="small" style={{ textAlign: "center", paddingHorizontal: space.screenX + 16, paddingBottom: 64, lineHeight: 18 }}>
        {phase === "uploading" ? "Keep the app open until the upload finishes." : "You can close the app — your takes will be ready when you're back."}
      </AppText>
    </Screen>
  );
}
```

- [ ] **Step 2: typecheck**

Run: `pnpm --filter mobile typecheck`
Expected: PASS (`colors.danger`가 테마에 있는지 확인 — `SessionRow`가 이미 쓴다).

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/src/features/recording/ProcessingScreen.tsx
git commit -m "feat(mobile): show upload progress and analysis state on the processing screen"
```

---

### Task 4: 가져오기 — document picker

**Files:**
- Modify: `apps/mobile/src/features/sessions/NewSessionSheet.tsx`

- [ ] **Step 1: "Import a recording" 액션 교체**

```tsx
import * as DocumentPicker from "expo-document-picker";
import { toLocalIso } from "@/lib/time";
// ...
        onPress={async () => {
          onClose();
          const picked = await DocumentPicker.getDocumentAsync({
            type: ["audio/mp4", "audio/x-m4a", "audio/m4a"],
            copyToCacheDirectory: true,
            multiple: false,
          });
          if (picked.canceled || !picked.assets[0]) return;
          const asset = picked.assets[0];
          router.push({
            pathname: "/processing",
            params: { fileUri: asset.uri, source: "import", startedAt: toLocalIso(new Date()) },
          });
        }}
```

`useToast`를 가져와 파일이 m4a가 아니면(`asset.mimeType`이 있고 `audio/mp4`·`audio/x-m4a`·`audio/m4a`가 아니면) `toast.show("Only .m4a recordings are supported for now")`를 띄우고 돌아간다. 원본 wav/영상 가져오기는 백로그다.

- [ ] **Step 2: typecheck 후 Commit**

Run: `pnpm --filter mobile typecheck`

```bash
git add apps/mobile/src/features/sessions/NewSessionSheet.tsx
git commit -m "feat(mobile): import an m4a recording from the device"
```

---

### Task 5: 실제 녹음

**Files:**
- Modify: `apps/mobile/src/features/recording/RecordingScreen.tsx`
- Delete: `apps/mobile/src/features/recording/useRecordingTimer.ts`

- [ ] **Step 1: 화면 교체**

```tsx
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder, useAudioRecorderState } from "expo-audio";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { fmtClock, toLocalIso } from "@/lib/time";
import { radius, useTheme } from "@/theme";
import { AppText, Chip, LiveWaveform, MonoLabel, PressableOpacity, Screen, StatusDot, useToast } from "@/ui";

export function RecordingScreen() {
  // HIGH_QUALITY = .m4a, AAC, 44.1kHz, 2ch, 128kbps — 스펙 결정 1과 일치한다
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const state = useAudioRecorderState(recorder, 200);
  const router = useRouter();
  const toast = useToast();
  const { colors } = useTheme();
  const [ready, setReady] = useState(false);
  const startedAtRef = useRef<Date | null>(null);
  const stoppingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        toast.show("Microphone access is needed to record");
        router.back();
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      if (cancelled) return;
      startedAtRef.current = new Date();
      recorder.record();
      setReady(true);
    })().catch(() => {
      toast.show("Couldn’t start recording");
      router.back();
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const seconds = state.durationMillis / 1000;

  const stop = async () => {
    if (stoppingRef.current || !ready) return;
    stoppingRef.current = true;
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) throw new Error("no recording file");
      const durationMs = Math.max(1000, Math.round(state.durationMillis));
      router.replace({
        pathname: "/processing",
        params: {
          fileUri: uri,
          source: "recording",
          startedAt: toLocalIso(startedAtRef.current ?? new Date(Date.now() - durationMs)),
          durationMs: String(durationMs),
        },
      });
    } catch {
      stoppingRef.current = false;
      toast.show("Couldn’t save the recording");
    }
  };

  return (
    <Screen>
      <MonoLabel style={{ textAlign: "center", letterSpacing: 2, paddingTop: 8 }}>REHEARSAL</MonoLabel>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 30 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <StatusDot color={ready ? colors.recording : colors.textFaint} size={10} />
          <MonoLabel color={ready ? colors.recording : colors.textFaint} style={{ fontSize: 12, letterSpacing: 2.4 }}>
            {ready ? "REC" : "PREPARING"}
          </MonoLabel>
        </View>
        <AppText variant="monoTimer">{fmtClock(seconds)}</AppText>
        <LiveWaveform />
        <Chip
          label="+ MARK"
          mono
          style={{ borderRadius: radius.chipLg + 4, paddingVertical: 10, paddingHorizontal: 22, marginTop: 6 }}
          onPress={() => toast.show(`Marked at ${fmtClock(seconds)}`)}
        />
      </View>
      <View style={{ alignItems: "center", gap: 10, paddingBottom: 60 }}>
        <PressableOpacity
          onPress={() => void stop()}
          style={{ width: 72, height: 72, borderRadius: 36, borderWidth: 1, borderColor: colors.borderStronger, alignItems: "center", justifyContent: "center" }}
        >
          <View style={{ width: 22, height: 22, borderRadius: 4, backgroundColor: colors.recording }} />
        </PressableOpacity>
        <AppText variant="small">Stop</AppText>
      </View>
    </Screen>
  );
}
```

`git rm apps/mobile/src/features/recording/useRecordingTimer.ts`.

- [ ] **Step 2: typecheck 후 Commit**

Run: `pnpm --filter mobile typecheck`

```bash
git add -A apps/mobile/src/features/recording
git commit -m "feat(mobile): record AAC m4a with expo-audio and hand it to the upload flow"
```

---

### Task 6: 재생 — expo-audio 플레이어와 presigned URL

**Files:**
- Modify: `apps/mobile/src/features/takes/usePlayback.ts`
- Create: `apps/mobile/src/features/takes/useAudioUrl.ts`
- Modify: `apps/mobile/src/features/takes/TakePlayerScreen.tsx`
- Modify: `apps/mobile/src/features/takes/SessionDetailScreen.tsx`

**Interfaces:**
- Produces: `usePlayback(durationSec, url: string | null)` — 반환 형태 `{ positionSec, playing, toggle, seekTo }`는 그대로. `useAudioUrl(kind: "take" | "session", id: string | undefined): string | null`.

- [ ] **Step 1: useAudioUrl**

```ts
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
```

- [ ] **Step 2: usePlayback 교체**

```ts
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useEffect, useRef, useState } from "react";

/**
 * url이 있으면 expo-audio로 실제 재생, 없으면(Mock 모드) 기존 시뮬레이션 타이머.
 * 두 경로의 반환 형태는 같아서 화면은 어느 쪽인지 모른다.
 */
export function usePlayback(durationSec: number, url: string | null) {
  const player = useAudioPlayer(url ? { uri: url } : null, { updateInterval: 200 });
  const status = useAudioPlayerStatus(player);
  const simulated = useSimulatedPlayback(durationSec, !url);

  if (!url) return simulated;

  const total = status.duration || durationSec;
  return {
    positionSec: status.currentTime,
    playing: status.playing,
    toggle: () => {
      if (status.playing) player.pause();
      else {
        if (status.didJustFinish || status.currentTime >= total) void player.seekTo(0);
        player.play();
      }
    },
    seekTo: (sec: number, autoplay = false) => {
      void player.seekTo(Math.max(0, Math.min(total, sec)));
      if (autoplay) player.play();
    },
  };
}

function useSimulatedPlayback(durationSec: number, enabled: boolean) {
  const [positionSec, setPositionSec] = useState(0);
  const [playing, setPlaying] = useState(false);
  const posRef = useRef(0);
  posRef.current = positionSec;

  useEffect(() => {
    if (!enabled || !playing) return;
    const t = setInterval(() => {
      const next = posRef.current + 0.2;
      if (next >= durationSec) {
        setPositionSec(durationSec);
        setPlaying(false);
      } else {
        setPositionSec(next);
      }
    }, 200);
    return () => clearInterval(t);
  }, [enabled, playing, durationSec]);

  const toggle = () => {
    setPlaying((p) => {
      if (!p && posRef.current >= durationSec) setPositionSec(0);
      return !p;
    });
  };
  const seekTo = (sec: number, autoplay = false) => {
    setPositionSec(Math.max(0, Math.min(durationSec, sec)));
    if (autoplay) setPlaying(true);
  };
  return { positionSec, playing, toggle, seekTo };
}
```

- [ ] **Step 3: TakePlayerScreen 배선**

- `commentKey` 우회를 지운다. `take`는 `{ id, name, durationSec }`가 되고 원본은 `id: "orig"`.
- `const url = useAudioUrl(isOriginal ? "session" : "take", isOriginal ? session?.id : take?.id);`
- `const playback = usePlayback(take?.durationSec ?? 0, url);`
- 코멘트: `useComments(isOriginal ? undefined : take?.id)`; `PlayerWaveform`의 `seed`는 `seedOf(isOriginal ? \`${session.id}-orig\` : take.id)`.
- `CommentInput`은 `isOriginal`이면 렌더하지 않고, 대신 `FEEDBACK` 헤더 아래 빈 상태 문구를 `"Feedback lives on takes — open one to leave a note."`로 바꾼다.
- `api.comments.create(take.id, { atSec: playback.positionSec, text })` — `Math.floor`를 지운다 (서버가 ms로 저장한다).

- [ ] **Step 4: SessionDetailScreen 빈 상태**

`FlatList`에 `ListEmptyComponent`를 추가한다:

```tsx
        ListEmptyComponent={
          <AppText variant="caption" color={colors.textFaint} style={{ paddingVertical: 18 }}>
            No takes were found in this recording. You can still listen to the original.
          </AppText>
        }
```

- [ ] **Step 5: typecheck 후 Commit**

Run: `pnpm --filter mobile typecheck && pnpm --filter mobile test`

```bash
git add apps/mobile/src/features/takes
git commit -m "feat(mobile): play takes from presigned URLs and post comments to the API"
```

---

### Task 7: 웹 미리보기 검증과 기기 검증 안내

**Files:**
- Modify: `apps/mobile/.env.example` (설명 갱신), `README.md`

- [ ] **Step 1: Mock 모드 웹 확인**

`EXPO_PUBLIC_API_URL`을 비운 채 `pnpm dev`로 Expo 웹을 띄우고, Sessions → New session → Import 흐름이 Mock 진행률 → analyzing → ready → 세션 상세 → take 재생(시뮬레이션) → 코멘트까지 동작하는지 브라우저에서 확인한다. 웹에서는 document picker가 브라우저 파일 선택으로 동작하고 `fetch(uri).blob()`도 된다.

- [ ] **Step 2: 실서버 웹 확인 (선택)**

`.env`에 `EXPO_PUBLIC_API_URL=http://localhost:3001`을 넣고 dev 로그인이 없는 웹에서는 로그인이 막히므로, 이 단계는 맥/iOS 실기기에서 Google/Apple 로그인 후 진행한다. 그 전에 서버 플랜 Task 13의 스크립트가 통과했으면 서버 쪽은 검증된 상태다.

- [ ] **Step 3: README 갱신**

`README.md`의 "로컬 개발 환경"에 다음을 더한다:

```markdown
### 녹음 업로드·분석 (모바일)

- 가져오기·녹음 모두 m4a만 다룬다. 업로드는 앱이 R2에 직접 하고(presigned multipart), 완료되면 워커가 분석한다.
- 새 네이티브 모듈(expo-audio, expo-document-picker)이 들어갔으니 dev build를 다시 만들어야 한다: `pnpm --filter mobile ios` (맥).
- 서버 없이 UI만 볼 때는 `EXPO_PUBLIC_API_URL`을 비워 Mock으로 띄운다. Mock은 업로드 진행률만 흉내 내고 재생은 시뮬레이션이다.
```

- [ ] **Step 4: Commit**

```bash
git add README.md apps/mobile/.env.example
git commit -m "docs: describe the mobile upload flow and dev build requirement"
```

## 이월 (docs/backlog.md 참조)

앱 종료 후 업로드 재개, 3시간 백그라운드 녹음, 실제 파형, Take 경계 편집, 대댓글 UI, 원본 코멘트, `+MARK` 힌트.
