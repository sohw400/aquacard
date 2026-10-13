import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Check, ChevronLeft, X } from 'lucide-react';
import { money, shortDate } from '../lib/format';
import { POLICY } from '../lib/policy';
import type { Action, AppState } from '../lib/types';
import './InternalTransferDialog.css';

export interface InternalTransferDialogProps {
  mode: 'reserve';
  direction: 'in' | 'out';
  state: AppState;
  onClose: () => void;
  dispatch: (action: Action) => AppState;
  notify: (message: string, type?: 'success' | 'error' | 'info') => void;
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

const focusable = 'button:not([disabled]), input:not([disabled]), a[href], select:not([disabled]), textarea:not([disabled]), [tabindex="0"]';

/** Moves won between the spend balance and the Reserve; no fee, no conversion. */
export default function InternalTransferDialog({ direction, state, onClose, dispatch, notify }: InternalTransferDialogProps) {
  const sourceName = direction === 'in' ? '결제 잔액' : '리저브';
  const targetName = direction === 'in' ? '리저브' : '결제 잔액';
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
  const close = useRef(onClose);
  close.current = onClose;
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
    if (amount > available) return '이동할 잔액이 부족합니다.';
    if (!Number.isSafeInteger(amount) || amount < POLICY.minimumTopup) return '1,000원 이상의 정수로 입력해 주세요.';
    if (!Number.isSafeInteger(targetBefore + amount)) return '받을 잔액이 처리 한도를 넘습니다.';
    return '';
  }, [amount, available, targetBefore, value]);
  const valid = value.trim() !== '' && previewIssue === '';
  const issue = error || previewIssue;
  const canProceed = valid && !busy;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const oldOverflow = document.body.style.overflow;
    const oldPadding = document.body.style.paddingRight;
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (scrollbar > 0) document.body.style.paddingRight = `${(Number.parseFloat(getComputedStyle(document.body).paddingRight) || 0) + scrollbar}px`;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close.current();
      } else if (event.key === 'Tab') {
        const targets = Array.from(panel.current?.querySelectorAll<HTMLElement>(focusable) ?? []).filter((element) => element.getClientRects().length > 0);
        const first = targets[0];
        const last = targets[targets.length - 1];
        if (!first || !last) { event.preventDefault(); panel.current?.focus(); return; }
        const active = document.activeElement;
        if (!targets.includes(active as HTMLElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
        else if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      document.body.style.overflow = oldOverflow;
      document.body.style.paddingRight = oldPadding;
      if (previous?.isConnected) previous.focus();
    };
  }, []);

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
      const message = failure instanceof Error ? failure.message : '이동을 완료하지 못했습니다. 내용을 다시 확인해 주세요.';
      setError(message);
      notify(message, 'error');
    }
  }

  const balanceChanges = (sourceBefore: number, sourceAfter: number, beforeTarget: number, afterTarget: number) => (
    <section className="itd-balances" aria-label="잔액 변경">
      <h3>{step === 'completed' ? '변경된 잔액' : '이동 후 잔액'}</h3>
      <div className="itd-balance"><span>{sourceName}</span><div><span>{money(sourceBefore)}</span><ArrowRight size={13} aria-label="변경 후" /><strong data-testid="transfer-source-after">{money(sourceAfter)}</strong></div></div>
      <div className="itd-balance"><span>{targetName}</span><div><span>{money(beforeTarget)}</span><ArrowRight size={13} aria-label="변경 후" /><strong data-testid="transfer-target-after">{money(afterTarget)}</strong></div></div>
    </section>
  );

  return (
    <div className="itd-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="internal-transfer-dialog" ref={panel} role="dialog" aria-modal="true" aria-labelledby={headingId} tabIndex={-1} data-testid="dialog-transfer">
        <header className="itd-header"><div><h2 id={headingId} ref={heading} tabIndex={-1}>{step === 'completed' ? '이동 완료' : title}</h2>{step !== 'completed' && <p>{step === 'amount' ? '내 잔액 사이에서 이동합니다.' : '금액과 변경될 잔액을 확인해 주세요.'}</p>}</div><button type="button" className="itd-close" aria-label="창 닫기" onClick={onClose}><X size={20} /></button></header>

        <div className="itd-body">
          {step !== 'completed' && <form id={formId} onSubmit={submit} noValidate>
            <div className="itd-route"><strong>{sourceName}</strong><ArrowRight size={16} aria-label="이동 대상" /><strong>{targetName}</strong></div>

            {step === 'amount' ? <>
              <div className="itd-amount"><label htmlFor={inputId}>이동할 금액</label><div className="itd-input"><input ref={input} id={inputId} data-testid="action-amount" type="number" inputMode="numeric" min={POLICY.minimumTopup} step={1} value={value} onChange={(event) => updateAmount(event.target.value)} autoComplete="off" aria-invalid={Boolean(issue)} aria-describedby={issue ? `${helpId} ${errorId}` : helpId} /><span>원</span></div><div className="itd-available" id={helpId}><span>이동 가능</span><strong data-testid="transfer-available">{money(available)}</strong></div></div>
              <div className="itd-presets">{[10_000, 50_000, 100_000].map((preset) => <button type="button" key={preset} disabled={preset > available} onClick={() => updateAmount(String(preset))}>{preset.toLocaleString('ko-KR')}원</button>)}<button type="button" data-testid="transfer-max" disabled={available <= 0} onClick={() => updateAmount(String(available))}>최대</button></div>
              <dl className="itd-detail-list itd-amount-details"><div><dt>수수료</dt><dd>0원</dd></div><div><dt>최소 이동 금액</dt><dd>{money(POLICY.minimumTopup)}</dd></div></dl>
            </> : <>
              <div className="itd-review-amount"><span>이동할 금액</span><strong data-testid="transfer-review-amount">{money(amount)}</strong></div>
              <dl className="itd-detail-list"><div><dt>수수료</dt><dd>0원</dd></div></dl>
              {balanceChanges(available, Math.max(0, available - amount), targetBefore, targetBefore + amount)}
              <p className="itd-reserve-note">{direction === 'in' ? '이동한 금액부터 보상이 계산됩니다.' : '리저브에서 뺀 금액은 이후 보상 계산에서 제외됩니다. 이미 쌓인 보상은 유지됩니다.'}</p>
            </>}

            {issue && <p className="itd-error" id={errorId} role="alert">{issue}</p>}
            <p className="itd-demo-note">체험용 잔액에만 반영되며 실제 자금은 이동하지 않습니다.</p>
          </form>}

          {step === 'completed' && receipt && <div className="itd-completed" data-testid="transfer-completed">
            <span className="itd-result-icon"><Check size={27} strokeWidth={1.8} /></span>
            <p>{targetName === '리저브' ? '리저브로 이동했습니다.' : '결제 잔액으로 이동했습니다.'}</p>
            <strong className="itd-result-amount">{money(receipt.targetAfter - receipt.targetBefore)}</strong>
            <div className="itd-route"><strong>{sourceName}</strong><ArrowRight size={16} aria-label="이동 대상" /><strong>{targetName}</strong></div>
            <dl className="itd-detail-list"><div><dt>수수료</dt><dd>0원</dd></div></dl>
            {balanceChanges(receipt.sourceBefore, receipt.sourceAfter, receipt.targetBefore, receipt.targetAfter)}
            <dl className="itd-detail-list itd-receipt-meta"><div><dt>처리 시각</dt><dd>{shortDate(receipt.timestamp)}</dd></div><div><dt>체험 처리번호</dt><dd>{receipt.reference}</dd></div></dl>
            <p className="itd-demo-note">체험용 잔액에만 반영되었습니다. 실제 자금은 이동하지 않았습니다.</p>
          </div>}
        </div>

        <footer className="itd-footer">{step === 'amount' ? <button key="next" type="submit" form={formId} className="itd-button itd-primary" data-testid="transfer-next" disabled={!canProceed}>다음</button> : step === 'review' ? <><button key="back" type="button" className="itd-button itd-secondary" data-testid="transfer-back" disabled={busy} onClick={(event) => { event.preventDefault(); setStep('amount'); setError(''); }}>이전 <ChevronLeft size={15} /></button><button key="confirm" type="submit" form={formId} className="itd-button itd-primary" data-testid="confirm-action" disabled={!canProceed}>{busy ? '처리 중' : '이동하기'}</button></> : <button key="done" type="button" className="itd-button itd-primary" data-testid="transfer-done" disabled={!completionReady} onClick={onClose}>확인</button>}</footer>
      </section>
    </div>
  );
}
