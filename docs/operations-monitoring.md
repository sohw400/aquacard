# 운영 알림과 장애 대응

AWS 서울 리전에서 ECS Fargate 작업이 5분마다 내부 원장과 세 대기열을 읽는다. 결과는 CloudWatch Logs에 한 줄로 기록하고 CloudWatch가 `AquaCard/Operations` 지표를 추출한다. 경보 상태가 `ALARM` 또는 `OK`로 바뀔 때 기존 SNS 구독자에게 통지한다. AWS 계정에서의 설치와 수신 확인은 별도로 수행한다. [CloudFormation 템플릿](../infra/operations-monitoring.yaml)

## 배포 입력

- AWS 계정·리전 안에서 고유한 `Environment`를 정한다. 예를 들어 `kr-staging`과 `kr-prod`를 분리한다. 점검 작업과 해당 환경의 상시 작업자에 같은 `AQUA_MONITOR_ENVIRONMENT`를 넣고 표준 출력의 JSON을 그대로 `awslogs`에 보낸다. 서로 다른 데이터베이스에 같은 이름을 쓰면 그 지표들이 합쳐진다.
- `ClusterArn`, `PrivateSubnetIds`, `TaskSecurityGroupId`를 준비한다. 점검 작업에는 공개 IP와 인바운드 규칙이 필요 없다. RDS는 작업 보안 그룹의 PostgreSQL 연결을 허용해야 한다. 사설 서브넷은 ECR API·Docker 레지스트리, ECR 레이어용 S3, CloudWatch Logs, Secrets Manager에 도달할 수 있어야 한다. VPC 엔드포인트를 쓰면 해당 리전의 DNS, 보안 그룹, S3 라우팅도 확인한다.
- `EcrRepositoryName`과 `ImageDigest`는 같은 계정·리전의 검증된 Linux amd64 서버 이미지를 가리킨다. `ImageDigest` 형식은 `sha256:`과 64자리 해시다. 서버 빌드에 점검 실행 파일과 해당 버전의 SQL 마이그레이션이 들어 있어야 한다. 운영 이미지를 만들 때 신뢰할 수 있는 RDS 서울 리전 CA 번들을 `DatabaseCaFile` 경로에 읽기 전용으로 복사한다. 기본 경로는 `/etc/aqua/rds-ca.pem`이다. 이미지의 `node` 사용자가 읽을 수 있는지, DB URL의 DNS 이름과 인증서가 일치하는지, CA 교체 때 새 번들로 접속할 수 있는지 확인한다. [RDS TLS 인증서 배포](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html)
- DB 관리자가 독립된 로그인 역할을 만든 뒤 그 이름을 `DATABASE_MONITOR_ROLE`에 지정해 해당 버전의 마이그레이션과 권한 부여를 실행한다. `MonitorDatabaseSecretArn`에는 이 로그인용 PostgreSQL 접속 URL을 문자열로 보관한 Secrets Manager 비밀의 전체 ARN을 넣는다. 애플리케이션 스키마를 바꿨다면 `DatabaseSchema`도 맞춘다. 고객 관리형 KMS 키를 쓴다면 `SecretKmsKeyArn`을 지정하고 키 정책에서 작업 실행 역할의 복호화를 허용한다. 각 실행에서 비밀의 현재 버전을 다시 읽는다.
- `AlarmTopicArn`으로 기존 당직 채널의 SNS 주제를 지정한다. 구독 승인, CloudWatch의 게시 권한, 주제 암호화 시 KMS 키 정책을 확인한다. `OldestDueThresholdSeconds`의 기본값 300초는 최초 배포 설정이다. 거래량과 허용 처리 지연을 측정해 조정한다.
- `CardWorkerExpected`, `AuthMailWorkerExpected`, `IssuerDispatcherExpected` 중 이 환경에서 상시 실행할 작업자만 `true`로 설정한다. 기본값은 모두 `false`다. 현재 발급사 전송기는 sandbox 전용으로 운영 모드에서 실행이 차단된다. `--once` 명령은 상시 작업자 신호를 발행하지 않는다.

마이그레이션 013은 기존 대기열에 부분 인덱스 4개를 생성한다. 생성 중에는 해당 테이블에 쓰려는 거래가 대기할 수 있다. 운영과 비슷한 크기로 복원한 스테이징에서 소요 시간과 결제·메일 지연을 측정해 적용 시간을 정한다. 새 점검 작업은 014까지 적용하고 전용 계정으로 검사한 뒤 켠다.

