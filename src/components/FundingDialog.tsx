import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, Copy, RefreshCw, X } from 'lucide-react';
import { assertFundingQuoteFresh } from '../lib/funding';
import { money, percent, shortDate } from '../lib/format';
import {
  createFundingQuote, fundingStatusLabel, getFundingNetworks, isFundingPending,
  validateFundingAddress, type FundingMovementQuote,
} from '../lib/movements';
import { ASSETS, POLICY } from '../lib/policy';
import type { Action, AppState, AssetSymbol, FundingNetwork, FundingOperation } from '../lib/types';
import './FundingDialog.css';

export interface FundingDialogProps {
  mode: 'deposit' | 'withdraw';
  symbol?: AssetSymbol;
  source?: 'spend' | 'holdings';
  operationId?: string;
  onOperationCreated?: (id: string) => void;
  state: AppState;
  onClose: () => void;
  dispatch: (action: Action) => AppState;
  notify: (message: string, type?: 'success' | 'error' | 'info') => void;
}

type Step = 'asset' | 'details' | 'review';
type FieldErrors = { amount?: string; recipient?: string; address?: string; general?: string };
const SYMBOLS: AssetSymbol[] = ['USDC', 'USDT', 'BTC', 'ETH'];
const unitsText = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 8 });
const requestIdentifier = () => globalThis.crypto?.randomUUID?.() ?? `aqua-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const previewAddress = (symbol: AssetSymbol, network: FundingNetwork) => `aqua-preview:${network}:${symbol.toLowerCase()}`;

export default function FundingDialog({ mode, symbol: initialSymbol = 'USDC', source = 'spend', operationId, onOperationCreated, state, onClose, dispatch, notify }: FundingDialogProps) {
  const initialOperation = operationId ? state.fundingOperations.find((operation) => operation.id === operationId) : undefined;
  const [formMode, setFormMode] = useState<'deposit' | 'withdraw'>(initialOperation ? initialOperation.kind === 'deposit' ? 'deposit' : 'withdraw' : mode);
  const [formSource, setFormSource] = useState<'spend' | 'holdings'>(initialOperation?.source ?? (mode === 'deposit' ? 'spend' : source));
  const [symbol, setSymbol] = useState<AssetSymbol>(initialOperation?.symbol ?? initialSymbol);
  const [network, setNetwork] = useState<FundingNetwork>(initialOperation?.network ?? getFundingNetworks(initialSymbol)[0].id);
  const [step, setStep] = useState<Step>('asset');
  const [amountInput, setAmountInput] = useState('');
  const [recipient, setRecipient] = useState('');
  const [address, setAddress] = useState('');
  const [consent, setConsent] = useState(false);
  const [simulation, setSimulation] = useState<'success' | 'failure'>('success');
  const [quote, setQuote] = useState<FundingMovementQuote | null>(null);
  const [quotedAt, setQuotedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [requestId, setRequestId] = useState(requestIdentifier);
  const [retryOf, setRetryOf] = useState<string | undefined>();
  const [currentOperationId, setCurrentOperationId] = useState(operationId);
  const [showForm, setShowForm] = useState(!operationId);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [copyFeedback, setCopyFeedback] = useState<{ text: string; failed: boolean } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const uid = useId();
  const formId = `${uid}-form`;
  const headingId = `${uid}-heading`;
  const amountId = `${uid}-amount`;
  const addressId = `${uid}-address`;
  const recipientId = `${uid}-recipient`;
  const operation = !showForm && currentOperationId ? state.fundingOperations.find((item) => item.id === currentOperationId) : undefined;
  const missingOperation = !showForm && !operation;
  const depositing = formMode === 'deposit';
  const usingUnits = depositing || formSource === 'holdings';
  const networks = getFundingNetworks(symbol);
  const selectedNetwork = networks.find((option) => option.id === network)!;
  const amount = Number(amountInput);
  const available = formSource === 'holdings' ? state.holdings[symbol] : state.spend;
  const seconds = quotedAt === null ? null : Math.max(0, POLICY.quoteTtlSeconds - Math.floor((now - quotedAt) / 1_000));
  const expired = seconds === 0;
  const sampleAddress = previewAddress(symbol, network);
  const draftQuote = useMemo<{ value: FundingMovementQuote | null; error: string }>(() => {
    if (!amountInput.trim()) return { value: null, error: '' };
    try {
      return { value: createFundingQuote({ kind: depositing ? 'deposit' : 'withdrawal', symbol, network, source: depositing ? 'spend' : formSource, ...(usingUnits ? { units: amount } : { amount }) }), error: '' };
    } catch (issue) { return { value: null, error: issue instanceof Error ? issue.message : '금액을 확인해 주세요.' }; }
  }, [amountInput, amount, depositing, symbol, network, formSource, usingUnits]);
  const insufficient = !depositing && draftQuote.value !== null && (formSource === 'holdings' ? draftQuote.value.units > available : draftQuote.value.amountWon > available);
  const amountIssue = errors.amount || draftQuote.error || (insufficient ? '출금할 잔액이 부족합니다.' : '');
  const displayedQuote = quote ?? draftQuote.value;

  useEffect(() => {
    if (!operationId) return;
    setCurrentOperationId(operationId);
    setShowForm(false);
  }, [operationId]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const timer = setTimeout(() => headingRef.current?.focus(), 0);
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape') closeRef.current();
      if (event.key === 'Tab') {
        const targets = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex="0"]') ?? []).filter((element) => element.getClientRects().length > 0);
        const first = targets[0]; const last = targets[targets.length - 1];
        if (!first) return;
        if (!targets.includes(document.activeElement as HTMLElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
        else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener('keydown', keydown);
    return () => { clearTimeout(timer); document.body.style.overflow = overflow; document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, []);

  useEffect(() => {
    if (quotedAt === null || !showForm) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [quotedAt, showForm]);

  useEffect(() => {
    const timer = requestAnimationFrame(() => {
      ref.current?.querySelector('.funding-body')?.scrollTo({ top: 0 });
      headingRef.current?.focus();
    });
    return () => cancelAnimationFrame(timer);
  }, [step, showForm, currentOperationId]);

  function moveTo(next: Step) {
    setStep(next);
    setErrors({});
    setCopyFeedback(null);
    requestAnimationFrame(() => headingRef.current?.focus());
  }
  function clearQuote() { setQuote(null); setQuotedAt(null); setErrors({}); }
  function chooseAsset(next: AssetSymbol) {
    setSymbol(next); setNetwork(getFundingNetworks(next)[0].id);
    setAmountInput(''); setAddress(''); setConsent(false); clearQuote();
  }
  function chooseNetwork(next: FundingNetwork) { setNetwork(next); setAddress(''); setConsent(false); clearQuote(); }
  function editAmount(value: string) { setAmountInput(value); clearQuote(); }
  function maxAmount() { editAmount(String(available)); }
  async function copy(value: string, message: string) {
    setCopyFeedback(null);
    try { await navigator.clipboard.writeText(value); setCopyFeedback({ text: message, failed: false }); }
    catch { setCopyFeedback({ text: '복사하지 못했습니다. 내용을 직접 선택해 주세요.', failed: true }); }
  }
  function validateDetails(): boolean {
    const next: FieldErrors = {};
    if (!amountInput.trim()) next.amount = usingUnits ? '수량을 입력해 주세요.' : '출금할 금액을 입력해 주세요.';
    else if (draftQuote.error) next.amount = draftQuote.error;
    else if (insufficient) next.amount = '출금할 잔액이 부족합니다.';
    if (!depositing) {
      if (!recipient.trim()) next.recipient = '받는 사람을 입력해 주세요.';
      const addressIssue = validateFundingAddress(symbol, network, address);
      if (addressIssue) next.address = addressIssue;
    }
    setErrors(next);
    if (Object.keys(next).length) {
      const field = next.recipient ? recipientId : next.address ? addressId : amountId;
      requestAnimationFrame(() => document.getElementById(field)?.focus());
      return false;
    }
    return true;
  }
  function acceptQuote(advance = false) {
    if (!validateDetails() || !draftQuote.value) return;
    const time = Date.now();
    setQuote(draftQuote.value); setQuotedAt(time); setNow(time); setErrors({});
    if (advance) moveTo('review');
  }
  function next() {
    if (step === 'asset') { moveTo('details'); return; }
    acceptQuote(!depositing);
  }
  function back() {
    if (step === 'review') { clearQuote(); setConsent(false); moveTo('details'); }
    else { clearQuote(); setConsent(false); moveTo('asset'); }
  }
  function start() {
    if (submittingRef.current) return;
    if (!quote || quotedAt === null) { setErrors({ general: '견적을 먼저 확인해 주세요.' }); return; }
    if (!consent) { setErrors({ general: '입출금 정보를 확인하고 동의해 주세요.' }); return; }
    try {
      assertFundingQuoteFresh(quotedAt);
      submittingRef.current = true; setSubmitting(true);
      const result = dispatch({ type: 'START_FUNDING', requestId, kind: depositing ? 'deposit' : 'withdrawal', symbol, network, source: depositing ? 'spend' : formSource, ...(usingUnits ? { units: amount } : { amount }), address: depositing ? sampleAddress : address.trim(), recipient: depositing ? '내 원화 잔액' : recipient.trim(), quotedAt, simulation, ...(retryOf ? { retryOf } : {}) });
      const created = result.fundingOperations.find((item) => item.requestId === requestId);
      if (!created) throw new Error('요청 내역을 찾을 수 없습니다. 입출금 현황을 확인해 주세요.');
      setCurrentOperationId(created.id); setShowForm(false);
      setCopyFeedback(null);
      onOperationCreated?.(created.id);
      notify(depositing ? '입금 대기 요청을 등록했습니다.' : '출금 요청을 접수했습니다.');
    } catch (issue) {
      setErrors({ general: issue instanceof Error ? issue.message : '요청 내용을 확인해 주세요.' });
    } finally { submittingRef.current = false; setSubmitting(false); }
  }
  function operate(action: Action, message: string) {
    if (submittingRef.current) return;
    try { submittingRef.current = true; setSubmitting(true); dispatch(action); setErrors({}); notify(message); }
    catch (issue) { setErrors({ general: issue instanceof Error ? issue.message : '처리 상태를 확인해 주세요.' }); }
    finally { submittingRef.current = false; setSubmitting(false); }
  }
  function retry(previous: FundingOperation) {
    setFormMode(previous.kind === 'deposit' ? 'deposit' : 'withdraw');
    setFormSource(previous.source); setSymbol(previous.symbol); setNetwork(previous.network);
    setRetryOf(previous.id); setRequestId(requestIdentifier());
    setAmountInput(''); setAddress(''); setRecipient(''); setConsent(false); setSimulation('success');
    setCurrentOperationId(undefined); setShowForm(true); clearQuote(); moveTo('asset');
  }

  const title = operation ? operation.status === 'completed' ? operation.kind === 'deposit' ? '입금 완료' : '출금 완료' : operation.status === 'failed' ? '처리 실패' : operation.status === 'cancelled' ? '요청 취소' : operation.kind === 'deposit' ? '입금 현황' : '출금 현황'
    : missingOperation ? '입출금 내역' : step === 'asset' ? depositing ? '입금할 자산 선택' : '출금할 자산 선택' : step === 'review' ? '출금 정보 확인' : depositing ? '입금 정보 확인' : '출금 정보 입력';
  const cancellable = operation?.status === 'awaiting_deposit' || operation?.status === 'reviewing';
  const readyToStart = showForm && (step === 'review' || depositing && step === 'details' && quote !== null);

  function quoteSummary(value: FundingMovementQuote | null) {
    return <div className="funding-quote"><div className="funding-quote-header"><h3>{depositing ? '원화 반영 금액' : '수수료와 수령 금액'}</h3><div className="funding-quote-clock"><span data-testid="quote-ttl" className={expired ? 'expired' : ''}>{seconds === null ? '견적 확인 필요' : expired ? '견적 만료' : `${seconds}초 유효`}</span><button type="button" aria-label="견적 갱신" data-testid="refresh-quote" onClick={() => acceptQuote()}><RefreshCw size={14} />{seconds === null ? '확인' : '갱신'}</button></div></div><dl>
      <div className="funding-quote-row"><dt>{depositing ? '입금 평가액' : formSource === 'holdings' ? '출금 평가액' : '총 차감 원화'}</dt><dd data-testid="quote-gross">{value ? money(value.amountWon) : '입력 전'}</dd></div>
      <div className="funding-quote-row"><dt>전환 수수료 {formSource !== 'holdings' || depositing ? percent(POLICY.conversionFee) : '없음'}</dt><dd data-testid="quote-fee">{value ? money(value.feeWon) : '입력 전'}</dd></div>
      <div className="funding-quote-row"><dt>네트워크 비용 예시</dt><dd data-testid="quote-network-fee">{value ? money(value.networkFeeWon) : '입력 전'}</dd></div>
      {!depositing && <div className="funding-quote-row"><dt>수수료 제외 원화</dt><dd data-testid="quote-net">{value ? money(value.netWon) : '입력 전'}</dd></div>}
      <div className="funding-quote-total"><dt>{depositing ? '충전될 원화 잔액' : `예상 수령 ${symbol}`}</dt><dd>{depositing ? <span data-testid="quote-net">{value ? money(value.netWon) : '입력 전'}</span> : <><span data-testid="quote-units">{value ? unitsText(value.outputUnits) : '입력 전'}</span><small>{symbol}</small></>}</dd></div>
      {depositing && <div className="funding-quote-row"><dt>입금 예정 수량</dt><dd><span data-testid="quote-units">{value ? unitsText(value.units) : '입력 전'}</span> {symbol}</dd></div>}
    </dl><p className="funding-help">수수료와 처리 시간은 체험용 예시입니다.</p></div>;
  }

  function simulationControl() {
    return <details className="funding-simulation"><summary data-testid="funding-simulation-settings">처리 상황 설정</summary><div><label><input type="radio" name={`${uid}-simulation`} checked={simulation === 'success'} onChange={() => setSimulation('success')} data-testid="funding-outcome-success" />정상 완료</label><label><input type="radio" name={`${uid}-simulation`} checked={simulation === 'failure'} onChange={() => setSimulation('failure')} data-testid="funding-outcome-failure" />실패 처리</label></div></details>;
  }

  return <div className="funding-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="funding-dialog" ref={ref} role="dialog" aria-modal="true" aria-labelledby={headingId} data-testid="dialog-funding">
    <span className="sheet-handle" aria-hidden="true" />
    <header className="funding-header"><div className="funding-heading">{showForm && <span className="funding-step-label">{step === 'asset' ? 1 : step === 'details' ? 2 : 3} / {depositing ? 2 : 3}</span>}<h2 id={headingId} ref={headingRef} tabIndex={-1}>{title}</h2><span className="funding-preview-tag">체험 · 실제 송금 불가</span></div><div className="funding-header-actions">{showForm && step !== 'asset' && <button type="button" className="funding-close" data-testid="funding-back" aria-label="이전 단계" onClick={back}><ArrowLeft size={20} /></button>}<button type="button" className="funding-close" aria-label="창 닫기" onClick={onClose}><X size={21} /></button></div></header>
      {copyFeedback && <p className={`funding-copy-feedback${copyFeedback.failed ? ' failed' : ''}`} role={copyFeedback.failed ? 'alert' : 'status'}>{copyFeedback.text}</p>}
    <form id={formId} className="funding-body" noValidate onSubmit={(event) => { event.preventDefault(); if (showForm) { if (readyToStart) start(); else next(); } }}>
      {missingOperation ? <div className="funding-status-message"><p>요청 내역을 찾을 수 없습니다.</p><p>창을 닫고 지갑의 입출금 현황을 확인해 주세요.</p></div>
      : operation ? <FundingStatus operation={operation} onCopy={copy} />
      : step === 'asset' ? <div className="funding-route-step"><fieldset className="funding-fieldset"><legend>코인</legend><div className="funding-assets">{SYMBOLS.map((asset) => <button type="button" className={`funding-asset${symbol === asset ? ' selected' : ''}`} key={asset} data-testid={`funding-asset-${asset}`} aria-pressed={symbol === asset} onClick={() => chooseAsset(asset)}><span className="funding-asset-dot" style={{ backgroundColor: ASSETS[asset].color }} aria-hidden="true" />{asset}</button>)}</div></fieldset><fieldset className="funding-fieldset" data-testid="funding-network"><legend>네트워크</legend><div className="funding-network-options">{networks.map((option) => <button type="button" className={`funding-network-option${network === option.id ? ' selected' : ''}`} key={option.id} data-testid={`funding-network-${option.id}`} aria-pressed={network === option.id} onClick={() => chooseNetwork(option.id)}><span><strong>{option.label}</strong><small>{depositing ? option.confirmationLabel : `네트워크 비용 예시 ${money(option.feeWon)}`}</small></span><span className="funding-selection-mark">{network === option.id && <Check size={15} />}</span></button>)}</div></fieldset><p className="funding-help">입출금 코인과 네트워크가 일치해야 합니다.</p><div className="funding-route-note"><span>처리 시간 예시</span><strong>{selectedNetwork.estimatedTime}</strong></div>{!depositing && <p className="funding-help">{formSource === 'holdings' ? '보유 코인을 직접 출금합니다. 전환 수수료는 없습니다.' : '원화 잔액을 선택한 코인으로 전환해 출금합니다.'}</p>}</div>
      : step === 'details' ? <div className="funding-details-step"><div className="funding-route-label"><strong>{symbol}</strong><span>{selectedNetwork.label}</span>{!depositing && <span>{formSource === 'holdings' ? '보유 코인' : '원화 잔액'}</span>}</div>
        {depositing ? <div className="funding-destination"><div className="funding-destination-heading"><h3>체험용 주소</h3><button type="button" data-testid="funding-copy-address" aria-label="체험용 주소 복사" onClick={() => copy(sampleAddress, '체험용 주소를 복사했습니다.')}><Copy size={15} />복사</button></div><code>{sampleAddress}</code><p>실제 송금이 불가능한 주소입니다.</p><p>{symbol}와 {selectedNetwork.label}이 일치해야 합니다. 입금 확인 후 원화 잔액으로 전환됩니다.</p></div>
        : <><div className="funding-form-field"><label htmlFor={recipientId}>받는 사람</label><input id={recipientId} data-testid="funding-recipient" type="text" maxLength={60} value={recipient} placeholder="이름 또는 메모" onChange={(event) => { setRecipient(event.target.value); setErrors((current) => ({ ...current, recipient: undefined })); setConsent(false); clearQuote(); }} autoComplete="off" aria-invalid={Boolean(errors.recipient)} />{errors.recipient && <p className="funding-field-error" role="alert">{errors.recipient}</p>}</div><div className="funding-form-field"><div className="funding-label-row"><label htmlFor={addressId}>받는 지갑 주소</label><button type="button" className="funding-text-button" data-testid="funding-preview-address" onClick={() => { setAddress(sampleAddress); setErrors((current) => ({ ...current, address: undefined })); clearQuote(); }}>예시 주소</button></div><textarea id={addressId} data-testid="funding-address" rows={2} value={address} placeholder={network === 'bitcoin' ? 'bc1으로 시작하는 주소' : '0x로 시작하는 주소'} onChange={(event) => { setAddress(event.target.value); setConsent(false); clearQuote(); }} autoComplete="off" spellCheck={false} aria-invalid={Boolean(errors.address)} />{errors.address && <p className="funding-field-error" role="alert">{errors.address}</p>}<p className="funding-help">{address === sampleAddress ? '실제 송금이 불가능한 체험용 주소입니다.' : network === 'bitcoin' ? '주소 형식만 확인합니다. 수신자를 직접 확인하세요.' : '0x 주소 형식만으로 네트워크를 확인할 수 없습니다.'}</p></div></>}
        <div className="funding-amount"><div className="funding-label-row"><label htmlFor={amountId}>{depositing ? '입금 예정 수량' : usingUnits ? '출금 수량' : '출금 금액'}</label>{!depositing && <button type="button" className="funding-text-button" data-testid="funding-max" disabled={available <= 0} onClick={maxAmount}>최대</button>}</div><div className="funding-amount-input"><input id={amountId} data-testid="action-amount" type="number" inputMode={usingUnits ? 'decimal' : 'numeric'} min={usingUnits ? '0.00000001' : POLICY.minimumTopup} step={usingUnits ? 'any' : 1} value={amountInput} placeholder="0" onChange={(event) => editAmount(event.target.value)} autoComplete="off" aria-invalid={Boolean(amountIssue)} /><span>{usingUnits ? symbol : '원'}</span></div>{amountIssue && <p className="funding-field-error" role="alert">{amountIssue}</p>}<p className="funding-help">{depositing ? '원화 평가액 1,000원 이상 · 입금 확인 후 반영' : `출금 가능 ${usingUnits ? `${unitsText(available)} ${symbol}` : money(available)} · 수수료 포함`}</p></div>
        {depositing && <>{quoteSummary(displayedQuote)}<label className="funding-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} data-testid="funding-consent" /><span>체험용 주소는 실제 송금에 사용할 수 없으며, 입금 확인 후 원화로 전환되는 것을 확인했습니다.</span></label>{simulationControl()}</>}
      </div>
      : <div className="funding-review-step"><dl className="funding-review-recipient"><div><dt>받는 사람</dt><dd>{recipient.trim()}</dd></div><div><dt>코인·네트워크</dt><dd>{symbol} · {selectedNetwork.label}</dd></div><div className="funding-review-address"><dt>받는 지갑 주소</dt><dd>{address.trim()}</dd></div>{usingUnits && <div><dt>차감할 코인</dt><dd>{unitsText(amount)} {symbol}</dd></div>}</dl>{quoteSummary(quote)}<div className="funding-resulting-balance"><span>출금 후 사용 가능 잔액</span><strong>{formSource === 'holdings' ? `${unitsText(Math.max(0, available - (quote?.units ?? 0)))} ${symbol}` : money(Math.max(0, available - (quote?.amountWon ?? 0)))}</strong></div><label className="funding-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} data-testid="funding-consent" /><span>받는 사람, 지갑 주소, 네트워크와 수수료를 확인했습니다.</span></label><p className="funding-help">주소 형식 확인은 수신자 또는 네트워크를 보증하지 않습니다.</p>{simulationControl()}</div>}
      {errors.general && <div className="funding-error" role="alert">{errors.general}</div>}
      {readyToStart && expired && <p className="funding-field-error" role="alert">견적이 만료되었습니다. 갱신 후 다시 확인해 주세요.</p>}
    </form>
    <footer className="funding-footer">{operation ? <><p className="funding-footer-note">{isFundingPending(operation) ? '창을 닫아도 요청은 유지됩니다. 지갑의 입출금 현황에서 확인할 수 있습니다.' : '실제 송금이 없는 체험 내역입니다.'}</p><div className="funding-footer-actions">{operation.status === 'awaiting_deposit' ? <button type="button" className="funding-confirm" data-testid="funding-simulate-deposit" disabled={submitting} onClick={() => operate({ type: 'SIMULATE_FUNDING_DEPOSIT', id: operation.id }, '입금 확인 처리를 시작했습니다.')}>입금 확인 체험</button> : operation.status === 'failed' || operation.status === 'cancelled' ? <button type="button" className="funding-confirm" data-testid="funding-retry" onClick={() => retry(operation)}>다시 입력</button> : <button type="button" className="funding-confirm" data-testid="funding-done" onClick={onClose}>{isFundingPending(operation) ? '나중에 확인' : '닫기'}</button>}{cancellable && <button type="button" className="funding-secondary" data-testid="funding-cancel" disabled={submitting} onClick={() => operate({ type: 'CANCEL_FUNDING', id: operation.id }, '입출금 요청을 취소했습니다.')}>요청 취소</button>}</div></>
      : missingOperation ? <button type="button" className="funding-confirm" onClick={onClose}>닫기</button>
      : readyToStart ? <button type="submit" form={formId} className="funding-confirm" data-testid="confirm-action" disabled={!consent || expired || submitting || quote === null}>{submitting ? '접수 중' : depositing ? '입금 대기 등록' : formSource === 'holdings' ? `${unitsText(quote?.units ?? 0)} ${symbol} 출금 요청` : `${money(quote?.amountWon ?? 0)} 출금 요청`}</button>
      : <button type="submit" form={formId} className="funding-confirm" data-testid="funding-next">{depositing && step === 'details' ? '입금 금액 확인' : step === 'asset' ? '다음' : '출금 정보 확인'}</button>}</footer>
  </section></div>;
}

function FundingStatus({ operation, onCopy }: { operation: FundingOperation; onCopy: (value: string, message: string) => Promise<void> }) {
  const incoming = operation.kind === 'deposit';
  const terminalError = operation.status === 'failed' || operation.status === 'cancelled';
  const statuses: FundingOperation['status'][] = incoming ? ['awaiting_deposit', 'confirming', 'converting', 'completed'] : ['reviewing', 'broadcasting', 'completed'];
  const stages = terminalError ? [statuses[0], operation.status] : statuses;
  const index = terminalError ? 1 : statuses.indexOf(operation.status);
  const sourceUnits = operation.source === 'holdings';
  const pending = isFundingPending(operation);
  const restoration = sourceUnits ? `${unitsText(operation.units)} ${operation.symbol}` : money(operation.amountWon);
  return <div className="funding-status-view"><div className={`funding-status-heading ${operation.status}`} data-testid="funding-status" data-status={operation.status} role="status" aria-live="polite"><span>{fundingStatusLabel(operation.status)}</span><strong>{incoming ? money(operation.netWon) : sourceUnits ? `${unitsText(operation.units)} ${operation.symbol}` : money(operation.amountWon)}</strong><p>{incoming ? operation.status === 'completed' ? '원화 잔액에 반영 완료' : terminalError ? '원화 잔액에 반영되지 않은 금액' : '입금 확인 후 원화 잔액에 반영' : '수수료를 포함한 출금 신청 금액'}</p></div>
    <ol className="funding-timeline">{stages.map((status, position) => <li key={status} className={position < index || operation.status === 'completed' ? 'done' : position === index ? 'current' : ''} aria-current={position === index ? 'step' : undefined}><span className="funding-timeline-marker">{position + 1}</span><div><strong>{terminalError && position === 0 ? '요청 접수' : fundingStatusLabel(status)}</strong>{position === index && <span>{shortDate(operation.updatedAt)}</span>}</div></li>)}</ol>
    <div className="funding-status-message">{operation.status === 'awaiting_deposit' ? <><p>입금 확인 전이며 잔액은 변경되지 않았습니다.</p><p>아래에서 입금 확인 과정을 체험할 수 있습니다.</p></> : operation.status === 'completed' ? <p>{incoming ? `${money(operation.netWon)}이 원화 잔액에 반영되었습니다.` : sourceUnits ? `${unitsText(operation.units)} ${operation.symbol}이 보유 코인에서 차감되었습니다.` : `${money(operation.amountWon)}이 원화 잔액에서 차감되었습니다.`}</p> : terminalError ? <><p>{operation.failureReason ?? (operation.status === 'cancelled' ? '요청을 취소했습니다.' : '입출금을 완료하지 못했습니다.')}</p><p>{incoming ? '원화 잔액에 반영된 금액은 없습니다.' : `보류했던 ${restoration}이 반환되었습니다. 수수료는 차감되지 않았습니다.`}</p></> : <><p>{incoming ? '입금 확인과 원화 전환을 진행하고 있습니다.' : `신청 금액 ${restoration}이 보류되어 있습니다.`}</p><p>처리 상태는 지갑의 입출금 현황에서 이어서 확인할 수 있습니다.</p></>}</div>
    {incoming && operation.status === 'awaiting_deposit' && <div className="funding-destination"><div className="funding-destination-heading"><h3>체험용 주소</h3><button type="button" aria-label="체험용 주소 복사" onClick={() => onCopy(operation.address, '체험용 주소를 복사했습니다.')}><Copy size={15} />복사</button></div><code>{operation.address}</code><p>실제 송금이 불가능한 주소입니다.</p></div>}
    <details className="funding-operation-details" open={!pending}><summary>요청 상세</summary><dl><div><dt>코인·네트워크</dt><dd>{operation.symbol} · {getFundingNetworks(operation.symbol).find((option) => option.id === operation.network)?.label}</dd></div>{!incoming && <><div><dt>받는 사람</dt><dd>{operation.recipient}</dd></div><div className="address"><dt>받는 주소</dt><dd>{operation.address}</dd></div></>}<div><dt>접수 일시</dt><dd>{shortDate(operation.createdAt)}</dd></div><div><dt>{terminalError ? '견적 전환 수수료' : '전환 수수료'}</dt><dd>{money(operation.feeWon)}</dd></div><div><dt>{terminalError ? '견적 네트워크 비용' : '네트워크 비용 예시'}</dt><dd>{money(operation.networkFeeWon)}</dd></div>{terminalError && <div><dt>실제 차감 수수료</dt><dd>{money(0)}</dd></div>}{!incoming && <div><dt>{terminalError ? '견적 수령 수량' : '예상 수령'}</dt><dd>{unitsText(operation.outputUnits)} {operation.symbol}</dd></div>}</dl><div className="funding-operation-reference"><span>요청 번호</span><code>{operation.requestId}</code><button type="button" aria-label="요청 번호 복사" data-testid="funding-copy-request" onClick={() => onCopy(operation.requestId, '요청 번호를 복사했습니다.')}><Copy size={15} />복사</button></div></details>
  </div>;
}
