# KAST 입금·전환·Reserve 구조: 공식 자료 확인

조회일: **2026-10-13** · 대상: 공개된 영문 상품 페이지와 약관 · 상태: 공식 설명 확인, 앱 실거래 검증 없음

## 확인 결과

**KAST 약관상 코인 입금은 KAST에 자산 소유권을 넘기는 매도이며, 그 시점의 시장가격을 기준으로 USD 표시 채권 장부가 기록된다. Reserve 이동은 이미 기록된 USD Spending 잔액을 USD Reserve로 배정하는 내부 장부 이동이다.**

따라서 “BTC·ETH를 고객 소유 그대로 Reserve에 넣고, 카드 결제 때만 처음 매도한다”는 구조로 설명하면 공식 약관과 맞지 않는다. 다만 계약상 입금 매도와 KAST 내부의 실제 시장 매매는 서로 다른 단계다. 내부에서 받은 코인을 언제·어디서 팔거나 보유하는지까지 공개 자료로 확인한 것은 아니다.

이 조사에서는 기존 HTTPS 경로와 Python `urllib`의 기본 TLS 검증을 사용했다. 인증서 검증을 끄거나 신뢰 저장소를 변경하지 않았다. `www.kast.xyz` 상품·약관 페이지는 HTTP 200으로 읽었고, `help.kast.xyz`는 프록시 `403 Forbidden`으로 읽지 못했다. 이전에 접근하지 못했던 상품 정보가 이번 조회에서는 확인되어 이전 문서의 “KAST 공식 수치 미검증” 상태를 대체한다.

## 1. 코인 입금 때 무엇이 일어나는가

