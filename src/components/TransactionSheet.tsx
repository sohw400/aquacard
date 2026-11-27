import { useId, useRef } from 'react';
import { X } from 'lucide-react';
import { useModal } from './useModal';
import { dateLabel, money, timeLabel } from '../lib/format';
import type { Payment, PaymentChannel, Transaction } from '../lib/types';
import './InternalTransferDialog.css';
import './TransactionSheet.css';

const KIND_LABELS: Record<Transaction['kind'], string> = {
  deposit: '충전', transfer: '이동', convert: '전환', payment: '카드 결제', refund: '환불',
  reward: '리저브 보상', payback: '페이백', rate: '안내', card: '카드',
};
const CHANNEL_LABELS: Record<PaymentChannel, string> = { store: '매장', online: '온라인', overseas: '해외' };
const PAYMENT_STATUS: Record<Payment['status'], string> = { pending: '승인 중', completed: '결제 완료', refunded: '전액 환불', partially_refunded: '부분 환불' };

function kindLabel(item: Transaction) {
  if (item.fundingId) return item.kind === 'deposit' ? '입금' : '출금';
  if (item.kind === 'transfer' && item.member) return item.amount < 0 ? '보내기' : '받기';
  return KIND_LABELS[item.kind];
}

export default function TransactionSheet({ item, payment, status, onRefund, onFunding, onClose }: {
  item: Transaction;
  payment?: Payment;
  status: string | null;
  onRefund: (payment: Payment) => void;
  onFunding?: (id: string) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const id = useId();
  useModal(panel, onClose, heading);
  const remaining = payment ? payment.amount - payment.refunded : 0;
  const hasRefund = payment !== undefined && payment.refunded > 0;
  const refundable = payment && remaining > 0 && (payment.status === 'completed' || payment.status === 'partially_refunded');
  const unsettled = Boolean(item.fundingId) && item.status !== 'completed';
  const showAmount = item.amount !== 0 || Boolean(item.fundingId);
  const direction = unsettled || item.amount === 0 ? '' : item.amount < 0 ? '−' : '+';
  const kind = kindLabel(item);
  const stateLabel = payment ? PAYMENT_STATUS[payment.status] : status ?? '완료';
  const timestamp = payment?.timestamp ?? item.timestamp;
  const fundingId = item.fundingId;
  return <div className="itd-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="internal-transfer-dialog tx-sheet" ref={panel} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} data-testid="transaction-sheet">
      <header className="itd-header">
        <h2 id={id} ref={heading} tabIndex={-1}>{payment ? '카드 결제 전표' : '거래 상세'}</h2>
        <button type="button" className="itd-close" aria-label="창 닫기" onClick={onClose}><X size={20} /></button>
      </header>
      <div className="itd-body">
        <div className="tx-summary">
          <div className="tx-summary-meta">
            <time className="tx-time" dateTime={new Date(timestamp).toISOString()}>{dateLabel(timestamp)} {timeLabel(timestamp)}</time>
            <span className="tx-state" data-kind={payment?.status ?? item.status}>{stateLabel}</span>
          </div>
          <h3>{payment?.merchant ?? item.title}</h3>
          {hasRefund ? <>
            <div className="tx-amount-line"><span>남은 결제액</span><strong data-testid="transaction-amount">{money(remaining)}</strong></div>
            <dl className="tx-refund-summary">
              <div><dt>원결제 금액</dt><dd>{money(payment.amount)}</dd></div>
              <div><dt>누적 환불액</dt><dd>{money(payment.refunded)}</dd></div>
            </dl>
          </> : showAmount && <div className="tx-amount-line">
            <span>{payment ? '결제 금액' : unsettled ? `${kind} 요청 금액` : `${kind} 금액`}</span>
            <strong className={direction === '+' ? 'tx-credit' : undefined} data-testid="transaction-amount">{direction}{money(Math.abs(item.amount))}</strong>
          </div>}
        </div>
        {payment && <>
          {hasRefund && <section className="tx-block" aria-label="환불받은 금액">
            <h3>환불받은 금액</h3>
            <dl className="tx-lines">
              <div><dt>잔액으로 복원</dt><dd>{money(payment.principalRestored)}</dd></div>
              <div><dt>리워드로 복원</dt><dd>{money(payment.rewardsRestored)}</dd></div>
            </dl>
          </section>}
          <dl className="tx-lines">
            <div><dt>결제 방식</dt><dd>{payment.channel ? CHANNEL_LABELS[payment.channel] : '기록 없음'}</dd></div>
            <div><dt>승인번호</dt><dd data-testid="transaction-approval">AQ{payment.id.replace(/\D/g, '').padStart(8, '0')}</dd></div>
          </dl>
          <section className="tx-block" aria-label="결제 금액 구성">
            <h3>결제 금액 구성</h3>
            <dl className="tx-lines">
              <div><dt>리워드에서</dt><dd>{money(payment.fromRewards)}</dd></div>
              <div><dt>잔액에서</dt><dd>{money(payment.fromSpend)}</dd></div>
              {payment.fromReserve > 0 && <div><dt>리저브에서</dt><dd>{money(payment.fromReserve)}</dd></div>}
            </dl>
          </section>
          <dl className="tx-lines tx-cashback">
            <div><dt>{payment.status === 'pending' ? '확정 전 페이백' : '확정 페이백'}</dt><dd>{money(payment.cashback - payment.cashbackReversed)}</dd></div>
          </dl>
        </>}
        {!payment && item.note && <p className="tx-memo">{item.note}</p>}
      </div>
      <footer className="itd-footer">
        {refundable && <button type="button" className="itd-button itd-secondary" data-testid="transaction-refund" onClick={() => { onClose(); onRefund(payment); }}>환불하기</button>}
        {fundingId && onFunding ? <button type="button" className="itd-button itd-primary" onClick={() => { onClose(); onFunding(fundingId); }}>{kind} 처리 내역 보기</button>
          : <button type="button" className="itd-button itd-primary" onClick={onClose}>확인</button>}
      </footer>
    </section>
  </div>;
}
