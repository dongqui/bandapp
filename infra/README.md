# infra

배포/인프라 정의 자리. MVP Phase 1 이후 R2, PostgreSQL, 배포 구성이 여기에 들어온다.
아직 내용 없음.

## 환경변수

- `FIREBASE_SERVICE_ACCOUNT_JSON` — FCM 푸시용 서비스 계정 JSON. 태스크 정의의 secrets에 `api`와 `worker` 둘 다 넣는다 (worker가 세션 완료 푸시를 보낸다). 비어 있으면 푸시는 로그만 남긴다.
