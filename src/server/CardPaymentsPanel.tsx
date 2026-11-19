import { ChevronRight } from 'lucide-react';
import type { CardPaymentRecord, CardPaymentStatus } from '../../shared/api';

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

export default function CardPaymentsPanel({ payments }: { payments: CardPaymentRecord[] | null }) {
  return <section className="sa-transactions sa-card-transactions" data-testid="server-card-payments">
    <div className="sa-section-heading"><div><h2>카드 결제 내역</h2><p>테스트 원장 내역이며 실제 카드사 승인이 아니에요.</p></div><span>{payments ? `${payments.length}건` : '확인 중'}</span></div>
    {payments === null ? <div className="sa-empty-state">카드 내역을 불러오고 있어요.</div> : payments.length === 0 ? <div className="sa-empty-state">아직 카드 결제 내역이 없어요.</div> : <div className="sa-card-payment-list">{payments.map((payment) => <details className="sa-card-payment" key={payment.id} data-testid={`server-card-payment-${payment.id}`} data-status={payment.status}>
      <summary className="sa-card-summary"><div className="sa-card-summary-copy"><strong>{payment.merchantName}</strong><span>{date(payment.createdAt)}</span><span className={`sa-card-status ${payment.status}`} data-testid={`server-card-status-${payment.id}`}>{statusLabels[payment.status]}</span></div><div className="sa-card-summary-amount"><span>승인 금액</span><strong data-testid={`server-card-amount-${payment.id}`}>{money(payment.authorizedWon)}</strong></div><ChevronRight className="sa-card-chevron" size={18} aria-hidden="true" /></summary>
      <div className="sa-card-detail"><dl className="sa-card-amounts"><div><dt>승인 금액</dt><dd data-testid={`server-card-authorized-${payment.id}`}>{money(payment.authorizedWon)}</dd></div><div><dt>결제대기</dt><dd data-testid={`server-card-held-${payment.id}`}>{money(payment.heldWon)}</dd></div><div><dt>매입 · 결제 확정</dt><dd data-testid={`server-card-captured-${payment.id}`}>{money(payment.capturedWon)}</dd></div><div><dt>승인 해제</dt><dd data-testid={`server-card-released-${payment.id}`}>{money(payment.releasedWon)}</dd></div><div><dt>환불</dt><dd data-testid={`server-card-refunded-${payment.id}`}>{money(payment.refundedWon)}</dd></div><div className="sa-card-net"><dt>환불 후 확정 금액</dt><dd data-testid={`server-card-net-${payment.id}`}>{money(payment.capturedWon - payment.refundedWon)}</dd></div></dl><p className="sa-card-detail-note">결제대기 금액은 사용 가능한 잔액에서 제외돼요. 매입은 결제가 확정된 금액이고, 승인 해제는 사용 가능한 잔액으로 돌아온 금액이에요.</p><dl className="sa-card-metadata"><div><dt>마지막 변경</dt><dd>{date(payment.updatedAt)}</dd></div><div><dt>내역 번호</dt><dd>{payment.id}</dd></div></dl></div>
    </details>)}</div>}
  </section>;
}
