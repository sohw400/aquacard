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

## 블록체인과 지갑 원장 함께 검증하기

### 로컬 원화 토큰으로 입금부터 카드 결제까지

Node.js 24와 Docker가 필요하다. 처음 체크아웃한 경우 `.env.example`을 `.env`로 복사하고 로컬 PostgreSQL 접속 정보 `TEST_DATABASE_URL`을 확인한다.

```bash
npm ci --no-audit --no-fund
docker compose up -d --wait postgres
npm run test:chain
```

이 명령은 임시 Anvil 노드(체인 ID 31337)와 전용 PostgreSQL 스키마를 만들고, 그 체인에 소수 6자리의 시험 토큰 `MockKRWS`를 배포한다. 매 실행마다 송금인, 수탁 지갑, 출금 수취인의 키를 새로 만들고 시험용 가스를 지급한다. 체험판의 입금 주소와 테스트 수탁 주소는 전송 전에 짝지어 둔다. 이 대응표와 지갑은 해당 시험에서만 유효하다.

| 단계 | 체인에서 확인할 내용 | Aqua의 사용 가능 잔액 |
| --- | --- | ---: |
| 25,000토큰 입금 관측 후 블록 재편성 | 원래 영수증이 사라지고 수탁 지갑의 토큰 잔액이 0으로 돌아간다. | 0원 |
| 입금 재전송 후 12회 확인 | 토큰 계약, 송금인, 수취인, 수량과 로그 위치가 일치한다. 적립 이벤트를 동시에 두 번 보내도 원장 분개는 한 건이다. | 25,000원 |
| 14,000원 출금 | 수취 지갑에 11,200토큰이 도착한다. 2,800원은 견적에 정한 시험 수수료다. 노드의 실제 가스비는 테스트 ETH로 낸다. | 11,000원 |
| 샌드박스 카드로 3,000원 결제 | 승인 때 3,000원을 보류하고 매입 때 보류를 해제한다. 승인·매입을 재처리해도 카드 결제는 한 건이고 체인 높이는 그대로다. | 8,000원 |

금액의 원장 단위는 `TEST_KRW`다. 스크립트가 출력하는 거래 해시는 해당 로컬 체인에서 발행한 값이다. 명령을 마치면 노드와 시험 스키마를 정리한다.

### 공개 Sepolia에서 테스트 USDC 확인하기

`probe`는 체인 ID 11155111과 Circle이 공시한 USDC 계약의 배포 코드 및 소수 자릿수를 확인한다. `sample`은 최근 블록에서 충분히 확인된 일반 전송 한 건을 찾아 영수증과 대조한다. 두 명령은 개인 키, 테스트 코인과 데이터베이스 없이 실행할 수 있다. 공개 거래를 조회해도 Aqua 잔액은 바뀌지 않는다.

```bash
npm run chain:sepolia -- probe
npm run chain:sepolia -- sample
```

특정 전송을 검사할 때는 송금 전 정해 둔 주소와 사람이 읽는 단위의 수량을 입력한다. 로그 번호는 블록 전체에서의 `logIndex`를 쓴다.

```bash
npm run chain:sepolia -- verify --tx "$TX_HASH" --log-index "$LOG_INDEX" \
  --from "$SENDER" --to "$RECIPIENT" --amount 10.25
```

기본 RPC 호스트는 `ethereum-sepolia-rpc.publicnode.com`이다. 별도 공급자를 쓰는 경우 `AQUA_SEPOLIA_RPC_URL`에 해당 Sepolia HTTPS 주소를 지정한다. 검사기는 영수증 성공 여부, 계약, 송금인, 수취인, 최소 단위 수량, 정식 체인에 포함된 블록과 12회 확인을 대조한다. 여기서 12회는 Aqua의 시험 기준이다. 공개 체인의 합의상 최종 확정과는 다른 시점이다. [Circle의 테스트 USDC 주소](https://github.com/circlefin/skills/blob/a0457677ce1ba6e1e20ca06cee1c21a39b77aaa8/plugins/circle/skills/use-usdc/SKILL.md) · [Ethereum Sepolia 체인 등록 정보](https://github.com/ethereum-lists/chains/blob/master/_data/chains/eip155-11155111.json)

공개 테스트넷에서 앱 회원이 직접 입출금하려면 회원별 입금 주소 발급과 영구 보관, 마지막 처리 블록부터의 재관측, 수탁 서명·전송과 결과 미확인 출금의 재조회가 다음 개발 범위다. 현재 회원 화면의 `aqua-test:…`는 합성 주소다.
