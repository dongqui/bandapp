# 타임라인 뷰어 설계 (스펙 A)

## 목표

2~3시간짜리 원본 녹음 위에서 AI가 뽑은 take를 확인하는 별도 화면을 만든다. 팬·핀치 줌으로 자유롭게 이동하고, 재생 위치가 파형과 실시간으로 맞고, 파형을 눌러 seek하고, take를 골라 그 구간으로 자동 확대한다. Take 경계 편집(핸들 드래그, 재컷, PATCH API)은 **스펙 B**로 미룬다 — 이 스펙은 편집 없이도 "긴 녹음에서 take를 빠르게 찾고 듣는다"는 절반의 목표를 완성한다.

GPT와 쓴 초안 문서("Take N — Original Recording Timeline Editor")의 원칙은 그대로 따른다. 모든 상태의 기준은 픽셀이 아니라 `timeMs`이고, 화면 폭만큼만 그리며, 팬·줌·재생·take가 하나의 좌표 변환식을 공유한다. 이 스펙은 그 원칙을 지금 코드베이스에 맞춰 구체화하고, 초안에 빠져 있던 서버·데이터·라이브러리 결정을 채운다.

현재 상태: 원본 녹음 플레이어([TakePlayerScreen](../../../apps/mobile/src/features/takes/TakePlayerScreen.tsx))는 `session.peaks` 128버킷을 View 64개로 그리고, Responder 시스템으로 drag-seek한다. 워커는 원본을 50 peaks/초로 디코드한 뒤 128버킷만 남기고 고해상도 배열은 버린다([2026-09-10 스펙](2026-09-10-real-waveform-design.md)). 앱에 Skia·gesture-handler 직접 의존성은 없다(gesture-handler 3.2.1은 expo-router 전이 의존성). 세션 상세 디자인에는 "Edit takes" 칩이 있지만 프로토타입에서는 토스트 스텁이고, 타임라인 화면 자체는 디자인에 없다.

## 범위

**포함:**
- 워커가 고해상도 피크를 R2 사이드카(`peaks.bin`)로 올리고, `sessions.peaks_key`에 키를 저장 — 마이그레이션 `0008`
- `GET /sessions/:id/peaks` — presigned URL 발급. api-client `sessions.peaksUrl(id)`
- 앱: 타임라인 화면 `/session/[id]/timeline` — 파형(react-native-svg + Reanimated), 시간 눈금, take 오버레이·선택·자동 줌, playhead, 팬·핀치·탭, 재생/일시정지/seek, follow playhead, 오버뷰, 디버그 오버레이(dev)
- 순수 함수 모듈 `src/lib/timeline/` + vitest (좌표·줌·팬·clamp·fit·LOD 선택·눈금·playhead 보간·follow 정책·peaks 파일 파싱)
- 세션 상세의 "Edit takes" 칩이 이 화면으로 진입
- 의존성 추가: `react-native-gesture-handler` (직접 의존성) + 루트 `GestureHandlerRootView`

**제외 (스펙 B 또는 백로그):**
- Take 시작/종료 핸들 드래그, edge auto pan, PATCH takes, 재컷, take 코멘트 `atSec` 이동 정책 — 스펙 B
- Playhead 스크럽(핸들을 잡고 끄는 seek) — 탭 seek와 ±1초 버튼으로 충분. B에서 핸들 제스처와 함께 넣는다
- 타임라인 위 코멘트 마커 — 원본 코멘트는 절대 시각이라 붙이기 쉽지만 이번 화면의 목적(take 확인)과 무관
- LOD 교체 crossfade — hysteresis만 둔다. 튀는 게 눈에 띄면 그때
- peaks.bin 디스크 캐시 — presigned URL 1시간, 540KB라 화면 진입마다 받는다
- 기존 세션 백필 — retry로 재분석하면 채워진다. `peaks_key`가 null이면 128버킷 폴백으로 그린다
- 가로 모드 — `orientation: portrait`. 폭 변화는 태블릿 split 정도만 `centerMs` 유지로 대응
- 라이브 파형·take 플레이어 화면 변경 — 손대지 않는다

