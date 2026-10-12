# 녹음 화면 실제 미터링 파형 + MARK 제거 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 녹음 화면의 장식용 시드 파형을 expo-audio 미터링 값으로 그리는 "흘러가는 기록" 파형으로 바꾸고, 토스트만 띄우던 `+ MARK` 버튼을 없앤다.

**Architecture:** `lib/metering.ts`에 dB→0~1 변환(`dbToUnit`)과 고정 길이 레벨 큐(`pushLevel`) 순수 함수를 두고 vitest로 고정한다. `LiveWaveform`은 애니메이션을 버리고 `levels: number[]`를 받아 `barHeight`로 바 34개를 그리기만 한다. `RecordingScreen`이 `useAudioRecorderState`의 200ms 틱마다 `state.metering`을 변환해 레벨 배열을 쌓는다. 서버·워커·네이티브 모듈 변경 없음(미터링은 녹음 옵션이라 dev client 재빌드 불필요).

**Tech Stack:** Expo 57 / expo-audio ~57.0.4 (`isMeteringEnabled`, `RecorderState.metering`), React Native 0.86, vitest 4.

**Spec:** [docs/superpowers/specs/2026-10-12-live-metering-remove-mark-design.md](../specs/2026-10-12-live-metering-remove-mark-design.md)

## Global Constraints

- 범위는 `apps/mobile`의 녹음 화면만. 서버·워커·`StaticWaveform`·`PlayerWaveform`·`lib/peaks.ts` 수정 금지(`barHeight`는 import만).
- `METER_FLOOR_DB = -60`, `METER_CEIL_DB = 0`, 선형 매핑, 밖은 clamp. `undefined`와 `-160`(무음)은 0.
- `LIVE_BARS = 34`, 바 너비 3, 간격 3, `borderRadius 1.5`, 색 `colors.textSecondary`, 기본 height 72, 최소 높이 `Math.round(height * 0.12)`.
- 상태는 `RecordingScreen`이 들고 `LiveWaveform`은 그리기만. 별도 타이머·Reanimated 없음.
- `seededUnit`(`lib/seed.ts`)은 `LoginScreen`이 쓰므로 삭제하지 않는다.
- 평활화(EMA) 넣지 않는다. 200ms 샘플 그대로.
- 테스트는 vitest, 실행은 `pnpm --filter mobile test`. 타입 검사는 `pnpm --filter mobile typecheck`. (스펙의 `pnpm --filter mobile lint`는 mobile 패키지에 lint 스크립트가 없어 typecheck로 대체한다.)
- 코드 주석은 한국어, 커밋 메시지는 기존 관례(`feat(mobile): ...`, `docs: ...`)에 맞춘다.
- 모든 커밋 메시지 끝에 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. `dbToUnit`에 `NaN`이 들어오면 0으로 떨어져야 한다(`Math.max(0, NaN)`은 NaN이라 바 높이가 NaN이 된다). → Task 1 테스트에 추가.
2. `pushLevel`에 `size <= 0`이 들어오면 빈 배열을 돌려야 한다(`slice(-0)`은 전체를 돌려준다). → Task 1 테스트에 추가.
3. `LiveWaveform`에 `levels`가 `bars`보다 길게 들어오면 **뒤에서** `bars`개를 써야 한다(가장 최근이 오른쪽). → Task 2 테스트에 추가.
4. `LiveWaveform`에 `levels`가 비어 있으면 모든 바가 최소 높이로 평평해야 한다(PREPARING 상태). → Task 2 테스트에 추가.
5. `ready`가 false인 동안(PREPARING)은 레벨을 쌓지 않아야 하고, `ready` 전환 뒤 첫 틱에서야 쌓이기 시작해야 한다. → Task 3은 훅 테스트 환경이 없어(RN 컴포넌트 테스트 미설정) 기기 검증(Task 5)으로 확인한다.

---

### Task 1: `lib/metering.ts` 순수 함수 + 테스트

**Files:**
- Create: `apps/mobile/src/lib/metering.ts`
- Create: `apps/mobile/src/lib/metering.test.ts`

