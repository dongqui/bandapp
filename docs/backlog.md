# 백로그

이번 스펙([2026-09-04](superpowers/specs/2026-09-04-upload-analysis-takes-feedback-design.md))에서 의도적으로 미룬 것. 각 항목은 자기 스펙을 받아 진행한다.

## 업로드·녹음
- **가져오기 원본 업로드 + 서버 변환.** wav·영상 등 원본을 그대로 올리고 워커가 ffmpeg으로 m4a로 바꾼다. `recordings`가 세션당 원본·변환본 두 행을 갖게 된다.
- **앱 종료 후 업로드 재개.** `{ sessionId, fileUri }`를 로컬에 남기고, 세션 목록의 `uploading` 행을 눌러 이어 올린다. 서버 `GET /sessions/:id/upload`(ListParts)는 준비돼 있다.
- **3시간 백그라운드 녹음 안정성.** 백그라운드 오디오 모드, 중단(전화·앱 종료) 복구, 저장 공간 부족 처리.
- **업로드 성공 후 캐시 디렉터리 정리.** 캐시 디렉터리의 녹음 m4a·가져오기 복사본을 삭제한다 (지금은 쌓인다).
- **녹음 중 `+MARK`를 분석 힌트로.** 마크 타임스탬프를 세션에 저장하고 Gemini 프롬프트·병합에 반영.

## 분석
- **검출기 전처리(Python 워커).** POC의 YAMNet/PANNs 등으로 음악 구간 후보를 먼저 뽑아 `planChunks()`를 "후보 구간 목록"으로 교체. Gemini 토큰과 시간을 줄인다. 모델 선정이 선행돼야 한다.
- **gap-merge 옵션.** 떨어진 후보를 N초 이내면 합치는 규칙. 지금은 Gemini 프롬프트가 담당한다.
- **Take 경계 편집.** 사용자가 start/end를 고치면 take 파일을 다시 잘라 올린다.
- **워커 e2e(실 Postgres)로 `analyzing` 가드 두 곳을 실제로 검증.** 지금 단위 테스트의 가짜 DB는 where 조건을 보지 않는다.

## 재생·피드백
- **실제 파형.** 워커가 take별 피크 배열을 만들어 저장하고 앱이 그린다. 지금은 시드 기반 가짜 파형.
- **대댓글 UI·작성.** `comments.parent_id`와 `TakeComment.parentId`는 준비됨. 스레드 표시와 답글 입력이 남았다.
- **원본 녹음에 대한 코멘트.** `comments.take_id`를 nullable로 바꾸고 `session_id`를 더한다.

## 운영
- **세션 삭제 API와 R2 객체 정리.** 세션을 지울 때 원본·take 객체를 함께 지운다.
- **만료된 multipart 업로드.** 버킷 수명주기 규칙이 7일 뒤 자동 중단한다. `recordings.upload_status=pending`으로 남은 행을 같이 정리하는 배치가 필요하다.
- **Gemini 파일 정리 실패 재시도.** 지금은 경고 로그만 남긴다.
- **`analyzing`에 1시간 이상 머문 세션을 자동으로 failed로 돌리는 스위퍼.** 지금은 사용자의 retry(1시간 뒤 허용)에 의존한다.
- **중복 전달 경합에서 진 워커가 올린 take 객체는 세션이 ready라 prefix 정리가 다시 돌지 않아 남는다.** 드물지만 세션 삭제 정리 배치에서 함께 처리.