## 결정

1. **별도 화면, 진입은 세션 상세의 "Edit takes" 칩.** 디자인이 이미 칩 자리를 잡아 놓았고 타임라인은 결국 그 칩이 여는 화면이다. 스펙 A 동안은 편집이 없으므로 라벨을 **"Timeline"**으로 바꾸고, B가 들어오면 디자인대로 "Edit takes"로 되돌린다. (제품 결정 — 사용자 확인 필요. 대안: 라벨은 두고 화면 안에서 "편집은 곧"을 안내.)

2. **타임라인 화면 UI는 Claude Design에 먼저 요청한다.** 디자인 파일에 이 화면이 없다(`data-screen-label` 7개 중 없음). 프로젝트 규칙(`design-delegation`)대로 아래 "디자인 브리프"를 보내고, 그 결과가 화면 명세가 된다. 브리프가 돌아오기 전에는 서버·데이터·순수 함수·제스처/재생 훅까지 구현하고, 화면 조립만 블로커로 남긴다.

3. **고해상도 피크는 R2 사이드카, 피라미드는 앱에서.** 워커가 이미 만드는 `Uint8Array`(50 peaks/초, 3시간 = 540KB)를 `bands/{bandId}/sessions/{sessionId}/peaks.bin`으로 올린다. 서버 피라미드·별도 해상도 엔드포인트는 만들지 않는다 — 54만 개 max 다운샘플은 앱에서 수 ms다. 50 peaks/초 = 20ms/peak이고 최대 줌(5초/화면, 390px)이 12.8ms/px라 바 하나(3px)에 피크 1~2개가 들어간다. 더 촘촘히 원하면 워커 상수 `PEAKS_PER_SEC` 하나만 올린다.

4. **peaks.bin은 8바이트 헤더 + 원시 바이트.** `"TNPK"`(4) + version u8(=1) + peaksPerSec u16 LE + reserved u8(=0), 이어서 0~255 피크 바이트. 헤더가 있어야 나중에 `PEAKS_PER_SEC`를 바꿔도 옛 객체를 읽을 수 있다. 앱 파서(`parsePeaksFile`)는 magic·version이 다르면 throw하고, 화면은 128버킷 폴백으로 내려간다.

5. **`sessions.peaks_key text null`.** 사이드카 업로드가 성공했을 때만 채운다. ffmpeg 실패(기존 결정 5)나 업로드 실패면 null로 두고 warn 로그 — 파형은 장식이지 분석 결과가 아니다. 키 규약(`peaksKey()`)은 `session-mapper.ts`에 두고, 세션 삭제 정리 배치(백로그)가 지울 객체 목록에 추가한다.

6. **정규화는 세션 전체 최댓값 기준 한 번.** hires 전체의 max로 나눠 0~1 스케일을 만든다. viewport마다 정규화하면 팬할 때 파형이 숨쉬듯 흔들린다. 128버킷 폴백은 이미 세션 기준으로 정규화돼 있다.

7. **렌더링은 react-native-svg + Reanimated `animatedProps`, 상태는 shared value.** 처음 검토에서는 Skia를 추천했지만 계획 단계에서 바꿨다. 이 프로젝트의 주 개발 루프가 Browser pane의 웹 Mock 프리뷰인데 Skia는 웹에서 canvaskit(wasm) 로딩 설정이 따로 필요하고, `react-native-svg` 15는 이미 의존성이며 웹 구현의 `setNativeProps`가 Reanimated `animatedProps` 전용으로 만들어져 있어 네이티브·웹이 같은 코드로 돈다. viewport·playhead가 shared value라 팬·줌·재생 중 React 리렌더가 0이고, 바 `Path`의 `d`를 `useDerivedValue`로 UI 스레드에서 만들어 `animatedProps`로 흘린다(바 ≤ 130개, 프레임당 문자열 하나). 눈금 라벨만 React state로 받는다(작은 컴포넌트, 제스처 중에만 갱신). 기기에서 팬·줌이 60fps에 못 미치면 그때 `WaveformCanvas` 한 파일만 Skia로 바꾼다 — 좌표·LOD 계산은 전부 순수 함수라 옮길 게 렌더러뿐이다. 비용: gesture-handler 직접 의존성 추가로 dev client 재빌드(Windows Android는 `subst` 우회).