**Interfaces:**
- Consumes: 없음.
- Produces:
  - `export const METER_FLOOR_DB: number` (-60), `export const METER_CEIL_DB: number` (0)
  - `export function dbToUnit(db: number | undefined): number` — 0~1
  - `export function pushLevel(levels: number[], unit: number, size: number): number[]` — 새 배열, 길이 ≤ size

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/mobile/src/lib/metering.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { METER_CEIL_DB, METER_FLOOR_DB, dbToUnit, pushLevel } from "./metering";

describe("dbToUnit", () => {
  it("상수는 -60~0 dB", () => {
    expect(METER_FLOOR_DB).toBe(-60);
    expect(METER_CEIL_DB).toBe(0);
  });
  it("undefined·무음(-160)·바닥(-60)은 0", () => {
    expect(dbToUnit(undefined)).toBe(0);
    expect(dbToUnit(-160)).toBe(0);
    expect(dbToUnit(-60)).toBe(0);
  });
  it("-30 dB는 0.5, 0 dB는 1", () => {
    expect(dbToUnit(-30)).toBeCloseTo(0.5);
    expect(dbToUnit(0)).toBe(1);
  });
  it("천장 위는 1로 clamp", () => {
    expect(dbToUnit(5)).toBe(1);
  });
  it("NaN은 0", () => {
    expect(dbToUnit(Number.NaN)).toBe(0);
  });
});

