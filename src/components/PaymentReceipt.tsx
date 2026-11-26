import { useRef } from 'react';
import { useModal } from './useModal';
import { Check, X } from 'lucide-react';
import { money, shortDate } from '../lib/format';
import type { Payment } from '../lib/types';
import './PaymentReceipt.css';

export interface PaymentReceiptData {
  payment: Payment;
  rewardsBefore: number;
  rewardsAfterDebit: number;
  rewardsAfter: number;
  cashbackCredit: number;
  cashbackOffset: number;
  otherRewardDelta: number;
}

export default function PaymentReceipt({ receipt, onClose }: { receipt: PaymentReceiptData; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { payment } = receipt;
  const heading = useRef<HTMLHeadingElement>(null);
  useModal(ref, onClose, heading);

  const sources = [
    { label: '지갑 잔액', id: 'spend', amount: payment.fromSpend },
    { label: '리워드', id: 'rewards', amount: payment.fromRewards },
    { label: '리저브', id: 'reserve', amount: payment.fromReserve },
  ].filter((source) => source.amount > 0);
  const usedEqualsCredit = receipt.rewardsBefore === receipt.rewardsAfter && payment.fromRewards > 0
    && receipt.cashbackCredit === payment.fromRewards && receipt.otherRewardDelta === 0;

  return <div className="receipt-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="payment-receipt" role="dialog" aria-modal="true" aria-labelledby="receipt-title" data-testid="payment-receipt" ref={ref}>
      <span className="sheet-handle" aria-hidden="true" />
      <header className="receipt-header">
        <h2 id="receipt-title" tabIndex={-1} ref={heading}><Check size={18} aria-hidden="true" />결제 완료</h2>
        <button type="button" className="receipt-close" aria-label="결제 내역 닫기" data-testid="receipt-close" onClick={onClose}><X size={21} /></button>
      </header>
      <div className="receipt-body">
        <div className="receipt-headline">
          <strong className="receipt-amount" data-testid="receipt-payment-amount">{money(payment.amount)}</strong>
          <p className="receipt-merchant">{payment.merchant}</p>
          <time className="receipt-date" dateTime={new Date(payment.timestamp).toISOString()}>{shortDate(payment.timestamp)}</time>
        </div>
        <section className="receipt-reward-reconciliation">
          <h3>리워드 변동</h3>
          <div className="receipt-row"><span>결제 전</span><strong data-testid="receipt-rewards-before">{money(receipt.rewardsBefore)}</strong></div>
          <div className="receipt-row"><span>사용한 리워드</span><strong data-testid="receipt-rewards-used">{payment.fromRewards > 0 && '−'}{money(payment.fromRewards)}</strong></div>
          {receipt.otherRewardDelta !== 0 && <div className="receipt-row">
            <span>결제 처리 중 변동</span><strong data-testid="receipt-rewards-other">{receipt.otherRewardDelta > 0 ? '+' : '−'}{money(Math.abs(receipt.otherRewardDelta))}</strong>
          </div>}
          <div className="receipt-row positive"><span>이번 결제 페이백</span><strong data-testid="receipt-cashback-earned">
            {receipt.cashbackOffset === 0
              ? <span data-testid="receipt-cashback-credit">{receipt.cashbackCredit > 0 && '+'}{money(receipt.cashbackCredit)}</span>
              : `+${money(payment.cashback)}`}
          </strong></div>
          {receipt.cashbackOffset > 0 && <>
            <div className="receipt-row"><span>이전 페이백 조정</span><strong data-testid="receipt-cashback-offset">−{money(receipt.cashbackOffset)}</strong></div>
            <div className="receipt-row receipt-credit"><span>실제 적립액</span><strong data-testid="receipt-cashback-credit">+{money(receipt.cashbackCredit)}</strong></div>
          </>}
          <div className="receipt-row total"><span>남은 리워드</span><strong data-testid="receipt-rewards-after">{money(receipt.rewardsAfter)}</strong></div>
          {usedEqualsCredit && <p className="receipt-explanation">쓴 리워드와 새 페이백이 같아서 리워드는 그대로예요.</p>}
        </section>
        <section className="receipt-breakdown"><h3>결제 금액 구성</h3>
          {sources.map((source) => <div className="receipt-row" key={source.id}><span>{source.label}</span><strong data-testid={`receipt-payment-${source.id}`}>{money(source.amount)}</strong></div>)}
        </section>
      </div>
      <footer className="receipt-footer"><button type="button" className="receipt-confirm" onClick={onClose}>확인</button></footer>
    </section>
  </div>;
}