8. **제스처는 react-native-gesture-handler.** Responder 시스템으로는 핀치와 exclusive 관계를 못 만든다. `Gesture.Race(Gesture.Simultaneous(pan, pinch), tap)`. 팬은 `onChange`의 `changeX`를 현재 `viewStart`에 더하는 증분 방식이라 핀치 → 팬 전환에서 origin을 다시 잡을 필요가 없다(초안 22-G). 매 이벤트마다 clamp한다.

9. **재생 위치의 기준은 expo-audio status.** `useAudioPlayerStatus`(200ms)가 주는 `currentTime`·`playing`을 anchor `{posMs, atMs: performance.now(), playing}`로 shared value에 쓰고, `useFrameCallback`이 `playheadMs = playing ? posMs + (now − atMs) : posMs`로 보간한다. 보간은 anchor로부터 **최대 400ms**까지만 — status가 멈추면(버퍼링·인터럽션) playhead도 멈춘다. seek는 `seekTo()` Promise가 끝날 때까지 `seekPending`을 세워 도착하는 status를 무시하고, 그동안 playhead는 seek 목표에 고정한다(초안 22-D의 generation 토큰을 Promise로 대신한다). `isBuffering`·`didJustFinish`도 anchor에 반영한다.

10. **Follow playhead는 초안 13·14절 그대로.** play → ON, 사용자 팬/핀치 시작 → OFF, playhead가 화면 폭 80%를 넘으면 30% 위치로 viewport를 옮긴다(애니메이션 없이 점프 — 계속 흐르는 느낌을 줄이려는 초안 의도). playhead가 화면 밖이면 가장자리에 표시 + "재생 위치로" 버튼이 ON으로 되돌리고 playhead를 30%에 놓는다. 이 정책은 순수 함수 `followViewport()`다.

11. **Take 선택은 seek와 다른 타깃에서.** 파형을 탭하면 seek, take 레인(파형 위의 take 띠)을 탭하면 선택 + `fitRange(take, padding 20%)`. 같은 영역에서 둘을 겸하면 take 안을 seek할 때마다 줌이 튄다. 레인의 정확한 모양은 Claude Design이 정한다. 너무 긴 take는 fit이 최소 줌(전체)에 걸리는 게 자연스러운 상한이다. 선택된 take는 이름·구간을 보여주고 "Open take"로 take 플레이어(`/session/[id]/take/[takeId]`)로 간다.

12. **줌 범위.** 최소 줌 `msPerPx = durationMs / widthPx`(전체가 한 화면), 최대 줌 `msPerPx = 5000 / widthPx`(5초가 한 화면). 10초짜리 녹음처럼 duration < 5초 × 2면 최소·최대가 같아질 수 있으니 `clampViewport`가 max ≥ min을 보장한다.

13. **LOD.** `buildLevels(hires)`: L0 = hires, L(k+1) = L(k)를 2개씩 max로 접은 것, 길이가 512 이하가 될 때까지(3시간이면 11단계, 메모리 합 ~1.1MB). 바 피치 `BAR_PX = 3`(2px 바 + 1px 간격), 바 수 = `floor(widthPx / BAR_PX)`. 레벨 선택은 "바 하나당 피크 1~3개"를 목표로 하되 hysteresis: 현재 레벨의 바당 피크가 3.5를 넘으면 한 단계 거칠게, 0.8 미만이면 한 단계 세밀하게. 폴백(128버킷)은 레벨 하나짜리 피라미드다.

14. **Mock은 사이드카 없음.** `sessions.peaksUrl`이 `{ url: "" }`을 돌려주고 앱은 빈 URL을 null로 봐서 128버킷 폴백으로 그린다. 프리뷰에서 팬·줌·take 동작은 다 확인되고 파형만 거칠다.

