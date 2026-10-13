import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Check, ChevronLeft, RefreshCw, X } from 'lucide-react';
import { assertFundingQuoteFresh, getFundingQuote, type FundingQuote } from '../lib/funding';
import { money, percent, shortDate } from '../lib/format';
import { ASSETS, POLICY } from '../lib/policy';
import type { Action, AppState, AssetSymbol } from '../lib/types';
import './InternalTransferDialog.css';

interface TransferCommonProps {
  state: AppState;
  onClose: () => void;
  dispatch: (action: Action) => AppState;
  notify: (message: string, type?: 'success' | 'error' | 'info') => void;
}

export type InternalTransferDialogProps = TransferCommonProps & (
  | { mode: 'reserve'; direction: 'in' | 'out' }
  | { mode: 'convert'; symbol: AssetSymbol }
);

type Step = 'amount' | 'review' | 'completed';
interface TransferReceipt {
  amount: number;
  quote: FundingQuote | null;
  sourceBefore: number;
  sourceAfter: number;
  targetBefore: number;
  targetAfter: number;
  reference: string;
  timestamp: number;
}

const unitsText = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 10 });
const focusable = 'button:not([disabled]), input:not([disabled]), a[href], select:not([disabled]), textarea:not([disabled]), [tabindex="0"]';