템플릿은 점검 전용 작업 정의·실행 역할·로그 그룹, 스케줄과 실행 권한, 경보를 만든다. 컨테이너에는 AWS 작업 역할이 없다. ECS 실행 역할이 지정한 비밀을 읽고 이미지를 내려받아 로그를 보낸다. 스케줄러는 지정한 클러스터에서 이 작업 정의의 해당 리비전만 실행할 수 있다. 스택 삭제 뒤에도 로그 그룹은 남으며 각 로그의 보존 기간은 30일이다.

### RDS 인증서를 포함한 이미지 빌드

릴리스 담당자가 AWS에서 확인한 서울 리전 공개 CA 번들을 저장소 밖에 보관한다. 아래 `AQUA_RDS_CA_PATH`는 그 파일의 절대 경로, `AQUA_RDS_CA_SHA256`은 릴리스 검토에서 확인한 번들의 SHA-256 값이다. 빌드는 인증서와 해시를 함께 받아 검증하고 `/etc/aqua/rds-ca.pem`에 설치한다. 개인 키나 CA 용도가 아닌 인증서가 섞이면 실패한다. 인증서를 교체할 때는 해시와 이미지 다이제스트를 함께 갱신한다.

```bash
docker buildx build --platform linux/amd64 --load --tag aqua-server:rds \
  --no-cache-filter rds-trust \
  --secret id=rds_ca,src="$AQUA_RDS_CA_PATH" \
  --build-arg RDS_CA_SHA256="$AQUA_RDS_CA_SHA256" .
docker run --rm --entrypoint node aqua-server:rds \
  -e "require('node:fs').accessSync('/etc/aqua/rds-ca.pem', require('node:fs').constants.R_OK)"
```

두 입력을 생략하면 로컬용 이미지에는 RDS 번들이 설치되지 않는다. 데이터베이스 연결은 계속 인증서와 호스트 이름을 검증한다.

## 설치와 인수 확인

1. 격리 환경에서 `npm run server:monitor` 또는 빌드된 `node dist-server/operations-monitor.js`로 권한과 마이그레이션을 확인한다. 종료값 `0`은 점검 완료, `1`은 확인된 원장 차이·검토 대기·최근 실패, `2`는 점검 미완료다. 대기 시간과 선행 거래 지연의 통지 기준은 CloudWatch에 둔다.
2. `cfn-lint --regions ap-northeast-2 --template infra/operations-monitoring.yaml`로 리전 스키마를 검사한다. 같은 Python 환경에서 프로젝트 의존성을 설치하고 `node --import tsx scripts/check-operations-alarms.mjs`를 실행하면 경보가 실제 점검 결과와 작업자 신호를 구독하는지도 확인할 수 있다. 배포 담당자가 스테이징에서 템플릿과 위 입력으로 CloudFormation 변경 세트를 만든다. 스택에 IAM 역할이 있어 `CAPABILITY_IAM` 승인이 필요하다. 예상 리소스와 SNS 대상을 확인하고 변경 세트를 적용한다.
3. `MonitorScheduleArn`의 스케줄이 켜졌는지, `MonitorTaskDefinitionArn`으로 뜬 작업이 종료값 `0`을 냈는지 확인한다. `MonitorLogGroup`에서 `Environment`, `MonitorHealthy=1`, `LedgerFindings=0`과 세 큐의 지표를 함께 확인한다. 이어지는 실행에서도 지표가 들어오는지 보고 각 경보의 실제 상태와 SNS 구독자 수신 경로를 확인한다.
4. [스테이징 경보 훈련 절차](staging-recovery.md)에 따라 시험용 구독에서 부재 경보를 점검한다. 스케줄을 잠시 중단하고 부재 알림을 받은 시각을 기록한 뒤 바로 재개한다. 다음 정상 표본과 정상 복귀 알림을 확인한다. 상시 작업자도 시험 환경에서 건별로 중단·복구해 대기열이 비어 있을 때의 통지를 확인한다. 장애 감지까지 걸린 시간, 담당자, 대응 시간과 알림 수신 기록을 남긴다.
5. 실제 규모의 비식별 데이터로 5분 주기 대사의 DB 읽기 부하와 실행 시간을 측정한다. 현재 검사에는 원장 전체 조회가 포함되며 대사 SQL 문당 제한은 30초, 명령 실행 제한은 75초다. 지연이 반복되면 운영 전 데이터량에 맞춰 대사 실행 방식을 조정한다. 운영 전환 때는 검증한 이미지·스키마 조합으로 설치하고 운영 당직 채널에서 수신을 확인한다.