## 스키마

```sql
ALTER TABLE "sessions" ADD COLUMN "peaks_key" text;
```

drizzle: `peaksKey: text("peaks_key")`. 마이그레이션 `0008`은 `pnpm --filter @bandapp/api db:generate`로 만든다. 기존 행은 null.

## 타입·API 계약

`packages/types`:

```ts
/** peaks.bin 헤더. 앱 파서와 워커 인코더가 공유한다 (2026-09-11 스펙 결정 4) */
export const PEAKS_FILE_MAGIC = "TNPK";
export const PEAKS_FILE_VERSION = 1;
export const PEAKS_FILE_HEADER_BYTES = 8;
```

`Session` wire 타입은 바뀌지 않는다 — `peaks_key`는 노출하지 않고 엔드포인트가 404로 알린다.

**`GET /sessions/:id/peaks`** → `AudioUrl` 모양 `{ url, expiresAt }` (presigned GET, 1시간). 멤버가 아니면 기존 세션 조회와 같은 403/404. `peaks_key`가 null이면 404 `peaks_not_found`. api-client: `sessions.peaksUrl(id): Promise<AudioUrl>`. Mock: `{ url: "", expiresAt }`.

## 워커

`FfmpegRunner`는 변경 없음. `SessionAnalysisService.run`:

```
hires = await this.extractPeaks(sessionId, original)           // 기존
peaksKey = hires ? await this.uploadPeaks(sessionId, bandId, hires, workDir) : null   // 실패하면 null + warn
...
update sessions set ..., peaks = ..., peaksKey
```

`uploadPeaks`는 `encodePeaksFile(hires, PEAKS_PER_SEC)`(순수 함수, `apps/api/src/worker/peaks.ts`)로 헤더를 붙여 `workDir/peaks.bin`에 쓰고 `storage.putFile(key, path, "application/octet-stream")` 뒤 지운다. retry는 같은 키를 덮어쓴다. `peaksKey()`는 `session-mapper.ts`에 `originalKey`·`takeKey` 옆에 둔다.

## 서버

- `SESSION_WITH_COUNTS`에 `peaksKey: sessions.peaksKey`, `SessionRow.peaksKey: string | null`. `toSession`은 노출하지 않는다.
- `SessionsService.peaksUrl(id, userId)` — `audioUrl`과 같은 멤버 검사 후 `peaksKey`가 null이면 `NotFoundException("peaks_not_found")`, 아니면 `presignGet(peaksKey, PRESIGN_EXPIRES_SEC)`.
- `SessionsController` `@Get(":id/peaks")`.

## 모바일

### 의존성·루트

- `react-native-gesture-handler`를 `apps/mobile/package.json` 직접 의존성으로 (지금 잠긴 3.2.1 그대로). Skia는 넣지 않는다 (결정 7).
- `app/_layout.tsx`의 `SafeAreaProvider` 바깥을 `GestureHandlerRootView style={{ flex: 1 }}`로 감싼다.
- dev client 재빌드 필요 (Android: `subst B:` 경로, iOS: `expo run:ios`).

### 파일 구조

