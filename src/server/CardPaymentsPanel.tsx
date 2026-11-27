import { ChevronRight } from 'lucide-react';
import type { CardFundingAmounts, CardPaymentRecord, CardPaymentStatus } from '../../shared/api';

const money = (value: number) => `${value.toLocaleString('ko-KR')}원`;
const date = (value: number) => new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' }).format(value);
const statusLabels: Record<CardPaymentStatus, string> = {
  authorized: '승인 · 매입 대기',
  partially_captured: '일부 결제 확정',
  captured: '결제 확정',
  cancelled: '승인 취소',
  partially_refunded: '일부 환불',
  refunded: '전액 환불',
};

const fundingFields: { key: keyof CardFundingAmounts; label: string; id: string }[] = [
  { key: 'authorizedWon', label: '승인', id: 'authorized' },
  { key: 'heldWon', label: '결제대기', id: 'held' },
  { key: 'capturedWon', label: '결제 확정', id: 'captured' },
  { key: 'releasedWon', label: '승인 해제', id: 'released' },
  { key: 'refundedWon', label: '환불', id: 'refunded' },
];

function CardFundingDetail({ payment }: { payment: CardPaymentRecord }) {
  const funding = payment.funding;
  if (!funding) return <div className="sa-card-funding-detail"><h3>결제 재원</h3><p className="sa-card-detail-note" data-testid={`server-card-funding-unavailable-${payment.id}`}>이전 기록에는 재원별 상세 정보가 없어요.</p></div>;
  const parts = [
    { key: 'principal', label: '지갑 잔액', amount: (field: keyof CardFundingAmounts) => funding.principal[field] - (funding.reserve?.[field] ?? 0) },
    { key: 'rewards', label: '카드 전용 리워드', amount: (field: keyof CardFundingAmounts) => funding.rewards[field] },
  ];
  if (funding.reserve) parts.push({ key: 'reserve', label: '리저브 원금', amount: field => funding.reserve![field] });
  return <div className="sa-card-funding-detail"><h3>결제 재원</h3><div className="sa-card-funding-columns">
    {parts.map(part => <div key={part.key}><h4>{part.label}</h4><dl>{fundingFields.map(field =>
      <div key={field.key}><dt>{field.label}</dt><dd data-testid={`server-card-${part.key}-${field.id}-${payment.id}`}>{money(part.amount(field.key))}</dd></div>
    )}</dl></div>)}</div>{funding.reserve && <p className="sa-card-detail-note">미사용 승인액은 원래 재원으로 돌아갑니다. 매입 후 환불된 리저브 원금은 지갑 잔액에서 확인할 수 있어요.</p>}</div>;
}

function CardCashbackDetail({ payment }: { payment: CardPaymentRecord }) {
  const cashback = payment.cashback;
  return <div className="sa-card-cashback-detail"><h3>이 결제의 페이백</h3>{cashback ? <><dl><div><dt>대기</dt><dd data-testid={`server-card-cashback-pending-${payment.id}`}>{money(cashback.pendingWon)}</dd></div><div><dt>확정 누계</dt><dd data-testid={`server-card-cashback-awarded-${payment.id}`}>{money(cashback.awardedWon)}</dd></div><div><dt>환수 누계</dt><dd data-testid={`server-card-cashback-reversed-${payment.id}`}>{money(cashback.reversedWon)}</dd></div><div><dt>조정액 상계</dt><dd data-testid={`server-card-cashback-offset-${payment.id}`}>{money(cashback.offsetWon)}</dd></div></dl>{cashback.reason === 'budget_unavailable' && <p className="sa-card-detail-note">승인 당시 페이백 재원이 부족해 이 결제의 적립액은 0원입니다.</p>}<p className="sa-card-detail-note">{payment.heldWon > 0 && cashback.pendingWon > 0 ? '결제대기 금액이 남아 있어 아직 지급되지 않았어요. ' : ''}리워드 결제분은 페이백 대상에서 제외돼요.{cashback.offsetWon > 0 ? ' 확정된 페이백 일부는 이전 조정액에 반영됐어요.' : ''}</p><p className="sa-card-cashback-policy">{cashback.month} 결제 기준 · {Number((cashback.rateBps / 100).toFixed(2))}%</p></> : <p className="sa-card-detail-note" data-testid={`server-card-cashback-unavailable-${payment.id}`}>이 기록에는 페이백 상세 정보가 없어요.</p>}</div>;
}

export default function CardPaymentsPanel({ payments }: { payments: CardPaymentRecord[] | null }) {
  return <section className="sa-transactions sa-card-transactions" data-testid="server-card-payments">
    <div className="sa-section-heading"><div><h2>카드 결제 내역</h2><p>테스트 원장 내역이며 실제 카드사 승인이 아니에요.</p></div><span>{payments ? `${payments.length}건` : '확인 중'}</span></div>
    {payments === null ? <div className="sa-empty-state">카드 내역을 불러오고 있어요.</div> : payments.length === 0 ? <div className="sa-empty-state">아직 카드 결제 내역이 없어요.</div> : <div className="sa-card-payment-list">{payments.map((payment) => <details className="sa-card-payment" key={payment.id} data-testid={`server-card-payment-${payment.id}`} data-status={payment.status}>
      <summary className="sa-card-summary"><div className="sa-card-summary-copy"><strong>{payment.merchantName}</strong><span>{date(payment.createdAt)}</span><span className={`sa-card-status ${payment.status}`} data-testid={`server-card-status-${payment.id}`}>{statusLabels[payment.status]}</span></div><div className="sa-card-summary-amount"><span>승인 금액</span><strong data-testid={`server-card-amount-${payment.id}`}>{money(payment.authorizedWon)}</strong></div><ChevronRight className="sa-card-chevron" size={18} aria-hidden="true" /></summary>
      <div className="sa-card-detail"><dl className="sa-card-amounts"><div><dt>승인 금액</dt><dd data-testid={`server-card-authorized-${payment.id}`}>{money(payment.authorizedWon)}</dd></div><div><dt>결제대기</dt><dd data-testid={`server-card-held-${payment.id}`}>{money(payment.heldWon)}</dd></div><div><dt>매입 · 결제 확정</dt><dd data-testid={`server-card-captured-${payment.id}`}>{money(payment.capturedWon)}</dd></div><div><dt>승인 해제</dt><dd data-testid={`server-card-released-${payment.id}`}>{money(payment.releasedWon)}</dd></div><div><dt>환불</dt><dd data-testid={`server-card-refunded-${payment.id}`}>{money(payment.refundedWon)}</dd></div><div className="sa-card-net"><dt>환불 후 확정 금액</dt><dd data-testid={`server-card-net-${payment.id}`}>{money(payment.capturedWon - payment.refundedWon)}</dd></div></dl><p className="sa-card-detail-note">결제대기 금액은 각 재원의 사용 가능 잔액에서 제외돼요. 매입은 결제 확정액, 승인 해제는 원금과 리워드에 각각 돌아온 금액이에요.</p><CardFundingDetail payment={payment} /><CardCashbackDetail payment={payment} /><dl className="sa-card-metadata"><div><dt>마지막 변경</dt><dd>{date(payment.updatedAt)}</dd></div><div><dt>내역 번호</dt><dd>{payment.id}</dd></div></dl></div>
    </details>)}</div>}
  </section>;
}
