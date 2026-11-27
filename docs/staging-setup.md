# 서울 스테이징 만들기

이 절차로 합성 거래를 보관할 PostgreSQL과 정기 원장 점검기를 준비한다. 첫 설치는 AWS 서울 리전(`ap-northeast-2`)에서 진행하고, 각 스택이 `CREATE_COMPLETE`가 된 후 다음 단계에 필요한 출력을 읽는다. 실제 계정에서의 설치·경보 수신·복구 시간은 배포 후 기록한다.

## 배포 전

스테이징 계정 담당자가 MFA로 보호한 단기 IAM 세션을 준비한다. 네트워크의 VPC 범위는 `10.84.0.0/20`이므로 앞으로 연결할 사내망과 주소가 겹치는지 먼저 확인한다. 배포 세션에는 해당 스택을 생성하고 실행 역할을 전달할 권한이 필요하다. ECR에 이미지를 올리는 세션에는 대상 저장소의 push 권한이 필요하다. 작업 전 `aws sts get-caller-identity`에서 의도한 계정을 확인하고 아래 조회에 사용할 리전을 설정한다.

```bash
export AWS_REGION=ap-northeast-2
aws rds describe-db-engine-versions --engine postgres \
  --query "DBEngineVersions[?starts_with(EngineVersion, '18.')].EngineVersion" --output text
aws ec2 describe-managed-prefix-lists \
  --filters Name=prefix-list-name,Values=com.amazonaws.ap-northeast-2.s3 \
  --query 'PrefixLists[?OwnerId==`AWS`].PrefixListId' --output text
```

새 계정에서 RDS·ECS를 처음 쓰는 경우 서비스 연결 역할 `AWSServiceRoleForRDS`와 `AWSServiceRoleForECS`가 있는지 확인한다. 없다면 배포 담당자 또는 CloudFormation 실행 역할이 해당 서비스에 한해 `iam:CreateServiceLinkedRole`을 사용할 수 있어야 한다. RDS가 관리자 비밀을 만들고 관리하는 데 필요한 Secrets Manager 권한과, 고객 관리형 키를 선택했다면 해당 키 정책도 확인한다.

지원 중인 PostgreSQL 18 버전을 하나 골라 `AQUA_STAGE_PG_VERSION`으로 정한다. 인스턴스 클래스 후보를 `AQUA_STAGE_DB_CLASS`에 지정한다. 템플릿 기본값은 `db.t4g.micro`다. 선택한 버전·클래스로 gp3 인스턴스를 주문할 수 있는지 조회한다. 결과에 클래스가 나오면 템플릿에 그 값을 사용한다.

```bash
aws rds describe-orderable-db-instance-options --engine postgres \
  --engine-version "$AQUA_STAGE_PG_VERSION" --db-instance-class "$AQUA_STAGE_DB_CLASS" \
  --query 'OrderableDBInstanceOptions[?StorageType==`gp3`].DBInstanceClass' --output text
```

