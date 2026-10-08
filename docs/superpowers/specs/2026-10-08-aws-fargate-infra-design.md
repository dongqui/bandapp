# AWS Fargate 배포 인프라 설계 (CDK)

- 날짜: 2026-10-08
- 범위: api와 worker를 AWS ECS Fargate에 올리는 인프라를 `infra/`에 CDK(TypeScript) 코드로 정의한다.
- 전제: 이미지는 `infra/ecr-push.sh`로 ECR `take-n/api`에 올라가 있다 (api·worker 공용 이미지).

## 배경과 제약

- 계정 405134482966("Project N")은 AWS 새 가입 경험의 프로젝트 계정이다. AWS 관리 SCP가
  us-east-1, us-west-2, 프로젝트 선택 리전(**ap-southeast-2 시드니**) 밖의 호출을 거부한다.
  모든 리소스는 시드니에 만든다. SCP는 수정할 수 없다.
- 유료 플랜(크레딧 $120). ECR/ECS/ELB/SQS/SSM/Route 53/ACM/CloudFormation 허용.
  EC2 스팟 인스턴스는 거부되지만 Fargate Spot은 EC2 API를 쓰지 않으므로 사용 가능할 것으로 본다
  (배포 시 확인, 막히면 온디맨드로 전환).
- 혼자 운영, 런웨이 제한. 월 비용을 최소화하되 출시 품질(HTTPS, 무중단 배포, 자동 복구)은 유지한다.
- 환경은 prod 하나. 로컬 docker compose가 개발 환경이다.
- 도메인은 Route 53에서 등록한다 (사용자가 콘솔에서 직접). API 호스트는 `api.<도메인>`.
- DB는 Neon 무료 플랜(시드니 리전)을 쓴다. RDS는 만들지 않는다.

## 결정 사항

1. **퍼블릭 서브넷, NAT 없음.** 태스크가 공인 IP를 받아 Gemini·R2·SQS로 직접 나간다. 인바운드는
   보안 그룹으로 ALB→api만 허용. NAT 게이트웨이(월 약 $35)를 피한다.
2. **스택 두 개.** `Stateful`(VPC, SQS)과 `Runtime`(ECS, ALB, DNS, 서비스). Stateful은 삭제 방지.
3. **비밀값은 SSM Parameter Store SecureString** `/bandapp/prod/<이름>`. Secrets Manager보다 싸고
   ECS가 태스크 기동 시 직접 주입한다. 등록은 `infra/put-secrets.sh`가 gitignore된 `.env.prod`를 읽어 수행.
4. **DATABASE_URL은 Neon 접속 URL 그대로** 비밀값으로 둔다 (`sslmode=require` 포함). api 코드 변경 없음.
5. **마이그레이션은 api 태스크 기동 시** 실행한다 (`drizzle-kit migrate` 후 `node dist/api.main`).
   compose와 같은 방식. api desiredCount는 1로 두어 동시 마이그레이션 경합을 피한다.
6. **worker는 Fargate Spot, 1대 상시.** 0 스케일링은 범위 밖.
7. **이미지 태그는 git 짧은 해시.** CDK가 ECR 저장소를 이름으로 참조하고 태그를 컨텍스트 값으로 받는다.
8. **python 큐는 만들지 않는다.** api 코드가 `SQS_PYTHON_ANALYSIS_QUEUE_URL`을 읽지 않는다.

## 구성 요소

### `infra/` 패키지 (`@bandapp/infra`)

- `pnpm-workspace.yaml`에 `infra`를 추가한다.
- 의존성: `aws-cdk-lib`, `constructs`, `aws-cdk`(CLI), `tsx`, `vitest`, `typescript`.
- 파일
  - `bin/app.ts`: 앱 진입점. 계정·리전·도메인·이미지 태그를 `config.ts`와 CDK 컨텍스트에서 읽어 두 스택을 만든다.
  - `lib/config.ts`: 환경 설정 타입과 prod 값 (도메인, 호스트명, 태스크 사양, 평문 환경변수).
  - `lib/stateful-stack.ts`
  - `lib/runtime-stack.ts`
  - `test/stacks.test.ts`: assertions 테스트.
  - `cdk.json`: `"app": "npx tsx bin/app.ts"`, 컨텍스트 플래그 기본값.
  - `put-secrets.sh`, `.env.prod.example`, `deploy.sh`.
