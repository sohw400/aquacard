# 연결형 지갑의 코인 입출금

회원은 카드 홈의 **코인 입출금 → 입출금 보기**에서 자산, 네트워크와 수량을 고른다. 입금 원화는 체인 확인과 환전이 끝났을 때 지갑 잔액으로 들어간다. 이후 리저브로 옮길 수 있다. 출금은 반대 방향으로 진행하며, 회원의 원화 지갑에서 총액을 먼저 보류한다. 이 구현은 합성 코인과 `TEST_KRW` 장부를 사용한다. 체험용 주소에는 실제 자산을 보낼 수 없다.

## 견적과 수수료

| 자산 | 체험용 단가 | 출금 네트워크 비용 |
| --- | ---: | --- |
| KRWS | 1원 | Polygon 140원, Ethereum 2,800원 |
| USDC | 1,400원 | Polygon 140원, Ethereum 2,800원 |
| USDT | 1,400원 | Ethereum 2,800원 |
| BTC | 150,000,000원 | Bitcoin 1,500원 |
| ETH | 4,000,000원 | Ethereum 2,000원 |

견적 유효 시간은 60초다. 요청당 환산 총액은 1천~1억원이며, 회원당 진행 중인 요청은 20건까지 유지한다. 입금 환산액은 원 단위로 내림한다. 출금 시 KRWS의 전환 수수료는 0원이다. 다른 자산은 총액의 0.5%를 원 단위로 올림한다. 총액에서 전환 수수료와 네트워크 비용을 뺀 뒤 전송 수량을 소수 8자리에서 버린다. 예를 들어 Polygon USDC로 14,000원을 출금하면 전환 수수료 70원, 네트워크 비용 140원, 전송분 13,790원과 9.85 USDC를 확인할 수 있다. 가격과 비용은 고정 시험값이다.

## 회원 요청

`GET /api/funding`은 로그인한 회원의 최근 50건과 진행 상태를 반환한다. `POST /api/funding`에서 `quote`, `accept_deposit`, `accept_withdrawal`, `cancel`을 처리한다. 조회에는 `X-Aqua-Account`, 쓰기에는 같은 계정 헤더와 `Idempotency-Key`가 필요하다. 출금 보류에는 최근 비밀번호 재확인이 필요하다. 입금 주소 발급 후 체인 관측 전, 출금 보류 후 전송 시작 전에는 취소할 수 있다. 응답이 끊기면 화면에서 **같은 요청으로 결과 확인**을 눌러 동일한 요청 키로 조회한다.

## 운영자 합성 이벤트

로컬 PostgreSQL을 준비하고 기존 마이그레이션 설정의 `DATABASE_FUNDING_ROLE`과 운영자 전용 연결 문자열 `FUNDING_DATABASE_URL`을 지정한다. API 계정과 운영자 계정은 서로 다른 로그인이다. `npm run db:migrate`는 각 로그인에 역할별 권한을 부여한다. 운영자 명령은 표준 입력에서 JSON 객체 하나를 읽으며 연결형 회원 화면에 노출되지 않는다.

입금 요청을 확정한 뒤 회원 화면의 체험용 지갑 주소와 거래 ID를 사용한다. Polygon에서 정확히 10 USDC를 넣는 예시다. 아래의 `id`를 실제 견적 행의 UUID로 바꾼다. 입금 주소는 `aqua-test:polygon:<거래 UUID>` 형식이다.

```bash
id='00000000-0000-4000-8000-000000000001'
jq -nc --arg id "$id" '{eventId:"example-observe",id:$id,action:"observe",asset:"USDC",network:"polygon",units:"10",destination:("aqua-test:polygon:"+$id),transferRef:"sim-tx:deposit-one:0",blockRef:"sim-block:block-one"}' | npm run --silent server:funding
jq -nc --arg id "$id" '{eventId:"example-confirm",id:$id,action:"confirm",transferRef:"sim-tx:deposit-one:0",blockRef:"sim-block:block-one",confirmations:2}' | npm run --silent server:funding
jq -nc --arg id "$id" '{eventId:"example-convert",id:$id,action:"convert"}' | npm run --silent server:funding
```

Ethereum은 12회, Polygon과 Bitcoin은 2회 확인을 요구한다. 동일한 네트워크의 거래와 출력 번호(`transferRef`)는 다른 견적에서 재사용할 수 없다. 블록 재편성 시 해당 거래·블록을 지정한 `reorg` 이벤트를 보낸다. 환전 전에는 새 블록을 기다린다. 환전 후에는 재확인 상태로 전환하고 `compensate`로 원장에 별도의 정정 분개를 남긴다. 차감 가능한 잔액이 부족하면 수동 확인 상태가 유지된다.

출금 견적을 확정하면 원화 총액이 즉시 보류된다. 운영자는 해당 거래의 UUID를 `id`에 넣고 다음 순서로 진행한다.

```bash
jq -nc --arg id "$id" '{eventId:"example-dispatch",id:$id,action:"dispatch"}' | npm run --silent server:funding
jq -nc --arg id "$id" '{eventId:"example-settle",id:$id,action:"settle",dispatchKey:$id,proofRef:"sim-proof:outcome-one",transferRef:"sim-tx:withdraw-one:0"}' | npm run --silent server:funding
```

결과를 모르는 전송은 `unknown` 상태에서 보류를 유지한다. 출금 UUID를 계속 같은 전송 키로 사용하며, 미전송 증빙이 있는 `not_sent`만 재시도를 열어 준다. 확정 거절은 `reject`로 보류를 복원한다. 두 결과 모두 `dispatchKey`와 `proofRef`가 필요하다. `settle`은 전송량, 전환 수수료, 네트워크 비용을 분리해 정산한다. 같은 이벤트 재처리에는 같은 `eventId`와 본문을 사용한다.

## 로컬 검증

```bash
node --env-file-if-exists=.env --import tsx --test server/funding-store.test.ts
npm run build:connected
node --env-file-if-exists=.env --import tsx scripts/funding-browser-check.mjs
```

브라우저 검증은 서로 다른 로컬 `TEST_DATABASE_URL`과 `DATABASE_URL`, Chromium(`CHROMIUM_PATH`로 지정 가능)을 사용한다. 390px 화면에서 입금 확정 후 새로고침, 출금 비밀번호 재확인, 보류, 회원 취소와 잔액 복원을 검사하고 `artifacts/server-funding/funding-mobile.png`에 결과를 저장한다. 운영 결제에 연결하려면 별도 수탁사·체인 확인·가격 공급·실제 전송 증빙·규제 심사를 연결해야 한다.