```
apps/mobile/src/lib/timeline/          — RN 없이 테스트하는 순수 함수
  viewport.ts        timeToX, xToTime, clampViewport, panViewport, zoomAtFocal,
                     fitRange, minMsPerPx, maxMsPerPx, keepCenterOnResize
  follow.ts          followViewport (80% → 30% 정책), playheadEdge
  playhead.ts        interpolatePlayhead(anchor, nowMs)  (400ms 상한)
  levels.ts          buildLevels, selectLevel (hysteresis), barsForViewport
  ruler.ts           rulerTicks(viewport) — 1s/5s/10s/30s/1m/5m/10m/30m/1h 사다리, 라벨 간격 ≥ 80px
  peaksFile.ts       parsePeaksFile(ArrayBuffer) → { peaksPerSec, peaks: Uint8Array }
  *.test.ts

apps/mobile/src/features/timeline/
  TimelineScreen.tsx        화면 조립 (Claude Design 결과대로)
  useTimelineViewport.ts    shared values(viewStart, msPerPx, widthPx) + 제스처 정의
  usePlayheadClock.ts       expo-audio status → anchor shared value → useFrameCallback 보간, seek pending
  useFollowPlayhead.ts      follow 플래그 + useAnimatedReaction
  useSessionPeaks.ts        peaksUrl → fetch → parse → buildLevels, 실패·404·Mock이면 128버킷 폴백
  WaveformCanvas.tsx        Svg: 파형 Path 두 개(재생 전/후, animatedProps d) + take 레인 Path + 선택 Rect + playhead(Animated.View)
  TimeRuler.tsx             눈금 — viewport 스냅샷을 React state로 받아 그린다
  OverviewStrip.tsx         작은 Svg: 최저 LOD(정적) + take 마커 + viewport 창(animatedProps), 탭/드래그로 이동
  TimelineDebugOverlay.tsx  __DEV__ 전용, 200ms throttle로 shared value를 텍스트로

apps/mobile/app/session/[id]/timeline.tsx   → export { TimelineScreen as default }
```

### 상태 구분

| 60fps (shared value, UI 스레드) | React state |
|---|---|
| `viewStart`, `msPerPx`, `widthPx` | `selectedTakeId` |
| `playheadAnchor`, `playheadMs`, `seekPending` | `levels` (로드 결과), `peaksSource: "hires" \| "buckets" \| "none"` |
| `followPlayhead`, `activeGesture` | `playing`, `error`, 클럭 라벨용 `positionSec`(200ms) |
| take 구간 배열 (`startMs[]`, `endMs[]`) | take 목록 자체 |

클럭 라벨은 200ms마다 리렌더되지만 Skia 캔버스와 제스처는 shared value만 읽으므로 영향이 없다.

### 좌표·viewport (초안 2·4·5·6·7절)

```ts
type Viewport = { startMs: number; msPerPx: number; widthPx: number };
timeToX(v, t)      = (t - v.startMs) / v.msPerPx
xToTime(v, x)      = v.startMs + x * v.msPerPx
minMsPerPx(d, w)   = d / w                       // 전체가 한 화면
maxMsPerPx(w)      = 5000 / w                    // 5초가 한 화면
clampViewport(v, d): msPerPx를 [max(maxMsPerPx, ·), minMsPerPx] 안으로, 그 뒤 startMs를 [0, d - w·msPerPx] 안으로
panViewport(v, dxPx, d)          = clamp({ ...v, startMs: v.startMs - dxPx * v.msPerPx })
zoomAtFocal(v, focalX, scale, d) = focalT = xToTime(v, focalX); m = v.msPerPx / scale;
                                   clamp({ startMs: focalT - focalX * m, msPerPx: m })
fitRange(s, e, w, pad, d)        = span = (e - s) * (1 + 2·pad); m = span / w;
                                   clamp({ startMs: s - (e - s)·pad, msPerPx: m })
keepCenterOnResize(v, newW, d)   = center 유지
```

핀치는 RNGH `onUpdate`의 `scale`·`focalX`를 `onBegin` 시점 viewport에 적용한다(누적이 아니라 시작 viewport 기준 절대 scale). 팬은 증분(`changeX`). 둘이 동시에 오면 핀치가 시작 viewport 기준으로 계산한 결과에 팬 증분을 더한다.

### 재생 (초안 11·12절)

`usePlaybackClock(player, status)`:
- status 도착: `seekPending`이 false일 때만 anchor 갱신 `{ posMs: currentTime·1000, atMs: now, playing: playing && !isBuffering }`.
- `useFrameCallback`: `playheadMs.value = interpolatePlayhead(anchor, now)` — `playing`이면 `min(now - atMs, 400)`만큼 더한다.
- `seekTo(ms)`: `seekPending = true`, anchor를 `{ posMs: ms, playing: false }`로 즉시 고정, `player.seekTo(ms/1000)` resolve/reject 후 `seekPending = false`. 다음 status가 실제 위치로 재동기화한다.
- `toggle`은 기존 `usePlayback`과 같다(끝났으면 0으로). 소스는 `useAudioUrl("session", id)`.
- 백그라운드 → 포그라운드, 인터럽션은 expo-audio가 status로 알려 주므로 별도 처리 없음. 화면 unmount 시 `player.pause()`.