- 스크립트: `cdk`, `synth`(`cdk synth --strict`), `diff`, `deploy`(git 해시를 `-c imageTag=`로 넘김), `test`.

### Stateful 스택 (`bandapp-prod-stateful`)

| 리소스 | 설정 |
|---|---|
| VPC | CIDR 10.0.0.0/16, AZ 2개, 퍼블릭 서브넷만, NAT 0, IGW |
| SQS `recording-analysis` | visibilityTimeout 300초, DLQ로 redrive maxReceiveCount 3 |
| SQS `recording-analysis-dlq` | 보관 14일 |
| 출력 | VPC ID, 큐 URL·ARN (Runtime 스택이 객체 참조로 사용) |

`terminationProtection: true`.

### Runtime 스택 (`bandapp-prod-runtime`)

| 리소스 | 설정 |
|---|---|
| ECS 클러스터 | Fargate 전용, capacity provider FARGATE·FARGATE_SPOT 활성 |
| ECR 참조 | `Repository.fromRepositoryName("take-n/api")`, 태그 = 컨텍스트 `imageTag` |
| ALB | 퍼블릭 서브넷, 인터넷 연결. 리스너 443(ACM 인증서) → api 타겟 그룹, 리스너 80 → 443 리다이렉트 |
| ACM 인증서 | `api.<도메인>`, Route 53 DNS 검증 (호스티드 존은 도메인 이름으로 lookup) |
| Route 53 | `api.<도메인>` A 레코드 → ALB alias |
| 타겟 그룹 | HTTP 3000, 헬스체크 `/health` 200, 간격 30초, deregistration 30초 |
| api 태스크 정의 | 0.25 vCPU / 512MB, 컨테이너 `api`, 포트 3000, command `sh -c "pnpm db:migrate && node dist/api.main"`, 로그 `/bandapp/prod/api` |
| api 서비스 | desiredCount 1, FARGATE 온디맨드, assignPublicIp, 서킷 브레이커 + 롤백, min 100% / max 200% |
| worker 태스크 정의 | 0.5 vCPU / 1GB, command `node dist/worker.main`, 로그 `/bandapp/prod/worker` |
| worker 서비스 | desiredCount 1, capacity provider FARGATE_SPOT weight 1 (base 0), assignPublicIp, 서킷 브레이커 |
| 로그 그룹 | 보관 2주 |
| 보안 그룹 | ALB: 80·443 인바운드 any. api: 3000 인바운드 ALB SG만. worker: 인바운드 없음. 아웃바운드 전부 허용 |
| IAM 태스크 역할 | api: 분석 큐 `SendMessage`. worker: 분석 큐 `ReceiveMessage`·`DeleteMessage`·`ChangeMessageVisibility`. 둘 다 SSM 파라미터 `GetParameters`(접두어 `/bandapp/prod/`) |
| IAM 실행 역할 | ECR pull, 로그 쓰기, SSM SecureString 복호화 (CDK `secrets` 지정 시 자동 부여) |
| 출력 | API URL, ALB DNS, 클러스터·서비스 이름 |

### 환경변수와 비밀값

평문(CDK 코드, `config.ts`):

| 이름 | 값 |
|---|---|
| NODE_ENV | production |
| PORT | 3000 |
| AWS_REGION | ap-southeast-2 |
| SQS_ANALYSIS_QUEUE_URL | Stateful 스택 큐 URL |
| GEMINI_MODEL | gemini-3.8-flash |
| R2_BUCKET | 설정값 (초기 `taken-rehearsal-dev`, 운영 버킷 생기면 변경) |
| INVITE_LINK_BASE_URL | `https://api.<도메인>` (앱 딥링크 도메인 정해지면 변경) |
| AUTH_THROTTLE_LIMIT | 20 |
| APPLE_BUNDLE_ID | com.projectn.taken |
| APPLE_TEAM_ID | 5JZBZK5HDQ |

비밀(SSM SecureString `/bandapp/prod/<이름>`, `.env.prod`에서 등록):

DATABASE_URL, JWT_ACCESS_SECRET, GOOGLE_CLIENT_IDS, APPLE_KEY_ID, APPLE_PRIVATE_KEY, GEMINI_API_KEY,
R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, REVENUECAT_API_KEY, REVENUECAT_WEBHOOK_SECRET,
SUPPORT_WEBHOOK_URL.

