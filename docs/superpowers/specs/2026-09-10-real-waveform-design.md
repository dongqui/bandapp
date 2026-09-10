# 실제 파형 설계

## 목표

take 목록 행, take 플레이어, 원본 녹음 플레이어의 파형을 실제 오디오에서 뽑은 피크로 그린다. 지금은 세 곳 모두 `seededUnit(seed * 97 + i * 13)`으로 만든 시드 기반 가짜 파형이다 ([2026-09-04 스펙](2026-09-04-upload-analysis-takes-feedback-design.md) "파형은 기존 시드 파형 유지"). 디자인(Claude Design `Rehearsal App.dc.html`)의 바 개수·간격·높이 공식은 그대로 두고 높이의 소스만 시드에서 피크로 바꾼다.

현재 상태: 워커([session-analysis.service.ts](../../../apps/api/src/worker/session-analysis.service.ts))는 원본 다운로드 → ffprobe 길이 → 청크 Gemini 분석 → take별 `ffmpeg -c copy` 컷 → R2 업로드 → `takes` 행 insert 순으로 돈다. `FfmpegRunner` 인터페이스가 ffmpeg 호출을 감싸고, 스펙 테스트는 가짜 runner를 넘긴다. `Take`·`Session` 타입과 `takes`·`sessions` 테이블에는 파형 관련 필드가 없다.

## 범위

**포함:**
- 워커가 원본을 한 번 디코드해 고해상도 피크 배열을 만들고, 세션·take별로 128버킷 피크를 저장
- `takes.peaks`, `sessions.peaks` 컬럼 — 마이그레이션 `0007`
- `Take.peaks`, `Session.peaks` (`number[] | null`) 인라인 응답, `PEAK_BUCKETS` 상수
- Mock 시드에 가짜 피크, 플레이스홀더 확인용 null take
- 모바일: `StaticWaveform`·`PlayerWaveform`이 피크를 그리고, null이면 평평한 플레이스홀더

**제외:**
- 녹음 중 라이브 파형(`LiveWaveform`)의 실제 미터링 — 워커와 무관한 네이티브 작업, 백로그
- 기존 세션 백필 — 사전 출시 단계라 retry로 재분석하거나 방치
- 별도 해상도·별도 엔드포인트 — 128버킷 인라인이 모든 화면을 덮는다
- Take 경계 편집 연동 — 백로그 항목이 `slicePeaks`를 재사용한다
- 표시 곡선 튜닝(sqrt 등) — 앱 헬퍼 한 곳이라 필요해지면 그때

## 결정

1. **DB 컬럼 + 인라인 응답.** `takes.peaks`, `sessions.peaks`를 `smallint[]`(nullable)로 두고 `Take`·`Session` 응답에 `peaks: number[] | null`로 그대로 싣는다. take 하나 400~500바이트, 세션 목록 20개에 약 9KB라 목록·단건 shape을 나누지 않는다. R2 사이드카 JSON은 목록 행마다 URL 발급 + fetch 두 요청이 더 들어 탈락. 별도 엔드포인트는 행마다 로딩 상태를 다뤄야 해서 탈락.

2. **길이 128, 값 0~255, 객체 안 정규화.** `PEAK_BUCKETS = 128`은 `@bandapp/types`가 export해 워커·Mock·앱 테스트가 공유한다. 값은 선형 진폭을 0~255 정수로 환산한 뒤 객체(take 하나, 또는 세션 전체) 안의 최댓값이 255가 되도록 정규화한다. 조용한 합주도 모양이 보이고, 완전 무음이면 전부 0이다.

3. **원본 한 번 디코드 → 슬라이스.** ffmpeg이 원본을 8kHz 모노 s16le로 stdout에 흘리면 노드가 160샘플(1/50초) 창마다 max|s|를 `Uint8Array`에 쌓는다. 3시간이면 54만 개, 540KB. 세션 피크는 전체를, take 피크는 `startMs~endMs` 구간을 128버킷으로 다운샘플한다. 객체마다 따로 디코드하는 방식은 디코드 총량이 두 배라 탈락. take 피크가 컷 파일이 아니라 원본 타임라인에서 나오지만, `-c copy` 컷 오차 ~23ms는 3분 take의 버킷 폭 1.4초에 묻힌다.

