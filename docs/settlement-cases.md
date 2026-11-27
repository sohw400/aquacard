# 정산 차이 조사와 승인

담당자는 마감된 영업일의 명세서에서 거래 한 건 또는 은행 정산 한 건을 골라 조사한다. `open-issuer`는 발급사 명세서와 원장을 다시 대조한다. `open-bank`는 원장과 발급사 명세서가 일치한 뒤 정산 통지서와 은행 전표를 다시 대조한다. 지정한 참조에 실제 차이가 있어야 사건이 열린다. 기본 보고서의 상세 100건을 넘는 참조도 조회할 수 있다. [매입·환불 대사](issuer-statement-reconciliation.md) · [은행 대사](bank-settlement-reconciliation.md)

## 개인 계정과 입력 자료

조사자와 승인자는 서로 다른 개인 DB 로그인을 사용한다. DB 관리자는 이 로그인 이름들을 쉼표로 구분해 `DATABASE_SETTLEMENT_CASE_ROLES`에 지정하고 마이그레이션을 적용한다. 개인 로그인은 회원 정보·원장·사건 테이블을 직접 읽거나 수정할 수 없고, 사건 관련 함수만 호출한다. 작업자는 자신의 로그인으로 발급한 `SETTLEMENT_CASE_DATABASE_URL`을 사용한다. 최초 접수에는 별도 읽기 전용 `SETTLEMENT_DATABASE_URL`과 접근이 제한된 정규화 파일이 필요하다. 운영 시 개인과 로그인 간 대응표와 발급·폐기 이력을 관리한다. 공동 로그인이나 한 사람이 두 로그인으로 조사와 승인을 수행하는 방식은 업무 분리를 보장하지 못한다.

입력에는 전체 계좌번호, 카드번호, 자료 경로, 자유 서술 메모를 넣지 않는다. 근거 문서에는 원인, 대조한 원본과 정정 근거를 기록하고 통제된 증빙 저장소에 보관한다. 사건 DB에는 고정된 사유 코드, 입력 파일·거래 참조·차이 상세·증빙의 SHA-256, 처리자와 처리 시각이 남는다. 파일 해시는 바이트 동일성 확인에 사용한다. 발급사·은행 원본의 진위와 권한 있는 담당자의 자료 제출 이력은 증빙 보관 절차에서 확인한다.

## 처리 순서

각 쓰기 명령에 새 UUID를 발급하고 재시도할 때 같은 UUID를 쓴다. 접수 UUID가 사건 번호다. 아래 변수는 개별 작업에서 기록한 UUID, 참조와 파일 경로다. 새 접수는 현재 파일과 DB로 차이를 재확인한다. 이미 저장한 접수의 응답을 잃은 경우에는 같은 로그인·참조·파일 바이트·UUID로 원래 영수증을 받을 수 있다. 이미 접수한 차이를 새 UUID로 다시 제출하면 `SETTLEMENT_CASE_ALREADY_RECORDED`가 반환된다.

```bash
npm run --silent server:settlement:cases -- open-issuer "$OPEN_ID" "$EVENT_REF" "$ISSUER_FILE"
npm run --silent server:settlement:cases -- open-bank "$BANK_OPEN_ID" "$BATCH_REF" "$ISSUER_FILE" "$ADVICE_FILE" "$BANK_FILE"
npm run --silent server:settlement:cases -- claim "$CLAIM_ID" "$OPEN_ID" 1
npm run --silent server:settlement:cases -- evidence "$EVIDENCE_ID" "$OPEN_ID" 2 source_corrected "$EVIDENCE_SHA256"
```

`claim`은 현재 사용자를 조사자로 지정한다. `release`는 본인이 맡은 조사 건을 다시 미배정 상태로 돌린다. `evidence`에서 사용할 수 있는 사유는 `source_corrected`(원본 정정), `timing_confirmed`(기장 시차), `provider_confirmed`(제휴사 확인), `adjustment_required`(추가 조정 필요)다. 해시는 근거 문서의 SHA-256 소문자 64자다.

승인자는 자기 계정으로 사건과 근거 원본을 검토하고 아래 중 한 명령을 실행한다. DB가 로그인 주체를 직접 확인하며, 처음 접수한 사람과 이 사건에서 근거를 제출한 사람은 승인·반려할 수 없다. 반려하면 조사자에게 돌아가며 새 버전과 새 증빙을 제출해야 한다.

```bash
npm run --silent server:settlement:cases -- read "$OPEN_ID"
npm run --silent server:settlement:cases -- approve "$REVIEW_ID" "$OPEN_ID" 3
npm run --silent server:settlement:cases -- return "$RETURN_ID" "$OPEN_ID" 3 "$RETURN_REASON_SHA256"
```

`list open`, `list assigned`, `list evidenced`, `list approved`는 상태별로 사건 번호순 최대 50건을 반환한다. 다음 묶음에는 마지막 사건 UUID를 추가한다. `read`는 상태, 버전, 원본 증빙 지문과 사건별 처리 이력을 제공한다. `SETTLEMENT_CASE_STALE`이면 최신 버전과 이력을 확인한다. 다른 사람이 수행한 명령의 UUID를 재사용하거나 같은 UUID로 내용이 달라지면 `SETTLEMENT_COMMAND_CONFLICT`가 반환된다.

승인은 조사 결과에 대한 동의다. 이 명령은 고객 잔액, 정산 계정, 은행 전표를 변경하지 않는다. 자금 조정이 필요하면 승인된 별도 회계 절차로 집행하고 다음 대사에서 새 전표를 확인한다. 통합 시험은 합성 TEST_KRW 원장을 사용한다.