export default function InternalTransferDialog(props: InternalTransferDialogProps) {
  const { state, onClose, dispatch, notify } = props;
  const conversion = props.mode === 'convert';
  const symbol = props.mode === 'convert' ? props.symbol : 'USDC';
  const direction = props.mode === 'reserve' ? props.direction : 'in';
  const sourceName = conversion ? symbol : direction === 'in' ? '결제 잔액' : '리저브';
  const targetName = conversion || direction === 'out' ? '결제 잔액' : '리저브';
  const title = conversion ? `${symbol} 전환` : direction === 'in' ? '리저브에 넣기' : '리저브에서 빼기';
  const available = conversion ? state.holdings[symbol] : direction === 'in' ? state.spend : state.reserve;
  const targetBefore = conversion || direction === 'out' ? state.spend : state.reserve;

  const [step, setStep] = useState<Step>('amount');
  const [value, setValue] = useState('');
  const [quotedAt, setQuotedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
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

  const preview = useMemo<{ quote: FundingQuote | null; issue: string }>(() => {
    if (value.trim() === '') return { quote: null, issue: '' };
    if (!Number.isFinite(amount) || amount <= 0) return { quote: null, issue: conversion ? '0보다 큰 수량을 입력해 주세요.' : '0보다 큰 금액을 입력해 주세요.' };
    if (amount > available) return { quote: null, issue: conversion ? '전환할 코인 잔액이 부족합니다.' : '이동할 잔액이 부족합니다.' };
    if (!conversion) {
      if (!Number.isSafeInteger(amount) || amount < POLICY.minimumTopup) return { quote: null, issue: '1,000원 이상의 정수로 입력해 주세요.' };
      if (!Number.isSafeInteger(targetBefore + amount)) return { quote: null, issue: '받을 잔액이 처리 한도를 넘습니다.' };
      return { quote: null, issue: '' };
    }
    try {
      const quote = getFundingQuote({ direction: 'receive', symbol, units: amount });
      if (!Number.isSafeInteger(targetBefore + quote.netWon)) return { quote: null, issue: '받을 잔액이 처리 한도를 넘습니다.' };
      return { quote, issue: '' };
    } catch (issue) {
      const message = issue instanceof Error ? issue.message.replace(/입출금|입금/g, '전환') : '전환할 수량을 확인해 주세요.';
      return { quote: null, issue: message };
    }
  }, [amount, available, conversion, symbol, targetBefore, value]);
  const quote = preview.quote;
  const seconds = quotedAt === null ? 0 : Math.max(0, Math.ceil((POLICY.quoteTtlSeconds * 1_000 - (now - quotedAt)) / 1_000));
  const expired = conversion && quote !== null && seconds === 0;
  const valid = value.trim() !== '' && preview.issue === '' && (!conversion || quote !== null);
  const issue = error || preview.issue;
  const canProceed = valid && !expired && !busy;
  const projectedSource = Math.max(0, available - amount);
  const projectedTarget = targetBefore + (conversion ? quote?.netWon ?? 0 : amount);
  const sourceText = (number: number) => conversion ? `${unitsText(number)} ${symbol}` : money(number);

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

  useEffect(() => {
    if (!conversion || quotedAt === null || step === 'completed') return;
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, [conversion, quotedAt, step]);

  function updateAmount(next: string) {
    setValue(next);
    setError('');
    if (conversion) { const time = Date.now(); setQuotedAt(time); setNow(time); }
  }

  function refreshQuote() {
    const time = Date.now();
    setQuotedAt(time);
    setNow(time);
    setError('');
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || step === 'completed') return;
    if (!valid) { setError(preview.issue || '금액을 입력해 주세요.'); return; }
    if (conversion && (quotedAt === null || Date.now() - quotedAt >= POLICY.quoteTtlSeconds * 1_000)) {
      setNow(Date.now());
      setError('견적이 만료되었습니다. 새 견적을 확인해 주세요.');
      return;
    }
    if (step === 'amount') { setError(''); setStep('review'); return; }

    try {
      if (conversion) assertFundingQuoteFresh(quotedAt as number);
      submitting.current = true;
      setBusy(true);
      setError('');
      const next = dispatch(conversion
        ? { type: 'CONVERT', symbol, units: amount, quotedAt: quotedAt as number }
        : { type: 'TRANSFER_RESERVE', direction, amount });
      const transaction = next.transactions.find((item) => !state.transactions.some((old) => old.id === item.id));
      setReceipt({
        amount, quote,
        sourceBefore: available,
        sourceAfter: conversion ? next.holdings[symbol] : direction === 'in' ? next.spend : next.reserve,
        targetBefore,
        targetAfter: conversion || direction === 'out' ? next.spend : next.reserve,
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

  const quoteBreakdown = (current: FundingQuote, showClock: boolean) => (
    <section className="itd-quote" aria-label="전환 견적">
      <div className="itd-section-title"><h3>전환 견적</h3>{showClock && <div className="itd-clock"><span className={expired ? 'expired' : ''} data-testid="quote-ttl">{seconds > 0 ? `${seconds}초 유효` : '견적 만료'}</span><button type="button" className="itd-refresh" data-testid="refresh-quote" aria-label="견적 갱신" onClick={refreshQuote}><RefreshCw size={14} />갱신</button></div>}</div>
      <dl className="itd-detail-list"><div><dt>평가액</dt><dd data-testid="quote-gross">{money(current.grossWon)}</dd></div><div><dt>수수료 {percent(POLICY.conversionFee)}</dt><dd data-testid="quote-fee">{money(current.feeWon)}</dd></div><div className="itd-net-row"><dt>받을 결제 잔액</dt><dd data-testid="quote-net">{money(current.netWon)}</dd></div></dl>
      {expired && showClock && <p className="itd-expired" role="status">견적을 갱신한 뒤 전환할 수 있습니다.</p>}
    </section>
  );

  const balanceChanges = (sourceBefore: number, sourceAfter: number, beforeTarget: number, afterTarget: number) => (
    <section className="itd-balances" aria-label="잔액 변경">
      <h3>{step === 'completed' ? '변경된 잔액' : '이동 후 잔액'}</h3>
      <div className="itd-balance"><span>{sourceName}</span><div><span>{sourceText(sourceBefore)}</span><ArrowRight size={13} aria-label="변경 후" /><strong data-testid="transfer-source-after">{sourceText(sourceAfter)}</strong></div></div>
      <div className="itd-balance"><span>{targetName}</span><div><span>{money(beforeTarget)}</span><ArrowRight size={13} aria-label="변경 후" /><strong data-testid="transfer-target-after">{money(afterTarget)}</strong></div></div>
    </section>
  );

  return (
    <div className="itd-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="internal-transfer-dialog" ref={panel} role="dialog" aria-modal="true" aria-labelledby={headingId} tabIndex={-1} data-testid={conversion ? 'dialog-convert' : 'dialog-transfer'}>
        <header className="itd-header"><div><h2 id={headingId} ref={heading} tabIndex={-1}>{step === 'completed' ? conversion ? '전환 완료' : '이동 완료' : title}</h2>{step !== 'completed' && <p>{step === 'amount' ? conversion ? '전환할 코인 수량을 입력해 주세요.' : '내 잔액 사이에서 이동합니다.' : '금액과 변경될 잔액을 확인해 주세요.'}</p>}</div><button type="button" className="itd-close" aria-label="창 닫기" onClick={onClose}><X size={20} /></button></header>

        <div className="itd-body">
          {step !== 'completed' && <form id={formId} onSubmit={submit} noValidate>
            <div className="itd-route"><strong>{sourceName}</strong><ArrowRight size={16} aria-label="이동 대상" /><strong>{targetName}</strong></div>

            {step === 'amount' ? <>
              <div className="itd-amount"><label htmlFor={inputId}>{conversion ? '전환할 수량' : '이동할 금액'}</label><div className="itd-input"><input ref={input} id={inputId} data-testid="action-amount" type="number" inputMode={conversion ? 'decimal' : 'numeric'} min={conversion ? '0' : POLICY.minimumTopup} step={conversion ? 'any' : 1} value={value} onChange={(event) => updateAmount(event.target.value)} autoComplete="off" aria-invalid={Boolean(issue)} aria-describedby={issue ? `${helpId} ${errorId}` : helpId} /><span>{conversion ? symbol : '원'}</span></div><div className="itd-available" id={helpId}><span>{conversion ? '보유 수량' : '이동 가능'}</span><strong data-testid="transfer-available">{sourceText(available)}</strong></div></div>
              <div className="itd-presets">{!conversion && [10_000, 50_000, 100_000].map((preset) => <button type="button" key={preset} disabled={preset > available} onClick={() => updateAmount(String(preset))}>{preset.toLocaleString('ko-KR')}원</button>)}<button type="button" data-testid="transfer-max" disabled={available <= 0} onClick={() => updateAmount(String(available))}>최대</button></div>
              {conversion ? <p className="itd-help">모의 시세 · 1 {symbol} = {money(ASSETS[symbol].price)}<br />평가액 {money(POLICY.minimumConversion)}부터 전환할 수 있습니다.</p> : <dl className="itd-detail-list itd-amount-details"><div><dt>수수료</dt><dd>0원</dd></div><div><dt>최소 이동 금액</dt><dd>{money(POLICY.minimumTopup)}</dd></div></dl>}
              {conversion && quote && quoteBreakdown(quote, true)}
            </> : <>
              <div className="itd-review-amount"><span>{conversion ? '전환할 수량' : '이동할 금액'}</span><strong data-testid="transfer-review-amount">{conversion ? <>{unitsText(amount)}<small>{symbol}</small></> : money(amount)}</strong></div>
              {conversion && quote ? quoteBreakdown(quote, true) : <dl className="itd-detail-list"><div><dt>수수료</dt><dd>0원</dd></div></dl>}
              {balanceChanges(available, projectedSource, targetBefore, projectedTarget)}
              {!conversion && <p className="itd-reserve-note">{direction === 'in' ? '이동한 금액부터 보상이 계산됩니다.' : '리저브에서 뺀 금액은 이후 보상 계산에서 제외됩니다. 이미 쌓인 보상은 유지됩니다.'}</p>}
            </>}

            {issue && <p className="itd-error" id={errorId} role="alert">{issue}</p>}
            <p className="itd-demo-note">체험용 잔액에만 반영되며 실제 자금은 이동하지 않습니다.</p>
          </form>}

          {step === 'completed' && receipt && <div className="itd-completed" data-testid="transfer-completed">
            <span className="itd-result-icon"><Check size={27} strokeWidth={1.8} /></span>
            <p>{conversion ? '결제 잔액으로 전환했습니다.' : targetName === '리저브' ? '리저브로 이동했습니다.' : '결제 잔액으로 이동했습니다.'}</p>
            <strong className="itd-result-amount">{money(receipt.targetAfter - receipt.targetBefore)}</strong>
            <div className="itd-route"><strong>{sourceName}</strong><ArrowRight size={16} aria-label="이동 대상" /><strong>{targetName}</strong></div>
            {receipt.quote ? quoteBreakdown(receipt.quote, false) : <dl className="itd-detail-list"><div><dt>수수료</dt><dd>0원</dd></div></dl>}
            {balanceChanges(receipt.sourceBefore, receipt.sourceAfter, receipt.targetBefore, receipt.targetAfter)}
            <dl className="itd-detail-list itd-receipt-meta">{conversion && <div><dt>전환 수량</dt><dd>{unitsText(receipt.amount)} {symbol}</dd></div>}<div><dt>처리 시각</dt><dd>{shortDate(receipt.timestamp)}</dd></div><div><dt>체험 처리번호</dt><dd>{receipt.reference}</dd></div></dl>
            <p className="itd-demo-note">체험용 잔액에만 반영되었습니다. 실제 자금은 이동하지 않았습니다.</p>
          </div>}
        </div>

        <footer className="itd-footer">{step === 'amount' ? <button key="next" type="submit" form={formId} className="itd-button itd-primary" data-testid="transfer-next" disabled={!canProceed}>다음</button> : step === 'review' ? <><button key="back" type="button" className="itd-button itd-secondary" data-testid="transfer-back" disabled={busy} onClick={(event) => { event.preventDefault(); setStep('amount'); setError(''); }}>이전 <ChevronLeft size={15} /></button><button key="confirm" type="submit" form={formId} className="itd-button itd-primary" data-testid="confirm-action" disabled={!canProceed}>{busy ? '처리 중' : conversion ? '전환하기' : '이동하기'}</button></> : <button key="done" type="button" className="itd-button itd-primary" data-testid="transfer-done" disabled={!completionReady} onClick={onClose}>확인</button>}</footer>
      </section>
    </div>
  );
}
