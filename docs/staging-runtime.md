# 서울 스테이징의 API·웹훅·작업자

`infra/staging-runtime-edge.yaml`은 사설 HTTPS 주소 하나를 만들고, `infra/staging-runtime-service.yaml`은 같은 이미지에서 역할 하나를 실행한다. API, 웹훅 수신기, 카드 작업자, 발급사 명령 작업자, 메일 작업자에 각각 독립적인 스택과 PostgreSQL 로그인을 사용한다. 모든 자금·카드 이벤트와 메일은 체험용이다.

## 설치 전 준비

1. [서울 스테이징 설치](staging-setup.md)에 따라 네트워크·기반·부트스트랩을 먼저 준비한다. 최신 네트워크 스택 출력에 `EndpointSecurityGroupId`가 있어야 한다. 두 private subnet, `VpcId`, DB·endpoint 보안 그룹, 서울 S3 prefix list, ECS cluster ARN, ECR 저장소 이름을 기록한다. Linux amd64 서버 이미지에는 연결형 프론트엔드와 검증한 서울 RDS CA 파일 `/etc/aqua/rds-ca.pem`이 있어야 한다. 배포는 태그 대신 ECR digest를 사용한다.
2. private ALB에 실제로 접근할 VPN 또는 테스트 클라이언트와 해당 보안 그룹을 준비한다. 이 그룹에서 ALB의 443으로 나가는 경로가 필요하다. ACM에서 사내 테스트 호스트명과 일치하는 인증서를 서울 리전에 발급하고, 사용자 기기에 해당 인증서의 루트 신뢰를 구성한다. private DNS 레코드를 만들 수 있는 VPC 연결 hosted zone도 필요하다.
3. 기존 부트스트랩은 관리자·모니터 역할을 위한 작업이다. DB 담당자가 `aqua` DB에 역할별 `LOGIN`을 만든다. 각 로그인에는 고유한 임의 비밀번호를 쓰며 `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`로 설정한다. 로그인끼리 또는 소유자 역할에 대한 멤버십을 주지 않는다. 접근이 제한된 일회성 작업에서 마이그레이션 소유자 연결과 아래 역할 변수들을 설정하고 같은 digest의 `node dist-server/migrate.js`를 실행한다. DB 연결 문자열은 `MIGRATION_DATABASE_URL`, 스키마는 `DATABASE_SCHEMA=aqua`, CA 경로는 `DATABASE_CA_FILE=/etc/aqua/rds-ca.pem`이다.
4. 같은 계정·리전의 Secrets Manager에 **스택마다 별개의 JSON 비밀**을 만든다. 이 템플릿은 서울 Secrets Manager의 기본 암호화 키를 사용한다. 비밀 생성 및 회전은 스테이징 담당자가 수행한다. 컨테이너 환경 변수에 들어가는 값을 AWS CLI 인자·셸 이력·CloudFormation 파라미터에 넣지 않는다. CFN에는 해당 역할 비밀의 전체 ARN만 전달한다.

| 서비스 종류 | 마이그레이션 시 지정할 역할 변수 | 해당 역할 비밀에 필요한 JSON 필드 |
| --- | --- | --- |
| `api` | `DATABASE_RUNTIME_ROLE` | `databaseUrl`, `mailKeys`, `mailActiveKey` |
| `ingress` | `DATABASE_INGRESS_ROLE` | `databaseUrl`, `webhookKeys` |
| `card-worker` | `DATABASE_WORKER_ROLE` | `databaseUrl` |
| `issuer-dispatcher` | `DATABASE_DISPATCHER_ROLE` | `databaseUrl`, `issuerKeyId`, `issuerKey` |
| `mail-worker` | `DATABASE_AUTH_MAIL_ROLE` | `databaseUrl`, `mailKeys`, `mailActiveKey` |

`databaseUrl`에는 `postgresql://<role>:<URI 인코딩된 비밀번호>@<서울 RDS endpoint>:5432/aqua` 형식의 문자열을 넣는다. API와 메일 작업자의 비밀은 각각 다르며, `mailKeys`와 `mailActiveKey` 값은 같아야 한다. `mailKeys`와 `webhookKeys`는 중첩 JSON 객체 대신 그 객체를 직렬화한 **문자열**이다. 메일 키는 32바이트의 표준 base64, 웹훅과 발급사 키는 32바이트의 패딩 없는 base64url로 인코딩한다. 키들은 용도별로 독립 생성한다. 구성 예시는 [메일 발송](email-verification-delivery.md), [카드 웹훅](card-event-inbox.md), [발급사 작업자](issuer-command-outbox.md)에 있다. 키 교체 시 기존 암호문을 해독할 키와 전송 중인 웹훅 검증 키를 정리 완료까지 유지한 뒤 두 스택을 재배포한다.

## 스택 생성

다음은 스테이징 계정에 배포할 때 사용하는 명령이다. 실제 설치 비용은 internal ALB·Fargate·기존 네트워크 endpoint·RDS에 발생한다. `private_subnets`는 쉼표로 연결한 두 subnet ID다. 각 환경 변수는 위에서 얻은 스택 출력 또는 비밀 ARN을 가리킨다.

```bash
aws cloudformation deploy --region ap-northeast-2 \
  --stack-name aqua-staging-runtime-edge --template-file infra/staging-runtime-edge.yaml \
  --parameter-overrides VpcId="$vpc_id" PrivateSubnetIds="$private_subnets" \
  ClientSecurityGroupId="$client_group" CertificateArn="$certificate_arn"
aws cloudformation describe-stacks --region ap-northeast-2 \
  --stack-name aqua-staging-runtime-edge --query 'Stacks[0].Outputs'
```

