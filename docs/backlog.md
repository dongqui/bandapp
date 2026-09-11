# 백로그

이번 스펙([2026-09-04](superpowers/specs/2026-09-04-upload-analysis-takes-feedback-design.md))에서 의도적으로 미룬 것. 각 항목은 자기 스펙을 받아 진행한다.

## 업로드·녹음
- **가져오기 원본 업로드 + 서버 변환.** wav·영상 등 원본을 그대로 올리고 워커가 ffmpeg으로 m4a로 바꾼다. `recordings`가 세션당 원본·변환본 두 행을 갖게 된다.
- **3시간 백그라운드 녹음 안정성.** 백그라운드 오디오 모드, 중단(전화·앱 종료) 복구, 저장 공간 부족 처리.
- **녹음 중 `+MARK`를 분석 힌트로.** 마크 타임스탬프를 세션에 저장하고 Gemini 프롬프트·병합에 반영.
- **끊긴 업로드 자동 재개.** 지금은 세션 목록의 uploading 행을 눌러야 이어 올린다 ([2026-09-10 스펙](superpowers/specs/2026-09-10-upload-resume-design.md) 범위 제외). 앱 시작 시 백그라운드에서 이어 올리려면 화면 밖 진행 상태 관리가 필요하다.
- **2026-09-10 이전에 캐시에 쌓인 녹음·가져오기 파일 청소.** 지금은 새 파일만 `uploads/`로 옮겨 관리한다. 옛 캐시 파일은 어떤 게 우리 것인지 알 수 없어 손대지 않았다.
- **세션 목록의 재개 표시 갱신.** `usePendingUploadIds`는 화면 포커스 때만 로컬 레코드를 다시 읽는다. 업로드 화면에서 나온 뒤 백그라운드 업로드가 실패하면 다음 포커스까지 행이 "This upload was started on another device"로 보인다. 스토어·in-flight 레지스트리에 변경 통지를 붙이면 해결된다.

## 분석
- **검출기 전처리(Python 워커).** POC의 YAMNet/PANNs 등으로 음악 구간 후보를 먼저 뽑아 `planChunks()`를 "후보 구간 목록"으로 교체. Gemini 토큰과 시간을 줄인다. 모델 선정이 선행돼야 한다.
- **gap-merge 옵션.** 떨어진 후보를 N초 이내면 합치는 규칙. 지금은 Gemini 프롬프트가 담당한다.
- **Take 경계 편집 (스펙 B).** 타임라인 뷰어([2026-09-11 스펙](superpowers/specs/2026-09-11-timeline-viewer-design.md)) 위에 start/end 핸들 드래그·edge auto pan·playhead 스크럽을 더하고, `PATCH /takes/:id`로 재컷(`-c copy` ±23ms 오차)·peaks·durationSec 재계산. take 코멘트 `atSec`이 take 상대 시각이라 start를 옮기면 함께 밀어야 한다 — 제품 결정 필요. 세션 상세 칩 라벨을 디자인대로 "Edit takes"로 되돌린다.
- **워커 e2e(실 Postgres)로 `analyzing` 가드 두 곳을 실제로 검증.** 지금 단위 테스트의 가짜 DB는 where 조건을 보지 않는다.

## 재생·피드백
- **녹음 중 라이브 파형 실제 미터링.** `LiveWaveform`은 아직 시드 애니메이션이다. expo-audio metering 값으로 그리려면 기기 검증이 필요하다 ([2026-09-10 스펙](superpowers/specs/2026-09-10-real-waveform-design.md) 범위 제외).
- **파형 표시 곡선 튜닝.** 선형 진폭을 그대로 그린다. 조용한 구간이 너무 낮아 보이면 `apps/mobile/src/lib/peaks.ts`의 `barHeight` 한 곳에서 sqrt 등으로 바꾼다.
- **기존 세션 피크 백필.** 2026-09-10 이전에 분석된 세션은 `peaks`가 null이라 평평한 플레이스홀더로 보인다. 필요해지면 Gemini 없이 R2 원본만 내려받아 `slicePeaks`로 채우는 일회성 스크립트를 만든다. 지금은 retry로 재분석한다.
- **타임라인 코멘트 마커.** 원본 코멘트(절대 시각)를 타임라인 위에 마커로. 2026-09-11 스펙 범위 제외.
- **타임라인 LOD crossfade.** 지금은 hysteresis만 있다. 레벨 교체가 눈에 띄면 두 레벨을 짧게 섞는다.
- **타임라인 파형을 Skia로.** SVG `animatedProps`가 기기에서 60fps에 못 미치면 `WaveformCanvas` 한 파일만 Skia로 바꾼다 (2026-09-11 스펙 결정 7). 웹 프리뷰는 canvaskit 설정이 필요하다.
- **타임라인 기기 검증.** 핀치 focal 고정, 핀치→팬 전환, 백그라운드 복귀·블루투스 전환 후 playhead 재동기화, 3시간 세션 60fps, Android 제스처 취소 후 상태 — 계획 Task 16 목록. gesture-handler가 직접 의존성이 돼 dev client 재빌드가 필요하다.
- **코멘트 owner 중재.** 지금은 작성자만 수정·삭제한다 ([2026-09-09 스펙](superpowers/specs/2026-09-09-comment-edit-delete-original-design.md) 결정 1). 밴드 owner가 남의 코멘트를 지울 수 있게 하려면 서비스의 작성자 검사에 role 분기를 더한다.
- **코멘트 시점 수정.** 본문만 고칠 수 있다. 시점을 바꾸려면 답글의 `at_ms`도 같이 옮겨야 한다.
- **삭제된 코멘트 흔적(tombstone).** 지금은 행이 사라진다. 답글이 달린 코멘트를 지웠을 때 "삭제된 코멘트"로 남기려면 soft delete가 필요하다 ([2026-09-09 스펙](superpowers/specs/2026-09-09-comment-edit-delete-original-design.md) 범위 제외).