describe("pushLevel", () => {
  it("빈 배열에 하나 넣으면 [u]", () => {
    expect(pushLevel([], 0.3, 34)).toEqual([0.3]);
  });
  it("size를 넘으면 가장 오래된 것부터 버린다", () => {
    expect(pushLevel([0.1, 0.2, 0.3], 0.4, 3)).toEqual([0.2, 0.3, 0.4]);
  });
  it("입력 배열을 바꾸지 않는다", () => {
    const prev = [0.1, 0.2];
    const next = pushLevel(prev, 0.3, 34);
    expect(prev).toEqual([0.1, 0.2]);
    expect(next).not.toBe(prev);
  });
  it("size가 0 이하면 빈 배열", () => {
    expect(pushLevel([0.1, 0.2], 0.3, 0)).toEqual([]);
    expect(pushLevel([0.1], 0.3, -1)).toEqual([]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter mobile exec vitest run src/lib/metering.test.ts`
Expected: FAIL — `./metering` 모듈을 찾을 수 없음.

- [ ] **Step 3: 최소 구현**

`apps/mobile/src/lib/metering.ts`:

```ts
/**
 * 녹음 중 라이브 파형용 미터링 변환 (2026-10-12 스펙 결정 2).
 * expo-audio의 metering은 dB(iOS averagePower, Android maxAmplitude 환산)이고 무음은 -160이다.
 * 합주실 소리는 -30 dB 위에서 주로 움직이므로 -60을 바닥으로 잡는다. 기기에서 보고 조정한다.
 */
export const METER_FLOOR_DB = -60;
export const METER_CEIL_DB = 0;

/** expo-audio metering(dB) → 0~1. undefined·NaN·무음은 0, 범위 밖은 clamp. */
export function dbToUnit(db: number | undefined): number {
  if (db === undefined || Number.isNaN(db)) return 0;
  const unit = (db - METER_FLOOR_DB) / (METER_CEIL_DB - METER_FLOOR_DB);
  return Math.min(1, Math.max(0, unit));
}

/** levels 끝에 unit을 붙이고 최근 size개만 남긴다. 입력은 건드리지 않고 새 배열을 돌려준다. */
export function pushLevel(levels: number[], unit: number, size: number): number[] {
  if (size <= 0) return [];
  const next = [...levels, unit];
  return next.length > size ? next.slice(next.length - size) : next;
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter mobile test`
Expected: `metering.test.ts` 9개 PASS, 기존 `peaks.test.ts`·`time.test.ts` 변화 없음.

- [ ] **Step 5: 커밋**

```bash
git add apps/mobile/src/lib/metering.ts apps/mobile/src/lib/metering.test.ts
git commit -m "feat(mobile): metering helpers — dbToUnit, pushLevel

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `LiveWaveform`을 레벨 배열을 그리는 컴포넌트로 교체

**Files:**
- Modify: `apps/mobile/src/ui/LiveWaveform.tsx` (전체 교체)
- Create: `apps/mobile/src/ui/liveWaveformLevels.ts`
- Create: `apps/mobile/src/ui/liveWaveformLevels.test.ts`

RN 컴포넌트 렌더 테스트 환경이 없으므로(vitest만, `@testing-library/react-native` 미설치) "levels를 bars 길이에 맞추는" 로직을 순수 함수 `fitLevels`로 떼어 테스트한다. 컴포넌트는 그 결과를 `barHeight`로 그리기만 한다.

**Interfaces:**
- Consumes: `barHeight(unit, height, minPx)` from `@/lib/peaks`; `useTheme` from `@/theme`.
- Produces:
  - `export const LIVE_BARS = 34` (`LiveWaveform.tsx`)
  - `export function LiveWaveform(props: { levels: number[]; bars?: number; height?: number }): JSX.Element`
  - `export function fitLevels(levels: number[], bars: number): number[]` (`liveWaveformLevels.ts`) — 길이 정확히 `bars`, 왼쪽 0 패딩, 길면 뒤에서 `bars`개.

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/mobile/src/ui/liveWaveformLevels.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fitLevels } from "./liveWaveformLevels";

describe("fitLevels", () => {
  it("짧으면 왼쪽을 0으로 채운다 (최근이 오른쪽)", () => {
    expect(fitLevels([0.5, 1], 4)).toEqual([0, 0, 0.5, 1]);
  });
  it("길면 뒤에서 bars개만 쓴다", () => {
    expect(fitLevels([0.1, 0.2, 0.3, 0.4], 2)).toEqual([0.3, 0.4]);
  });
  it("비어 있으면 전부 0 (PREPARING 평평)", () => {
    expect(fitLevels([], 3)).toEqual([0, 0, 0]);
  });
  it("길이가 같으면 그대로", () => {
    expect(fitLevels([0.2, 0.4], 2)).toEqual([0.2, 0.4]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter mobile exec vitest run src/ui/liveWaveformLevels.test.ts`
Expected: FAIL — `./liveWaveformLevels` 모듈 없음.

- [ ] **Step 3: `fitLevels` 구현**

`apps/mobile/src/ui/liveWaveformLevels.ts`:

```ts
/** levels를 bars 길이로 맞춘다. 짧으면 왼쪽을 0으로 채우고, 길면 가장 최근(뒤) bars개만 쓴다. */
export function fitLevels(levels: number[], bars: number): number[] {
  if (levels.length >= bars) return levels.slice(levels.length - bars);
  return [...Array.from({ length: bars - levels.length }, () => 0), ...levels];
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter mobile exec vitest run src/ui/liveWaveformLevels.test.ts`
Expected: 4개 PASS.

- [ ] **Step 5: `LiveWaveform.tsx` 전체 교체**

`apps/mobile/src/ui/LiveWaveform.tsx`를 아래 내용으로 덮어쓴다. `Animated`·`Easing`·`useEffect`·`useRef`·`seededUnit` import가 모두 사라져야 한다.

```tsx
import { View } from "react-native";
import { barHeight } from "@/lib/peaks";
import { useTheme } from "@/theme";
import { fitLevels } from "./liveWaveformLevels";

/** 바 34개 × 200ms 틱 = 최근 6.8초 (2026-10-12 스펙 결정 1). */
export const LIVE_BARS = 34;

/**
 * 녹음 중 라이브 파형. 상태는 RecordingScreen이 들고 여기선 levels(0~1, 오래된 것 → 최근)를 그리기만 한다.
 * levels가 비어 있으면 모든 바가 최소 높이라 PREPARING·미터링 미지원에서 가짜 움직임이 없다.
 */
export function LiveWaveform({ levels, bars = LIVE_BARS, height = 72 }: { levels: number[]; bars?: number; height?: number }) {
  const { colors } = useTheme();
  const minPx = Math.round(height * 0.12);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 3, height }}>
      {fitLevels(levels, bars).map((level, i) => (
        <View
          key={i}
          style={{ width: 3, borderRadius: 1.5, backgroundColor: colors.textSecondary, height: barHeight(level, height, minPx) }}
        />
      ))}
    </View>
  );
}
```

- [ ] **Step 6: 타입 검사**

Run: `pnpm --filter mobile typecheck`
Expected: `RecordingScreen.tsx`에서 `<LiveWaveform />`에 `levels`가 없다는 오류 **1건만** 난다(Task 3에서 해결). 다른 오류는 없어야 한다. `seededUnit`을 더 이상 import하지 않는지 `grep -n seededUnit apps/mobile/src/ui/LiveWaveform.tsx`로 확인(결과 없음).

- [ ] **Step 7: 커밋**

```bash
git add apps/mobile/src/ui/LiveWaveform.tsx apps/mobile/src/ui/liveWaveformLevels.ts apps/mobile/src/ui/liveWaveformLevels.test.ts
git commit -m "feat(mobile): LiveWaveform draws a scrolling levels array instead of seeded animation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `RecordingScreen` — 미터링 켜고 레벨 쌓기, `+ MARK` 제거

**Files:**
- Modify: `apps/mobile/src/features/recording/RecordingScreen.tsx`

**Interfaces:**
- Consumes: `dbToUnit`, `pushLevel` from `@/lib/metering`; `LIVE_BARS`, `LiveWaveform({ levels })` from `@/ui`.
- Produces: 없음(화면).

- [ ] **Step 1: import 수정**

파일 맨 위 import 블록을 아래로 바꾼다. `Chip`과 `radius`는 MARK 제거 후 이 파일에서 더 쓰지 않으므로 뺀다. `LIVE_BARS`는 `@/ui`가 `export * from "./LiveWaveform"`이라 그대로 나온다.

```tsx
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder, useAudioRecorderState } from "expo-audio";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { dbToUnit, pushLevel } from "@/lib/metering";
import { fmtClock, toLocalIso } from "@/lib/time";
import { useTheme } from "@/theme";
import { AppText, LIVE_BARS, LiveWaveform, MonoLabel, PressableOpacity, Screen, StatusDot, useToast } from "@/ui";
```

- [ ] **Step 2: 미터링 옵션 켜기**

```tsx
  // HIGH_QUALITY = .m4a, AAC, 44.1kHz, 2ch, 128kbps — 스펙 결정 1과 일치한다
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
```
를
```tsx
  // HIGH_QUALITY = .m4a, AAC, 44.1kHz, 2ch, 128kbps — 2026-09-04 스펙 결정 1과 일치한다.
  // isMeteringEnabled는 라이브 파형용(2026-10-12 스펙). 프리셋 기본값은 false라 명시해야 state.metering이 채워진다.
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });
```
로 바꾼다.

- [ ] **Step 3: 레벨 상태와 틱 effect 추가**

`const stoppingRef = useRef(false);` 바로 아래에 추가:

```tsx
  const [levels, setLevels] = useState<number[]>([]);

  // useAudioRecorderState가 200ms마다 리렌더를 일으키므로 그 틱에서 레벨을 쌓는다 (별도 타이머 없음).
  // 의존성을 durationMillis로 둔 이유: metering 값이 같아도 틱마다 한 칸씩 흘러가야 한다.
  // ready 전(PREPARING)에는 쌓지 않아 평평한 플레이스홀더로 남긴다.
  useEffect(() => {
    if (!ready) return;
    setLevels((prev) => pushLevel(prev, dbToUnit(state.metering), LIVE_BARS));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, state.durationMillis]);
```

- [ ] **Step 4: JSX에서 파형에 levels 전달, MARK 삭제**

```tsx
        <LiveWaveform />
        <Chip
          label="+ MARK"
          mono
          style={{ borderRadius: radius.chipLg + 4, paddingVertical: 10, paddingHorizontal: 22, marginTop: 6 }}
          onPress={() => toast.show(`Marked at ${fmtClock(seconds)}`)}
        />
```
를
```tsx
        <LiveWaveform levels={levels} />
```
로 바꾼다. `toast`는 권한·오류 토스트에서 계속 쓰이므로 남긴다.

- [ ] **Step 5: 타입 검사·테스트**

Run: `pnpm --filter mobile typecheck`
Expected: 오류 0.

Run: `pnpm --filter mobile test`
Expected: 전부 PASS.

Run: `grep -n "Chip\|radius\|MARK" apps/mobile/src/features/recording/RecordingScreen.tsx`
Expected: 결과 없음.

- [ ] **Step 6: 커밋**

```bash
git add apps/mobile/src/features/recording/RecordingScreen.tsx
git commit -m "feat(mobile): recording screen draws live metering levels, drop + MARK button

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: 백로그 정리

**Files:**
- Modify: `docs/backlog.md:8` (MARK 줄), `docs/backlog.md:22` (라이브 파형 줄)

- [ ] **Step 1: 두 줄 삭제**

`## 업로드·녹음` 아래에서 다음 줄을 삭제한다(폐기):

```
- **녹음 중 `+MARK`를 분석 힌트로.** 마크 타임스탬프를 세션에 저장하고 Gemini 프롬프트·병합에 반영.
```

`## 재생·피드백` 아래에서 다음 줄을 삭제한다(완료):

```
- **녹음 중 라이브 파형 실제 미터링.** `LiveWaveform`은 아직 시드 애니메이션이다. expo-audio metering 값으로 그리려면 기기 검증이 필요하다 ([2026-09-10 스펙](superpowers/specs/2026-09-10-real-waveform-design.md) 범위 제외).
```

- [ ] **Step 2: 확인**

Run: `grep -n "MARK\|라이브 파형 실제 미터링" docs/backlog.md`
Expected: 결과 없음.

- [ ] **Step 3: 커밋 (스펙 문서도 함께 추가)**

```bash
git add docs/backlog.md docs/superpowers/specs/2026-10-12-live-metering-remove-mark-design.md docs/superpowers/plans/2026-10-12-live-metering-remove-mark.md
git commit -m "docs: live metering waveform + MARK removal spec/plan, prune backlog

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: 기기 검증 (수동)

**Files:** 없음(검증만). 결과에 따라 `apps/mobile/src/lib/metering.ts`의 `METER_FLOOR_DB`를 조정.

- [ ] **Step 1: 웹 프리뷰로 화면이 깨지지 않는지 확인**

`.claude/launch.json`의 mobile 웹 설정으로 preview를 열고 녹음 화면에 진입한다(웹은 webm이라 파형 값은 의미 없음). 확인 항목: 바 34개가 가운데 정렬로 평평하게 보이고, MARK 버튼이 없고, 콘솔에 `levels` 관련 경고·오류가 없다.

- [ ] **Step 2: 안드로이드 dev client**

Run: `pnpm --filter mobile phone` (USB 재연결 시 `adb reverse` 다시 걸 것 — 메모리 참조)
확인:
- PREPARING 동안 바가 전부 최소 높이(≈9px)로 평평하다.
- REC 후 말을 하면 오른쪽 끝에 큰 바가 들어와 왼쪽으로 흘러간다. 조용하면 평평해진다.
- MARK 버튼이 없고, Stop은 전처럼 처리 화면으로 넘어간다.

- [ ] **Step 3: 바닥값 조정(필요 시)**

연주·말소리 중 바가 항상 꽉 차면 `METER_FLOOR_DB`를 -70으로 내리고, 조용할 때 바닥이 떠 있으면 -50으로 올린다. 바꿨으면 `metering.test.ts`의 `-30 → 0.5` 기대값을 새 중간값으로 맞추고 커밋:

```bash
git add apps/mobile/src/lib/metering.ts apps/mobile/src/lib/metering.test.ts
git commit -m "fix(mobile): tune METER_FLOOR_DB after device check

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 4: iOS**

기기가 없으면 스펙 "열어 둔 것"에 `- iOS 미확인 (2026-10-12).` 한 줄을 추가하고 `docs:` 커밋.