ACM 인증서에 대응하는 private DNS alias를 `PrivateDnsTarget`과 `CanonicalHostedZoneId`로 등록한다. `edge_group`에는 `EdgeSecurityGroupId`를 넣는다. API와 웹훅은 자신의 target group 출력을 사용한다.

```bash
common_args=(
  "VpcId=$vpc_id" "PrivateSubnetIds=$private_subnets" "ClusterArn=$cluster_arn"
  "SourceDatabaseSecurityGroupId=$database_group" "EndpointSecurityGroupId=$endpoint_group"
  "S3PrefixListId=$s3_prefix_list" "EdgeSecurityGroupId=$edge_group"
  "EcrRepositoryName=$ecr_repository" "ImageDigest=$image_digest" "MonitorEnvironment=staging"
)
deploy_service() {
  local service_kind=$1 role_secret_arn=$2 task_count=$3
  shift 3
  aws cloudformation deploy --region ap-northeast-2 --capabilities CAPABILITY_IAM \
    --stack-name "aqua-staging-runtime-$service_kind" --template-file infra/staging-runtime-service.yaml \
    --parameter-overrides "${common_args[@]}" "ServiceKind=$service_kind" \
    "RuntimeSecretArn=$role_secret_arn" "DesiredCount=$task_count" "$@"
}
deploy_service api "$api_secret" 0 "HttpsOrigin=$https_origin" "TargetGroupArn=$api_targets"
deploy_service ingress "$ingress_secret" 0 "TargetGroupArn=$ingress_targets"
deploy_service card-worker "$card_worker_secret" 0
deploy_service issuer-dispatcher "$dispatcher_secret" 0
deploy_service mail-worker "$mail_worker_secret" 0
```

처음에는 모두 `DesiredCount=0`으로 등록한다. 권한과 CA, 마이그레이션 호환성을 확인하면 같은 명령에서 각 개수를 `1`로 바꾼다. 앱 컨테이너에는 IAM task role이 없다. ECS 실행 역할은 각 스택의 단일 비밀, ECR 저장소와 로그 그룹에만 접근한다. 서비스별 보안 그룹은 RDS, 사설 ECR·Secrets Manager·Logs endpoint, ECR layer용 S3에만 나간다. 워커는 수신 포트를 공개하지 않는다.

## 배포 확인

승인된 VPN·클라이언트에서 HTTPS를 연다. API의 `/api/live`는 프로세스, `/api/health`는 DB 접근 준비 상태를 확인한다. 웹훅 준비 상태는 웹훅 target group의 `/health`로 확인한다. ALB의 `POST /webhooks/sandbox/cards`에는 테스트 키로 서명한 이벤트만 전달한다. 로그에는 webhook 본문·카드 정보·메일 인증 토큰을 기록하지 않는다.

```bash
aws elbv2 describe-target-health --region ap-northeast-2 --target-group-arn "$api_targets"
aws elbv2 describe-target-health --region ap-northeast-2 --target-group-arn "$ingress_targets"
curl --fail --silent --show-error "$https_origin/api/health"
```

카드 작업자가 서명 확인을 거친 이벤트를 처리하는지와 PostgreSQL 원장이 일치하는지를 점검한다. 발급사 sidecar는 같은 태스크의 `127.0.0.1:3005`에만 바인딩한다. 정상 서명의 카드 제어 명령을 `COMMAND_REJECTED`로 반환하고, 유실된 명령 재조회에는 실행 기록이 없음을 반환한다. 따라서 실제 카드 발급·정지 성공을 이 스택으로 인증할 수 없다. 메일은 외부로 보내지 않고 태스크 로컬 권한 0700 디렉터리에만 남긴다. 교체 시 해당 파일이 사라지므로 합성 계정만 사용한다. 실수신·SES 반송·불만은 별도 전달 시험이 필요하다.

`RuntimeLogGroup`에는 작업자 heartbeat를 포함한 로그가 쌓인다. [운영 모니터링](operations-monitoring.md)의 기대 환경 이름과 작업자 활성화 상태를 맞춘다. 런타임 서비스는 배포 실패 시 ECS 회로 차단기와 롤백을 사용한다. DB 스키마 변경 후에는 [호환 이미지 복구 절차](compatible-fallback.md)에 맞는 digest로 전환한다.

## AWS 없이 검증

```bash
python3 -m venv /tmp/aqua-runtime-cfn
/tmp/aqua-runtime-cfn/bin/pip install cfn-lint==1.40.4
/tmp/aqua-runtime-cfn/bin/cfn-lint --regions ap-northeast-2 --template \
  infra/staging-runtime-edge.yaml infra/staging-runtime-service.yaml infra/staging-network.yaml
/tmp/aqua-runtime-cfn/bin/python -B -m unittest discover -s scripts -p test_staging_runtime_template.py
node --env-file-if-exists=.env --import tsx --test --test-name-pattern='private staging' \
  server/staging-issuer.test.ts server/http.test.ts server/database.test.ts
```

로컬 검증은 템플릿 스키마와 접근 범위, 실제 발급사 어댑터와 loopback sidecar 간 서명·거절·재조회, 위조된 전달 IP에 대한 API 요청 제한을 확인한다. 실계정에서는 태스크 기동, 보안 그룹·DNS·인증서·비밀 회전, 경보 수신, 장애 복구 시간을 별도로 기록한다.
