import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Info, RefreshCw, X } from 'lucide-react';
import { assertFundingQuoteFresh, getFundingQuote, type FundingQuote } from '../lib/funding';
import { money, percent, won } from '../lib/format';
import { ASSETS, POLICY } from '../lib/policy';
import type { Action, AppState, AssetSymbol } from '../lib/types';
import './FundingDialog.css';

export interface FundingDialogProps {
  mode: 'deposit' | 'withdraw';
  symbol?: AssetSymbol;
  state: AppState;
  onClose: () => void;
  dispatch: (action: Action) => AppState;
  notify: (message: string, type?: 'success' | 'error' | 'info') => void;
}

const SYMBOLS: AssetSymbol[] = ['USDC', 'USDT', 'BTC', 'ETH'];
const GLYPHS: Record<AssetSymbol, string> = { USDC: '$', USDT: '₮', BTC: '₿', ETH: 'Ξ' };
const defaultUnits = (symbol: AssetSymbol) => symbol === 'BTC' ? '0.0001' : symbol === 'ETH' ? '0.01' : '10';
const unitsText = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 8 });

export default function FundingDialog({ mode, symbol: initialSymbol = 'USDC', state, onClose, dispatch, notify }: FundingDialogProps) {
  const [symbol, setSymbol] = useState<AssetSymbol>(initialSymbol);
  const [method, setMethod] = useState<'coin' | 'demo'>('coin');
  const [cryptoInput, setCryptoInput] = useState(mode === 'withdraw' ? '10000' : defaultUnits(initialSymbol));
  const [demoInput, setDemoInput] = useState('100000');
  const [quotedAt, setQuotedAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const uid = useId();
  const headingId = `${uid}-heading`;
  const formId = `${uid}-form`;
  const inputId = `${uid}-amount`;
  const errorId = `${uid}-error`;
  const panelId = `${uid}-method-panel`;
  const demo = mode === 'deposit' && method === 'demo';
  const value = demo ? demoInput : cryptoInput;
  const amount = Number(value);
  const seconds = Math.max(0, POLICY.quoteTtlSeconds - Math.floor((now - quotedAt) / 1_000));
  const network = ASSETS[symbol].network.replace(/\s*·\s*데모$/, '');

  const preview = useMemo<{ quote: FundingQuote | null; issue: string }>(() => {
    if (demo) return { quote: null, issue: '' };
    try {
      return { quote: getFundingQuote(mode === 'deposit' ? { direction: 'receive', symbol, units: amount } : { direction: 'withdraw', symbol, amount }), issue: '' };
    } catch (issue) {
      return { quote: null, issue: issue instanceof Error ? issue.message : '입력 내용을 확인해 주세요.' };
    }
  }, [demo, mode, symbol, amount]);
  const quote = preview.quote;
  const demoValid = Number.isSafeInteger(amount) && amount >= POLICY.minimumTopup;
  const insufficient = mode === 'withdraw' && quote !== null && quote.grossWon > state.spend;
  const invalidMessage = value !== '' ? demo ? demoValid ? '' : '최소 1,000원 이상의 정수로 입력해 주세요.' : preview.issue : '';
  const activeError = error || (insufficient ? '결제 잔액이 부족합니다. 리저브 금액은 먼저 결제 잔액으로 옮겨 주세요.' : invalidMessage);
  const disabled = submitting || (demo ? !demoValid : !quote || seconds === 0 || insufficient);
  const confirmationAmount = demo && demoValid ? amount : mode === 'deposit' ? quote?.netWon : quote?.grossWon;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusTimer = setTimeout(() => inputRef.current?.focus(), 0);
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape') closeRef.current();
      if (event.key === 'Tab') {
        const targets = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]') ?? []);
        const first = targets[0]; const last = targets[targets.length - 1];
        if (!first) return;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener('keydown', keydown);
    return () => { clearTimeout(focusTimer); document.body.style.overflow = overflow; document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, []);

  useEffect(() => {
    if (demo) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [demo]);

  function renewQuote() {
    const time = Date.now();
    setQuotedAt(time); setNow(time); setError('');
  }
  function selectSymbol(next: AssetSymbol) {
    setSymbol(next);
    if (mode === 'deposit') setCryptoInput(defaultUnits(next));
    renewQuote();
  }
  function updateValue(next: string) {
    if (demo) setDemoInput(next); else setCryptoInput(next);
    renewQuote();
  }
  function selectMethod(next: 'coin' | 'demo') {
    setMethod(next); renewQuote();
    requestAnimationFrame(() => inputRef.current?.focus());
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    if (submitting) return;
    try {
      if (demo) {
        if (!demoValid) throw new Error('충전 금액은 1,000원 이상의 정수로 입력해 주세요.');
        setSubmitting(true);
        dispatch({ type: 'DEPOSIT', bucket: 'spend', amount });
        notify(`원화 결제 잔액 ${money(amount)}을 충전했습니다.`);
      } else {
        const fresh = getFundingQuote(mode === 'deposit' ? { direction: 'receive', symbol, units: amount } : { direction: 'withdraw', symbol, amount });
        assertFundingQuoteFresh(quotedAt);
        setSubmitting(true);
        dispatch(mode === 'deposit' ? { type: 'RECEIVE_ASSET', symbol, units: amount, quotedAt } : { type: 'WITHDRAW_CRYPTO', symbol, amount, quotedAt });
        notify(mode === 'deposit' ? `${symbol} 입금분을 원화 ${money(fresh.netWon)}으로 충전했습니다.` : `${money(fresh.grossWon)} 출금 처리 · 예상 ${unitsText(fresh.outputUnits)} ${symbol}`);
      }
      onClose();
    } catch (issue) {
      setSubmitting(false);
      setError(issue instanceof Error ? issue.message : '입력 내용을 확인해 주세요.');
    }
  }

  return <div className="funding-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="funding-dialog" ref={ref} role="dialog" aria-modal="true" aria-labelledby={headingId} data-testid="dialog-funding">
    <header className="funding-header"><div><h2 id={headingId}>{mode === 'deposit' ? '충전' : '출금'}</h2><p>{mode === 'deposit' ? '입금 코인을 원화 결제 잔액으로 전환합니다.' : '원화 결제 잔액을 선택한 코인으로 출금합니다.'}</p></div><button type="button" className="funding-close" aria-label="창 닫기" onClick={onClose}><X size={21} /></button></header>
    <div className="funding-body">
      {mode === 'deposit' && <div className="funding-methods" role="tablist" aria-label="충전 방법"><button type="button" role="tab" id={`${uid}-coin-tab`} aria-selected={!demo} aria-controls={panelId} className={!demo ? 'selected' : ''} data-testid="funding-method-coin" onClick={() => selectMethod('coin')}>코인 충전</button><button type="button" role="tab" id={`${uid}-demo-tab`} aria-selected={demo} aria-controls={panelId} className={demo ? 'selected' : ''} data-testid="funding-method-demo" onClick={() => selectMethod('demo')}>원화로 체험 충전</button></div>}
      <form id={formId} onSubmit={submit} noValidate><div id={panelId} role={mode === 'deposit' ? 'tabpanel' : undefined} aria-labelledby={mode === 'deposit' ? `${uid}-${demo ? 'demo' : 'coin'}-tab` : undefined}>
        {!demo && <><div className="funding-field-label">{mode === 'deposit' ? '입금할 코인' : '받을 코인'}</div><div className="funding-assets" role="group" aria-label="코인 선택">{SYMBOLS.map((asset) => <button type="button" className={`funding-asset${symbol === asset ? ' selected' : ''}`} key={asset} data-testid={`funding-asset-${asset}`} aria-pressed={symbol === asset} onClick={() => selectSymbol(asset)}><span className="funding-coin" style={{ background: ASSETS[asset].color }} aria-hidden="true">{GLYPHS[asset]}</span>{asset}</button>)}</div><div className="funding-network"><span>네트워크</span><strong data-testid="funding-network">{network}</strong></div></>}
        <div className="funding-amount"><label htmlFor={inputId}>{demo ? '충전할 금액' : mode === 'deposit' ? '입금할 수량' : '출금할 금액'}</label><div className="funding-amount-input"><input id={inputId} ref={inputRef} data-testid="action-amount" type="number" inputMode={!demo && mode === 'deposit' ? 'decimal' : 'numeric'} min={!demo && mode === 'deposit' ? '0.00000001' : POLICY.minimumTopup} step={!demo && mode === 'deposit' ? 'any' : 1} value={value} onChange={(event) => updateValue(event.target.value)} autoComplete="off" aria-invalid={Boolean(activeError)} aria-describedby={activeError ? errorId : undefined} /><span>{!demo && mode === 'deposit' ? symbol : '원'}</span></div><div className="funding-amount-help">{mode === 'withdraw' ? <span>출금 가능 <strong>{money(state.spend)}</strong></span> : demo ? <span>체험용 원화 잔액 · 최소 1,000원</span> : <span>모의 시세 · 1 {symbol} = {money(ASSETS[symbol].price)}</span>}</div></div>
        {demo && <div className="funding-presets">{[10_000, 50_000, 100_000].map((preset) => <button type="button" key={preset} onClick={() => updateValue(String(preset))}>{won(preset)}원</button>)}</div>}
        <div className="funding-quote"><div className="funding-quote-header"><h3>{mode === 'deposit' ? '충전 내역' : '출금 내역'}</h3>{!demo && <div className="funding-quote-clock"><span className={seconds === 0 ? 'expired' : ''} data-testid="quote-ttl">{seconds > 0 ? `${seconds}초 유효` : '견적 만료'}</span><button type="button" aria-label="견적 갱신" data-testid="refresh-quote" onClick={renewQuote}><RefreshCw size={14} />갱신</button></div>}</div>
          <dl><div className="funding-quote-row"><dt>{mode === 'deposit' ? demo ? '충전 금액' : '입금 평가액' : '차감할 원화'}</dt><dd data-testid="quote-gross">{demo && demoValid ? money(amount) : quote ? money(quote.grossWon) : '—'}</dd></div><div className="funding-quote-row"><dt>수수료 {!demo && percent(POLICY.conversionFee)}</dt><dd data-testid="quote-fee">{demo ? money(0) : quote ? `−${money(quote.feeWon)}` : '—'}</dd></div>{mode === 'withdraw' && <div className="funding-quote-row"><dt>코인으로 전환할 원화</dt><dd data-testid="quote-net">{quote ? money(quote.netWon) : '—'}</dd></div>}<div className="funding-quote-total"><dt>{mode === 'deposit' ? '받을 원화 결제 잔액' : `예상 수령 ${symbol}`}</dt><dd>{mode === 'deposit' ? <span data-testid="quote-net">{demo && demoValid ? money(amount) : quote ? money(quote.netWon) : '—'}</span> : <><span data-testid="quote-units">{quote ? unitsText(quote.outputUnits) : '—'}</span><small>{symbol}</small></>}</dd></div></dl>
          {!demo && mode === 'deposit' && <div className="funding-route"><span><span data-testid="quote-units">{quote ? unitsText(quote.inputUnits) : '—'}</span> {symbol}</span><ArrowRight size={13} /><span>원화 결제 잔액</span></div>}
        </div>
        {activeError && <div className="funding-error" id={errorId} role="alert"><Info size={16} /><span>{activeError}</span></div>}
        <p className="funding-demo-note"><Info size={14} />모의 입출금입니다. 실제 송금은 실행하지 않습니다.</p>
      </div></form>
    </div>
    <footer className="funding-footer"><button type="submit" form={formId} className="funding-confirm" data-testid="confirm-action" disabled={disabled}>{submitting ? '처리 중' : confirmationAmount !== undefined ? `${money(confirmationAmount)} ${mode === 'deposit' ? '충전' : '출금'}` : '금액을 입력하세요'}<ArrowRight size={18} /></button></footer>
  </section></div>;
}
