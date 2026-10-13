import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, Copy, RefreshCw, X } from 'lucide-react';
import CoinIcon from './CoinIcon';
import { demoCode, maskEmail } from '../lib/auth';
import { assertFundingQuoteFresh } from '../lib/funding';
import { money, percent, shortDate, won } from '../lib/format';
import {
  createFundingQuote, fundingStatusLabel, getFundingNetworks, isFundingPending,
  validateFundingAddress, type FundingMovementQuote,
} from '../lib/movements';
import { FUNDING_ASSETS, fundingLabel, POLICY } from '../lib/policy';
import type { Account, Action, AppState, AssetSymbol, FundingNetwork, FundingOperation, FundingSymbol } from '../lib/types';
import './FundingDialog.css';

export interface FundingDialogProps {
  mode: 'deposit' | 'withdraw';
  symbol?: FundingSymbol;
  account: Account | null;
  source?: 'spend' | 'holdings';
  operationId?: string;
  onOperationCreated?: (id: string) => void;
  state: AppState;
  onClose: () => void;
  dispatch: (action: Action) => AppState;
  notify: (message: string, type?: 'success' | 'error' | 'info') => void;
}

type Step = 'asset' | 'details' | 'review';
type Origin = 'domestic' | 'global' | 'wallet' | 'address';
type FieldErrors = { amount?: string; recipient?: string; address?: string; general?: string };
const DEPOSIT_SYMBOLS: FundingSymbol[] = ['KRWS', 'USDC', 'USDT', 'BTC', 'ETH'];
const HOLDING_SYMBOLS: FundingSymbol[] = ['USDC', 'USDT', 'BTC', 'ETH'];
const ORIGINS: [Origin, string, string][] = [
  ['domestic', '국내 거래소', '업비트·빗썸·코인원·코빗'],
  ['global', '해외 거래소', '트래블룰 지원 거래소'],
  ['wallet', '내 지갑', '메타마스크·팬텀 같은 개인 지갑'],
  ['address', '주소만 받기', '주소를 복사해 직접 보내기'],
];
const unitsText = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 8 });
const amountOf = (symbol: FundingSymbol, units: number) => symbol === 'KRWS' ? money(units) : `${unitsText(units)} ${symbol}`;
const requestIdentifier = () => globalThis.crypto?.randomUUID?.() ?? `aqua-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const previewAddress = (symbol: FundingSymbol, network: FundingNetwork) => `aqua-preview:${network}:${symbol.toLowerCase()}`;

function guideSteps(origin: Origin, label: string, network: string): string[] {
  if (origin === 'wallet') return ['지갑 앱에서 보내기 선택', `코인 ${label}, 네트워크 ${network} 확인`, '받는 주소에 위 주소 붙여 넣기'];
  if (origin === 'address') return ['위 주소 복사', `코인 ${label}, 네트워크 ${network}로 보내기`];
  return ['거래소 앱에서 출금 선택', `코인 ${label}, 네트워크 ${network} 선택`, '받는 주소에 위 주소 붙여 넣기', '받는 곳은 Aqua, 받는 사람은 본인 이름으로 입력'];
}

export default function FundingDialog({ mode, symbol: initialSymbol, source = 'spend', account, operationId, onOperationCreated, state, onClose, dispatch, notify }: FundingDialogProps) {
  const initialOperation = operationId ? state.fundingOperations.find((operation) => operation.id === operationId) : undefined;
  const [formMode, setFormMode] = useState<'deposit' | 'withdraw'>(initialOperation ? initialOperation.kind === 'deposit' ? 'deposit' : 'withdraw' : mode);
  const [formSource, setFormSource] = useState<'spend' | 'holdings'>(initialOperation?.source ?? (mode === 'deposit' ? 'spend' : source));
  const firstSymbol: FundingSymbol = initialSymbol ?? (source === 'holdings' ? 'USDC' : 'KRWS');
  const [symbol, setSymbol] = useState<FundingSymbol>(initialOperation?.symbol ?? firstSymbol);
  const [network, setNetwork] = useState<FundingNetwork>(initialOperation?.network ?? getFundingNetworks(firstSymbol)[0].id);
  const [origin, setOrigin] = useState<Origin>('domestic');
  const [emailCode, setEmailCode] = useState<string | null>(null);
  const [emailInput, setEmailInput] = useState('');
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
  const available = formSource === 'holdings' ? state.holdings[symbol as AssetSymbol] ?? 0 : state.spend;
  const symbols = formSource === 'holdings' && !depositing ? HOLDING_SYMBOLS : DEPOSIT_SYMBOLS;
  const label = fundingLabel(symbol);
  const emailVerified = emailCode !== null && emailInput === emailCode;
  const email = account?.email ?? 'demo@aqua.example';
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
  function chooseAsset(next: FundingSymbol) {
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
    if (!depositing && !emailVerified) { setErrors({ general: '이메일 인증을 먼저 마쳐 주세요.' }); return; }
    if (!consent) { setErrors({ general: '입출금 정보를 확인하고 동의해 주세요.' }); return; }
    try {
      assertFundingQuoteFresh(quotedAt);
      submittingRef.current = true; setSubmitting(true);
      const result = dispatch({ type: 'START_FUNDING', requestId, kind: depositing ? 'deposit' : 'withdrawal', symbol, network, source: depositing ? 'spend' : formSource, ...(usingUnits ? { units: amount } : { amount }), address: depositing ? sampleAddress : address.trim(), recipient: depositing ? '내 결제 잔액' : recipient.trim(), quotedAt, simulation, ...(retryOf ? { retryOf } : {}) });
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
    setAmountInput(''); setAddress(''); setRecipient(''); setConsent(false); setSimulation('success'); setEmailCode(null); setEmailInput('');
    setCurrentOperationId(undefined); setShowForm(true); clearQuote(); moveTo('asset');
  }

  const title = operation ? operation.status === 'completed' ? operation.kind === 'deposit' ? '입금 완료' : '출금 완료' : operation.status === 'failed' ? '처리 실패' : operation.status === 'cancelled' ? '요청 취소' : operation.kind === 'deposit' ? '입금 현황' : '출금 현황'
    : missingOperation ? '입출금 내역' : step === 'asset' ? depositing ? '어디서 보내나요?' : '출금할 코인 선택' : step === 'review' ? '출금 정보 확인' : depositing ? '입금 주소' : '출금 정보 입력';
  const cancellable = operation?.status === 'awaiting_deposit' || operation?.status === 'reviewing';
  const readyToStart = showForm && (step === 'review' || depositing && step === 'details' && quote !== null);

  function quoteSummary(value: FundingMovementQuote | null) {
    return <div className="funding-quote"><div className="funding-quote-header"><h3>{depositing ? '원화 반영 금액' : '수수료와 수령 금액'}</h3><div className="funding-quote-clock"><span data-testid="quote-ttl" className={expired ? 'expired' : ''}>{seconds === null ? '견적 확인 필요' : expired ? '견적 만료' : `${seconds}초 유효`}</span><button type="button" aria-label="견적 갱신" data-testid="refresh-quote" onClick={() => acceptQuote()}><RefreshCw size={14} />{seconds === null ? '확인' : '갱신'}</button></div></div><dl>
      <div className="funding-quote-row"><dt>{depositing ? '입금 평가액' : formSource === 'holdings' ? '출금 평가액' : '총 차감 원화'}</dt><dd data-testid="quote-gross">{value ? money(value.amountWon) : '입력 전'}</dd></div>
      <div className="funding-quote-row"><dt>{depositing ? '입금 수수료' : formSource === 'holdings' || symbol === 'KRWS' ? '전환 수수료 없음' : `전환 수수료 ${percent(POLICY.conversionFee)}`}</dt><dd data-testid="quote-fee">{value ? money(value.feeWon) : '입력 전'}</dd></div>
      <div className="funding-quote-row"><dt>네트워크 비용 예시</dt><dd data-testid="quote-network-fee">{value ? money(value.networkFeeWon) : '입력 전'}</dd></div>
      {!depositing && <div className="funding-quote-row"><dt>수수료 제외 원화</dt><dd data-testid="quote-net">{value ? money(value.netWon) : '입력 전'}</dd></div>}
      <div className="funding-quote-total"><dt>{depositing ? '결제 잔액에 더할 금액' : `예상 수령 ${label}`}</dt><dd>{depositing ? <span data-testid="quote-net">{value ? money(value.netWon) : '입력 전'}</span> : symbol === 'KRWS' ? <span data-testid="quote-units">{value ? money(value.outputUnits) : '입력 전'}</span> : <><span data-testid="quote-units">{value ? unitsText(value.outputUnits) : '입력 전'}</span><small>{symbol}</small></>}</dd></div>
      {depositing && <div className="funding-quote-row"><dt>보낸 수량</dt><dd><span data-testid="quote-units">{value ? symbol === 'KRWS' ? won(value.units) : unitsText(value.units) : '입력 전'}</span> {symbol === 'KRWS' ? '원' : symbol}</dd></div>}
    </dl><p className="funding-help">{depositing ? '입금은 수수료가 없습니다. 처리 시간은 체험용 예시입니다.' : '수수료와 처리 시간은 체험용 예시입니다.'}</p></div>;
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
      : step === 'asset' ? <div className="funding-route-step">
        {depositing && <fieldset className="funding-fieldset"><legend>보내는 곳</legend><div className="funding-origins">{ORIGINS.map(([key, name, note]) => <button type="button" key={key} className={`funding-origin${origin === key ? ' selected' : ''}`} data-testid={`funding-origin-${key}`} aria-pressed={origin === key} onClick={() => setOrigin(key)}><strong>{name}</strong><span>{note}</span></button>)}</div></fieldset>}
        <fieldset className="funding-fieldset"><legend>코인</legend><div className="funding-coins">{symbols.map((asset) => <button type="button" className={`funding-coin${symbol === asset ? ' selected' : ''}`} key={asset} data-testid={`funding-asset-${asset}`} aria-pressed={symbol === asset} onClick={() => chooseAsset(asset)}><CoinIcon symbol={asset} size={34} /><span className="funding-coin-main"><strong>{FUNDING_ASSETS[asset].name}</strong><span>{depositing ? asset === 'KRWS' ? '결제 잔액과 1:1' : '원화 스테이블로 바뀜 · 수수료 없음' : formSource === 'holdings' ? `보유 ${unitsText(state.holdings[asset as AssetSymbol])} ${asset}` : asset === 'KRWS' ? '바꾸지 않고 그대로 보냄' : `원화 스테이블에서 바꿔 보냄 · 수수료 ${percent(POLICY.conversionFee)}`}</span></span><span className="funding-selection-mark">{symbol === asset && <Check size={15} />}</span></button>)}</div></fieldset>
        <fieldset className="funding-fieldset" data-testid="funding-network"><legend>네트워크</legend><div className="funding-network-options">{networks.map((option, index) => <button type="button" className={`funding-network-option${network === option.id ? ' selected' : ''}`} key={option.id} data-testid={`funding-network-${option.id}`} aria-pressed={network === option.id} onClick={() => chooseNetwork(option.id)}><span><strong>{option.label}{networks.length > 1 && index === 0 && <em className="funding-recommend">추천</em>}</strong><small>{depositing ? `${option.confirmationLabel} · ${option.estimatedTime}` : `네트워크 비용 예시 ${money(option.feeWon)}`}</small></span><span className="funding-selection-mark">{network === option.id && <Check size={15} />}</span></button>)}</div></fieldset>
        <p className="funding-help">{depositing ? '보내는 곳에서도 같은 코인과 네트워크를 골라야 합니다.' : '받는 곳이 같은 네트워크를 지원하는지 확인해 주세요.'}</p>
        {!depositing && <div className="funding-route-note"><span>처리 시간 예시</span><strong>{selectedNetwork.estimatedTime}</strong></div>}
        {!depositing && <p className="funding-help">{formSource === 'holdings' ? '보유 코인을 그대로 보냅니다. 전환 수수료는 없습니다.' : symbol === 'KRWS' ? '원화 스테이블을 그대로 보냅니다. 네트워크 비용만 듭니다.' : `원화 스테이블을 ${symbol}로 바꿔 보냅니다.`}</p>}
      </div>
      : step === 'details' ? <div className="funding-details-step">{!depositing && <div className="funding-route-label"><strong>{label}</strong><span>{selectedNetwork.label}</span><span>{formSource === 'holdings' ? '보유 코인' : '결제 잔액'}</span></div>}
        {depositing ? <><div className="funding-receive">
          <div className="funding-receive-head"><CoinIcon symbol={symbol} size={40} /><div><strong>{label} 받는 주소</strong><span>{selectedNetwork.label} 네트워크 · {ORIGINS.find(([key]) => key === origin)?.[1]}</span></div></div>
          <code className="funding-receive-address" data-testid="funding-deposit-address">{sampleAddress}</code>
          <button type="button" className="funding-receive-copy" data-testid="funding-copy-address" aria-label="체험용 주소 복사" onClick={() => copy(sampleAddress, '체험용 주소를 복사했습니다.')}><Copy size={16} />주소 복사</button>
          <ol className="funding-guide">{guideSteps(origin, label, selectedNetwork.label).map((item) => <li key={item}>{item}</li>)}</ol>
          <dl className="funding-receive-facts"><div><dt>최소 입금</dt><dd>{money(POLICY.minimumTopup)} 상당</dd></div><div><dt>입금 확인</dt><dd>{selectedNetwork.confirmationLabel}</dd></div><div><dt>수수료</dt><dd>없음</dd></div></dl>
          {origin === 'domestic' && <p className="funding-receive-note">100만원 이상 보내면 거래소가 받는 곳과 받는 사람을 묻습니다(트래블룰). 받는 곳은 Aqua를 고르세요.</p>}
          {origin === 'global' && <p className="funding-receive-note">트래블룰을 지원하는 해외 거래소에서만 받을 수 있습니다. 출금 화면에서 받는 곳을 Aqua로 고르세요.</p>}
          <p className="funding-receive-warning">{label}만 {selectedNetwork.label} 네트워크로 보내 주세요. 체험용 주소라 실제로는 보낼 수 없습니다.</p>
        </div>
        <div className="funding-trial-head"><h3>입금 체험</h3><p>실제로는 위 주소로 보내기만 하면 자동으로 반영됩니다. 체험에서는 보낸 수량을 정해 과정을 확인합니다.</p></div></>
        : <><div className="funding-form-field"><label htmlFor={recipientId}>받는 사람</label><input id={recipientId} data-testid="funding-recipient" type="text" maxLength={60} value={recipient} placeholder="이름 또는 메모" onChange={(event) => { setRecipient(event.target.value); setErrors((current) => ({ ...current, recipient: undefined })); setConsent(false); clearQuote(); }} autoComplete="off" aria-invalid={Boolean(errors.recipient)} />{errors.recipient && <p className="funding-field-error" role="alert">{errors.recipient}</p>}</div><div className="funding-form-field"><div className="funding-label-row"><label htmlFor={addressId}>받는 지갑 주소</label><button type="button" className="funding-text-button" data-testid="funding-preview-address" onClick={() => { setAddress(sampleAddress); setErrors((current) => ({ ...current, address: undefined })); clearQuote(); }}>예시 주소</button></div><textarea id={addressId} data-testid="funding-address" rows={2} value={address} placeholder={network === 'bitcoin' ? 'bc1으로 시작하는 주소' : '0x로 시작하는 주소'} onChange={(event) => { setAddress(event.target.value); setConsent(false); clearQuote(); }} autoComplete="off" spellCheck={false} aria-invalid={Boolean(errors.address)} />{errors.address && <p className="funding-field-error" role="alert">{errors.address}</p>}<p className="funding-help">{address === sampleAddress ? '실제 송금이 불가능한 체험용 주소입니다.' : network === 'bitcoin' ? '주소 형식만 확인합니다. 수신자를 직접 확인하세요.' : '0x 주소 형식만으로 네트워크를 확인할 수 없습니다.'}</p></div></>}
        <div className="funding-amount"><div className="funding-label-row"><label htmlFor={amountId}>{depositing ? '보낸 수량' : usingUnits ? '출금 수량' : '출금 금액'}</label>{!depositing && <button type="button" className="funding-text-button" data-testid="funding-max" disabled={available <= 0} onClick={maxAmount}>최대</button>}</div><div className="funding-amount-input"><input id={amountId} data-testid="action-amount" type="number" inputMode={usingUnits ? 'decimal' : 'numeric'} min={usingUnits ? '0.00000001' : POLICY.minimumTopup} step={usingUnits ? 'any' : 1} value={amountInput} placeholder="0" onChange={(event) => editAmount(event.target.value)} autoComplete="off" aria-invalid={Boolean(amountIssue)} /><span>{usingUnits && symbol !== 'KRWS' ? symbol : '원'}</span></div>{amountIssue && <p className="funding-field-error" role="alert">{amountIssue}</p>}<p className="funding-help">{depositing ? '원화 평가액 1,000원 이상 · 입금 확인 후 반영' : `출금 가능 ${usingUnits ? `${unitsText(available)} ${symbol}` : money(available)} · 수수료 포함`}</p></div>
        {depositing && <>{quoteSummary(displayedQuote)}<label className="funding-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} data-testid="funding-consent" /><span>{symbol === 'KRWS' ? '체험용 주소로는 실제로 보낼 수 없고, 입금이 확인되면 결제 잔액에 더해지는 것을 확인했습니다.' : '체험용 주소로는 실제로 보낼 수 없고, 입금이 확인되면 원화 스테이블로 바뀌는 것을 확인했습니다.'}</span></label>{simulationControl()}</>}
      </div>
      : <div className="funding-review-step"><dl className="funding-review-recipient"><div><dt>받는 사람</dt><dd>{recipient.trim()}</dd></div><div><dt>코인·네트워크</dt><dd>{label} · {selectedNetwork.label}</dd></div><div className="funding-review-address"><dt>받는 지갑 주소</dt><dd>{address.trim()}</dd></div>{usingUnits && <div><dt>차감할 코인</dt><dd>{unitsText(amount)} {symbol}</dd></div>}</dl>{quoteSummary(quote)}<div className="funding-resulting-balance"><span>출금 후 사용 가능 잔액</span><strong>{formSource === 'holdings' ? `${unitsText(Math.max(0, available - (quote?.units ?? 0)))} ${symbol}` : money(Math.max(0, available - (quote?.amountWon ?? 0)))}</strong></div><label className="funding-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} data-testid="funding-consent" /><span>받는 사람, 지갑 주소, 네트워크와 수수료를 확인했습니다.</span></label><section className="email-check" data-testid="email-check"><div className="email-check-head"><strong>이메일 인증</strong>{emailVerified ? <span className="email-check-done" data-testid="email-verified"><Check size={16} strokeWidth={2.6} />인증 완료</span> : <button type="button" className="funding-text-button" data-testid="email-send" onClick={() => { setEmailCode(demoCode()); setEmailInput(''); }}>{emailCode ? '다시 받기' : '코드 받기'}</button>}</div>{!emailVerified && <p>{maskEmail(email)}로 받은 6자리 코드를 넣어야 출금을 요청할 수 있습니다.</p>}{!emailVerified && emailCode && <><p className="email-check-demo" data-testid="email-demo-code">체험판이라 메일을 보내지 않습니다. 코드는 <strong>{emailCode}</strong>입니다.</p><input className="email-check-input" data-testid="email-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} aria-label="이메일 인증 코드" value={emailInput} onChange={(event) => setEmailInput(event.target.value.replace(/\D/g, ''))} /></>}</section><p className="funding-help">주소 형식 확인은 수신자 또는 네트워크를 보증하지 않습니다.</p>{simulationControl()}</div>}
      {errors.general && <div className="funding-error" role="alert">{errors.general}</div>}
      {readyToStart && expired && <p className="funding-field-error" role="alert">견적이 만료되었습니다. 갱신 후 다시 확인해 주세요.</p>}
    </form>
    <footer className="funding-footer">{operation ? <><p className="funding-footer-note">{isFundingPending(operation) ? '창을 닫아도 요청은 유지됩니다. 지갑의 입출금 현황에서 확인할 수 있습니다.' : '실제 송금이 없는 체험 내역입니다.'}</p><div className="funding-footer-actions">{operation.status === 'awaiting_deposit' ? <button type="button" className="funding-confirm" data-testid="funding-simulate-deposit" disabled={submitting} onClick={() => operate({ type: 'SIMULATE_FUNDING_DEPOSIT', id: operation.id }, '입금 확인 처리를 시작했습니다.')}>입금 확인 체험</button> : operation.status === 'failed' || operation.status === 'cancelled' ? <button type="button" className="funding-confirm" data-testid="funding-retry" onClick={() => retry(operation)}>다시 입력</button> : <button type="button" className="funding-confirm" data-testid="funding-done" onClick={onClose}>{isFundingPending(operation) ? '나중에 확인' : '닫기'}</button>}{cancellable && <button type="button" className="funding-secondary" data-testid="funding-cancel" disabled={submitting} onClick={() => operate({ type: 'CANCEL_FUNDING', id: operation.id }, '입출금 요청을 취소했습니다.')}>요청 취소</button>}</div></>
      : missingOperation ? <button type="button" className="funding-confirm" onClick={onClose}>닫기</button>
      : readyToStart ? <button type="submit" form={formId} className="funding-confirm" data-testid="confirm-action" disabled={!consent || expired || submitting || quote === null || (!depositing && !emailVerified)}>{submitting ? '접수 중' : depositing ? '입금 체험 시작' : formSource === 'holdings' ? `${unitsText(quote?.units ?? 0)} ${symbol} 출금 요청` : `${money(quote?.amountWon ?? 0)} 출금 요청`}</button>
      : <button type="submit" form={formId} className="funding-confirm" data-testid="funding-next">{depositing && step === 'details' ? '보낸 수량 확인' : step === 'asset' ? depositing ? '주소 보기' : '다음' : '출금 정보 확인'}</button>}</footer>
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
  return <div className="funding-status-view"><div className={`funding-status-heading ${operation.status}`} data-testid="funding-status" data-status={operation.status} role="status" aria-live="polite"><span>{fundingStatusLabel(operation.status)}</span><strong>{incoming ? money(operation.netWon) : sourceUnits ? `${unitsText(operation.units)} ${operation.symbol}` : money(operation.amountWon)}</strong><p>{incoming ? operation.status === 'completed' ? '결제 잔액에 반영 완료' : terminalError ? '결제 잔액에 반영되지 않은 금액' : '입금 확인 후 결제 잔액에 반영' : '수수료를 포함한 출금 신청 금액'}</p></div>
    <ol className="funding-timeline">{stages.map((status, position) => <li key={status} className={position < index || operation.status === 'completed' ? 'done' : position === index ? 'current' : ''} aria-current={position === index ? 'step' : undefined}><span className="funding-timeline-marker">{position + 1}</span><div><strong>{terminalError && position === 0 ? '요청 접수' : fundingStatusLabel(status)}</strong>{position === index && <span>{shortDate(operation.updatedAt)}</span>}</div></li>)}</ol>
    <div className="funding-status-message">{operation.status === 'awaiting_deposit' ? <><p>입금 확인 전이며 잔액은 변경되지 않았습니다.</p><p>아래에서 입금 확인 과정을 체험할 수 있습니다.</p></> : operation.status === 'completed' ? <p>{incoming ? `${money(operation.netWon)}이 결제 잔액에 반영되었습니다.` : sourceUnits ? `${unitsText(operation.units)} ${operation.symbol}이 보유 코인에서 차감되었습니다.` : `${money(operation.amountWon)}이 결제 잔액에서 차감되었습니다.`}</p> : terminalError ? <><p>{operation.failureReason ?? (operation.status === 'cancelled' ? '요청을 취소했습니다.' : '입출금을 완료하지 못했습니다.')}</p><p>{incoming ? '결제 잔액에 반영된 금액은 없습니다.' : `보류했던 ${restoration}이 반환되었습니다. 수수료는 차감되지 않았습니다.`}</p></> : <><p>{incoming ? operation.symbol === 'KRWS' ? '입금을 확인하고 있습니다.' : '입금 확인과 원화 스테이블 전환을 진행하고 있습니다.' : `신청 금액 ${restoration}이 보류되어 있습니다.`}</p><p>처리 상태는 지갑의 입출금 현황에서 이어서 확인할 수 있습니다.</p></>}</div>
    {incoming && operation.status === 'awaiting_deposit' && <div className="funding-destination"><div className="funding-destination-heading"><h3>체험용 주소</h3><button type="button" aria-label="체험용 주소 복사" onClick={() => onCopy(operation.address, '체험용 주소를 복사했습니다.')}><Copy size={15} />복사</button></div><code>{operation.address}</code><p>실제 송금이 불가능한 주소입니다.</p></div>}
    <details className="funding-operation-details" open={!pending}><summary>요청 상세</summary><dl><div><dt>코인·네트워크</dt><dd>{fundingLabel(operation.symbol)} · {getFundingNetworks(operation.symbol).find((option) => option.id === operation.network)?.label}</dd></div>{!incoming && <><div><dt>받는 사람</dt><dd>{operation.recipient}</dd></div><div className="address"><dt>받는 주소</dt><dd>{operation.address}</dd></div></>}<div><dt>접수 일시</dt><dd>{shortDate(operation.createdAt)}</dd></div><div><dt>{terminalError ? '견적 전환 수수료' : '전환 수수료'}</dt><dd>{money(operation.feeWon)}</dd></div><div><dt>{terminalError ? '견적 네트워크 비용' : '네트워크 비용 예시'}</dt><dd>{money(operation.networkFeeWon)}</dd></div>{terminalError && <div><dt>실제 차감 수수료</dt><dd>{money(0)}</dd></div>}{!incoming && <div><dt>{terminalError ? '견적 수령 수량' : '예상 수령'}</dt><dd>{amountOf(operation.symbol, operation.outputUnits)}</dd></div>}</dl><div className="funding-operation-reference"><span>요청 번호</span><code>{operation.requestId}</code><button type="button" aria-label="요청 번호 복사" data-testid="funding-copy-request" onClick={() => onCopy(operation.requestId, '요청 번호를 복사했습니다.')}><Copy size={15} />복사</button></div></details>
  </div>;
}
