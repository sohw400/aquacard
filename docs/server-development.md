# 서버 연결 개발

서버 연결 모드는 가입·로그인, 세션, 회원 조회, 잔액과 회원 간 송금을 서버에서 처리하는 첫 개발 단계다. Node.js 24의 `node:sqlite`로 계정과 원장을 파일에 저장한다. 처음에는 사용자와 잔액이 모두 없으며, 신규 계정의 시작 잔액은 0원이다.

여기서 사용하는 금액은 **테스트 원장 숫자**다. 실제 원화나 발행된 원화 스테이블이 아니며 카드 발급·본인확인·외부 코인 입출금은 연결하지 않았다. 브라우저 PoC의 잔액·회원·거래 내역을 서버로 가져오지 않는다. [공개 GitHub Pages](https://sohw400.github.io/aquacard/)는 기존 브라우저 데모 모드를 유지한다.

## 처음 실행

서버 모드는 Node.js **24**를 사용한다. 기존 브라우저 데모의 Node 최소 버전과 구분한다.

```bash
cd /workspace/aquacard
npm ci --no-audit --no-fund
npm run server:dev
```

API 기본 주소는 `http://127.0.0.1:3001`이다. 다른 터미널에서 연결 화면을 실행한다.

```bash
cd /workspace/aquacard
npm run dev:server
```

`http://127.0.0.1:5173`을 연다. Vite는 `/api`를 로컬 API로 전달한다. 세션 쿠키를 일관되게 쓰도록 접속 중에 `localhost`와 `127.0.0.1`을 번갈아 사용하지 않는다. 기존 `npm run dev`는 브라우저 데모를 실행한다.

## 두 계정으로 송금 확인

1. 연결 화면에서 첫 테스트 계정을 만든다. 실제 개인정보 대신 `alice@example.test`와 테스트용 이름·태그를 쓴다. 시작 잔액 0원을 확인한다.
2. 로그아웃하거나 다른 브라우저 프로필에서 두 번째 계정 `bob@example.test`를 만든다. 송금에 쓸 두 번째 계정의 태그를 확인한다.
3. 저장소 루트에서 개발자용 명령으로 첫 계정에 테스트 잔액을 넣는다.

```bash
npm run server:credit -- alice@example.test 100000 local-alice-credit-001
```

4. 첫 계정으로 로그인해 두 번째 계정을 태그로 찾고 10,000원을 보낸다. 첫 계정 90,000원, 두 번째 계정 10,000원과 양쪽 거래 내역을 확인한다.
5. 같은 적립 명령을 다시 실행해도 추가 적립되지 않는지 확인한다. API를 중지하고 다시 실행한 뒤 계정과 잔액이 유지되는지도 확인한다.

`server:credit`는 개발자용 로컬 도구이며 브라우저에서 호출하는 충전 API가 아니다. 대상 계정은 먼저 가입해야 한다. 마지막 인자는 중복 실행을 구분하는 키다. 새 적립에는 새 키를 쓰며, 기존 키를 다른 대상·금액에 재사용하지 않는다. 서버와 CLI는 같은 `AQUA_DB_PATH`를 사용해야 한다. `NODE_ENV=production`에서는 이 명령이 실행되지 않는다.

## 저장 위치와 설정

| 설정 | 기본값·역할 |
| --- | --- |
| `AQUA_DB_PATH` | `data/aqua.sqlite`. 계정·세션·원장 SQLite 파일. 서버와 CLI에 같은 경로를 지정한다. |
| `AQUA_MAIL_DIR` | `data/mail`. 로컬 개발용 비밀번호 재설정 안내 파일을 저장한다. |
| `AQUA_HOST` | `127.0.0.1`. API 수신 주소. |
| `AQUA_PORT` | `3001`. API 포트. |
| `AQUA_ALLOWED_ORIGINS` | 쉼표로 구분한 정확한 origin 목록. 기본 개발 origin은 `http://localhost:5173`, `http://127.0.0.1:5173`이다. 경로나 끝의 `/`를 붙이지 않는다. |
| `AQUA_STATIC_DIR` | 연결 화면의 빌드 출력 `dist/`를 지정하면 API가 정적 화면도 제공한다. 저장소 루트나 `data/`를 지정하지 않는다. |
| `VITE_DATA_MODE` | `server`이면 서버 연결 화면을 빌드·실행한다. `dev:server`와 `build:connected`가 지정한다. |
| `NODE_ENV` | `production`이면 명시적인 HTTPS origin이 필수이고 세션 쿠키에 `Secure`를 붙인다. 개발용 적립과 파일 메일함은 비활성화한다. |

기본 경로는 저장소 루트에서 실행하는 것을 전제로 한다. `data/`의 DB·메일 파일은 Git에 올리지 않는다. 다른 작업용 DB를 쓰려면 API·CLI·브라우저 테스트를 실행하는 터미널에 동일한 경로를 설정한다.

```bash
export AQUA_DB_PATH=/tmp/aqua-server-development/aqua.sqlite
export AQUA_MAIL_DIR=/tmp/aqua-server-development/mail
npm run server:dev
```

브라우저는 `HttpOnly`, `SameSite=Strict` 세션 쿠키를 사용한다. 운영 모드는 명시한 HTTPS origin과 Secure 쿠키가 필요하며 개발 기본값으로 조용히 실행하지 않는다. API를 공개할 때는 HTTPS 종료·쿠키·허용 origin을 함께 설정해야 한다. API에서 정적 화면도 제공한다면 그 화면의 origin을 `AQUA_ALLOWED_ORIGINS`에 지정한다.

## 비밀번호 재설정

로컬 개발 모드에서 재설정을 요청하면 개발용 메일 파일이 `AQUA_MAIL_DIR`에 생긴다. 새 디렉터리는 `0700`, 새 파일은 `0600` 권한으로 만든다. 이는 실제 메일 발송이 아니다. 재설정 토큰·비밀번호·쿠키를 로그나 문서, 스크린샷, Git에 남기지 않는다.

개발 환경에서 해당 파일을 열어 재설정 화면의 복구 코드 입력란에 토큰을 사용한다. 토큰은 15분 동안 한 번만 사용할 수 있다. 비밀번호를 바꾸면 기존 로그인 세션이 폐기되므로 새 비밀번호로 다시 로그인한다.

운영 모드에서는 메일 발송 어댑터가 연결되기 전까지 재설정 API가 `503`을 반환한다. 개발용 메일함을 운영 메일 발송으로 취급하지 않는다.

## API 범위

모든 경로는 `/api` 아래에 있다. 인증이 필요한 요청은 로그인 세션 쿠키로 처리한다. 상태 변경은 JSON 요청이며, 브라우저에서 임의의 장부·잔액을 보낼 수 없다.

| 메서드·경로 | 역할 |
| --- | --- |
| `GET /api/health` | 준비 확인. `{ "status": "ok", "mode": "sandbox" }`. |
| `GET /api/session` | 현재 로그인 세션 확인. |
| `POST /api/auth/signup` | 테스트 계정 생성. 시작 잔액 0원. |
| `POST /api/auth/login` | 로그인 및 세션 쿠키 발급. |
| `POST /api/auth/logout` | 세션 폐기. 유효한 로그인 세션에는 `X-Aqua-Account` 헤더가 필요하다. |
| `POST /api/auth/recovery/request` | 비밀번호 재설정 요청. |
| `POST /api/auth/recovery/confirm` | 재설정 토큰 확인 및 새 비밀번호 지정. |
| `GET /api/account` | 서버 잔액과 거래 내역 조회. |
| `GET /api/members?tag=...` | 실제 가입된 태그로 수신자 조회. |
| `POST /api/transfers` | 회원 간 송금. `Idempotency-Key`와 `X-Aqua-Account` 헤더가 필요하다. |

송금의 JSON 필드는 `recipientTag`와 최소 1,000원의 정수 `amountWon`이다. `X-Aqua-Account`에는 현재 화면과 저장된 송금 요청의 소유 계정 ID를 넣는다. 서버는 이 값이 세션의 계정과 같은지 확인하며, 송금 권한과 실제 보내는 계정은 세션 쿠키로 결정한다. 로그아웃에도 현재 화면의 계정 ID를 같은 헤더로 보낸다.

같은 브라우저의 다른 탭에서 로그인 계정이 바뀌면 일치하지 않는 송금·로그아웃은 `409 SESSION_CHANGED`로 거절한다. 다른 계정의 원장이나 세션을 바꾸지 않는다. 확인 중이던 요청은 원래 계정으로 다시 로그인한 뒤 같은 요청 키로 확인한다. 이미 만료된 세션의 로그아웃은 쿠키를 정리한다.

송금의 수신자·잔액·금액 검증과 차감·입금·기록은 서버에서 처리한다. 같은 요청 키의 재시도는 송금을 중복 실행하지 않는다. 클라이언트에서 성공 화면을 표시했다는 이유로 잔액을 추가하지 않는다.

## 빌드와 검증

```bash
npm run build:server
npm run test:server
npm test
npm run build
npm run build:connected
```

`build:server`는 서버 타입 검사이며 배포용 JS를 출력하지 않는다. `server:start`는 `tsx`로 서버를 실행한다. `build:connected`는 연결 화면을 `dist/`에 만들고, 일반 `build`·`build:pages`는 공개용 브라우저 데모를 만든다.

API와 `dev:server`를 실행한 상태에서 브라우저 검증을 수행한다. Chromium 또는 Chrome 실행 파일이 필요하다.

```bash
AQUA_BASE_URL=http://127.0.0.1:5173 npm run test:server:browser
```

브라우저 실행 파일은 `CHROMIUM_PATH`로 지정한다. 검증은 실행마다 고유한 두 계정을 만들고 CLI로 테스트 금액을 적립하므로 사용자 DB를 초기화하지 않는다. 테스트가 만든 계정·내역은 해당 DB에 남는다. 개발자 DB를 깨끗하게 유지하려면 별도 임시 DB로 API를 실행한다. 가입 요청 제한도 적용하므로 짧은 시간에 반복할 때는 API를 새 임시 DB로 다시 실행한다.

[서버 검사 워크플로](../.github/workflows/server-check.yml)는 PR과 `main` 푸시에서 Node 24로 서버 타입·서버 테스트·기존 로직·두 화면 빌드·연결 브라우저 흐름을 검사한다. 브라우저 검사는 CI 임시 DB에서 실행한다. 이 워크플로는 서버를 배포하지 않는다.

2026-11-16 검증에서는 제품·클라이언트 로직 123개, 서버 테스트 33개, 기존 웹 검사 57개, 연결 브라우저 검사 12개가 통과했다. 서버 프로세스 재시작, 별도 DB 연결의 동시 송금, 실제 처리 후 응답 유실과 같은 요청의 재확인, 5초 이상 느린 잔액 조회, 같은 브라우저의 다른 탭에서 계정 변경을 검증했다. 브라우저 검사는 Chromium에서 데스크톱과 모바일 화면 크기로 수행했으며 실제 iOS·Android 기기 검증은 아니다.

## 다음 개발 범위

현재 SQLite 구성은 영속 디스크를 가진 단일 서버 인스턴스용 샌드박스다. 다중 인스턴스·자동 확장·서버리스 배포용 공유 원장으로 사용하지 않는다. 운영 단계에서는 PostgreSQL 등으로 이전하고 마이그레이션·백업 복구·관측·사용량 제한을 검증해야 한다.

카드·KYC·외부 입출금·발행사·보관·전환·정산 파트너 연동은 후속 범위다. 실제 자금을 다루기 전에는 해당 연동과 운영 통제를 구현하고 검증해야 한다.