`SQS_ENDPOINT`는 설정하지 않는다 (로컬 전용). `DEV_LOGIN_SECRET`도 설정하지 않는다 (production에서 닫힘).
`FFMPEG_BIN`/`FFPROBE_BIN`은 이미지 PATH의 ffmpeg를 쓰므로 생략.

`put-secrets.sh`는 `.env.prod`의 각 줄을 `aws ssm put-parameter --type SecureString --overwrite`로 올린다.
빈 값은 건너뛴다. 값은 명령 인자로 넘기지 않고 `--cli-input-json file://<임시파일>`로 넘겨 프로세스 목록에 남지 않게 하며, 임시 파일은 끝나면 지운다.
`.gitignore`에 `.env.prod`를 추가한다.

### 데이터 흐름

- 앱 → `https://api.<도메인>` → ALB(443) → api 태스크(3000).
- api → SQS `recording-analysis` 전송 → worker가 long polling 수신 → Gemini·R2·Neon 접근 → 완료 시 삭제.
- 3회 실패 메시지 → DLQ. (알람은 범위 밖, 콘솔에서 확인.)

## 배포 절차

최초 한 번:

1. Route 53에서 도메인 등록 (콘솔). 호스티드 존이 자동 생성된다.
2. Neon 프로젝트 생성(시드니), 접속 URL 확보.
3. `.env.prod` 작성 → `sh infra/put-secrets.sh`.
4. `pnpm --filter @bandapp/infra cdk bootstrap aws://405134482966/ap-southeast-2`.
5. `lib/config.ts`에 도메인 입력.

매 배포:

```bash
sh infra/ecr-push.sh && pnpm --filter @bandapp/infra deploy
```

`deploy` 스크립트: `cdk deploy --all --require-approval never -c imageTag=$(git rev-parse --short HEAD)`.
배포 전 `cdk diff`를 확인하는 습관을 권장하며 `pnpm --filter @bandapp/infra diff`로 볼 수 있다.

## 실패 시 동작

- 새 api 태스크가 헬스체크를 통과하지 못하면 ECS 서킷 브레이커가 이전 태스크 정의로 롤백한다.
  CloudFormation 스택도 롤백되어 `cdk deploy`는 실패로 끝난다. 서비스는 옛 버전으로 계속 동작한다.
- 마이그레이션 실패 시 컨테이너가 종료되어 위와 같이 처리된다. drizzle은 마이그레이션을 트랜잭션으로 적용한다.
- worker Spot 회수: 2분 전 SIGTERM. `worker.main`이 consumer를 멈추고 종료한다. 처리 중 메시지는
  heartbeat 중단 후 visibility 만료(300초)로 재전달되며, 분석 로직은 멱등이다.
- 태스크 비정상 종료 시 ECS가 desiredCount를 유지하기 위해 재시작한다.
- Fargate Spot 용량 부족이나 SCP 거부로 worker가 뜨지 않으면 capacity provider를 FARGATE로 바꿔 재배포한다.

## 검증

- `pnpm --filter @bandapp/infra synth` (`--strict`): 템플릿 생성과 경고 검사.
- `pnpm --filter @bandapp/infra test`: `aws-cdk-lib/assertions`로
  - ECS 서비스 2개, api는 FARGATE, worker는 FARGATE_SPOT capacity provider
  - ALB 443 리스너와 80→443 리다이렉트
  - 분석 큐의 redrive 정책이 DLQ를 가리키고 maxReceiveCount 3
  - 로그 그룹 보관 14일
  - api 컨테이너 secrets에 DATABASE_URL 포함, 환경변수에 SQS_ANALYSIS_QUEUE_URL 포함
- 배포 후 `curl https://api.<도메인>/health` → `{"status":"ok"}`. worker 로그에 `analysis consumer started` 확인.

## 비용 추정 (시드니, 월)

| 항목 | USD |
|---|---|
| ALB | 약 20 |
| api Fargate 0.25 vCPU / 0.5GB 온디맨드 | 약 11 |
| worker Fargate Spot 0.5 vCPU / 1GB | 약 7 |
| Route 53 호스티드 존, 로그, SQS | 약 2 |
| Neon 무료 | 0 |
| 합계 | 약 40 |

크레딧 $120로 약 3개월.

## 범위 밖

- GitHub Actions 자동 배포, worker 0 스케일링(SQS 길이 기반), CloudWatch 알람(DLQ, 5xx),
  audio-worker 서비스, staging 환경, RDS 전환, CloudFront/WAF.
