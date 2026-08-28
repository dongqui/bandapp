# 모바일 디자인 시스템 + 페이지 구성 설계

날짜: 2026-08-29
상태: 검토 대기
근거: Claude Design "Rehearsal App" 프로토타입 (claude.ai/design 프로젝트
`08fad416-4a6b-4b4c-a905-0c0319ab3e2b`, `Rehearsal App.dc.html`),
모노레포 뼈대 설계(2026-08-28)

## 목적

Rehearsal App 프로토타입의 디자인을 apps/mobile(Expo)에 옮긴다.
언제든 수정 가능한 토큰 중심 디자인 시스템과 재사용 컴포넌트를 만들고,
6개 화면을 페이지로 구성한다. API는 인터페이스만 정의하고 Mock 구현체로
화면을 채운다.

## 범위

포함:

- 디자인 토큰(색·타이포·간격·반경) + ThemeProvider (accent 교체 가능)
- 도메인 무관 재사용 UI 컴포넌트
- 도메인별 co-location 구조의 feature 폴더 + 6개 화면
- expo-router 기반 페이지 구성 (커스텀 탭바)
- packages/types 도메인 타입, packages/api-client 인터페이스 + MockApiClient
- JetBrains Mono 폰트 로딩

제외 (다음 단계):

- 실제 오디오 녹음·재생·업로드, 실제 HTTP API 클라이언트, 인증,
  푸시 알림, 테이크 편집("Edit takes"는 토스트 안내만)

## 확정된 결정

1. **expo-router** — 파일 기반 라우팅. expo-router는 app/ 아래 모든
   파일을 라우트로 취급하므로 app/에는 얇은 래퍼(re-export)만 두고,
   화면 본체는 도메인 feature 폴더에 co-locate한다.
2. **토큰 + StyleSheet** — 추가 스타일링 의존성 없음. `theme/tokens.ts`만
   고치면 전체 반영. accent는 런타임 교체 가능(기본 `#5B9DFF`,
   옵션 `#4ADE80 #FFB454 #FF5C5C`).
3. **Mock 구현체 포함** — `RehearsalApiClient` 인터페이스의 MockApiClient가
   프로토타입과 동일한 시드 데이터를 제공. 실제 클라이언트는 나중에
   인터페이스만 구현해 교체.
4. **도메인 co-location** — 화면·컴포넌트·훅을 도메인 feature 폴더에
   모은다. `theme/`, `ui/`는 전 도메인 공유 계층이라 예외.
5. **컴포넌트는 apps/mobile 내부에** — 모바일 앱 하나뿐이므로
   packages/ui 분리는 하지 않는다(YAGNI).

## 디렉토리 구조

```
packages/types/src/
  band.ts      # Band, BandMember, MemberRole
  session.ts   # Session, SessionStatus('uploading'|'analyzing'|'failed'|'ready')
  take.ts      # Take, TakeComment
  index.ts

packages/api-client/src/
  client.ts    # RehearsalApiClient 인터페이스
  mock/        # MockApiClient + 시드 데이터 (프로토타입과 동일)
  index.ts

apps/mobile/
  app/
    _layout.tsx                    # ThemeProvider + ApiProvider + ToastProvider + 폰트
    (tabs)/_layout.tsx             # 커스텀 탭바 (SESSIONS · ⊕ FAB · BAND)
    (tabs)/index.tsx               # → features/sessions/SessionsScreen re-export
    (tabs)/band.tsx                # → features/band/BandScreen
    record.tsx                     # → features/recording/RecordingScreen
    processing.tsx                 # → features/recording/ProcessingScreen
    session/[id]/index.tsx         # → features/takes/SessionDetailScreen
    session/[id]/take/[takeId].tsx # → features/takes/TakePlayerScreen
  src/
    theme/     tokens.ts, ThemeProvider.tsx, useTheme.ts
    ui/        AppText, MonoLabel, Screen, Chip, Avatar, BottomSheet,
               SheetActionRow, TabBar, Fab, StaticWaveform, LiveWaveform,
               PlayerWaveform, ProgressBar, Toast(Provider+useToast),
               StatusDot, IconCircle, PressableOpacity
    features/                      # 도메인별 co-location: 화면 + 컴포넌트 + 훅
      sessions/   SessionsScreen, SessionRow, NewSessionSheet, useSessions
      recording/  RecordingScreen, ProcessingScreen, useRecordingTimer
      takes/      SessionDetailScreen, TakePlayerScreen, TakeRow,
                  CommentRow, CommentInput, usePlayback(모의), useTakes, useComments
      band/       BandScreen, MemberRow, BandSwitchSheet, InviteSheet, useBand
    api/       ApiProvider.tsx, useApi.ts   # 인터페이스에만 의존
    lib/       time.ts (fmtClock, fmtDuration, endTime), seed.ts (시드 웨이브폼)
```