공식 [Platform Terms — Services](https://www.kast.xyz/en/legal/terms-and-conditions-of-service) (표시 시행일: 2026-07-07):

> “transferring Virtual Assets (such as cryptocurrencies or stablecoins) into KAST is treated as a sale to KAST”

> “USD-denominated ledger entry, calculated at the prevailing market rate at the exact time of the sale”

같은 `Services` 문단은 자산 소유권이 KAST에 이전되고 KAST가 고객에 대해 지급 의무를 부담한다고 설명한다. 기록된 USD 장부는 예금·고객이 보유하는 원물 코인 계좌가 아니라 KAST에 대한 집행 가능한 채권이라는 설명이다. 미사용 지급 의무 잔액의 상환·출금은 본인 확인, 최소액, 수수료 등 조건에 따른다.

`Custodial Management of Virtual Assets`도 이후 보관된 코인이 고객을 위해서가 아니라 KAST를 위해 수탁된다고 설명한다. 고객이 원래 입금한 BTC·ETH 수량을 계속 소유하거나, 출금 시 같은 수량으로 돌려받을 권리가 있다는 뜻으로 해석할 수 없다.

공식 [홈 — FAQ](https://www.kast.xyz/)는 USDT·USDC와 PENGU 등 25개 이상의 다른 코인을 입금할 수 있다고 설명한다.

> “Balances are spendable straight from the card — there is no separate conversion step.”

이는 사용자가 카드 사용 전에 별도 전환 화면을 거치지 않는다는 상품 경험 설명이다. 내부 매매가 없거나 고객 원물 코인이 계속 보유된다는 뜻이 아니다. **입금 시 계약상 매도·USD 장부 반영**과 **그 이후 KAST가 자기 소유 자산을 실제 시장에서 전환하는 시점**을 구분한다.

약관의 `Acceptable Tokens` 정의에는 USDT·USDC만 명시되어 있고 목록을 변경할 수 있다고 한다. 홈의 광범위한 지원 설명과 범위가 다르므로 특정 일반 코인·체인의 현재 지원 여부를 이 문서로 보장하지 않는다.

## 2. Reserve 이동 때 다시 매도하는가

공식 [USD Reserve Product Terms](https://www.kast.xyz/en/legal/kast-usd-reserve-account) (표시 시행일: 2026-08-20):

- **§2:** Reserve는 카드 거래 등 서비스 이용을 위한 USD 표시 금액이다. 기존 카드 자금 우선순위의 마지막 재원으로 사용된다.
- **§4:** Spending에서 Reserve로 옮기는 것은 내부 장부 배정이다.

> “Setting aside a portion of your USD Spending Balance into the Reserve Account is a ledger designation only”

- **§6:** USD Spending → USD Reserve, USD Reserve → USD Spending 이동을 설명한다.
- **§2:** 제3자 결제 경로를 통한 입금·출금·송금은 USD Spending을 통과해야 한다. Reserve에서 외부로 직접 송금하는 구조가 아니다.
- **§9:** 설정을 켠 경우 Reserve 자금을 카드 결제에 사용할 수 있다. 해당 카드 거래의 환불은 Reserve가 아닌 Spending으로 들어오고, 다시 Reserve에 배정하려면 내부 이동이 필요하다.

공식 [Reserve 상품 페이지](https://www.kast.xyz/en/reserve)도 USD 잔액의 일부를 따로 배정한다고 설명한다.

> “Set aside part of your USD balance”

따라서 **Reserve 이동 자체를 BTC·ETH 추가 매도나 새로운 코인 스왑으로 해석할 근거는 없다.** 이미 USD 표시된 Spending 가치의 장부 배정이다.

## 3. 별도 Crypto Swap은 무엇인가

공식 [Platform Terms — Crypto Swap Services](https://www.kast.xyz/en/legal/terms-and-conditions-of-service)는 BTC·ETH 등 지원 가상자산을 USDT·USDC 같은 법정화폐 담보 스테이블코인으로 교환하는 서비스를 별도로 설명한다.

- 사용자 지시에 따라 실행한다.
- 내부 유동성 풀, 제3자 유동성 제공자 또는 관계사가 참여할 수 있다.
- 온체인 또는 오프체인으로 정산할 수 있다.
- 실행 시점의 전환율이 적용되며 스프레드나 서비스 수수료가 포함될 수 있다.
- 서비스 수수료는 전환액에서 차감되고, 다른 적용 수수료는 확인 전에 공개한다.
- 확정된 스왑은 최종적·비가역적이라고 설명한다.

**공개 약관은 고정 수수료율, 견적 유효시간, 각 체인의 최소액을 제공하지 않는다.** Aqua의 0.5%·30초 견적은 자체 모의 정책이며 KAST 수치를 복제한 것이 아니다. 별도 Swap 조항이 입금 시 매도·USD 장부 조항과 각 앱 화면에서 어떻게 연결되는지는 로그인 앱 또는 지원 설명을 더 확인해야 한다.

## 4. Reserve 인출·외부 출금

| 항목 | 공식 확인 내용 | 미확인 내용 |
| --- | --- | --- |
| Reserve → Spending | 일부·전체 내부 이동 요청 가능. 기본 최소 내부 이동액 USD 2 | 개별 사용자·지역의 실제 최소액·처리시간 |
| Reserve 직접 카드 결제 | 기존 자금 우선순위의 마지막 재원, 설정·운영 조건 적용 | 모든 고객에게 같은 설정이 적용되는지 |
| Reserve → 외부 | 먼저 Spending으로 이동해야 함 | 앱의 상세 버튼·실거래 처리시간 |
| Spending → 외부 | 플랫폼은 가상자산 출금·은행 지급 경로를 설명 | 현재 출금 가능한 코인 전체 목록, 체인별 최소액·가스비·환산 시점 |
| 원래 코인 수량 복원 | 약관상 입금은 소유권 이전 매도·USD 채권 장부 | 원래 BTC·ETH 수량의 반환을 보장하는 근거 없음 |

[Global Payouts](https://www.kast.xyz/en/global-payouts)는 은행·가상자산·KAST Tag 경로를 안내하며 송금 확인 전에 받을 금액과 비용을 보여준다고 설명한다. 그러나 최신 출금 자산/네트워크 일람으로 쓰기에는 상세 정보가 부족하다.

상품 페이지의 “no lock-ups”는 락업 상품이 아니라는 의미다. Reserve 약관 §6은 인출·이동이 언제나 즉시 처리된다고 보장하지 않으며 운영·컴플라이언스·계정 제한 등이 적용될 수 있다고 명시한다. “인출 제한 없음”을 모든 상황의 무조건적인 즉시 외부 출금 약속으로 사용하지 않는다.

## 5. 보상 재원과 포인트 전제 수정

공식 [Reserve 상품 페이지](https://www.kast.xyz/en/reserve)의 `Funded by KAST`:

> “KAST funds these rewards to members directly as a subsidy and customer incentive, from its own revenues and corporate balance sheet.”

공식 설명은 고객 자금을 스테이블코인과 국채 상당 자산으로 보수적으로 보유한다고 덧붙인다. 따라서 **고객 자산을 운용한 수익에서 일정 마진을 떼고 나머지를 고객에게 배당하는 모델**이라고 확정하면 안 된다. 공식적으로는 KAST 기업 재원에서 지급하는 보조·고객 혜택이다. 실제 보유 비율, 운용 계약, 수익 배분표는 공개되어 있지 않다. [2026-08-20 출시 뉴스](https://www.kast.xyz/en/newsroom/press-releases/much-more-than-a-card-kast-launches-reserve-to-enable-users-to-grow-and-spend-usd-balance)도 같은 재원 설명을 담는다.

보상의 종류도 구분한다.

- **Reserve 보상:** 상품 FAQ는 매일 Spending 잔액에 반영되어 사용할 수 있다고 설명한다. Reserve 약관 §3은 USD Spending으로 실제 교환되기 전까지 지급할 보상이 확정되지 않는다고 설명한다.
- **Card USD Cashback:** [Rewards Program Terms](https://www.kast.xyz/en/legal/rewards-program-terms-and-conditions) §5.6, §6은 Locked → Redeemable → Redeemed 상태와 카드 우선 적용을 설명한다. Rewards Balance의 외부 이체·현금 인출 제한도 규정한다.
- **KAST Points:** 같은 약관 §4.2, §5.6은 현금 가치가 없는 별도 참여·혜택 기록으로 설명한다. USD 표시 보상과 동일한 항목이 아니다.

Reserve 보상과 Card USD Cashback의 정확한 교환·출금 권리를 모두 같은 것으로 단정할 수 없다. 상품 페이지, Reserve 개별 약관, 공통 Rewards 약관의 화면·계정 연결을 추가 확인해야 한다. **“Reserve 보상은 달러로 표시한 KAST 포인트일 뿐이다” 또는 “KAST의 모든 Reserve 보상은 현금 출금이 불가능하다”라는 기존 추정은 공식 사실로 사용하지 않는다.** Aqua가 결제 전용 Aqua Rewards를 제공하는 것은 별도로 선택할 수 있는 자체 정책이다.

## 6. 공식 요율·일정의 불일치

현재 상품 페이지에서 확인한 표시값은 다음과 같다. 이 표는 페이지에 나타난 수치이며 모든 사용자에게 적용되는 최종 계약 조건을 보장하지 않는다.

| 구분 | Standard | Premium | Private |
| --- | --- | --- | --- |
| 멤버십 표시 | 무료 | 연 $1,000 | 연 $10,000 |
| 페이백 표시 | 1.5% | 2% | 3% |
| Reserve 표시 | 8% | 최초 $50,000에 10%, 초과분 8% | 최초 $200,000에 12%, 초과분 8% |

상품 페이지는 2026 도입 혜택이 **2027-07-01** 변경된다고 표시한다. 그러나 Reserve 약관 §4는 프로모션을 **2026-12-31 또는 총 Reserve $100 million 도달 중 빠른 시점**까지로 적고, 2026-08-20 출시 뉴스는 초기 **6–12% → 2027-01부터 4–8%**를 설명한다.

공식 문서 사이에 수치·종료 일정이 다르므로 “현재 모든 고객의 확정 Reserve 연율은 8%이고 2027년 7월까지 보장된다”고 말하지 않는다. 사용자별 앱 표시·프로모션 약관·공지로 적용 조건을 확인해야 한다. Aqua의 연환산 단리 5%는 독립적인 모의 정책으로 유지한다.

## 7. Aqua에 반영할 설계 제안

KAST와 유사한 기본 흐름을 채택한다면 아래처럼 입금과 Reserve 내부 이동을 분리한다.

1. **자산 입금 확인:** 자산·수량·체인·적용 가격·비용·받을 원화 장부액을 보여준다. PoC에서는 실제 입금·매매를 하지 않는다.
2. **입금 자산의 자금화:** 사용자가 동의한 모의 전환 조건에 따라 원화 결제 장부를 만든다. 자동 자금화 모드가 일반 코인 장기 보유 지갑으로 오인되지 않게 한다. 이 단계의 0.5%는 Aqua 자체 비용 가설이다.
3. **Reserve 배정:** 이미 기록된 원화 결제 장부액 일부를 Reserve에 배정한다. 재매도·추가 전환비를 부과하지 않는다.
4. **결제:** 사용할 수 있는 Aqua Rewards → 결제 잔액 → 사용자가 켠 Reserve 부족분 순서로 처리한다.
5. **인출:** Reserve → 결제 장부로 내부 이동한 후 별도 외부 출금 견적을 확인한다. 가상자산 출금 시 원래 코인 수량으로 돌아간다고 약속하지 않는다. PoC 네트워크 출금은 미연동이며 네트워크 비용은 미반영이다. Aqua 자체 전환 수수료는 모의 잔액에서 차감한다.

일반 코인을 원물로 유지하는 지갑 기능도 제공할 경우 **원물 보유 모드**와 **카드 자금화 모드**를 명확히 구분한다. 원물 잔액이 평가된다고 자동으로 Reserve 보상 대상·카드 결제 가능액이 되는 것은 아니다. Aqua의 자산 보관·소유권·전환 계약은 한국의 파트너 구조에 맞춰 별도로 정해야 하며 KAST 약관을 그대로 적용하는 것으로 간주하지 않는다.

이 문서는 확인 결과와 구현 제안만 기록한다. 앱·엔진 코드 변경 또는 실제 한국 서비스 제공 요건 검증을 완료했다는 뜻은 아니다.