RDS 인스턴스와 gp3 스토리지, VPC 인터페이스 엔드포인트는 대기 중에도 과금된다. 계정 담당자는 서울 리전의 인스턴스 시간·스토리지·엔드포인트 사용 시간과 데이터 처리량, 백업 및 스냅샷, 로그, Fargate 실행, 이미지 저장, 비밀 관리 비용을 산정하고 예산을 확정한다. 시점 복구 훈련 중에는 별도의 RDS 인스턴스가 추가된다. [AWS 요금 계산기](https://calculator.aws/) · [AWS PrivateLink 요금](https://aws.amazon.com/privatelink/pricing/)

## 네트워크와 데이터베이스

1. CloudFormation에서 네트워크용 새 스택의 변경 세트를 만들고 리소스를 검토한 뒤 실행한다. `S3PrefixListId`에는 위 조회에서 확인한 서울 리전 S3 관리형 접두사 목록 ID를 넣는다. `PrimaryAvailabilityZone`과 `SecondaryAvailabilityZone` 기본값은 `ap-northeast-2a`와 `ap-northeast-2c`다. 사용 계정에서 RDS와 엔드포인트가 지원되는 서로 다른 두 영역을 지정한다. 두 영역에 사설 서브넷을 만들며, ECR API·ECR 레지스트리·Secrets Manager·CloudWatch Logs용 인터페이스 엔드포인트 4개는 첫 서브넷에 둔다. S3는 게이트웨이 엔드포인트로 연결한다. 첫 가용 영역의 장애로 이미지 다운로드나 로그 전송이 중단될 수 있고, 둘째 영역에서 인터페이스 엔드포인트 사용 시 영역 간 전송료가 발생할 수 있다. [네트워크 템플릿](../infra/staging-network.yaml)
2. 기반 서비스용 새 스택의 입력 `VpcId`, `PrivateSubnetIds`, `SourceDatabaseSecurityGroupId`에 네트워크의 같은 이름 출력을 넣는다. `PrivateSubnetIds`는 두 서브넷의 쉼표 구분 값이다. 주문 가능 여부를 확인한 `EngineVersion`과 `DBInstanceClass`를 넣는다. 변경 세트에서 공개 접근이 꺼진 암호화 단일 AZ DB, gp3 20 GiB, 자동 백업 7일, 삭제 보호 설정을 확인한다. 스택은 ECR 저장소, ECS 클러스터와 SNS 주제도 만든다. [기반 서비스 템플릿](../infra/staging-foundation.yaml)
3. 당직자가 `AlarmTopicArn`의 스테이징 알림 채널 구독에 동의하고 수신처에서 확인한다. 구독 상태가 확인됨으로 바뀐 시각을 팀 기록에 남긴다. SNS의 저장 시 암호화가 필요하면 `AlarmTopicKmsKeyArn`에 고객 관리 키 ARN을 넣고 키 정책에서 CloudWatch 경보의 사용을 허용한다. 실제 경보와 정상 복귀 통지는 아래 인수 단계에서 확인한다.

## 릴리스 이미지

`EcrRepositoryUri` 출력을 `AQUA_ECR_URI`, `EcrRepositoryName` 출력을 `AQUA_ECR_REPOSITORY`로 둔다. 배포할 커밋의 깨끗한 체크아웃에서 해당 리전의 신뢰한 RDS CA 번들과 검토한 해시로 Linux amd64 이미지 `aqua-server:rds`를 빌드하고 인증서 접근을 검사한다. 같은 커밋의 승인된 이미지를 이미 올렸다면 기존 다이제스트를 사용한다. [인증서와 이미지 빌드 명령](operations-monitoring.md#rds-인증서를-포함한-이미지-빌드)

```bash
AQUA_RELEASE_TAG="$(git rev-parse HEAD)"
AQUA_ECR_REGISTRY="${AQUA_ECR_URI%%/*}"
aws ecr get-login-password | docker login --username AWS --password-stdin "$AQUA_ECR_REGISTRY"
docker tag aqua-server:rds "$AQUA_ECR_URI:$AQUA_RELEASE_TAG"
docker push "$AQUA_ECR_URI:$AQUA_RELEASE_TAG"
aws ecr describe-images --repository-name "$AQUA_ECR_REPOSITORY" \
  --image-ids imageTag="$AQUA_RELEASE_TAG" --query 'imageDetails[0].imageDigest' --output text
docker logout "$AQUA_ECR_REGISTRY"
```

배포 기록에 커밋과 반환된 `sha256:…` 다이제스트를 남긴다. 아래 두 작업에는 동일한 다이제스트를 지정한다.

## DB 초기화와 점검기

기반 스택이 만든 `DBMasterSecretArn`은 RDS가 관리하는 관리자 비밀이다. `MonitorDatabaseSecretArn`은 점검 계정에만 쓰는 별도 JSON 비밀이다. 둘 다 ECS가 실행 시 주입하도록 ARN만 지정한다. 새로 생성한 점검 계정의 비밀번호는 일회성 초기화 때 등록한다. 비밀과 이미 존재하는 로그인 정보가 다르면 초기화가 실패하며 기존 비밀번호를 덮어쓰지 않는다. 이후 회전은 PostgreSQL 로그인과 Secrets Manager 버전을 함께 전환하고 새 작업의 인증을 확인하는 별도 운영 변경으로 진행한다. 원문을 콘솔 출력, 셸 인수, CloudFormation 파라미터 파일, 채팅에 남기지 않는다.

1. 부트스트랩용 새 스택의 입력 `DatabaseHost`에 기반 스택의 `DBEndpoint`, `AdminSecretArn`에 `DBMasterSecretArn`을 연결한다. `MonitorDatabaseSecretArn`, `EcrRepositoryName`에는 같은 이름의 출력, `ImageDigest`에는 ECR의 다이제스트를 넣는다. 기본 DB·스키마 이름은 `aqua`다. 변경 세트에서 IAM 실행 역할의 두 비밀·ECR·로그 접근 권한을 검토하고 `CAPABILITY_IAM`으로 설치한다. [일회성 작업 템플릿](../infra/staging-bootstrap.yaml)
2. 기반 스택의 ECS 클러스터에서 해당 작업 정의를 **일회성 Fargate 작업**으로 실행한다. 네트워크 출력 `PrivateSubnetIds`와 `BootstrapSecurityGroupId`를 쓰고 공개 IP 할당은 끈다. ECS가 `STOPPED`가 될 때까지 기다린 뒤 컨테이너 종료 코드 0과 초기화 성공 로그를 확인한다. 이 작업은 마이그레이션을 적용하고 별도 점검 계정으로 재접속해 권한을 검사한다. 실패하면 중지 사유와 권한·TLS 경로를 확인하고 같은 정의로 재실행한다. 기존 로그인과 비밀이 다르면 DB 관리자가 비밀의 버전과 회전 상태를 맞춘 뒤 재시도한다.

아래 명령에서 `AQUA_STAGE_CLUSTER`는 기반 스택의 `ClusterArn`, `AQUA_BOOT_DEFINITION`은 부트스트랩 스택의 `BootstrapTaskDefinitionArn`, `AQUA_SUBNET_IDS`와 `AQUA_BOOT_SG`는 네트워크의 `PrivateSubnetIds`, `BootstrapSecurityGroupId`다. 실행자에게는 해당 작업의 `ecs:RunTask`와 `BootstrapExecutionRoleArn`을 ECS에 전달할 `iam:PassRole`이 필요하다.

```bash
aws ecs run-task --cluster "$AQUA_STAGE_CLUSTER" --task-definition "$AQUA_BOOT_DEFINITION" \
  --launch-type FARGATE --platform-version 1.4.0 \
  --network-configuration "awsvpcConfiguration={subnets=[$AQUA_SUBNET_IDS],securityGroups=[$AQUA_BOOT_SG],assignPublicIp=DISABLED}" \
  --query '{task:tasks[0].taskArn,failures:failures[].reason}'
```

응답의 `failures`가 비어 있고 `task`에 ARN이 있으면 그 값을 `AQUA_BOOT_TASK`로 둔다.

```bash
aws ecs wait tasks-stopped --cluster "$AQUA_STAGE_CLUSTER" --tasks "$AQUA_BOOT_TASK"
aws ecs describe-tasks --cluster "$AQUA_STAGE_CLUSTER" --tasks "$AQUA_BOOT_TASK" \
  --query "tasks[0].{reason:stoppedReason,exit:containers[?name=='bootstrap'].exitCode|[0]}"
```

초기화 성공을 확인한 뒤 점검 스택의 입력을 아래 표대로 연결한다. 환경 이름은 계정·리전에서 고유하게 정한다. IAM 역할이 포함된 스택은 변경 세트에서 `CAPABILITY_IAM`을 확인한다. 설치하면 스케줄이 5분마다 실행된다. 실제로 상시 실행 중인 서비스만 작업자 부재 경보를 켠다. [점검 템플릿](../infra/operations-monitoring.yaml)

| 점검 스택 입력 | 값의 출처 |
| --- | --- |
| `Environment`, `DatabaseSchema` | 예시 `kr-staging`, `aqua` |
| `ClusterArn`, `EcrRepositoryName`, `AlarmTopicArn`, `MonitorDatabaseSecretArn` | 기반 스택의 같은 이름 출력 |
| `PrivateSubnetIds`, `TaskSecurityGroupId` | 네트워크의 `PrivateSubnetIds`, `MonitorSecurityGroupId` |
| `ImageDigest`, `DatabaseCaFile`, `MonitorSecretFormat` | ECR에서 확인한 다이제스트, `/etc/aqua/rds-ca.pem`, `json` |

## API와 작업자 배포

모니터의 DB 접속을 확인한 뒤 사설 HTTPS 진입점과 서비스별 작업 정의를 준비한다. API, 카드 수신기와 각 작업자는 별도 로그인으로 실행한다. 실행 개수의 기본값은 0이며, 스테이징 운영자가 비밀값과 TLS 인증서를 준비한 후 시작한다. [사설 스테이징 서비스 배포](staging-runtime.md)

## 인수와 비용 정리

점검 작업이 정상 종료하고 CloudWatch에 해당 환경의 `MonitorHealthy=1`과 `LedgerFindings=0`이 기록되는지 확인한다. 새 DB에서는 업무 데이터가 비어 있어도 두 값이 나올 수 있다. 합성 송금 시점 복구를 검증하려면 스테이징 API, 제한된 앱 DB 계정, 거래를 허용한 합성 회원 두 명이 별도로 필요하다. API·카드 발급사·메일 작업자 배포는 위 스택의 범위 밖이다. 복구 스택 생성 시 네트워크 기반 스택의 `VerifierSecurityGroupId`를 사용하면 `ManageVerifierEgress=true`로 지정한다. 이 설정은 훈련 중 해당 검증기에서 새 복원본으로 가는 TCP 5432 경로만 열고 스택을 삭제할 때 정리한다. 준비된 뒤 원본과 복원본에서 거래를 대조하고, 당직자의 실제 경보 및 복구 통지 시각을 기록한다. [서울 스테이징 복구 훈련](staging-recovery.md)

잠시 멈추는 경우 점검 스케줄을 중지한 시각과 재개 담당자를 기록한다. 계속 과금되는 DB·엔드포인트·비밀·저장소를 비용 대시보드에서 확인한다. 스테이징을 폐기할 때는 담당자가 보존할 자료와 암호화 키를 먼저 결정한 뒤 점검 및 일회성 작업 스택, 기반 서비스, 네트워크 순서로 제거한다. RDS 삭제 보호를 해제하는 변경은 폐기 시점에 별도로 검토한다. 기반 스택은 원본 DB의 최종 스냅샷을 남기며 보관 기간이 남은 자동 백업도 유지한다. ECR 저장소와 점검 로그 그룹은 스택 삭제 뒤에도 남는다. 복원본 전용 스택은 삭제할 때 복원 DB를 함께 삭제한다. 보존한 항목의 소유자·유효 기간·비용을 점검한다.
