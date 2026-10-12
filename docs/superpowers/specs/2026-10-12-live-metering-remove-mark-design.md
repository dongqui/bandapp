# 녹음 화면: 실제 미터링 파형, MARK 제거

- 날짜: 2026-10-12
- 범위: `apps/mobile`의 녹음 화면만. 서버·워커 변경 없음.
- 배경: 스토어 심사 전 정리. 녹음 화면([RecordingScreen.tsx](../../../apps/mobile/src/features/recording/RecordingScreen.tsx))의 파형은 마이크 입력과 무관한 시드 애니메이션이고, `+ MARK` 버튼은 토스트만 띄운다. 둘 다 2026-09-04 스펙에서 "유지"로 두고 백로그에 미뤘던 것이다. MARK는 기능을 만들지 않고 버튼을 뺀다. 파형은 expo-audio 미터링으로 실제 소리를 그린다.

## 현재 상태

- `RecordingScreen`은 `useAudioRecorder(RecordingPresets.HIGH_QUALITY)`로 녹음하고 `useAudioRecorderState(recorder, 200)`로 200ms마다 상태를 읽는다. 상태에는 `durationMillis`만 쓴다.
- expo-audio 57의 `RecorderState`에는 `metering?: number`(dB)가 있다. 녹음 옵션에 `isMeteringEnabled: true`를 줘야 채워지고, 프리셋은 기본 `false`다. iOS는 `averagePower(forChannel: 0)`, Android는 `MediaRecorder.maxAmplitude`를 `20·log10(amp/32767)`로 환산한 값이며 무음은 -160이다. 네이티브 모듈 추가가 아니라 옵션이므로 dev client 재빌드는 필요 없다.
- [LiveWaveform.tsx](../../../apps/mobile/src/ui/LiveWaveform.tsx)는 바 34개가 `Animated.loop`로 각자 흔들리는 장식이다. 입력 prop이 없다. `seededUnit`은 여기와 `LoginScreen`이 쓴다.
- `+ MARK`는 `Chip` 하나이고 `onPress`가 `toast.show("Marked at …")`뿐이다.

## 범위

**포함**
- 녹음 옵션에 미터링 켜기
- dB → 0~1 변환과 최근 N개 레벨을 쌓는 순수 함수 + 테스트
- `LiveWaveform`을 "레벨 배열을 받아 그리는" 컴포넌트로 교체 (흘러가는 기록 방식)
- `+ MARK` 버튼 제거
- `docs/backlog.md`에서 완료·폐기된 두 줄 제거

**제외**
- MARK 기능 구현(마크 저장, 분석 힌트). 버튼과 함께 백로그에서도 지운다. 다시 필요해지면 그때 새 스펙.
- 파형 평활화(attack/decay). 200ms 샘플을 그대로 그린다. 기기에서 너무 튀면 `pushLevel` 한 곳에 EMA를 넣는다.
- 재생 화면 파형(`StaticWaveform`·`PlayerWaveform`)과 `lib/peaks.ts`. 손대지 않는다. `barHeight`만 가져다 쓴다.
- 백그라운드 녹음, 인터럽션 복구. 별도 백로그 항목 그대로.

## 결정

1. **흘러가는 기록.** 200ms마다 새 레벨이 오른쪽 끝에 들어오고 나머지는 왼쪽으로 밀린다. 바 34개 = 최근 6.8초. 디자인 시안의 들쭉날쭉한 모양과 맞고, 소리가 났다가 멈춘 것이 보인다. 바 전체가 현재 레벨 하나로 같이 커졌다 작아지는 방식은 레벨 미터에 가까워 탈락.
2. **dB 매핑은 -60~0 dB를 0~1 선형으로.** 그 밖은 clamp. `undefined`(미터링 꺼짐·아직 준비 전)와 -160(무음)은 0. 합주실 소리는 -30 dB 위에서 주로 움직이므로 -60 바닥이면 조용할 때 평평하고 연주 중엔 거의 꽉 찬다. 숫자는 `lib/metering.ts` 상수 두 개로 두고 기기에서 보고 조정한다.
3. **바 높이 공식은 `barHeight(unit, height, minPx)` 재사용.** 최소 높이 12%라 레벨 0이면 평평한 플레이스홀더가 된다. 2026-09-10 스펙 결정 6과 같은 모양이고, 준비 중(PREPARING)·미터링 미지원 상태에서 가짜 움직임을 보여주지 않는다.
4. **상태는 `RecordingScreen`이 들고, `LiveWaveform`은 그리기만 한다.** `useAudioRecorderState`가 이미 200ms마다 리렌더를 일으키므로 그 틱에서 레벨을 쌓는다. 별도 타이머·Reanimated 없음. View 34개를 초당 5번 다시 그리는 비용은 무시할 수 있다. 타임라인 뷰어처럼 shared value로 갈 이유가 없다.
5. **`seededUnit`은 남긴다.** `LoginScreen`이 쓴다. `LiveWaveform`에서만 import를 뺀다.