### 제스처 (초안 12·13·18절)

```
tap    (Gesture.Tap)   파형 영역: seekTo(xToTime(x)); take 레인: selectTake(hit) + fitRange
pan    (Gesture.Pan)   activeOffsetX ±6 — onBegin: follow=OFF, activeGesture="pan"
                       onChange: viewStart = panViewport(...).startMs
pinch  (Gesture.Pinch) onBegin: follow=OFF, 시작 viewport 저장; onUpdate: zoomAtFocal(시작 viewport, focalX, scale)
composed = Gesture.Race(Gesture.Simultaneous(pan, pinch), tap)
```

`onFinalize`에서 `activeGesture = null`. 이 화면에는 세로 스크롤 부모가 없다(take 목록은 이 화면에 없다). 오버뷰는 별도 Pan/Tap: 탭한 시각을 viewport 중앙으로, 드래그는 viewport 창을 끈다(seek 아님).

### 파형 렌더링 (초안 8·9·29절)

`useDerivedValue`가 매 프레임 `viewStart`·`msPerPx`·현재 레벨로 바 높이 배열을 만들고, 바마다 `M x y h2 v h h-2 z` 조각을 이어 붙인 path 문자열 두 개(playhead 이전 = `accent`, 이후 = `borderStronger`)를 `Animated.createAnimatedComponent(Path)`의 `animatedProps.d`로 흘린다. 바 수 ≤ 130이고 바당 피크 ≤ 3.5개라 프레임당 연산은 수백 회다. 레벨 교체는 React state가 아니라 `useDerivedValue` 안에서 `selectLevel`이 결정해 shared value에 기억한다(hysteresis 상태). 높이 공식은 `barHeight()` 재사용(`"worklet"` 지시자를 붙인다). LOD 피라미드(`Uint8Array[]`)는 worklet 클로저에 잡혀 UI 런타임으로 한 번 복사된다 — react-native-worklets가 typed array를 직렬화한다.

Take 레인: 화면 안의 take를 `[timeToX(start), timeToX(end)]` 사각형 path 하나로(muted), 선택된 take는 `animatedProps` x/width를 받는 `Rect`(accent) + 파형 위 반투명 `Rect`. 화면 밖 take는 건너뛴다. Playhead: `useAnimatedStyle` translateX의 `Animated.View`(1px 선 + 상단 삼각), 화면 밖이면 좌/우 가장자리 표시. 눈금: `TimeRuler`가 `useAnimatedReaction`으로 viewport 스냅샷을 `scheduleOnRN`으로 받아 React state로 그린다 — 제스처 중에만 바뀌는 작은 컴포넌트라 리렌더 비용이 무시할 만하다.

오버뷰: 최저 LOD를 폭에 맞춰 그리고, take는 3px 마커, 현재 viewport는 반투명 창. 1~2분 take를 3시간 위에서 정확히 표현하려 하지 않는다(초안 21절). 클러스터 처리는 하지 않는다 — 마커가 겹치면 겹친 채로 둔다.

### 디버그 오버레이 (초안 30절)

`__DEV__`에서 화면 상단 토글. `useAnimatedReaction` + 200ms throttle로 `viewStart`, `viewEnd`, `msPerPx`, LOD index, `playheadMs`, anchor, `seekPending`, `followPlayhead`, `activeGesture`, `selectedTakeId`, `peaksSource`를 텍스트로 보여준다.

## 디자인 브리프 (Claude Design에 보낼 것)

`design-delegation` 스킬의 프리앰블을 그대로 붙인 뒤:

