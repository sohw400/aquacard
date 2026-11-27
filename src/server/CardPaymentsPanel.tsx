import { useId, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
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
  return <div className="sa-card-cashback-detail"><h3>이 결제의 페이백</h3>{cashback ? <><dl><div><dt>대기</dt><dd data-testid={`server-card-cashback-pending-${payment.id}`}>{money(cashback.pendingWon)}</dd></div><div><dt>확정 누계</dt><dd data-testid={`server-card-cashback-awarded-${payment.id}`}>{money(cashback.awardedWon)}</dd></div><div><dt>환수 누계</dt><dd data-testid={`server-card-cashback-reversed-${payment.id}`}>{money(cashback.reversedWon)}</dd></div><div><dt>조정액 상계</dt><dd data-testid={`server-card-cashback-offset-${payment.id}`}>{money(cashback.offsetWon)}</dd></div></dl><p className="sa-card-detail-note">{payment.heldWon > 0 && cashback.pendingWon > 0 ? '결제대기 금액이 남아 있어 아직 지급되지 않았어요. ' : ''}리워드 결제분은 페이백 대상에서 제외돼요.{cashback.offsetWon > 0 ? ' 확정된 페이백 일부는 이전 조정액에 반영됐어요.' : ''}</p><p className="sa-card-cashback-policy">{cashback.month} 결제 기준 · {Number((cashback.rateBps / 100).toFixed(2))}%</p></> : <p className="sa-card-detail-note" data-testid={`server-card-cashback-unavailable-${payment.id}`}>이 기록에는 페이백 상세 정보가 없어요.</p>}</div>;
}

function CardReceipt({ payment }: { payment: CardPaymentRecord }) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const { cashback, funding } = payment;
  const reserve = funding?.reserve?.authorizedWon ?? 0;
  const sources = funding ? [
    { name: '지갑', amount: funding.principal.authorizedWon - reserve },
    { name: '리저브', amount: reserve },
    { name: '리워드', amount: funding.rewards.authorizedWon },
  ].filter(source => source.amount > 0) : [];
  const amounts = [
    { key: 'authorized', name: '승인 금액', amount: payment.authorizedWon },
    { key: 'captured', name: '결제 확정', amount: payment.capturedWon },
    { key: 'released', name: '승인 해제', amount: payment.releasedWon },
    { key: 'refunded', name: '환불', amount: payment.refundedWon },
  ];
  return <div className="sa-card-detail">
    <dl className="sa-receipt-summary">
      <div className="sa-receipt-net"><dt>현재 확정된 결제 금액</dt><dd data-testid={`server-card-net-${payment.id}`}>{money(payment.capturedWon - payment.refundedWon)}</dd></div>
      <div><dt>결제 대기</dt><dd data-testid={`server-card-held-${payment.id}`}>{money(payment.heldWon)}</dd></div>
      {sources.length > 0 && <div><dt>승인에 쓴 잔액</dt><dd>{sources.map(source => <span key={source.name}>{source.name} {money(source.amount)}</span>)}</dd></div>}
      {cashback && <div><dt>{payment.heldWon > 0 ? '적립 대기 페이백' : '확정 페이백'}</dt><dd>{money(payment.heldWon > 0 ? cashback.pendingWon : cashback.awardedWon - cashback.reversedWon)}</dd></div>}
    </dl>
    {cashback?.reason === 'budget_unavailable' && <p className="sa-card-detail-note">승인 당시 회사 예산이 부족해 페이백이 적립되지 않았어요.</p>}
    <button type="button" className="sa-receipt-toggle" aria-expanded={expanded} aria-controls={detailId} onClick={() => setExpanded(!expanded)}>
      금액 상세<ChevronDown size={15} aria-hidden="true" />
    </button>
    <div id={detailId} hidden={!expanded}>
      <dl className="sa-card-amounts">{amounts.map(row => <div key={row.key}><dt>{row.name}</dt>
        <dd data-testid={`server-card-${row.key}-${payment.id}`}>{money(row.amount)}</dd></div>)}</dl>
      <CardFundingDetail payment={payment} /><CardCashbackDetail payment={payment} />
      <dl className="sa-card-metadata"><div><dt>마지막 변경</dt><dd>{date(payment.updatedAt)}</dd></div><div><dt>내역 번호</dt><dd>{payment.id}</dd></div></dl>
    </div>
  </div>;
}

export default function CardPaymentsPanel({ payments }: { payments: CardPaymentRecord[] | null }) {
  return <section className="sa-transactions sa-card-transactions" data-testid="server-card-payments">
    <div className="sa-section-heading"><div><h2>카드 결제 내역</h2><p>테스트 카드로 결제한 내역이에요.</p></div><span>{payments ? `${payments.length}건` : '확인 중'}</span></div>
    {payments === null ? <div className="sa-empty-state">카드 내역을 불러오고 있어요.</div> : payments.length === 0 ? <div className="sa-empty-state">아직 카드 결제 내역이 없어요.</div> : <div className="sa-card-payment-list">{payments.map((payment) => <details className="sa-card-payment" key={payment.id} data-testid={`server-card-payment-${payment.id}`} data-status={payment.status}>
      <summary className="sa-card-summary"><div className="sa-card-summary-copy"><strong>{payment.merchantName}</strong><span>{date(payment.createdAt)}</span><span className={`sa-card-status ${payment.status}`} data-testid={`server-card-status-${payment.id}`}>{statusLabels[payment.status]}</span></div><div className="sa-card-summary-amount"><span>승인 금액</span><strong data-testid={`server-card-amount-${payment.id}`}>{money(payment.authorizedWon)}</strong></div><ChevronRight className="sa-card-chevron" size={18} aria-hidden="true" /></summary>
      <CardReceipt payment={payment} />
    </details>)}</div>}
  </section>;
}
