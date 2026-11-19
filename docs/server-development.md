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

처음 한 번 `.env.example`을 `.env`로 복사한다. 기존 `.env`는 덮어쓰지 않는다.

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

4. 첫 계정으로 로그인해 두 번째 계정을 태그로 찾고 10,000원을 보낸다. 양쪽 잔액 90,000원·10,000원과 거래 내역을 확인한다.
5. 같은 적립 명령을 다시 실행해도 추가 적립되지 않는지 확인한다. API를 재시작한 뒤 계정·잔액·같은 요청의 결과가 유지되는지도 확인한다.

`server:credit`는 개발자용 CLI다. HTTP 충전 API가 아니며 `NODE_ENV=production`에서는 거절한다. 대상 계정은 먼저 가입해야 하고 API·CLI는 같은 `DATABASE_URL`과 `DATABASE_SCHEMA`를 사용해야 한다. 새 적립에는 새 키를 쓰며 기존 키를 다른 대상·금액에 재사용하지 않는다.

## 카드 승인과 매입 확인

`npm run server:card -- <event.json>`으로 테스트 승인·부분 매입·승인 취소·부분 환불을 처리한다. 기존 DB에도 `db:migrate`를 먼저 적용한다. [카드 결제 서버 처리](card-payment-server.md)의 JSON 예시를 따라 승인액 확보와 마지막 매입의 잔여액 해제, 중복 환불 방지를 확인할 수 있다.

화면의 사용 가능 잔액은 승인 보류액을 제외한다. 보류액과 전체 잔액, 본인의 카드 결제 내역은 같은 계정 조회 응답으로 갱신된다. 카드 명령은 개발자 전용이며 일반 회원용 쓰기 API는 없다. `NODE_ENV=production`에서는 명령을 거절한다. 실제 카드사 이벤트와 리저브는 연결하지 않았다.

리워드 우선 사용과 스탠다드 페이백은 별도 서버 장부로 처리한다. 마이그레이션 후 기본 비활성이며 회사 테스트 재원을 명시적으로 넣어야 신규 지급을 활성화할 수 있다. [리워드 서버 처리](rewards-server.md)에 정책, 운영자 명령, 환불 회수와 내부 대사 절차를 정리했다.

## DB 변경과 설정

`npm run db:migrate`는 `server/migrations/`의 번호가 붙은 SQL을 적용한다. 체크섬으로 적용된 파일의 변경을 감지하고 PostgreSQL advisory lock으로 동시 실행을 조정한다. 적용한 SQL을 수정하지 말고 다음 번호의 마이그레이션을 추가한다. 애플리케이션 시작이 테이블을 자동 생성·변경하는 경로에 의존하지 않는다.

| 설정 | 역할 |
| --- | --- |
| `DATABASE_URL` | API·CLI의 PostgreSQL 접속 주소. 개발에서는 위 Compose 주소를 사용한다. |
| `DATABASE_SCHEMA` | 기본 `aqua`. API·CLI·마이그레이션이 같은 값을 사용한다. |
| `DATABASE_POOL_SIZE` | 연결 풀 크기. 기본 10개이며 1~100 범위다. |
| `DATABASE_CA_FILE` | DB 제공자의 CA가 필요할 때 신뢰할 PEM 파일 경로를 지정한다. 인증서 검증은 유지한다. |
| `MIGRATION_DATABASE_URL` | 별도 마이그레이션 연결을 사용할 때 지정한다. 없으면 `DATABASE_URL`을 사용한다. |
| `DATABASE_RUNTIME_ROLE` | 마이그레이션에서 권한을 부여할 기존 애플리케이션 역할. 로컬 기본값은 `aqua_app`이다. 역할·운영 비밀번호를 자동으로 만들지 않는다. |
| `TEST_DATABASE_URL` | 서버 통합 테스트용 PostgreSQL 주소. 테스트는 고유 스키마를 만들고 자신이 만든 스키마만 정리한다. |
| `AQUA_MAIL_DIR` | 기본 `data/mail`. 개발용 비밀번호 재설정 안내 파일 위치. |
| `AQUA_HOST`, `AQUA_PORT` | 기본 `127.0.0.1`, `3001`. API 수신 주소와 포트. |
| `AQUA_ALLOWED_ORIGINS` | 쉼표로 구분한 정확한 origin 목록. 개발 기본값은 `http://localhost:5173,http://127.0.0.1:5173`이다. 경로나 끝의 `/`를 붙이지 않는다. |
| `AQUA_TRUSTED_PROXIES` | 신뢰하는 프록시 IP·CIDR만 쉼표로 지정한다. 기본은 전달 헤더를 신뢰하지 않는다. |
| `AQUA_STATIC_DIR` | API에서 연결 웹 화면도 제공할 때 출력 `dist/`를 지정한다. 저장소 루트나 데이터 디렉터리를 지정하지 않는다. |
| `VITE_DATA_MODE` | `server`이면 서버 연결 화면을 빌드·실행한다. `dev:server`와 `build:connected`가 지정한다. |
| `NODE_ENV` | `production`이면 명시적인 HTTPS origin과 운영 DB TLS가 필요하고 쿠키는 `Secure`다. 개발 적립·카드 테스트 명령과 파일 메일함은 비활성화한다. |

