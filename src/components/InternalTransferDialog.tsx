import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, ChevronLeft, X } from 'lucide-react';
import { money, shortDate } from '../lib/format';
import { POLICY } from '../lib/policy';
import type { Action, AppState } from '../lib/types';
import { AmountInput } from './ui';
import { useModal } from './useModal';
import './InternalTransferDialog.css';

export interface InternalTransferDialogProps {
  mode: 'reserve';
  direction: 'in' | 'out';
  state: AppState;
  onClose: () => void;
  dispatch: (action: Action) => AppState;
}

type Step = 'amount' | 'review' | 'completed';
interface TransferReceipt {
  amount: number;
  sourceBefore: number;
  sourceAfter: number;
  targetBefore: number;
  targetAfter: number;
  reference: string;
  timestamp: number;
}

/** Moves won between the spend balance and the Reserve; no fee, no conversion. */
export default function InternalTransferDialog({ direction, state, onClose, dispatch }: InternalTransferDialogProps) {
  const sourceName = direction === 'in' ? '지갑 잔액' : '리저브';
  const targetName = direction === 'in' ? '리저브' : '지갑 잔액';
  const title = direction === 'in' ? '리저브에 넣기' : '리저브에서 빼기';
  const available = direction === 'in' ? state.spend : state.reserve;
  const targetBefore = direction === 'in' ? state.reserve : state.spend;

  const [step, setStep] = useState<Step>('amount');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<TransferReceipt | null>(null);
  const [completionReady, setCompletionReady] = useState(false);
  const submitting = useRef(false);
  const panel = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useModal(panel, onClose, input);
  const uid = useId();
  const headingId = `${uid}-heading`;
  const inputId = `${uid}-amount`;
  const errorId = `${uid}-error`;
  const helpId = `${uid}-help`;
  const formId = `${uid}-form`;
  const amount = Number(value);

  const previewIssue = useMemo(() => {
    if (value.trim() === '') return '';
    if (!Number.isFinite(amount) || amount <= 0) return '0보다 큰 금액을 입력해 주세요.';
    if (amount > available) return '옮길 수 있는 금액보다 많아요.';
    if (!Number.isSafeInteger(amount) || amount < POLICY.minimumTopup) return '1,000원 이상, 원 단위로 입력해 주세요.';
    if (!Number.isSafeInteger(targetBefore + amount)) return '처리할 수 있는 금액을 넘었어요.';
    return '';
  }, [amount, available, targetBefore, value]);
  const valid = value.trim() !== '' && previewIssue === '';
  const issue = error || previewIssue;
  const canProceed = valid && !busy;

  useEffect(() => {
    const focusTimer = setTimeout(() => { if (step === 'amount') input.current?.focus(); else heading.current?.focus(); }, 0);
    // A second tap on the confirmation position must not dismiss the receipt.
    const readyTimer = step === 'completed' ? setTimeout(() => setCompletionReady(true), 350) : null;
    return () => { clearTimeout(focusTimer); if (readyTimer !== null) clearTimeout(readyTimer); };
  }, [step]);

  function updateAmount(next: string) {
    setValue(next);
    setError('');
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || step === 'completed') return;
    if (!valid) { setError(previewIssue || '금액을 입력해 주세요.'); return; }
    if (step === 'amount') { setError(''); setStep('review'); return; }
    try {
      submitting.current = true;
      setBusy(true);
      setError('');
      const next = dispatch({ type: 'TRANSFER_RESERVE', direction, amount });
      const transaction = next.transactions.find((item) => !state.transactions.some((old) => old.id === item.id));
      setReceipt({
        amount,
        sourceBefore: available,
        sourceAfter: direction === 'in' ? next.spend : next.reserve,
        targetBefore,
        targetAfter: direction === 'in' ? next.reserve : next.spend,
        reference: transaction?.id ?? `AQUA-${next.sequence}`,
        timestamp: transaction?.timestamp ?? Date.now(),
      });
      setStep('completed');
    } catch (failure) {
      submitting.current = false;
      setBusy(false);
      const message = failure instanceof Error ? failure.message : '옮기지 못했어요. 금액을 다시 확인해 주세요.';
      setError(message);
    }
  }

  const route = <div className="reserve-route" role="group" aria-label="이동 경로">
    <div><span>보내는 곳</span><strong>{sourceName}</strong></div>
    <ArrowRight size={18} aria-hidden="true" />
    <div><span>받는 곳</span><strong>{targetName}</strong></div>
  </div>;

  const balanceChanges = (sourceBefore: number, sourceAfter: number, beforeTarget: number, afterTarget: number) => (
    <table className="reserve-balances">
      <caption>잔액 변화</caption>
      <thead><tr><th scope="col">계정</th><th scope="col">이동 전</th><th scope="col">이동 후</th></tr></thead>
      <tbody>
        <tr><th scope="row">{sourceName}</th><td>{money(sourceBefore)}</td><td data-testid="transfer-source-after">{money(sourceAfter)}</td></tr>
        <tr><th scope="row">{targetName}</th><td>{money(beforeTarget)}</td><td data-testid="transfer-target-after">{money(afterTarget)}</td></tr>
      </tbody>
    </table>
  );

  return (
    <div className="itd-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="internal-transfer-dialog reserve-transfer" ref={panel} role="dialog" aria-modal="true" aria-labelledby={headingId} tabIndex={-1} data-testid="dialog-transfer">
        <header className="itd-header"><div className="reserve-heading">{step === 'review' && <button type="button" className="itd-close" data-testid="transfer-back" aria-label="이전" disabled={busy} onClick={() => { setStep('amount'); setError(''); }}><ChevronLeft size={22} /></button>}<h2 id={headingId} ref={heading} tabIndex={-1}>{step === 'completed' ? '이동 완료' : title}</h2></div><button type="button" className="itd-close" aria-label="창 닫기" onClick={onClose}><X size={20} /></button></header>

        <div className="itd-body">
          {step !== 'completed' && <form id={formId} onSubmit={submit} noValidate>
            {route}

            {step === 'amount' ? <>
              <div className="itd-amount"><label htmlFor={inputId}>이동할 금액</label><div className="itd-input"><AmountInput ref={input} id={inputId} unit="원" data-testid="action-amount" value={value} onValueChange={updateAmount} autoComplete="off" aria-invalid={Boolean(issue)} aria-describedby={issue ? errorId : helpId} /></div>{issue ? <p className="itd-field-error itd-in-place" id={errorId} role="alert">{issue}</p> : <div className="itd-available" id={helpId}><span>이동 가능</span><strong data-testid="transfer-available">{money(available)}</strong></div>}</div>
              <div className="itd-presets">{[10_000, 50_000, 100_000].map((preset) => <button type="button" key={preset} disabled={preset > available} onClick={() => updateAmount(String(preset))}>{preset.toLocaleString('ko-KR')}원</button>)}<button type="button" data-testid="transfer-max" disabled={available <= 0} onClick={() => updateAmount(String(available))}>최대</button></div>
              <dl className="itd-detail-list itd-amount-details"><div><dt>수수료</dt><dd>0원</dd></div><div><dt>최소 이동 금액</dt><dd>{money(POLICY.minimumTopup)}</dd></div></dl>
            </> : <>
              <div className="itd-review-amount"><span>이동할 금액</span><strong data-testid="transfer-review-amount">{money(amount)}</strong></div>
              <dl className="itd-detail-list"><div><dt>수수료</dt><dd>0원</dd></div></dl>
              {balanceChanges(available, Math.max(0, available - amount), targetBefore, targetBefore + amount)}
              <p className="itd-reserve-note">{direction === 'in' ? '옮긴 원금은 리저브에 남고, 보상은 결제에 쓸 리워드로 쌓여요.' : '지갑으로 옮긴 원금의 적립이 멈춰요. 이미 받은 리워드는 그대로예요.'}</p>
            </>}

            {step === 'review' && issue && <p className="itd-error" id={errorId} role="alert">{issue}</p>}
          </form>}

          {step === 'completed' && receipt && <div className="itd-completed" data-testid="transfer-completed">

            <p>{targetName === '리저브' ? '리저브로 옮겼어요.' : '잔액으로 옮겼어요.'}</p>
            <strong className="itd-result-amount">{money(receipt.targetAfter - receipt.targetBefore)}</strong>
            {route}
            <dl className="itd-detail-list"><div><dt>수수료</dt><dd>0원</dd></div></dl>
            {balanceChanges(receipt.sourceBefore, receipt.sourceAfter, receipt.targetBefore, receipt.targetAfter)}
            <dl className="itd-detail-list itd-receipt-meta"><div><dt>처리 시각</dt><dd>{shortDate(receipt.timestamp)}</dd></div><div><dt>처리 번호</dt><dd>{receipt.reference}</dd></div></dl>
          </div>}
        </div>

        <footer className="itd-footer">{step === 'amount' ? <button key="next" type="submit" form={formId} className="itd-button itd-primary" data-testid="transfer-next" disabled={!canProceed}>이동 금액 확인</button> : step === 'review' ? <button key="confirm" type="submit" form={formId} className="itd-button itd-primary" data-testid="confirm-action" disabled={!canProceed}>{busy ? '처리 중' : `${money(amount)} 옮기기`}</button> : <button key="done" type="button" className="itd-button itd-primary itd-guarded" data-testid="transfer-done" disabled={!completionReady} onClick={onClose}>확인</button>}</footer>
      </section>
    </div>
  );
}