4. **원본 녹음 플레이어도 실제 파형.** `sessions.peaks`가 `takeId === "orig"` 화면을 그린다. 세션 목록도 같은 필드를 싣지만 목록 행은 파형을 그리지 않는다.

5. **피크 실패는 세션을 failed로 만들지 않는다.** ffmpeg 오류·타임아웃이면 경고 로그를 남기고 고해상도 배열을 null로 두어 take·세션 `peaks` 전부 null로 저장한다. 파형은 재생 화면의 장식이지 분석 결과가 아니다.

6. **null은 평평한 플레이스홀더.** 앱은 `peaks === null`이면 모든 바를 최소 높이(높이의 12%)로 그린다. 시드 파형 폴백은 가짜와 진짜를 구분할 수 없어 탈락. 이 상태는 디자인에 없지만 새 UI라기보다 빈 상태라 별도 디자인 없이 간다. `seedOf`는 사용처가 없어져 삭제하고, `seededUnit`은 `LiveWaveform`·`LoginScreen`이 계속 쓴다.

7. **디코드는 Gemini 분석 뒤, take 컷 직전.** Gemini가 실패하면 디코드 비용을 쓰지 않는다. take 행을 만들 때 `peaks`를 같이 채우고, 마무리 트랜잭션의 세션 update에 `peaks`가 들어간다. retry는 자연히 덮어쓴다. `resetTakes`는 변경 없음.

## 스키마

```sql
ALTER TABLE "takes" ADD COLUMN "peaks" smallint[];
ALTER TABLE "sessions" ADD COLUMN "peaks" smallint[];
```

drizzle: `peaks: smallint("peaks").array()` 두 곳. 마이그레이션 `0007`은 `pnpm --filter @bandapp/api db:generate`로 만든다. 기존 행은 null.

## 타입·API 계약

`packages/types`:

```ts
/** Take.peaks / Session.peaks 길이. 값은 0~255 정수, 객체 안 최댓값이 255 (2026-09-10 스펙 결정 2) */
export const PEAK_BUCKETS = 128;

export interface Take {
  // ...기존 필드
  /** 원본 타임라인의 startMs~endMs 구간 피크. 워커가 못 만들었거나 옛 데이터면 null */
  peaks: number[] | null;
}

export interface Session {
  // ...기존 필드
  /** 원본 녹음 전체 피크. ready가 아니거나 옛 데이터면 null */
  peaks: number[] | null;
}
```

새 엔드포인트는 없다. `GET /sessions/:id/takes`, `GET /bands/:bandId/sessions`, `GET /sessions/:id`가 `peaks`를 포함한다. api-client HTTP는 통과.

## 워커

**`FfmpegRunner.peaks(input, peaksPerSec): Promise<Uint8Array>`** — `ffmpeg -v error -i <input> -vn -ac 1 -ar 8000 -f s16le -`를 `spawn`하고 stdout을 스트리밍으로 `PeakAccumulator`에 넣는다. 타임아웃은 `cut`과 같은 10분. 종료 코드가 0이 아니거나 stderr에 오류가 있으면 reject. 8000이 `peaksPerSec`로 나누어떨어지지 않으면 창 크기는 `Math.round`.

**`apps/api/src/worker/peaks.ts`** — ffmpeg 없이 테스트하는 순수 모듈:
- `class PeakAccumulator(samplesPerPeak)` — `push(buf: Buffer)`가 s16le 샘플을 읽으며 창마다 `max|s|`를 0~255(`Math.round(max / 32767 * 255)`)로 기록한다. 청크 경계의 홀수 바이트와 창 자투리는 이월한다. `finish(): Uint8Array`는 마지막 자투리 창도 포함한다.
- `slicePeaks(hires: Uint8Array, peaksPerSec: number, startMs: number, endMs: number, buckets: number): number[]` — `[startMs, endMs)`에 해당하는 인덱스 범위를 배열 길이로 clamp한 뒤 `buckets`개 창으로 나눠 창 안 max를 취하고, 최댓값이 255가 되도록 정규화한다. 구간이 `buckets`보다 짧으면 같은 값이 여러 버킷에 반복된다. 범위가 비면(길이 0) 전부 0. 전부 0이면 정규화하지 않고 0을 유지한다.

**파이프라인** (`SessionAnalysisService.run`):