## 팀·설정
- **삭제된 밴드 영구 삭제 배치.** `bands.deleted_at`이 채워진 밴드의 행과 R2 객체(원본·take)를 N일 뒤 지운다 ([2026-09-08 스펙](superpowers/specs/2026-09-08-team-management-screen-design.md) 결정 3). 세션 삭제 정리 배치와 같이 진행.
- **기존 화면 문구의 i18n 이관.** 세션·녹음·설정·초대 랜딩의 하드코딩 문구를 `src/i18n` 리소스로. 설정 화면의 `Alert.alert`를 `ConfirmDialog`로. 코멘트 수정·삭제 문구(`···` 시트, 편집 배너, 삭제 확인)도 영어 하드코딩이다.
- **언어 전환 UI.** 지금은 기기 언어만 따른다.
- **파트 해제 UI.** `setMyPart(null)`은 서버·클라이언트 모두 지원하지만 파트 시트에 "해제" 행이 없다 (2026-09-08 스펙 갭).
- **밴드가 바뀌면 열린 시트·다이얼로그를 닫기.** BandScreen의 `sheet`/`confirm`이 `band.id` 변경에도 살아남는다. 지금은 `band_member_not_found` 토스트로 끝난다.
- **BandSwitchSheet 문구 i18n.** `features/band/` 안에서 유일하게 하드코딩("Switch band", "Create or join a band").
- **SheetRow와 SheetActionRow 통합.** `icon?`·`danger?`를 공용 컴포넌트에 더하면 하나로 합쳐진다.
- **밴드 soft delete 시 활성 초대 revoke.** 지금은 preview/join이 404로 막지만, 삭제를 되돌리면 옛 링크가 살아난다. `removeMember`와 같은 방식으로 `markDeleted`에서 revoke.
- **소유권 이전 TOCTOU.** 트랜잭션 안의 FOR UPDATE 재확인이 `bands.deleted_at`은 다시 보지 않는다. 창이 극히 좁아 방치.
- **api-client 정리.** Mock 테스트 파일이 `.test.ts`/`.spec.ts` 둘로 나뉘어 있고, `index.ts`가 `ApiError`를 `errors.ts` 대신 `HttpApiClient`를 거쳐 export한다.
- **기기 검증(dev build) 필요.** 시트→다이얼로그 Modal 전환, 시트 안 TextInput 키보드 회피, 토스트와 Modal의 z-order, 한국어 기기의 `getLocales()[0].languageCode`가 `ko`인지. 녹음 파일을 uploads/로 옮긴 뒤 expo-audio가 문제없는지, 앱 강제 종료 후 목록에서 이어 올리기가 되는지.
- **oxlint를 mobile·api-client에도.** `pnpm lint`는 `apps/api`만 돈다 — `apps/mobile`, `packages/api-client`에 lint 스크립트가 없다.

## 운영
- **세션 삭제 API와 R2 객체 정리.** 세션을 지울 때 원본·take 객체, 피크 사이드카(`peaks.bin`)를 함께 지운다.
- **만료된 multipart 업로드.** 버킷 수명주기 규칙이 7일 뒤 자동 중단한다. `recordings.upload_status=pending`으로 남은 행을 같이 정리하는 배치가 필요하다.
- **Gemini 파일 정리 실패 재시도.** 지금은 경고 로그만 남긴다.
- **`analyzing`에 1시간 이상 머문 세션을 자동으로 failed로 돌리는 스위퍼.** 지금은 사용자의 retry(1시간 뒤 허용)에 의존한다.
- **중복 전달 경합에서 진 워커가 올린 take 객체는 세션이 ready라 prefix 정리가 다시 돌지 않아 남는다.** 드물지만 세션 삭제 정리 배치에서 함께 처리.