원격·운영 PostgreSQL은 인증서를 검증하는 TLS를 사용한다. URL에 `sslmode=verify-full`을 지정할 수 있으며 제공자 CA가 필요하면 `DATABASE_CA_FILE`을 사용한다. 검증을 끄는 설정으로 연결 오류를 우회하지 않는다. DB 접속 정보·메일 파일은 Git이나 프런트엔드 환경 변수에 넣지 않는다. PostgreSQL 볼륨은 컨테이너를 재생성해도 유지된다. 개발을 멈출 때는 `docker compose stop postgres`를 사용한다.

운영 API는 DB 관리자나 스키마 소유자 역할로 실행하지 않는다. 런타임이 스키마를 만들거나 원장 이력을 수정·삭제·비우고 잔액을 직접 바꿀 수 있으면 시작을 거절한다. 마이그레이션은 소유자 역할로, API는 제한된 애플리케이션 역할로 실행한다.

Compose의 역할 초기화 SQL은 **빈 볼륨의 첫 실행에만** 자동 적용된다. 기존 개발 볼륨에 역할이 없다면 다음 명령으로 로컬 bootstrap을 한 번 적용한 뒤 `db:migrate`를 실행한다. 기존 역할의 비밀번호는 덮어쓰지 않는다.

```bash
docker compose exec -T postgres psql -U aqua -d aqua -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/010_aqua_app.sql
npm run db:migrate
```

이 bootstrap은 로컬·CI 전용이다. 운영 역할과 자격 증명은 별도 배포 절차에서 준비한다.

## 비밀번호 재설정

개발 모드에서 요청하면 `AQUA_MAIL_DIR`에 안내 파일이 생긴다. 새 디렉터리는 `0700`, 새 파일은 `0600` 권한으로 만든다. 실제 메일 발송이 아니며 파일의 토큰을 재설정 화면의 복구 코드로 사용한다. 토큰은 15분 동안 한 번만 쓸 수 있다. 비밀번호 변경은 기존 세션을 폐기한다.

토큰·비밀번호·쿠키를 로그·문서·스크린샷·Git에 남기지 않는다. 운영 모드에서는 메일 발송 어댑터가 연결되기 전까지 재설정 API가 `503`을 반환한다.

## API 범위

Fastify JSON Schema로 HTTP 경계를 정의하고 OpenAPI를 생성한다. 인증은 `HttpOnly`, `SameSite=Strict` 세션 쿠키로 처리한다. 상태 변경은 JSON 요청이며 클라이언트에서 임의의 장부·잔액을 보낼 수 없다.

