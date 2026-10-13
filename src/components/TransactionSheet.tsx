import { useId, useRef } from 'react';
import { X } from 'lucide-react';
import { useModal } from './useModal';
import { money, shortDate } from '../lib/format';
import { PLANS } from '../lib/policy';
import type { CardState, Payment, PaymentChannel, Transaction } from '../lib/types';
import './InternalTransferDialog.css';
import './WalletSheet.css';

const KIND_LABELS: Record<Transaction['kind'], string> = {
  deposit: '충전', transfer: '이동', convert: '전환', payment: '카드 결제', refund: '환불',
  reward: '리저브 보상', payback: '페이백', rate: '안내', card: '카드',
};
const CHANNEL_LABELS: Record<PaymentChannel, string> = { store: '매장', online: '온라인', overseas: '해외' };
const PAYMENT_STATUS: Record<Payment['status'], string> = { pending: '승인 중', completed: '결제 완료', refunded: '전액 환불', partially_refunded: '부분 환불' };

/** Everything known about one ledger entry; payments add the approval number, sources and payback. */
export default function TransactionSheet({ item, payment, card, status, onRefund, onFunding, onClose }: {
  item: Transaction;
  payment?: Payment;
  card: CardState;
  status: string | null;
  onRefund: (payment: Payment) => void;
  onFunding?: (id: string) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const id = useId();
  useModal(panel, onClose, heading);
  const refundable = payment && ['completed', 'partially_refunded'].includes(payment.status);
  const approval = payment ? `AQ${payment.id.replace(/\D/g, '').padStart(8, '0')}` : null;
  const amount = item.amount === 0 ? null : `${item.amount < 0 ? '−' : '+'}${money(Math.abs(item.amount))}`;

  return <div className="itd-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="internal-transfer-dialog wallet-sheet tx-sheet" ref={panel} role="dialog" aria-modal="true" aria-labelledby={`${id}-heading`} tabIndex={-1} data-testid="transaction-sheet">
      <header className="itd-header"><div><h2 id={`${id}-heading`} ref={heading} tabIndex={-1}>{item.title}</h2><p>{item.kind === 'transfer' && item.amount < 0 ? '보내기' : KIND_LABELS[item.kind]} · {shortDate(item.timestamp)}</p></div><button type="button" className="itd-close" aria-label="창 닫기" onClick={onClose}><X size={20} /></button></header>
      <div className="itd-body">
        {amount && <strong className={`tx-amount${item.amount > 0 ? ' positive' : ''}`} data-testid="transaction-amount">{amount}</strong>}
        <dl className="card-sheet-cost tx-facts">
          <div><dt>상태</dt><dd>{payment ? PAYMENT_STATUS[payment.status] : status ?? '완료'}</dd></div>
          {payment && <>
            <div><dt>결제 방식</dt><dd>{CHANNEL_LABELS[payment.channel ?? 'store']}</dd></div>
            <div><dt>카드</dt><dd>{PLANS[card.plan].name} · 끝번호 {card.last4}</dd></div>
            <div><dt>승인번호</dt><dd data-testid="transaction-approval">{approval}</dd></div>
          </>}
        </dl>
        {payment && <dl className="card-sheet-cost tx-facts">
          <div><dt>리워드에서</dt><dd>{money(payment.fromRewards)}</dd></div>
          <div><dt>잔액에서</dt><dd>{money(payment.fromSpend)}</dd></div>
          {payment.fromReserve > 0 && <div><dt>리저브에서</dt><dd>{money(payment.fromReserve)}</dd></div>}
          <div><dt>{payment.status === 'pending' ? '받을 페이백' : '페이백'}</dt><dd>{money(payment.cashback - payment.cashbackReversed)}</dd></div>
          {payment.refunded > 0 && <div><dt>환불한 금액</dt><dd>{money(payment.refunded)}</dd></div>}
        </dl>}
        {item.note && <p className="tx-note">{item.note}</p>}
      </div>
      <footer className="itd-footer">
        {refundable && payment ? <button type="button" className="itd-button itd-primary" data-testid="transaction-refund" onClick={() => { onClose(); onRefund(payment); }}>환불하기</button>
          : item.fundingId && onFunding ? <button type="button" className="itd-button itd-primary" onClick={() => { onClose(); onFunding(item.fundingId!); }}>처리 내역 보기</button>
            : <button type="button" className="itd-button itd-primary" onClick={onClose}>확인</button>}
      </footer>
    </section>
  </div>;
}
