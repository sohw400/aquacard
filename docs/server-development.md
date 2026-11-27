# 서버 연결 개발

서버 연결 모드는 가입·로그인, 세션, 회원 조회, 잔액, 회원 송금과 카드 결제 내역을 서버에서 처리한다. **Node.js 24 LTS·Fastify 5·PostgreSQL 18**을 사용하며 인증과 원장의 기준 데이터는 PostgreSQL에 저장한다. 카드 승인·매입·취소·환불은 내부 테스트 CLI로 반영한다. 기술 선택과 구현·계획의 구분은 [기술 결정](technology-decisions.md)에 정리했다.

신규 계정은 0원에서 시작한다. 금액은 테스트 원장의 숫자이며 실제 원화·발행된 스테이블·카드 정산과 연결되지 않았다. 브라우저 PoC 잔액이나 이전 SQLite 테스트 데이터를 가져오지 않는다. [공개 GitHub Pages](https://sohw400.github.io/aquacard/)는 기존 브라우저 데모를 유지한다.

## 처음 실행

Node.js **24**와 Docker Compose가 필요하다. 저장소 루트에서 의존성을 설치하고 로컬 PostgreSQL을 시작한다.

```bash
cd /workspace/aquacard
npm ci --no-audit --no-fund
docker compose up -d --wait postgres
```

Compose는 PostgreSQL만 실행한다. 호스트의 `127.0.0.1:54329`, DB `aqua`를 사용한다. 마이그레이션·테스트 소유자는 `aqua` / `aqua_local_only`, 애플리케이션 역할은 `aqua_app` / `aqua_app_local_only`다. 이 값은 로컬 테스트 전용이며 운영 자격 증명이 아니다. PostgreSQL 18 데이터 볼륨은 `/var/lib/postgresql`에 연결한다.

처음 실행할 때는 `.env.example`을 `.env`로 복사한다. 기존 로컬 DB 볼륨을 업그레이드할 때는 아래 명령으로 이 버전에서 추가한 서비스 로그인을 만든다. 기존 `.env`에는 사용할 서비스의 접속 주소와 `DATABASE_*_ROLE` 항목만 예제에서 추가한다. 정산 차이를 승인하는 두 운영자는 `DATABASE_SETTLEMENT_CASE_ROLES`에 각각 등록한다.

```bash
docker compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U aqua -d aqua < docker/postgres-init.sql
```

```bash
test -f .env || cp .env.example .env
npm run db:migrate
npm run server:dev
```

API의 개발 DB 주소는 `postgresql://aqua_app:aqua_app_local_only@127.0.0.1:54329/aqua`, 기본 스키마는 `aqua`다. `.env.example`은 마이그레이션·테스트에 소유자 연결을 지정하고 `DATABASE_RUNTIME_ROLE=aqua_app`으로 애플리케이션 권한을 부여한다. 마이그레이션을 먼저 적용한 뒤 API를 실행한다. API 기본 주소는 `http://127.0.0.1:3001`이다. 별도 터미널에서 연결 화면을 연다.

```bash
cd /workspace/aquacard
npm run dev:server
```

`http://127.0.0.1:5173`에 접속한다. Vite는 `/api`를 로컬 API로 전달한다. 세션 쿠키를 일관되게 쓰도록 `localhost`와 `127.0.0.1`을 번갈아 사용하지 않는다. 기존 `npm run dev`는 브라우저 데모를 실행한다.

## 두 계정으로 송금 확인

1. 첫 테스트 계정을 만든다. 실제 개인정보 대신 `alice@example.test`와 테스트용 이름·태그를 쓴다. 시작 잔액 0원을 확인한다.
2. 로그아웃하거나 다른 브라우저 프로필에서 두 번째 계정 `bob@example.test`를 만든다. 수신자 태그를 확인한다.
3. 저장소 루트에서 첫 계정에 테스트 금액을 넣는다.

```bash
npm run server:credit -- alice@example.test 100000 local-alice-credit-001
```

4. 두 계정은 기본 `unverified` 상태다. 각 계정의 `GET /api/account`에서 `user.id`와 `access.version`을 확인한 뒤, 테스트 운영자가 `server:customer:access -- set USER_ID active VERSION REQUEST_KEY 'Disposable sandbox account approved for testing'`으로 각각 명시적으로 허용한다. [고객 거래 자격·로그인 기기 관리](customer-access-security.md)에 권한과 명령을 정리했다. 실제 본인확인이 완료된 것은 아니다.
5. 011 이후에는 두 계정의 이메일 확인도 필요하다. [이메일 확인·발송 설정](email-verification-delivery.md)에 따라 별도 작업자를 실행하고, 개발용 비공개 메일함의 확인 코드를 각 계정에 입력한다. 테스트 고객 승인만으로 확인을 대신하지 않는다.
6. 첫 계정으로 로그인해 두 번째 계정을 태그로 찾고 10,000원을 보낸다. 양쪽 잔액 90,000원·10,000원과 거래 내역을 확인한다.
7. 같은 적립 명령을 다시 실행해도 추가 적립되지 않는지 확인한다. API를 재시작한 뒤 계정·잔액·같은 요청의 결과가 유지되는지도 확인한다.

`server:credit`는 개발자용 CLI다. HTTP 충전 API가 아니며 `NODE_ENV=production`에서는 거절한다. 대상 계정은 먼저 가입해야 하고 API·CLI는 같은 `DATABASE_URL`과 `DATABASE_SCHEMA`를 사용해야 한다. 새 적립에는 새 키를 쓰며 기존 키를 다른 대상·금액에 재사용하지 않는다.

## 카드 승인과 매입 확인

009 이후 새 카드 승인에는 고객 상태 `active`도 필요하고, 011 이후에는 이메일 확인을 함께 요구한다. 기존 계정도 자동 승인하거나 이메일을 확인한 것으로 표시하지 않는다. 기존 승인 건의 매입·취소·환불과 원래 요청의 재조회는 고객 상태가 제한돼도 유지된다.

`npm run server:card -- <event.json>`으로 테스트 승인·부분 매입·승인 취소·부분 환불을 처리한다. 기존 DB에도 `db:migrate`를 먼저 적용한다. 새 승인 전에는 `npm run server:issuer -- register USER_ID sandbox-card-local active`로 회원의 테스트 카드를 연결한다. [카드 결제 서버 처리](card-payment-server.md)의 JSON 예시를 따라 승인액 확보와 마지막 매입의 잔여액 해제, 중복 환불 방지를 확인할 수 있다. [카드 승인 정책](card-authorization-policy.md)은 잠금 이후 새 승인을 차단하고 거절 재전송을 보존한다.

화면의 사용 가능 잔액은 승인 보류액을 제외한다. 보류액과 전체 잔액, 본인의 카드 결제 내역은 같은 계정 조회 응답으로 갱신된다. 카드 명령은 개발자 전용이며 일반 회원용 쓰기 API는 없다. `NODE_ENV=production`에서는 명령을 거절한다. 실제 카드사 이벤트와 리저브는 연결하지 않았다.

리워드 우선 사용과 스탠다드 페이백은 별도 서버 장부로 처리한다. 마이그레이션 후 기본 비활성이며 회사 테스트 재원을 명시적으로 넣어야 신규 지급을 활성화할 수 있다. [리워드 서버 처리](rewards-server.md)에 정책, 운영자 명령, 환불 회수와 내부 대사 절차를 정리했다.

이벤트를 먼저 접수하고 별도 작업자로 처리하려면 [카드 수신·재처리](card-event-inbox.md)를 따른다. `server:inbox enqueue`는 원장을 즉시 바꾸지 않는다. 서명한 sandbox HTTP와 별도 작업자 프로세스로 재시도·중복·중단 복구를 확인할 수 있으며, 실제 발급사의 실시간 승인 경로와 구분한다.

## DB 변경과 설정

승인·거절 원인을 확인할 때는 [카드 거래 운영 조회](card-operations.md)를 사용한다. `server:card:ops`는 전용 `OPERATIONS_DATABASE_URL`로 조회 기록을 남긴 뒤 결과를 읽는다. 기존 관리자 계정을 운영 조회용으로 넘기지 않는다.

`npm run db:migrate`는 `server/migrations/`의 번호가 붙은 SQL을 적용한다. 체크섬으로 적용된 파일의 변경을 감지하고 PostgreSQL advisory lock으로 동시 실행을 조정한다. 적용한 SQL을 수정하지 말고 다음 번호의 마이그레이션을 추가한다. 애플리케이션 시작이 테이블을 자동 생성·변경하는 경로에 의존하지 않는다.

| 설정 | 역할 |
| --- | --- |
| `DATABASE_URL` | API·CLI의 PostgreSQL 접속 주소. 개발에서는 위 Compose 주소를 사용한다. |
| `DATABASE_SCHEMA` | 기본 `aqua`. API·CLI·마이그레이션이 같은 값을 사용한다. |
| `DATABASE_POOL_SIZE` | 연결 풀 크기. 기본 10개이며 1~100 범위다. |
| `DATABASE_CA_FILE` | DB 제공자의 CA가 필요할 때 신뢰할 PEM 파일 경로를 지정한다. 인증서 검증은 유지한다. |
| `MIGRATION_DATABASE_URL` | 별도 마이그레이션 연결을 사용할 때 지정한다. 없으면 `DATABASE_URL`을 사용한다. |
| `DATABASE_RUNTIME_ROLE` | 마이그레이션에서 권한을 부여할 기존 애플리케이션 역할. 로컬 기본값은 `aqua_app`이다. 역할·운영 비밀번호를 자동으로 만들지 않는다. |
| `DATABASE_WORKER_ROLE` | inbox 처리 전용 역할. 로컬 `aqua_worker`. API 역할과 달라야 한다. |
| `DATABASE_DISPATCHER_ROLE` | 발급사 명령 발신 전용 역할. 로컬 `aqua_dispatcher`. 다른 런타임 역할과 달라야 한다. |
| `DATABASE_INGRESS_ROLE` | 이벤트 접수 전용 역할. 로컬 `aqua_ingress`. 웹 API·작업자 역할과 달라야 한다. |
| `INGRESS_DATABASE_URL` | 수신 서버·접수 CLI 전용 연결. 웹 API의 DB 연결로 대체하지 않는다. |
| `WORKER_DATABASE_URL` | 별도 카드 작업자 연결. 처리·집계 함수 실행만 허용하며 API 관리자 연결을 대신 넣지 않는다. |
| `DISPATCHER_DATABASE_URL` | 발신 명령 확보·결과 기록·집계 함수만 실행하는 별도 연결. 회원·명령 생성·장부 변경 권한을 주지 않는다. |
| `DATABASE_OPERATIONS_ROLE` | 카드 거래 운영 조회 전용 역할. 다른 런타임 역할과 분리한다. 로컬 `aqua_operations`. |
| `OPERATIONS_DATABASE_URL` | 조회 기록 준비·결과 확인 함수만 실행하는 별도 연결. API·관리자 주소로 대체하지 않는다. |
| `DATABASE_SETTLEMENT_ROLE`, `SETTLEMENT_DATABASE_URL` | 마감된 하루의 매입·환불 전표를 읽는 정산 전용 역할과 접속 주소. 로컬 기본 역할은 `aqua_settlement`다. |
| `DATABASE_MONITOR_ROLE`, `MONITOR_DATABASE_URL` | 원장 불일치 건수와 대기열 집계만 읽는 계정. 로컬 기본값은 `aqua_monitor`다. |
| `AQUA_MONITOR_ENVIRONMENT` | 점검 명령과 상시 작업자가 CloudWatch 지표에 기록하는 환경 이름. [.env.example](../.env.example)의 로컬 예시는 `local`이다. |
| `DATABASE_AUTH_MAIL_ROLE`, `AUTH_MAIL_DATABASE_URL` | 별도 메일 발송 역할과 연결. 로컬 역할은 `aqua_auth_mail`이며 API·카드 작업자·관리자와 분리한다. |
| `AQUA_ISSUER_SANDBOX_URL`, `AQUA_ISSUER_KEY_ID`, `AQUA_ISSUER_SIGNING_KEY` | 로컬 sandbox 발신 URL과 명시적인 서명 키. [발급사 요청·복구](issuer-command-outbox.md)의 제한과 실행 방법을 따른다. |
| `TEST_DATABASE_URL` | 서버 통합 테스트용 PostgreSQL 주소. 테스트는 고유 스키마를 만들고 자신이 만든 스키마만 정리한다. |
| `AQUA_AUTH_MAIL_KEYS`, `AQUA_AUTH_MAIL_ACTIVE_KEY` | API·메일 작업자가 공유하는 발송 암호화 키링과 활성 키 ID. [이메일 확인·복구 안내 발송](email-verification-delivery.md)의 설정을 따른다. |
| `AQUA_AUTH_MAIL_TRANSPORT`, `AQUA_MAIL_DIR` | `file` 또는 `ses`를 명시한다. 개발용 파일 메일함 기본 경로는 `data/mail`이며 production에서는 파일 전송을 거부한다. |
| `AQUA_HOST`, `AQUA_PORT` | 기본 `127.0.0.1`, `3001`. API 수신 주소와 포트. |
| `AQUA_ALLOWED_ORIGINS` | 쉼표로 구분한 정확한 origin 목록. 개발 기본값은 `http://localhost:5173,http://127.0.0.1:5173`이다. 경로나 끝의 `/`를 붙이지 않는다. |
| `AQUA_TRUSTED_PROXIES` | 신뢰하는 프록시 IP·CIDR만 쉼표로 지정한다. 기본은 전달 헤더를 신뢰하지 않는다. |
| `AQUA_STATIC_DIR` | API에서 연결 웹 화면도 제공할 때 출력 `dist/`를 지정한다. 저장소 루트나 데이터 디렉터리를 지정하지 않는다. |
| `VITE_DATA_MODE` | `server`이면 서버 연결 화면을 빌드·실행한다. `dev:server`와 `build:connected`가 지정한다. |
| `NODE_ENV` | `production`이면 명시적인 HTTPS origin과 운영 DB TLS가 필요하고 쿠키는 `Secure`다. 개발 적립·카드 테스트 명령과 파일 메일함은 비활성화한다. |

원격·운영 PostgreSQL은 인증서를 검증하는 TLS를 사용한다. URL에 `sslmode=verify-full`을 지정할 수 있으며 제공자 CA가 필요하면 `DATABASE_CA_FILE`을 사용한다. 검증을 끄는 설정으로 연결 오류를 우회하지 않는다. DB 접속 정보·메일 파일은 Git이나 프런트엔드 환경 변수에 넣지 않는다. PostgreSQL 볼륨은 컨테이너를 재생성해도 유지된다. 개발을 멈출 때는 `docker compose stop postgres`를 사용한다.

운영 API는 DB 관리자나 스키마 소유자 역할로 실행하지 않는다. 런타임이 스키마를 만들거나 원장 이력을 수정·삭제·비우고 잔액을 직접 바꿀 수 있으면 시작을 거절한다. 마이그레이션은 소유자 역할로, API는 제한된 애플리케이션 역할로 실행한다.

Compose의 역할 초기화 SQL은 **빈 볼륨의 첫 실행에만** 자동 적용된다. 기존 개발 볼륨에 API 또는 작업자 역할이 없다면 다음 명령으로 로컬 bootstrap을 한 번 적용한 뒤 `db:migrate`를 실행한다. 기존 역할의 비밀번호는 덮어쓰지 않는다.

```bash
docker compose exec -T postgres psql -U aqua -d aqua -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/010_aqua_app.sql
npm run db:migrate
```

이 bootstrap은 로컬·CI 전용이다. 운영 역할과 자격 증명은 별도 배포 절차에서 준비한다.

## 비밀번호 재설정

API는 복구 토큰과 암호화된 발송 대기열을 함께 저장한다. 키링과 별도 메일 역할을 설정하고 `npm run server:mail:worker`를 실행해야 발송을 처리한다. 개발 환경에서 `AQUA_AUTH_MAIL_TRANSPORT=file`을 선택하면 `AQUA_MAIL_DIR`에 안내 파일이 생긴다. 디렉터리는 `0700`, 파일은 `0600` 권한을 사용하며 실제 메일 발송이 아니다. 파일의 코드를 재설정 화면에 입력한다. 토큰은 15분 동안 한 번만 쓸 수 있고 비밀번호 변경은 기존 세션과 대기 중인 이메일 확인 코드를 폐기한다.

토큰·비밀번호·쿠키를 로그·문서·스크린샷·Git에 남기지 않는다. 발송 큐 설정이 없으면 새 복구 요청은 `503`을 반환한다. 이미 받은 유효한 코드로 비밀번호를 변경하는 기능은 메일 설정이 없어도 작동한다. 실제 SES 설정, 키 교체와 장애 시 처리 범위는 [이메일 확인·복구 안내 발송](email-verification-delivery.md)을 따른다.

## API 범위

Fastify JSON Schema로 HTTP 경계를 정의하고 OpenAPI를 생성한다. 인증은 `HttpOnly`, `SameSite=Strict` 세션 쿠키로 처리한다. 상태 변경은 JSON 요청이며 클라이언트에서 임의의 장부·잔액을 보낼 수 없다.

| 메서드·경로 | 역할 |
| --- | --- |
| `GET /api/live` | 프로세스가 HTTP에 응답하면 200. 컨테이너 생존 검사에 사용한다. |
| `GET /api/health` | 트래픽 수신 준비 확인. 쓰기 가능한 기본 DB에 연결되고 배포 이력과 주요 원장 권한이 확인되면 200과 `{"status":"ok","mode":"sandbox"}`를 반환한다. 조회 실패·시간 초과는 503이다. |
| `GET /api/openapi.json` | 개발 모드의 OpenAPI 문서. 운영 모드에서는 기본으로 노출하지 않는다. |
| `GET /api/session` | 현재 세션 확인. |
| `POST /api/auth/signup` | 테스트 계정 생성. 시작 잔액 0원. |
| `POST /api/auth/login` | 로그인·세션 쿠키 발급. |
| `POST /api/auth/logout` | 세션 폐기. 유효한 세션에는 `X-Aqua-Account` 헤더가 필요하다. |
| `POST /api/auth/recovery/request` | 재설정 요청. |
| `POST /api/auth/recovery/confirm` | 토큰 확인·비밀번호 변경. |
| `GET /api/auth/email` | 현재 계정의 이메일 확인 상태·안내 요청 가능 여부. 계정 헤더가 필요하다. |
| `POST /api/auth/email/request` | 로그인한 계정의 이메일 확인 안내를 암호화된 발송 큐에 저장. |
| `POST /api/auth/email/confirm` | 해당 회원·이메일에 발급한 코드로 확인. 세션과 계정 헤더를 다시 검사한다. |
| `GET /api/account` | 사용 가능·카드 보류·전체 잔액, 송금·카드 결제 내역을 함께 조회. |
| `GET /api/members?tag=...` | 가입된 태그로 수신자 조회. |
| `POST /api/transfers` | 회원 송금. `Idempotency-Key`, `X-Aqua-Account` 헤더가 필요하다. |
| `POST /api/rewards/preference` | 리워드 우선 사용 설정. 요청 키·계정 헤더와 `expectedVersion`으로 중복·오래된 변경을 방지한다. |

송금 JSON 필드는 `recipientTag`와 최소 1,000원의 정수 `amountWon`이다. 보내는 계정과 권한은 서버 세션으로 결정한다. `X-Aqua-Account`는 화면·저장된 요청의 소유 계정이 세션과 같은지 확인하는 전제 조건이다. 다른 탭에서 계정이 바뀌면 일치하지 않는 송금·로그아웃은 `409 SESSION_CHANGED`로 거절한다.

결과가 불확실한 송금은 원래 계정에서 같은 요청 키·내용으로 다시 확인한다. DB 트랜잭션과 계정 잠금으로 검증·차감·입금·기록을 함께 처리하며 같은 요청은 거래를 다시 만들지 않는다.

`balanceWon`은 사용 가능 원금을 유지한다. `heldBalanceWon`은 카드에 확보한 원금이며 `totalBalanceWon`은 두 값의 합이다. 카드 전용 리워드는 `rewards`에 별도로 포함한다. `cardPayments`에는 현재 세션 회원의 결제와 원금·리워드 구성을 제공한다. 카드 승인·매입·환불이나 리워드 지급·회사 재원 변경을 직접 수행하는 HTTP API와 공급업체 웹훅 엔드포인트는 제공하지 않는다.

## PostgreSQL 백업 복원 훈련

Node.js 24, 프로젝트 의존성, 로컬 Docker와 Compose v2가 있는 환경에서 실행한다.

```bash
npm run test:recovery
```

이 명령은 임시 PostgreSQL 18 클러스터에 테스트 거래를 만들고 `pg_dump`로 전체 DB의 논리 백업을 생성한다. 원본 컨테이너를 제거한 다음, 새 클러스터에 DB 로그인 역할을 준비하고 빈 DB에 `pg_restore --single-transaction --exit-on-error`로 복원한다. 덤프에 포함된 스키마, 데이터, 소유권과 권한을 그대로 사용하며 복원된 마이그레이션 기록을 현재 릴리스와 대조한다. 두 클러스터는 각각 루프백 임시 포트와 별도 저장 공간을 쓴다. 기존 개발 DB의 접속 정보나 볼륨은 사용하지 않는다.

| 확인 시점 | 기대 결과 (TEST_KRW) |
| --- | --- |
| 백업 직전과 복원 직후 | 100원 매입 후 30원 환불한 결제의 순액은 70원이다. 별도 승인 75원은 원금 63원과 리워드 12원으로 보류돼 있다. |
| 복원 후 기존 충전·승인·매입·환불 재전송 | 중복 차감이나 지급 없이 원장, 이벤트 수와 고객 잔액이 동일하다. |
| 보류 거래의 후속 매입 | 75원 중 50원을 매입하고 25원을 해제한다. 보류액이 0원이 되고 전체 테스트 정산 잔액은 120원이다. |

각 단계에서 내부 대사를 실행한다. 복원 직후에는 마이그레이션 체크섬과 앱·수신·작업자·발신·운영 조회·집계·메일 발송 역할의 권한도 검사한다. 이상이 있으면 명령이 실패한다. 복원된 DB에서 TLS를 켜고 운영 모드 점검을 실행한다. 신뢰한 CA와 올바른 호스트 이름으로만 원장 검사를 통과해야 하며, 다른 인증서나 호스트 이름을 주면 점검 실패를 보고해야 한다. 임시 DB, 인증서와 백업 파일은 실행이 끝날 때 정리한다.

`npm run test:pitr`는 별도의 임시 PostgreSQL 18에서 물리 백업과 WAL(트랜잭션 로그)을 사용한다. 백업 뒤에 매입 80원과 환불 30원을 커밋하고 원본 DB 시각을 기록한 다음 추가 환불과 승인을 커밋한다. 새 클러스터에서 지정한 시점의 정산액 50원, 이후 두 건의 부재, 같은 요청의 재전송, 새 5원 환불 후 정산액 45원을 확인한다. 실행 결과에는 복원 컨테이너 시작부터 쓰기 가능한 DB와 거래 재개를 각각 검증하기까지의 시간이 표시된다.

서울 RDS의 복구 가능 구간과 소요 시간, 비밀·인증서 사용, 실제 당직자의 경보 수신은 스테이징에서 확인한다. [서울 스테이징 훈련 절차](staging-recovery.md)

## 빌드와 검증

2026-11-26 이메일 확인·발송 큐 추가 후 서버 테스트 302개, 제품 로직 139개, 연결 브라우저 62개가 통과했다. API·메일 워커의 별도 DB 역할, 키 교체 중 재시도, 복구 중단·응답 유실과 기존 결제 흐름을 검사한다. 이메일 브라우저 검사는 `npm run test:email:browser`로 실행하며 실제 외부 메일 발송을 대신하지 않는다.

로컬 PostgreSQL을 실행하고 테스트 접속 주소를 지정한다. 테스트용 스키마를 생성할 수 있는 개발 DB를 사용한다.

```bash
export TEST_DATABASE_URL=postgresql://aqua:aqua_local_only@127.0.0.1:54329/aqua
npm run typecheck:server
npm run test:server
npm test
npm run build
npm run build:connected
npm run build:server
```

`typecheck:server`는 타입 검사다. `build:server`는 타입 검사 후 서버·마이그레이션 실행기·CLI를 `dist-server/` JS로 컴파일하고 SQL을 포함한다. `server:start`는 개발용 TypeScript 실행 경로이며 `server:prod`는 컴파일한 서버를 실행한다. 운영 보안 설정은 `NODE_ENV=production`과 배포 환경에서 적용한다.

`build:connected`는 연결 화면을 `dist/`에 만든다. 일반 `build`·`build:pages`는 공개 브라우저 데모를 만든다. API에서 정적 화면을 제공할 때는 연결 빌드와 화면의 허용 origin을 함께 지정한다.

API와 `dev:server`를 실행한 뒤 브라우저 검사를 수행한다.

```bash
AQUA_BASE_URL=http://127.0.0.1:5173 npm run test:server:browser
AQUA_BASE_URL=http://127.0.0.1:5173 npm run test:card:browser
AQUA_BASE_URL=http://127.0.0.1:5173 npm run test:rewards:browser
npm run server:reconcile
```

브라우저 실행 파일은 `CHROMIUM_PATH`로 지정한다. 각 검사는 고유 계정과 CLI 적립을 사용하고 카드 검사는 실제 카드 테스트 CLI도 실행한다. 기존 데이터를 지우지 않으며 생성한 계정·내역은 개발 DB에 남는다. API·CLI·검사는 같은 DB·스키마를 사용해야 한다. 짧은 시간에 반복하면 가입 제한이 적용되므로 별도 개발 스키마로 API를 실행한다.

[서버 CI](../.github/workflows/server-check.yml)는 PostgreSQL 18 서비스와 분리된 테스트 스키마를 사용한다. 타입·서버 통합 테스트·기존 로직·웹 빌드·서버 번들·Docker 이미지·연결 브라우저의 송금·카드·리워드 흐름과 내부 대사를 검사한다. 서명 수신·순서 보존·재시도와 제한된 작업자 프로세스도 검사하며 컴파일한 작업자를 읽기 전용 컨테이너에서 실행한다. 실제 iOS·Android 기기 테스트나 서버 배포를 수행하지 않는다.

`npm run test:issuer:browser`는 컴파일한 서버·연결 웹 빌드가 필요하며, 별도 무작위 스키마와 기본 포트 3006에서 카드 설정을 검사한다. 실행·정리까지 자동으로 수행해 기존 검사의 가입 제한과 개발 데이터를 공유하지 않는다. [카드 설정 화면](card-controls-ui.md)에 응답 유실·저장소 오류·계정 전환과 모바일 너비 검사 절차를 정리했다. 카드 조회에도 세션과 일치하는 `X-Aqua-Account`가 필요하다.

발신 outbox의 임대·기한·조회 복구, 카드 상태 API, 역할 전환 차단과 운영자 명령도 CI에 포함한다. 컴파일한 발신 작업자는 비밀값을 남기지 않는 임시 키로 빈 큐를 읽기 전용 컨테이너에서 확인하며, 실제 HTTP 전송은 격리된 통합 검사에서 검증한다. 2026-11-19 추가 검증 후 서버 검사 수는 186개, 제품 로직은 127개다. [발급사 요청·복구](issuer-command-outbox.md)에 상세 범위를 정리했다.

2026-11-19 카드 수신·재처리 검증에서는 서버 테스트 139개와 제품·클라이언트 로직 127개가 통과했다. 컴파일한 작업자 실행과 회사 재원·리워드·원금의 내부 대사도 확인했다. 상세 범위는 [카드 수신·재처리](card-event-inbox.md)를 따른다. 같은 날 앞선 리워드 연결 검증에서는 서버 연결 브라우저 검사 28개도 통과했으며 CI에서 계속 실행한다.

2026-11-16 검증 결과: 실제 PostgreSQL 서버 테스트 48개, 제품·클라이언트 로직 테스트 123개, 연결 브라우저 검사 12개를 통과했다. 컨테이너의 첫 화면 경로 수정 후 PostgreSQL HTTP 테스트 11개도 다시 통과했다. 최종 이미지는 운영 모드에서 인증서를 검증하는 DB TLS와 제한된 DB 역할로 시작했고, UID 1000·읽기 전용 파일시스템에서 API, 첫 화면 GET·HEAD, SPA 경로와 JS·CSS 제공을 확인했다. CI에서도 컴파일한 컨테이너의 첫 화면과 자산을 검사한다.

## 운영 이미지와 배포 대상

```bash
docker build --tag aqua-card-server:local .
```

Dockerfile은 확인한 Node 24 digest와 lockfile을 사용한다. 빌드 단계에서 웹·서버를 컴파일하고 런타임에는 운영 의존성·`dist-server/`·`dist/`만 둔다. `node` 사용자로 실행하며 실제 `.env`·테스트 DB·메일함은 빌드 컨텍스트에서 제외한다.

신뢰하는 개발 환경 프록시의 CA가 필요한 경우에만 BuildKit `npm_ca` secret을 전달한다. 설치 단계의 `NODE_EXTRA_CA_CERTS`로 인증서 검증을 유지하며 CA 파일이나 해당 환경 변수를 최종 이미지에 저장하지 않는다. 일반 CI에서는 이 옵션 없이 빌드한다.

```bash
docker build --secret id=npm_ca,src=/path/to/trusted-proxy-ca.pem --tag aqua-card-server:local .
```

이 클라우드 환경에서 Buildx가 읽기 전용 홈 디렉터리에 메타데이터를 쓰지 못하면 `BUILDX_CONFIG=/tmp/aqua-buildx`를 명령 앞에 지정한다. 홈 디렉터리나 Docker 인증 설정을 바꾸지 않는다.

배포 전에 같은 이미지에서 `node dist-server/migrate.js` 또는 `npm run db:migrate:prod`를 별도 작업으로 실행한 뒤 API를 시작한다. 마이그레이션·런타임 연결을 구분할 수 있고 두 작업 모두 대상 DB·스키마와 TLS 신뢰를 명시해야 한다.

로드 밸런서의 대상 그룹은 `/api/health`를 사용한다. 프로세스 생존 검사에는 이미지 기본값인 `/api/live`를 사용한다. 준비 검사는 연결 풀 대기를 포함해 2초 안에 응답하고 같은 프로세스의 동시 조회는 한 번으로 묶는다. 발급사·수탁사와의 통신 상태는 이 검사 범위 밖이다. AWS 대상 그룹의 모든 대상이 비정상이면 ALB가 다시 트래픽을 보낼 수 있으므로 전체 중단이 필요한 배포에서는 리스너의 유지보수 응답을 별도로 설정한다.

새 프로세스는 DB의 전체 마이그레이션 목록·체크섬이 이미지와 일치해야 시작한다. 실행 중인 프로세스는 자신이 검증한 이력이 유지되고 새 버전이 뒤에 추가된 경우 계속 요청을 받는다. 롤링 배포에서는 기존 코드와 호환되는 SQL·권한을 먼저 적용하고 새 이미지의 준비 응답을 확인한 다음 이전 작업을 종료한다. 준비 검사는 SQL 변경의 호환성을 판정할 수 없다. 열·함수·권한 제거는 기존 API와 작업자 소비가 모두 끝난 뒤 별도 배포에서 적용한다. 기존 코드와 호환되지 않는 변경이 필요하면 먼저 트래픽과 쓰기를 멈추는 배포 절차를 스테이징에서 연습한다.

이미 새 SQL이 적용된 DB에서는 이전 이미지를 다시 시작할 수 없다. 되돌릴 수 있는 변경은 현재 마이그레이션 이력과 호환되는 이미지로 배포한다. SIGTERM을 받은 HTTP 서버는 진행 중인 요청을 마친 뒤 DB 풀을 닫으며 최대 대기 시간은 20초다.

운영 이미지는 `NODE_ENV=production`이 기본이며 HTTPS origin과 검증 가능한 운영 DB 연결 없이 실행하지 않는다. 읽기 전용 루트 파일시스템에서 실행할 수 있도록 로컬 DB·개발 메일함에 의존하지 않는다. TLS 종료와 비밀값 주입은 배포 환경에서 구성한다.

배포 대상은 AWS 서울 리전 ECS Fargate·RDS PostgreSQL로 정했다. S3·KMS를 포함한 세부 운영 구성은 후속 작업이다. AWS 리소스나 유료 인프라를 생성하지 않았으며 서버가 공개 배포됐다고 가정하지 않는다. 실제 카드 발급·발급사 수신·발신 연결·KYC·실제 입출금·파트너·메일·외부 정산 대사·운영 RDS 복구와 관측도 후속 범위다. 로컬 sandbox outbox와 내부 장부 대사는 실제 외부 자금 확인을 대신하지 않는다.