| 메서드·경로 | 역할 |
| --- | --- |
| `GET /api/health` | 준비 확인. `status: ok`, `mode: sandbox`. |
| `GET /api/openapi.json` | 개발 모드의 OpenAPI 문서. 운영 모드에서는 기본으로 노출하지 않는다. |
| `GET /api/session` | 현재 세션 확인. |
| `POST /api/auth/signup` | 테스트 계정 생성. 시작 잔액 0원. |
| `POST /api/auth/login` | 로그인·세션 쿠키 발급. |
| `POST /api/auth/logout` | 세션 폐기. 유효한 세션에는 `X-Aqua-Account` 헤더가 필요하다. |
| `POST /api/auth/recovery/request` | 재설정 요청. |
| `POST /api/auth/recovery/confirm` | 토큰 확인·비밀번호 변경. |
| `GET /api/account` | 사용 가능·카드 보류·전체 잔액, 송금·카드 결제 내역을 함께 조회. |
| `GET /api/members?tag=...` | 가입된 태그로 수신자 조회. |
| `POST /api/transfers` | 회원 송금. `Idempotency-Key`, `X-Aqua-Account` 헤더가 필요하다. |
| `POST /api/rewards/preference` | 리워드 우선 사용 설정. 요청 키·계정 헤더와 `expectedVersion`으로 중복·오래된 변경을 방지한다. |

송금 JSON 필드는 `recipientTag`와 최소 1,000원의 정수 `amountWon`이다. 보내는 계정과 권한은 서버 세션으로 결정한다. `X-Aqua-Account`는 화면·저장된 요청의 소유 계정이 세션과 같은지 확인하는 전제 조건이다. 다른 탭에서 계정이 바뀌면 일치하지 않는 송금·로그아웃은 `409 SESSION_CHANGED`로 거절한다.

결과가 불확실한 송금은 원래 계정에서 같은 요청 키·내용으로 다시 확인한다. DB 트랜잭션과 계정 잠금으로 검증·차감·입금·기록을 함께 처리하며 같은 요청은 거래를 다시 만들지 않는다.

`balanceWon`은 사용 가능 원금을 유지한다. `heldBalanceWon`은 카드에 확보한 원금이며 `totalBalanceWon`은 두 값의 합이다. 카드 전용 리워드는 `rewards`에 별도로 포함한다. `cardPayments`에는 현재 세션 회원의 결제와 원금·리워드 구성을 제공한다. 카드 승인·매입·환불이나 리워드 지급·회사 재원 변경을 직접 수행하는 HTTP API와 공급업체 웹훅 엔드포인트는 제공하지 않는다.

## 빌드와 검증

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

[서버 CI](../.github/workflows/server-check.yml)는 PostgreSQL 18 서비스와 분리된 테스트 스키마를 사용한다. 타입·서버 통합 테스트·기존 로직·웹 빌드·서버 번들·Docker 이미지·연결 브라우저의 송금·카드·리워드 흐름과 내부 대사를 검사한다. 실제 iOS·Android 기기 테스트나 서버 배포를 수행하지 않는다.

2026-11-19 리워드 연결 검증에서는 서버 테스트 109개, 제품·클라이언트 로직 127개, 컴파일한 API와 연결 웹 화면의 브라우저 검사 28개가 통과했다. 회사 재원·리워드·원금의 내부 대사도 일치했다. 상세 범위는 [리워드 서버 처리](rewards-server.md)를 따른다.

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

운영 이미지는 `NODE_ENV=production`이 기본이며 HTTPS origin과 검증 가능한 운영 DB 연결 없이 실행하지 않는다. 읽기 전용 루트 파일시스템에서 실행할 수 있도록 로컬 DB·개발 메일함에 의존하지 않는다. TLS 종료와 비밀값 주입은 배포 환경에서 구성한다.

배포 대상은 AWS 서울 리전 ECS Fargate·RDS PostgreSQL로 정했다. S3·KMS를 포함한 세부 운영 구성은 후속 작업이다. AWS 리소스나 유료 인프라를 생성하지 않았으며 서버가 공개 배포됐다고 가정하지 않는다. 실제 카드 발급·발급사 이벤트 수신·KYC·실제 입출금·파트너·메일·outbox·외부 정산 대사·백업 복구와 관측도 후속 범위다. 내부 장부 대사는 실제 외부 자금 확인을 대신하지 않는다.