- **목적:** 2~3시간 원본 녹음 위에서 AI가 뽑은 take를 찾고 듣는 타임라인 화면. 편집은 다음 단계라 이번에는 읽기 전용.
- **진입:** Session Detail의 "Edit takes" 칩(스펙 A 동안 라벨 "Timeline"). 뒤로 가면 Session Detail.
- **필수 요소:** 제목·길이 헤더 / 시간 눈금 / 메인 파형(팬·핀치, 탭 seek) / take 레인(파형과 분리된 탭 타깃, 선택 상태) / playhead(화면 밖일 때 가장자리 표시) / 전체 오버뷰(현재 viewport 창, take 마커) / 재생·일시정지, 현재 시각·전체 길이, ±1초 / "재생 위치로 돌아가기"(follow가 꺼졌을 때만) / 선택된 take의 이름·구간과 "Open take".
- **상태:** 피크 로딩 중, 고해상도 피크 없음(거친 폴백 파형이지만 동작은 같음), take 0개, 오디오 재생 실패(토스트).
- **정책(변경 금지):** take 탭 → 그 구간이 좌우 20% 여백과 함께 보이도록 자동 줌. 재생 중 사용자가 움직이면 follow 해제. 팬·줌은 녹음 범위를 넘지 않는다.

## 테스트

- **mobile vitest** (`pnpm --filter mobile test`):
  - `viewport.test.ts` — 표: 10초·1분·10분·2시간·3시간·6시간 × 폭 320/390/768. `xToTime(timeToX(t)) ≈ t`, clamp 불변식(`startMs ≥ 0`, `endMs ≤ duration`), `zoomAtFocal` 뒤 focal 시각의 x가 ±0.5px 안(0.5×~5× 20회 왕복 후에도), 끝에서 줌 시 빈 화면 없음(초안 22-H), 최소·최대 줌 역전 없음, `fitRange` 좌우 여백, `keepCenterOnResize`.
  - 랜덤 루프(시드 고정 LCG, 2000회): pan/zoom/fit을 섞어도 불변식 유지, 픽셀 누적 오차 없음(항상 절대 계산이라 초안 22-J).
  - `follow.test.ts` — 80% 넘김 → 30% 위치, follow OFF면 불변, 화면 밖 판단.
  - `playhead.test.ts` — 정지·재생·400ms 상한·seekPending 중 고정·버퍼링.
  - `levels.test.ts` — 피라미드 길이·max 보존, `selectLevel` hysteresis(경계에서 왔다 갔다 하지 않음), 폴백 128버킷.
  - `ruler.test.ts` — 라벨 간격 ≥ 80px, 줌 단계별 사다리 선택.
  - `peaksFile.test.ts` — 헤더 파싱, magic/version 불일치 throw, 빈 본문.
- **api 단위:** `peaks.spec.ts`에 `encodePeaksFile` 헤더·바이트. `session-analysis.service.spec.ts`에 `putFile(peaksKey, …, "application/octet-stream")` 호출과 세션 update의 `peaksKey`, `ffmpeg.peaks` throw 시 `peaksKey: null`, putFile throw 시 `peaksKey: null` + ready 유지.
- **api e2e:** `GET /sessions/:id/peaks`가 키 있는 세션에 URL을, 없는 세션에 404 `peaks_not_found`를, 비멤버에 403/404를 돌려준다.
- **api-client:** Mock `peaksUrl`이 빈 URL. Http는 경로만.
- **기기 검증(dev build, 자동화 불가):** 초안 25~28절 — 핀치 스트레스(손가락 아래 시각 고정), 핀치 중 손가락 하나 떼기, 재생 중 팬/핀치 → follow 해제, seek 직후 되돌아감 없음, 백그라운드 복귀·블루투스 전환 후 playhead 재동기화, 3시간 세션에서 팬·줌 60fps, Android 제스처 취소 후 상태 잔류 없음.
- `pnpm typecheck`·`pnpm lint`·`pnpm build` 통과.

## 구현 순서