## 디자인 토큰 (프로토타입에서 추출)

색 (다크 단일 테마):

| 토큰 | 값 | 용도 |
|---|---|---|
| bg | #0B0C0E | 화면 배경 |
| bgDeep | #08090A | 루트 배경 |
| surface | #15171B | 시트·입력 배경 |
| surfaceSunken | #0F1114 | 코드/링크 박스 |
| surfaceRaised | #1A1C20 | 아바타·아이콘 원 |
| toastBg | #22252B | 토스트 |
| border / borderStrong / borderHover | #1D2025 / #23262B·#2A2D33 / #3A3E45 | 구분선·칩 보더 |
| text / textSecondary / textMuted / textFaint | #F2F3F5 / #C6CAD1 / #8A8F98 / #5A5F68 | 텍스트 4단계 |
| accent | #5B9DFF (교체 가능) | 강조·FAB·진행 |
| recording | #FF4545 | REC·정지 버튼 |
| danger | #E0736B | 실패 상태 |

타이포 변형: `titleXL 32/700(-0.01em)` `title 26/700` `heading 22/700`
`itemTitle 20/600` `sheetTitle 17/600` `rowTitle 15..16/600` `body 14`
`caption 13` `small 12` / mono: `monoLabel 11(+0.14em)` `monoMeta 12`
`monoTimer 52/500` `monoAvatar 14`. mono는 JetBrains Mono 400·500·600.

간격: 화면 좌우 24, 시트 패딩 14~20, 리스트 행 상하 14~19.
반경: chipSm 9, input 10, row 12, chipLg 16, sheet 20(상단), 원형 = 높이/2.

## API 인터페이스

```ts
interface RehearsalApiClient {
  bands: {
    list(): Promise<Band[]>;
    members(bandId: string): Promise<BandMember[]>;
    inviteLink(bandId: string): Promise<string>;
  };
  sessions: {
    list(bandId: string): Promise<Session[]>;
    get(id: string): Promise<Session>;
    create(bandId: string, input: { durationSec: number; source: 'recording' | 'import' }): Promise<Session>;
    retryAnalysis(id: string): Promise<Session>;
  };
  takes: {
    list(sessionId: string): Promise<Take[]>;
  };
  comments: {
    list(takeId: string): Promise<TakeComment[]>;
    create(takeId: string, input: { atSec: number; text: string }): Promise<TakeComment>;
  };
}
```

MockApiClient: 프로토타입 시드 데이터(세션 5건 — ready 3, analyzing 1,
failed 1 — 테이크·코멘트 포함), 인메모리 mutate(create/retry는 상태 갱신),
`subscribe(listener)` 로 변경 통지(훅 갱신용). `create`는 짧은 지연 후
analyzing→ready 전환을 시뮬레이션해 Processing 플로우를 재현한다.

## 화면 플로우

- Sessions: 세션 목록(상태별 표시), 밴드 칩→BandSwitchSheet, FAB→NewSessionSheet
  (Record now → /record, Import → /processing). failed 행 탭 → retryAnalysis.
- Recording: 로컬 타이머 + LiveWaveform + MARK(토스트) + 정지 → /processing.
- Processing: ProgressBar 모의 진행 → mock create 완료 → /session/[id] 교체 이동.
- Session Detail: 테이크 목록(StaticWaveform, 코멘트 수), Original recording →
  플레이어, Edit takes → 토스트.
- Take Feedback: PlayerWaveform(진행·코멘트 마커·시킹), 재생/일시정지(모의 진행),
  코멘트 목록(탭→해당 시점 -5s 이동), CommentInput → mock 저장.
- Band: 멤버 목록, Invite → InviteSheet(링크 + 복사 → expo-clipboard).

## 오류 처리

- Mock이므로 네트워크 오류 UI는 최소화: failed 세션 상태 표시 + 재시도만.
- 훅은 loading 상태를 노출하되 Mock은 즉시 resolve라 스피너는 두지 않는다.

## 테스트·검증

- `packages/api-client` MockApiClient 단위 테스트(시드 조회, create 전환, 코멘트 추가)
- `apps/mobile/src/lib/time.ts` 단위 테스트
- `pnpm turbo build lint` + `tsc --noEmit` 통과
- `expo start` 웹/Expo Go로 6개 화면 눈 확인

## 신규 의존성 (apps/mobile)

expo-router, react-native-safe-area-context, react-native-screens,
@expo-google-fonts/jetbrains-mono, expo-font, expo-clipboard,
expo-linking, expo-constants, expo-status-bar(기존)
