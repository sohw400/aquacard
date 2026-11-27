# Aqua Card 스테이징

이 환경은 한 대의 개발용 머신이나 Codex Cloud에서 QA 계정으로 연결형 웹 앱을 시험할 때 쓴다. 빌드한 웹·서버, 스테이징 모드의 세션 검사, 인증서를 검증하는 PostgreSQL 18, HTTPS 앞단을 함께 실행한다. 회원과 거래는 전용 DB에 저장한다. 서울의 RDS·ECS에서 인수 시험을 진행할 때는 [AWS 스테이징 설치](staging-setup.md)와 [런타임 구성](staging-runtime.md)을 따른다.

## 열기

Linux에서 Node.js 24, npm, Docker Engine과 Compose, Bash, OpenSSL, curl, `sha256sum`, `flock`을 사용한다. 브라우저 자동 검사에는 Chromium 또는 Google Chrome과 `certutil`(Ubuntu의 `libnss3-tools`)이 필요하다. Chrome 위치는 `CHROMIUM_PATH`로 지정할 수 있다. 저장소 루트에서 실행한다.

```bash
npm ci --no-audit --no-fund
npm run staging:up
npm run staging:status
```

직접 실행한 머신에서는 `https://localhost:3443`으로 접속한다. 최초 실행 시 발급된 테스트 CA 공개 인증서는 `data/local-staging/ca.crt`에 있다. 전용 테스트 프로필에서 이 CA를 신뢰하도록 설정한다. 자동 검증은 매번 임시 브라우저 프로필을 만들고 인증서를 등록한다.

Codex Cloud에서 휴대폰이나 다른 컴퓨터로 열려면 해당 채팅의 **Edit Environment → HTTP Previews**에서 `3000`을 추가하고 **Apply to this chat**을 선택한다. 발급된 미리보기 HTTPS 주소의 origin(경로를 제외한 주소)을 `AQUA_STAGING_PREVIEW_ORIGIN`으로 설정한 뒤 `npm run staging:up`을 실행한다. 미리보기 인증을 거친 뒤 아래 테스트 계정으로 로그인한다.

## 로그인과 첫 거래

테스트 계정 이메일·비밀번호·태그는 첫 실행 시 `data/local-staging/member.json`에 만들어진다. 이 파일과 발급 키, DB 비밀번호는 운영자만 읽을 수 있도록 보관한다. 가입 인증·비밀번호 복구 메일은 같은 디렉터리의 비공개 `mailbox/`에 배달된다. 비밀번호, 키, 메일함은 Git이나 CI 산출물에 올리지 않는다. 로그인 후 카드 홈에서 다음 시작 상태를 볼 수 있다.

| 항목 | 처음 설정하는 값 |
| --- | ---: |
| 사용 가능 지갑 잔액 | 678,200 TEST_KRW |
| 리저브에 보관한 원금 | 300,000 TEST_KRW |
| 성수서점 카드 결제 | 21,800 TEST_KRW |
| 해당 결제의 확정 페이백 | 218 TEST_KRW |

`npm run staging:member`는 같은 계정의 준비를 재개한다. 이미 거래가 끝난 계정에서는 테스터가 바꾼 잔액과 카드 상태를 보존한다. `npm run staging:down`과 `npm run staging:up`으로 서비스를 멈추고 다시 띄울 수 있다.

## 출시 전 로컬 인수 검사

```bash
npm run staging:smoke
npm run staging:down
npm run staging:up
npm run staging:smoke -- --after-restart
npm run staging:smoke -- --chain-deposit
npm run staging:smoke -- --card-controls
```

첫 검사는 신뢰할 수 있는 HTTPS 연결로 로그인하고, 모바일 레이아웃에서 카드와 잔액을 읽는다. API 준비 상태, 세션 쿠키, 다른 origin에서 온 쓰기 요청 거절도 확인한다. 리저브에 1,000원을 넣고 다시 뺀 뒤 지갑·리저브 원금과 이체 기록을 대조한다. 재시작 검사는 같은 회원·카드·거래 기록을 다시 읽는다. 두 검사 사이에 다른 테스터가 그 계정의 원금을 바꾸면 금액 비교에 영향을 준다.

카드 검사는 앱과 같은 API로 잠금을 요청하고 테스트 발급사의 확정을 기다린 뒤 다시 해제한다. 잠금 요청을 재전송해도 카드가 사용 가능 상태이고 회원 잔액이 같은지 확인한다. 로컬 발급사는 요청과 응답에 서명하며 처리한 결과를 전용 볼륨에 보관한다.

체인 입금 검사는 QA 회원 명의의 KRWS/Ethereum 입금 요청을 만들고 로컬 노드에 배포한 시험 토큰을 해당 요청에 배정한 주소로 보낸다. 12블록을 확인한 입금 한 건을 운영자 두 명이 동시에 처리하고 다시 실행해도, 입금 내역 한 건과 지갑 증가분 5,000 TEST_KRW만 남아야 한다. 검사할 때마다 새 요청을 만들어 해당 시험 금액이 지갑에 남는다.

직접 시험하려면 카드 홈의 **코인 입출금**에서 **KRWS → Ethereum**을 선택하고 입금 주소를 발급받는다. 운영자는 화면에 표시된 코드 전체를 아래 명령에 넣는다. 같은 코드로 다시 실행하면 보관한 거래 해시와 영수증을 확인할 수 있다.

```bash
npm run staging:deposit -- "aqua-test:ethereum:${INTENT_UUID}"
```

이 코드는 Aqua의 테스트 요청 번호다. 로컬 노드를 시작할 때 별도의 테스트 수취 주소를 배정한다. `data/local-staging/chain-deposits/`에는 테스트 지갑의 서명이 포함된 영수증이 남는다.

공개 Sepolia RPC의 체인 ID, Circle 테스트 USDC와 전송 영수증은 별도 명령으로 검증한다. `npm run chain:sepolia -- sample`은 공개 기록을 읽으며 회원 잔액을 바꾸지 않는다. [로컬 체인과 공개 테스트넷 검증](synthetic-funding.md#블록체인과-지갑-원장-함께-검증하기)

## 운영 전 별도로 확인할 항목

- 발급사와 수탁사 샌드박스에서 실계약의 서명, 승인·취소·환불, 입금 주소 배정, 출금 재조회와 대사를 검증한다.
- 실제 메일 공급자에서 인증·복구 메일의 도착과 반송, 신고 처리를 확인한다. 이 환경의 발송은 로컬에 격리한다.
- 서울 인프라에서 인증서·사설 네트워크 경로, 경보 수신, 시점 복구에 걸린 시간과 복구 후 거래 재개를 측정한다. [복구 훈련](staging-recovery.md)