1. types 상수, 워커 인코더 + 사이드카 업로드, 마이그레이션, 엔드포인트, api-client — 서버 쪽은 디자인과 무관하게 먼저 끝낸다.
2. `lib/timeline/*` 순수 함수 + 테스트 (초안 Phase 1).
3. 의존성 추가, `GestureHandlerRootView`, dev client 재빌드.
4. `useSessionPeaks`, `usePlaybackClock`, `useTimelineViewport`, `useFollowPlayhead` — 훅은 화면 없이도 임시 캔버스로 기기 확인 가능.
5. Claude Design 결과 수신 → `WaveformCanvas`, `OverviewStrip`, `TimelineScreen` 조립, 라우트, 세션 상세 칩 연결.
6. 디버그 오버레이, 기기 검증 목록 수행.

## 완료 조건

초안 33절 중 A에 해당하는 것: Zoom(focal 고정), Pan(범위 유지), Playback(재동기화), User Navigation(강제 복귀 없음), Take(모든 줌에서 `startMs/endMs` 동일), Long Recording(데이터·폭이 길이에 비례하지 않음 — 화면에 내려오는 건 540KB 한 번), Performance(팬·줌·재생 중 React 리렌더 없음 — 디버그 오버레이 제외), Recovery(제스처 취소·seek·백그라운드 후 정상). Editing 항목은 B.

## 문서

README 분석 파이프라인 한 줄에 "피크 사이드카 업로드"를 더한다. `docs/backlog.md`: "Take 경계 편집" 항목을 스펙 B 내용(핸들·edge auto pan·PATCH·재컷·코멘트 `atSec` 정책·스크럽)으로 갱신하고, "세션 삭제 API와 R2 객체 정리"에 `peaks.bin`을 추가하고, "타임라인 코멘트 마커"와 "LOD crossfade"를 새로 적는다.

## 2026-09-20 디자인 개정

Claude Design "Timeline" 화면이 바뀌어 코드를 맞췄다. 이 절이 위 본문(결정 10·11, 화면 구성)과 스펙 B의 카드 설명보다 우선한다.

- **첫 take에서 시작.** 화면을 열면 첫 take가 선택되고 viewport가 그 take에 fit된다 (전체 보기로 시작하지 않는다). 레이아웃 전에 선택이 오면 `fitTo`가 첫 레이아웃까지 미룬다.
- **take 내비.** 오버뷰 아래 `‹ TAKE n / N ›`. 선택이 없으면 `N TAKES`, ›는 첫 take, ‹는 마지막 take. dirty 초안이 있으면 레인 탭과 같이 Discard 확인을 거친다.
- **레인 라벨.** 필 안은 `T1`처럼 번호만, 가운데 정렬. 이름은 내비가 보여 준다.
- **빠진 것.** 파형 위 −/+ 줌 버튼(핀치만 남는다, `zoomBy` 삭제), "⟲ PLAYHEAD" 필, 카드의 ··· 와 Open take. 카드는 초안이 dirty이거나 `audioStatus`가 updating/failed일 때만 뜬다.
- **오버뷰 playhead.** 2px 선 + 위쪽 7px 점.

디자인에 없어 코드에서 정한 것 (디자인이 바뀌면 다시 본다):

- **take 선택 = seek.** 자동 선택·내비·레인 탭 모두 재생 위치를 take 시작으로 옮기고 follow를 켠다. 디자인 프로토타입은 viewport만 옮겨서, 재생을 누르면 화면 밖 00:00부터 들렸다. 오디오 로드 전의 seek는 `usePlaybackClock`이 들고 있다가 로드 후 적용한다.
- **follow 복귀.** 필이 없어졌으니 재생 시작, 파형 탭 seek, take 선택이 follow를 다시 켠다.
- **take 삭제 진입점.** ··· 가 빠져서 레인 필 롱프레스가 기존 `TakeActionSheet`를 연다. 보이는 진입점이 필요하면 Claude Design에서 정한다.
- **Open take.** 타임라인에서 Take Feedback으로 가는 길은 없다 — 세션 상세의 take 목록으로 간다.