## 당직자가 확인할 내용

| 경보 | 발생 조건 | 첫 조치 |
| --- | --- | --- |
| `MissingMonitorAlarm` | `MonitorHealthy` 표본이 5분 단위 3개 구간에서 누락 | 스케줄 상태, ECS가 기록한 마지막 작업 중지 사유, 이미지 풀·비밀 읽기·VPC·로그 전달을 확인한다. 작업 자체가 뜨지 않은 경우에도 이 경보가 적용된다. |
| `MonitorErrorAlarm` | 완료하지 못한 점검이 `MonitorHealthy=0` 기록 | 로그의 `failedChecks` 값을 확인한다. 이미지와 DB의 마이그레이션, 역할, TLS 연결, 제한 시간을 점검한다. 실패한 항목의 지표는 생략된다. 성공한 항목이 보고한 차이는 계속 조사한다. |
| `LedgerAlarm` | 내부 원장 차이 1건 이상 | 제한된 운영 환경에서 `npm run server:reconcile`을 실행해 차이의 종류·참조를 확보한다. 결제별 매입·환불, 보류액, 정산 계정과 리워드 분개를 대조한다. 상세 보고서는 접근 통제된 사건 기록에 보관한다. 외부 정산 대조는 별도로 발급사·수탁사·은행 자료가 필요하다. [대사 절차](server-development.md) |
| `OldestDueAlarm` | 세 큐 중 가장 오래 기다린 처리 가능 건이 설정한 시간 이상 지연 | `*DueCount`, `*OldestDueSeconds`로 큐를 찾고 작업자 상태와 DB 접속을 확인한다. 재시도 예약과 유효한 임대가 끝나야 대기 시간 계산이 시작된다. |
| `BlockedCardAlarm` | 앞선 미처리 매입이 막은 카드 이벤트가 5분 단위 두 구간에서 관측 | 같은 결제에서 먼저 들어온 매입의 상태와 재시도·검토 이력을 확인한다. 짧은 처리 순서 대기는 정상일 수 있다. [카드 이벤트 처리 순서](card-event-inbox.md) |
| `ReviewAlarm` | 재시도를 소진한 카드 이벤트 또는 결과 확인이 필요한 발급사 명령이 있음 | 카드 이벤트는 원본과 앞선 사건을 조회한다. 발급사 명령은 기존 요청 키로 외부 결과부터 확인한다. 담당자와 조치 근거를 사건에 남긴다. [카드 운영 조회](card-operations.md) · [발급사 명령 복구](issuer-command-outbox.md) |
| `QueueFailureAlarm` | 직전 15분 안에 카드 처리 실패, 발급사 거절 또는 메일 발송 실패·전달 기한 만료가 관측됨 | `*FailureCount`로 영향을 받은 큐를 찾고 오류 종류와 발생 시점을 확인한다. 일반 카드 승인 거절과 효력을 잃어 폐기한 인증 요청은 이 집계에서 제외한다. 상태의 최근 변경을 집계하므로 15분을 넘긴 단절은 별도 실패 이력으로 조사한다. [이메일 발송 처리](email-verification-delivery.md) |
| 작업자별 부재 경보 | 사용하도록 설정한 작업자에서 1분 단위 다섯 구간 동안 완료한 조회 신호가 누락 | 서비스의 실행 수·재시작 이력·DB·로그 전달을 본다. 빈 큐 조회도 신호를 보낸다. 복제본이 여럿이면 한 개 이상이 조회를 끝냈음을 뜻한다. 처리량과 개별 복제본 상태는 ECS 서비스에서도 확인한다. |

경보 구간은 CloudWatch 평가 단위다. 늦게 들어온 지표, 결측 평가 범위, ECS 기동, SNS 전달 때문에 실제 통지 시각은 달라질 수 있다. 거래·큐 경보의 결측 처리 설정은 `ignore`다. 점검 중단은 별도 경보로 확인한다. 운영 지표에는 회원·거래 식별자, 메일 주소, 공급업체 원문이 들어가지 않는다. 별도 권한이 필요한 상세 조회는 사건 담당자만 수행한다.