## 변경

### `apps/mobile/src/lib/metering.ts` (신설)

```ts
export const METER_FLOOR_DB = -60;
export const METER_CEIL_DB = 0;

/** expo-audio metering(dB) → 0~1. undefined·무음은 0. */
export function dbToUnit(db: number | undefined): number;

/** levels 끝에 unit을 붙이고 최근 size개만 남긴다. 새 배열을 돌려준다. */
export function pushLevel(levels: number[], unit: number, size: number): number[];
```

### `apps/mobile/src/lib/metering.test.ts` (신설, vitest)

- `dbToUnit`: `undefined` → 0, `-160` → 0, `-60` → 0, `-30` → 0.5, `0` → 1, `5` → 1
- `pushLevel`: 빈 배열에 하나 넣으면 `[u]`; size를 넘으면 가장 오래된 것부터 버린다; 입력 배열을 바꾸지 않는다

### `apps/mobile/src/ui/LiveWaveform.tsx` (교체)

- `export const LIVE_BARS = 34`. props: `{ levels: number[]; bars?: number; height?: number }` (bars 기본 `LIVE_BARS`, height 기본 72)
- `levels`가 bars보다 짧으면 왼쪽을 0으로 채운다. 길면 뒤에서 bars개만 쓴다.
- 바 하나: 너비 3, 간격 3, `borderRadius 1.5`, 색 `colors.textSecondary`, 높이 `barHeight(level, height, Math.round(height * 0.12))`. 세로 가운데 정렬. 지금 레이아웃 값 그대로.
- `Animated`, `seededUnit` import 제거.

### `apps/mobile/src/features/recording/RecordingScreen.tsx`

- `useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true })`
- `const [levels, setLevels] = useState<number[]>([])`
- `useEffect`로 `state.metering`이 바뀔 때마다 `setLevels((prev) => pushLevel(prev, dbToUnit(state.metering), LIVE_BARS))`. 의존성은 `state.durationMillis`로 두어 틱마다 한 번 들어오게 한다 (`metering` 값이 같아도 틱은 진행해야 하므로).
- `ready`가 false면 `levels`에 쌓지 않는다 (준비 중 평평).
- `<LiveWaveform levels={levels} />`
- `+ MARK` `Chip` 블록 삭제. `Chip` import가 남는 사용처 없으면 같이 삭제. `toast`는 권한·오류 토스트에 계속 쓴다.

### `docs/backlog.md`

- "녹음 중 라이브 파형 실제 미터링" 줄 삭제 (완료)
- "녹음 중 `+MARK`를 분석 힌트로" 줄 삭제 (폐기)

## 검증

1. `pnpm --filter mobile test` — `metering.test.ts` 통과, 기존 테스트 변화 없음.
2. `pnpm --filter mobile lint`, 타입 검사 통과.
3. 안드로이드 dev client(`pnpm --filter mobile phone`)에서 녹음 화면 진입:
   - PREPARING 동안 바가 전부 최소 높이로 평평하다.
   - REC로 바뀐 뒤 말을 하면 오른쪽에서 큰 바가 들어와 왼쪽으로 흘러간다. 조용하면 평평해진다.
   - MARK 버튼이 없다. Stop은 전처럼 처리 화면으로 넘어간다.
4. iOS 기기가 있으면 같은 확인. 없으면 스펙에 "iOS 미확인"으로 남긴다.
5. 웹 프리뷰(`pnpm --filter mobile dev`)는 webm이라 녹음 자체가 의미 없으므로 파형 확인 대상이 아니다. 화면이 깨지지 않는지만 본다.

## 열어 둔 것

- `-60 dB` 바닥은 추정값이다. 합주실에서 녹음해 보고 연주 중 바가 항상 꽉 차면 `METER_FLOOR_DB`를 낮추고(-70 등), 조용할 때 바닥이 떠 있으면 올린다.
- Android `maxAmplitude`는 읽을 때마다 리셋되는 최대값이라 iOS `averagePower`보다 값이 크게 나올 수 있다. 두 플랫폼이 눈에 띄게 다르면 플랫폼별 바닥값을 둔다. 지금은 하나로 간다.