```
merged = mergeCandidates(candidates)
hires = await this.extractPeaks(original)        // 실패하면 null + warn
for take in merged:
  cut / putFile / unlink (기존)
  rows.push({ ..., peaks: hires ? slicePeaks(hires, PEAKS_PER_SEC, startMs, endMs, PEAK_BUCKETS) : null })
transaction:
  insert takes (peaks 포함)
  update sessions set status='ready', peaks = hires ? slicePeaks(hires, PEAKS_PER_SEC, 0, durationMs, PEAK_BUCKETS) : null, ...
```

`PEAKS_PER_SEC = 50`은 워커 상수. `extractPeaks`는 `ffmpeg.peaks`를 try/catch로 감싸 실패 시 `null`을 돌려주고 `session ${id}: peaks failed: ...`를 warn으로 남긴다.

## 서버

- `TAKE_WITH_COUNT`에 `peaks: takes.peaks`, `TakeRow.peaks: number[] | null`, `toTake`가 `peaks: row.peaks ?? null`.
- `SESSION_WITH_COUNTS`에 `peaks: sessions.peaks`, `SessionRow.peaks`, `toSession`이 `peaks: row.peaks ?? null`.
- 세션 생성·업로드 완료 경로는 `peaks`를 건드리지 않는다(null).

## api-client

- HTTP: 변경 없음 (응답을 그대로 넘긴다).
- Mock `seed.ts`: `fakePeaks(seed: number): number[]` — `seededUnit`으로 128개, 0~255, 최댓값 255가 되도록 정규화. `generateTakes`가 take마다 채우고, `session()` 헬퍼는 `status === "ready"`면 채운다. s1의 마지막 take는 `peaks: null`로 두어 플레이스홀더를 프리뷰에서 본다.
- Mock `scheduleAnalysis`: ready로 바꿀 때 세션 `peaks`도 `fakePeaks`로 채운다 (take는 `generateTakes`가 이미 채운다).

## 모바일

- `apps/mobile/src/lib/peaks.ts`: `resamplePeaks(peaks: number[] | null, bars: number): number[]` — 128개를 `bars`개 창으로 나눠 창 안 max를 0~1로 돌려준다. null이거나 비어 있으면 전부 0. `barHeight(unit: number, height: number, minPx: number): number` = `Math.max(minPx, Math.round((0.12 + 0.88 * unit) * height))` — 지금 공식과 같다.
- `StaticWaveform({ peaks, bars = 36, height = 26, color })`, `PlayerWaveform({ peaks, durationSec, positionSec, markers, onSeek, height = 88 })` — `seed` prop 제거, `peaks: number[] | null` 추가. 바 개수·간격·색·마커·seek 로직은 그대로.
- `TakeRow`는 `take.peaks`, `TakePlayerScreen`은 `isOriginal ? session.peaks : take.peaks`. 플레이어의 `take` memo 객체에 `peaks`를 더한다.
- `lib/seed.ts`에서 `seedOf` 삭제.

## 테스트

- api 단위: `peaks.spec.ts` — 누산기(청크 경계 홀수 바이트, 자투리 창, 0~255 환산), `slicePeaks`(범위 clamp, 짧은 구간 반복, 정규화, 무음, 빈 범위). `session-analysis.service.spec.ts` — take 행과 세션 update에 길이 128 `peaks`가 들어가는지, `ffmpeg.peaks`가 throw하면 peaks null로 ready가 되는지. 가짜 runner에 `peaks` 스텁 추가.
- api e2e: takes 목록과 세션 단건이 `peaks`를 돌려주고, 삽입 없이 만든 세션·take는 null.
- api-client Mock 테스트: 시드 take·ready 세션의 `peaks` 길이가 128이고 값이 0~255.
- mobile vitest: `resamplePeaks`(다운샘플 max, null → 0, bars가 128보다 클 때), `barHeight`.
- `pnpm typecheck`·`pnpm lint`·`pnpm build` 통과.

## 문서

README 분석 파이프라인 한 줄에 "피크 추출(원본 1회 디코드)"을 더한다. `docs/backlog.md`에서 "실제 파형"을 지우고 다음을 남긴다: 녹음 중 라이브 파형 실제 미터링(`LiveWaveform` + expo-audio metering), 파형 표시 곡선 튜닝(`barHeight` 한 곳), 기존 세션 피크 백필 스크립트(필요해지면).
