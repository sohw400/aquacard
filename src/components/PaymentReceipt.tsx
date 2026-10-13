import { useEffect, useRef } from 'react';
import { Check, X } from 'lucide-react';
import { money, shortDate } from '../lib/format';
import type { Payment } from '../lib/types';

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
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const target = ref.current;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    target?.querySelector<HTMLButtonElement>('button')?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const buttons = Array.from(target?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []);
        if (!buttons.length) return;
        const first = buttons[0]; const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener('keydown', keydown);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [onClose]);

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="modal payment-receipt" role="dialog" aria-modal="true" aria-labelledby="receipt-title" data-testid="payment-receipt" ref={ref}>
    <div className="modal-head"><h2 id="receipt-title">결제 완료</h2><button className="icon-button" aria-label="결제 내역 닫기" data-testid="receipt-close" onClick={onClose}><X size={21} /></button></div>
    <div className="modal-body"><div className="receipt-success"><Check size={20} /><span>{payment.merchant}</span></div><strong className="receipt-amount" data-testid="receipt-payment-amount">{money(payment.amount)}</strong><p className="receipt-date">{shortDate(payment.timestamp)}</p>
      <div className="receipt-breakdown"><h3>결제에 사용한 금액</h3><div className="receipt-row"><span>리워드</span><strong data-testid="receipt-payment-rewards">{money(payment.fromRewards)}</strong></div><div className="receipt-row"><span>결제 잔액</span><strong data-testid="receipt-payment-spend">{money(payment.fromSpend)}</strong></div><div className="receipt-row"><span>리저브 원금</span><strong data-testid="receipt-payment-reserve">{money(payment.fromReserve)}</strong></div></div>
      <div className="receipt-reward-reconciliation"><h3>리워드 잔액 변동</h3><div className="receipt-row"><span>결제 전</span><strong data-testid="receipt-rewards-before">{money(receipt.rewardsBefore)}</strong></div><div className="receipt-row negative"><span>이번 결제 사용</span><strong data-testid="receipt-rewards-used">−{money(payment.fromRewards)}</strong></div>{receipt.otherRewardDelta !== 0 && <div className={`receipt-row${receipt.otherRewardDelta > 0 ? ' positive' : ' negative'}`}><span>처리 중 다른 리워드 변동</span><strong data-testid="receipt-rewards-other">{receipt.otherRewardDelta > 0 ? '+' : '−'}{money(Math.abs(receipt.otherRewardDelta))}</strong></div>}<div className="receipt-row positive"><span>새 페이백</span><strong data-testid="receipt-cashback-earned">{receipt.cashbackOffset === 0 ? <span data-testid="receipt-cashback-credit">+{money(receipt.cashbackCredit)}</span> : `+${money(payment.cashback)}`}</strong></div>{receipt.cashbackOffset > 0 && <><div className="receipt-row negative"><span>이전 페이백 조정</span><strong data-testid="receipt-cashback-offset">−{money(receipt.cashbackOffset)}</strong></div><div className="receipt-row receipt-credit"><span>그중 사용 가능한 적립</span><strong data-testid="receipt-cashback-credit">+{money(receipt.cashbackCredit)}</strong></div></>}<div className="receipt-row total"><span>결제 후 리워드</span><strong data-testid="receipt-rewards-after">{money(receipt.rewardsAfter)}</strong></div></div>
      <p className="small-note">리워드로 사용한 금액은 페이백 대상에서 제외됩니다.</p>{receipt.rewardsBefore === receipt.rewardsAfter && payment.fromRewards > 0 && receipt.cashbackCredit === payment.fromRewards && receipt.otherRewardDelta === 0 && <p className="receipt-explanation">사용한 리워드와 새 페이백이 같아 잔액은 동일합니다.</p>}
    </div><div className="modal-footer receipt-footer"><button className="btn primary full" onClick={onClose}>확인</button></div>
  </div></div>;
}
