import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, Copy, RefreshCw, X } from 'lucide-react';
import CoinIcon from './CoinIcon';
import { AmountInput } from './ui';
import { demoCode, maskEmail } from '../lib/auth';
import { assertFundingQuoteFresh } from '../lib/funding';
import { josa, money, percent, shortDate, won } from '../lib/format';
import {
  createFundingQuote, fundingStatusLabel, getFundingNetworks, isFundingPending,
  validateFundingAddress, type FundingMovementQuote,
} from '../lib/movements';
import { FUNDING_ASSETS, fundingLabel, POLICY } from '../lib/policy';
import { destinationName, normalizeName, regionName, UNLISTED_VENUE, validRecipientName, venueOf, VENUES } from '../lib/travel';
import type { Account, Action, AppState, FundingNetwork, FundingOperation, FundingSymbol, WithdrawalDestination } from '../lib/types';
import './FundingDialog.css';

export interface FundingDialogProps {
  mode: 'deposit' | 'withdraw';
  symbol?: FundingSymbol;
  account: Account | null;
  operationId?: string;
  onOperationCreated?: (id: string) => void;
  state: AppState;
  onClose: () => void;
  dispatch: (action: Action) => AppState;
}

type Step = 'asset' | 'details' | 'review';
type Origin = 'domestic' | 'global' | 'wallet' | 'address';
/** Where a withdrawal goes. The travel rule allows exchanges it can reach, and personal wallets only when they are the holder's own. */
type Destination = 'domestic' | 'global' | 'wallet';
type FieldErrors = { amount?: string; recipient?: string; address?: string; venue?: string; proof?: string; general?: string };
const DEPOSIT_SYMBOLS: FundingSymbol[] = ['KRWS', 'USDC', 'USDT', 'BTC', 'ETH'];
const ORIGINS: [Origin, string, string][] = [
  ['domestic', '국내 거래소', '업비트·빗썸 등'],
  ['global', '해외 거래소', '트래블룰 지원 거래소'],
  ['wallet', '내 지갑', '메타마스크·팬텀 등'],
  ['address', '주소로 받기', '주소를 복사해 직접 보내기'],
];
const DESTINATIONS: [Destination, string, string][] = [
  ['domestic', '국내 거래소', '업비트·빗썸 등 신고한 거래소'],
  ['global', '해외 거래소', '트래블룰로 확인되는 거래소만'],
  ['wallet', '내 지갑', '본인 지갑만 · 서명으로 확인'],
];
const SAMPLE_RECIPIENT = '정하늘';
const PROOF_MS = 700;
const unitsText = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 8 });
const amountOf = (symbol: FundingSymbol, units: number) => symbol === 'KRWS' ? money(units) : `${unitsText(units)} ${symbol}`;
const requestIdentifier = () => globalThis.crypto?.randomUUID?.() ?? `aqua-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const previewAddress = (symbol: FundingSymbol, network: FundingNetwork) => `aqua-preview:${network}:${symbol.toLowerCase()}`;

function guideSteps(origin: Origin, label: string, network: string): string[] {
  if (origin === 'wallet') return ['지갑 앱에서 보내기를 눌러요', `${label}, ${network} 네트워크가 맞는지 확인해요`, '받는 주소 칸에 위 주소를 붙여 넣어요'];
  if (origin === 'address') return ['위 주소를 복사해요', `${network} 네트워크로 ${label} 보내요`];
  return ['거래소 앱에서 출금을 눌러요', `${label}, ${network} 네트워크를 골라요`, '받는 주소 칸에 위 주소를 붙여 넣어요', '받는 곳은 Aqua, 받는 사람은 본인 이름이에요'];
}

export default function FundingDialog({ mode, symbol: initialSymbol, account, operationId, onOperationCreated, state, onClose, dispatch }: FundingDialogProps) {
  const initialOperation = operationId ? state.fundingOperations.find((operation) => operation.id === operationId) : undefined;
  const [formMode, setFormMode] = useState<'deposit' | 'withdraw'>(initialOperation ? initialOperation.kind === 'deposit' ? 'deposit' : 'withdraw' : mode);
  const firstSymbol: FundingSymbol = initialSymbol ?? 'KRWS';
  const [symbol, setSymbol] = useState<FundingSymbol>(initialOperation?.symbol ?? firstSymbol);
  const [network, setNetwork] = useState<FundingNetwork>(initialOperation?.network ?? getFundingNetworks(firstSymbol)[0].id);
  const [origin, setOrigin] = useState<Origin>('domestic');
  const [destination, setDestination] = useState<Destination>('domestic');
  /** An exchange id from the directory, or 'unlisted' when the one wanted is not there. */
  const [venue, setVenue] = useState<string | null>(null);
  const [relation, setRelation] = useState<'self' | 'other'>('self');
  const [proof, setProof] = useState<'none' | 'checking' | 'done'>('none');
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
  const usingUnits = depositing;
  const networks = getFundingNetworks(symbol);
  const selectedNetwork = networks.find((option) => option.id === network)!;
  const amount = Number(amountInput);
  const available = state.spend;
  const symbols = DEPOSIT_SYMBOLS;
  const label = fundingLabel(symbol);
  const emailVerified = emailCode !== null && emailInput === emailCode;
  const email = account?.email ?? 'demo@aqua.example';
  const seconds = quotedAt === null ? null : Math.max(0, POLICY.quoteTtlSeconds - Math.floor((now - quotedAt) / 1_000));
  const expired = seconds === 0;
  const sampleAddress = previewAddress(symbol, network);
  const exchange = destination !== 'wallet';
  const chosenVenue = venue ? venueOf(venue) : undefined;
  const venueName = chosenVenue?.name ?? '거래소';
  const holder = account?.name ?? '';
  const recipientName = exchange && relation === 'other' ? normalizeName(recipient) : holder;
  const draftQuote = useMemo<{ value: FundingMovementQuote | null; error: string }>(() => {
    if (!amountInput.trim()) return { value: null, error: '' };
    try {
      return { value: createFundingQuote({ kind: depositing ? 'deposit' : 'withdrawal', symbol, network, source: 'spend', ...(usingUnits ? { units: amount } : { amount }) }), error: '' };
    } catch (issue) { return { value: null, error: issue instanceof Error ? issue.message : '금액을 확인해 주세요.' }; }
  }, [amountInput, amount, depositing, symbol, network, usingUnits]);
  const insufficient = !depositing && draftQuote.value !== null && draftQuote.value.amountWon > available;
  const amountIssue = errors.amount || draftQuote.error || (insufficient ? '잔액이 부족해요. 금액을 줄여 주세요.' : '');
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
    if (proof !== 'checking') return;
    const timer = setTimeout(() => setProof('done'), PROOF_MS);
    return () => clearTimeout(timer);
  }, [proof]);

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
  function chooseNetwork(next: FundingNetwork) { setNetwork(next); setAddress(''); setProof('none'); setConsent(false); clearQuote(); }
  function chooseDestination(next: Destination) {
    setDestination(next); setVenue(null); setRelation('self'); setRecipient('');
    setAddress(''); setProof('none'); setConsent(false); clearQuote();
  }
  function chooseVenue(next: string) { setVenue(next); setErrors((current) => ({ ...current, venue: undefined })); setConsent(false); clearQuote(); }
  function chooseRelation(next: 'self' | 'other') { setRelation(next); setErrors((current) => ({ ...current, recipient: undefined })); setConsent(false); clearQuote(); }
  /** A new address needs a new signature. */
  function editAddress(next: string) { setAddress(next); setProof('none'); setErrors((current) => ({ ...current, address: undefined, proof: undefined })); setConsent(false); clearQuote(); }
  function signWallet() {
    const issue = validateFundingAddress(symbol, network, address);
    if (issue) {
      setErrors((current) => ({ ...current, address: issue }));
      requestAnimationFrame(() => document.getElementById(addressId)?.focus());
      return;
    }
    setErrors((current) => ({ ...current, proof: undefined }));
    setProof('checking');
  }
  function editAmount(value: string) { setAmountInput(value); clearQuote(); }
  function maxAmount() { editAmount(String(available)); }
  async function copy(value: string, message: string) {
    setCopyFeedback(null);
    try { await navigator.clipboard.writeText(value); setCopyFeedback({ text: message, failed: false }); }
    catch { setCopyFeedback({ text: '복사하지 못했어요. 직접 선택해서 복사해 주세요.', failed: true }); }
  }
  function validateDetails(): boolean {
    const next: FieldErrors = {};
    if (!amountInput.trim()) next.amount = depositing ? '수량을 입력해 주세요.' : '보낼 금액을 입력해 주세요.';
    else if (draftQuote.error) next.amount = draftQuote.error;
    else if (insufficient) next.amount = '잔액이 부족해요. 금액을 줄여 주세요.';
    if (!depositing) {
      if (exchange && !venue) next.venue = '받는 거래소를 골라 주세요.';
      else if (exchange && !chosenVenue) next.venue = UNLISTED_VENUE;
      if (exchange && chosenVenue && relation === 'other') {
        if (!recipientName) next.recipient = '받는 사람 이름을 넣어 주세요.';
        else if (!validRecipientName(recipientName)) next.recipient = '이름은 글자로만 2~30자로 넣어 주세요. 거래소 계정의 이름과 같아야 해요.';
      }
      if (!exchange || chosenVenue) {
        const addressIssue = validateFundingAddress(symbol, network, address);
        if (addressIssue) next.address = addressIssue;
        else if (!exchange && proof !== 'done') next.proof = '서명으로 내 지갑인지 확인해 주세요.';
      }
    }
    setErrors(next);
    if (Object.keys(next).length) {
      const field = next.venue ? `${uid}-venues` : next.recipient ? recipientId : next.address ? addressId : next.proof ? `${uid}-proof` : amountId;
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
      const sendTo: WithdrawalDestination | undefined = depositing ? undefined
        : exchange ? { kind: 'exchange', venue: venue ?? '', relation } : { kind: 'own_wallet', proof: 'signature' };
      const result = dispatch({ type: 'START_FUNDING', requestId, kind: depositing ? 'deposit' : 'withdrawal', symbol, network, source: 'spend', ...(usingUnits ? { units: amount } : { amount }), address: depositing ? sampleAddress : address.trim(), recipient: depositing ? '내 잔액' : recipientName, ...(sendTo ? { destination: sendTo } : {}), quotedAt, simulation, ...(retryOf ? { retryOf } : {}) });
      const created = result.fundingOperations.find((item) => item.requestId === requestId);
      if (!created) throw new Error('요청 내역을 찾지 못했어요. 거래 내역에서 확인해 주세요.');
      setCurrentOperationId(created.id); setShowForm(false);
      setCopyFeedback(null);
      onOperationCreated?.(created.id);
    } catch (issue) {
      setErrors({ general: issue instanceof Error ? issue.message : '요청 내용을 확인해 주세요.' });
    } finally { submittingRef.current = false; setSubmitting(false); }
  }
  function operate(action: Action) {
    if (submittingRef.current) return;
    try { submittingRef.current = true; setSubmitting(true); dispatch(action); setErrors({}); }
    catch (issue) { setErrors({ general: issue instanceof Error ? issue.message : '처리 상태를 확인해 주세요.' }); }
    finally { submittingRef.current = false; setSubmitting(false); }
  }
  function retry(previous: FundingOperation) {
    setFormMode(previous.kind === 'deposit' ? 'deposit' : 'withdraw');
    setSymbol(previous.symbol); setNetwork(previous.network);
    setRetryOf(previous.id); setRequestId(requestIdentifier());
    // The same place again, without the address or the signature, which belong to that one request.
    const sentTo = previous.destination;
    setDestination(sentTo?.kind === 'own_wallet' ? 'wallet' : sentTo ? venueOf(sentTo.venue)?.region ?? 'domestic' : 'domestic');
    setVenue(sentTo?.kind === 'exchange' ? sentTo.venue : null); setRelation(sentTo?.kind === 'exchange' ? sentTo.relation : 'self'); setProof('none');
    setAmountInput(''); setAddress(''); setRecipient(sentTo?.kind === 'exchange' && sentTo.relation === 'other' ? previous.recipient : ''); setConsent(false); setSimulation('success'); setEmailCode(null); setEmailInput('');
    setCurrentOperationId(undefined); setShowForm(true); clearQuote(); moveTo('asset');
  }

  const title = operation ? operation.status === 'completed' ? operation.kind === 'deposit' ? '입금 완료' : '보내기 완료' : operation.status === 'failed' ? '처리 실패' : operation.status === 'cancelled' ? '취소된 요청' : operation.kind === 'deposit' ? '입금 진행 상황' : '보내기 진행 상황'
    : missingOperation ? '입출금 내역' : step === 'asset' ? depositing ? '어디서 보내나요?' : '어디로 보낼까요?' : step === 'review' ? '보낼 정보 확인' : depositing ? '입금 주소' : '보낼 정보 입력';
  const cancellable = operation?.status === 'awaiting_deposit' || operation?.status === 'reviewing';
  const readyToStart = showForm && (step === 'review' || depositing && step === 'details' && quote !== null);

  function quoteSummary(value: FundingMovementQuote | null) {
    return <div className="funding-quote"><div className="funding-quote-header"><h3>{depositing ? '들어올 금액' : '수수료와 받는 금액'}</h3><div className="funding-quote-clock"><span data-testid="quote-ttl" className={expired ? 'expired' : ''}>{seconds === null ? '견적 확인 필요' : expired ? '견적 만료' : `${seconds}초 유효`}</span><button type="button" aria-label="견적 갱신" data-testid="refresh-quote" onClick={() => acceptQuote()}><RefreshCw size={14} />{seconds === null ? '확인' : '갱신'}</button></div></div><dl>
      {depositing && <div className="funding-quote-row"><dt>보낸 수량</dt><dd><span data-testid="quote-units">{value ? symbol === 'KRWS' ? won(value.units) : unitsText(value.units) : '입력 전'}</span>{value && (symbol === 'KRWS' ? '원' : ` ${symbol}`)}</dd></div>}
      <div className="funding-quote-row"><dt>{depositing ? '원화 환산 금액' : '잔액에서 빠질 금액'}</dt><dd data-testid="quote-gross">{value ? money(value.amountWon) : '입력 전'}</dd></div>
      <div className="funding-quote-row"><dt>{depositing ? '입금 수수료' : symbol === 'KRWS' ? '전환 수수료 없음' : `전환 수수료 ${percent(POLICY.conversionFee)}`}</dt><dd data-testid="quote-fee">{depositing ? money(0) : value ? money(value.feeWon) : '입력 전'}</dd></div>
      {!depositing && <div className="funding-quote-row"><dt>네트워크 비용</dt><dd data-testid="quote-network-fee">{value ? money(value.networkFeeWon) : '입력 전'}</dd></div>}
      {!depositing && <div className="funding-quote-row"><dt>수수료를 뺀 금액</dt><dd data-testid="quote-net">{value ? money(value.netWon) : '입력 전'}</dd></div>}
      <div className="funding-quote-total"><dt>{depositing ? '잔액에 더할 금액' : '받는 금액'}</dt><dd className={value ? undefined : 'empty'}>{depositing ? <span data-testid="quote-net">{value ? money(value.netWon) : '입력 전'}</span> : symbol === 'KRWS' ? <span data-testid="quote-units">{value ? money(value.outputUnits) : '입력 전'}</span> : <><span data-testid="quote-units">{value ? unitsText(value.outputUnits) : '입력 전'}</span>{value && <small>{symbol}</small>}</>}</dd></div>
    </dl>{depositing && <p className="funding-help">보내는 곳에서 수수료가 따로 들 수 있어요.</p>}</div>;
  }

  /** Step 2 of a withdrawal: the exchange and who holds the account there, or the holder's own wallet and its signature. */
  function withdrawalFields() {
    const addressField = <div className="funding-form-field"><div className="funding-label-row"><label htmlFor={addressId}>{exchange ? `${venueName} 입금 주소` : '내 지갑 주소'}</label><button type="button" className="funding-text-button" data-testid="funding-preview-address" onClick={() => editAddress(sampleAddress)}>예시 주소</button></div><textarea id={addressId} data-testid="funding-address" rows={2} value={address} placeholder={network === 'bitcoin' ? 'bc1으로 시작하는 주소' : '0x로 시작하는 주소'} onChange={(event) => editAddress(event.target.value)} autoComplete="off" spellCheck={false} aria-invalid={Boolean(errors.address)} />{errors.address ? <p className="funding-field-error" role="alert">{errors.address}</p> : <p className="funding-help">{address === sampleAddress ? '체험용\u00a0주소라 실제로 보내지 않아요.' : exchange ? `${venueName} 앱의 입금 화면에서 ${label} ${selectedNetwork.label} 주소를 복사해 넣어 주세요.` : network === 'bitcoin' ? '주소 형식만 확인해요. 내 지갑 주소가 맞는지 확인해 주세요.' : '0x 주소는 여러 네트워크에서 같이 쓰여요. 지갑의 네트워크를 확인해 주세요.'}</p>}</div>;
    if (!exchange) return <>{addressField}
      <section className="email-check wallet-proof" id={`${uid}-proof`} tabIndex={-1} data-testid="wallet-proof"><div className="email-check-head"><strong>내 지갑 확인</strong>{proof === 'done' ? <span className="email-check-done" data-testid="wallet-proof-done"><Check size={16} strokeWidth={2.6} />확인 완료</span> : <button type="button" className="funding-text-button" data-testid="wallet-proof-sign" disabled={proof === 'checking'} onClick={signWallet}>{proof === 'checking' ? '확인 중' : '서명하기'}</button>}</div>
        {proof === 'done' ? <p>이 주소는 {holder ? `${holder}님` : '내'} 지갑이에요.</p> : <><p>지갑 앱에서 Aqua가 보낸 문구에 서명하면 이 주소가 내 지갑인지 확인돼요. 서명만 하고 돈은 나가지 않아요.</p><p className="wallet-proof-demo">체험판이라 지갑을 연결하지 않고 과정만 보여 드려요.</p></>}</section>
      {errors.proof && <p className="funding-field-error" role="alert">{errors.proof}</p>}</>;
    return <>
      <fieldset className="funding-fieldset funding-venue-field" id={`${uid}-venues`} tabIndex={-1} data-testid="funding-venues"><legend>받는 거래소</legend>
        <div className="funding-venues">{VENUES.filter((item) => item.region === destination).map((item) => <button type="button" key={item.id} className={`funding-venue${venue === item.id ? ' selected' : ''}`} data-testid={`funding-venue-${item.id}`} aria-pressed={venue === item.id} onClick={() => chooseVenue(item.id)}>{item.name}</button>)}</div>
        <button type="button" className={`funding-unlisted${venue === 'unlisted' ? ' selected' : ''}`} data-testid="funding-venue-unlisted" aria-pressed={venue === 'unlisted'} onClick={() => chooseVenue('unlisted')}>찾는 거래소가 없어요</button>
        {venue === 'unlisted' ? <p className="funding-block" role="alert" data-testid="funding-venue-blocked">{UNLISTED_VENUE} 신고하지 않은 거래소로 보내는 것은 법으로 막혀 있어요.</p>
          : errors.venue ? <p className="funding-field-error" role="alert">{errors.venue}</p>
          : destination === 'global' && <p className="funding-help">체험판의 해외 거래소는 예시예요. 실제로 보낼 수 있는 곳은 트래블룰 연동 뒤에 정해져요.</p>}
      </fieldset>
      {venue !== 'unlisted' && <><fieldset className="funding-fieldset funding-relation-field"><legend>받는 사람</legend>
        <div className="funding-relations">{(['self', 'other'] as const).map((key) => <button type="button" key={key} className={`funding-relation${relation === key ? ' selected' : ''}`} data-testid={`funding-relation-${key}`} aria-pressed={relation === key} onClick={() => chooseRelation(key)}>{key === 'self' ? '본인' : '다른 사람'}</button>)}</div>
        {relation === 'self' ? <p className="funding-help">내 {venueName} 계정으로 보내요. 계정 이름이 {holder ? `${holder}님과` : '내 이름과'} 같아야 해요.</p>
          : <div className="funding-form-field"><div className="funding-label-row"><label htmlFor={recipientId}>받는 사람 이름</label><button type="button" className="funding-text-button" data-testid="funding-recipient-sample" onClick={() => { setRecipient(SAMPLE_RECIPIENT); setErrors((current) => ({ ...current, recipient: undefined })); setConsent(false); clearQuote(); }}>샘플 이름</button></div><input id={recipientId} data-testid="funding-recipient" type="text" maxLength={40} value={recipient} placeholder="거래소 계정의 이름" onChange={(event) => { setRecipient(event.target.value); setErrors((current) => ({ ...current, recipient: undefined })); setConsent(false); clearQuote(); }} autoComplete="off" aria-invalid={Boolean(errors.recipient)} />{errors.recipient ? <p className="funding-field-error" role="alert">{errors.recipient}</p> : <p className="funding-help">거래소 계정의 이름과 같아야 해요. 체험판이에요. 실제 이름은 넣지 마세요.</p>}</div>}
      </fieldset>
      {addressField}</>}
    </>;
  }

  function simulationControl() {
    return <details className="funding-simulation"><summary data-testid="funding-simulation-settings">처리 결과 설정</summary><div><label><input type="radio" name={`${uid}-simulation`} checked={simulation === 'success'} onChange={() => setSimulation('success')} data-testid="funding-outcome-success" />정상 완료</label><label><input type="radio" name={`${uid}-simulation`} checked={simulation === 'failure'} onChange={() => setSimulation('failure')} data-testid="funding-outcome-failure" />실패 처리</label></div></details>;
  }

  return <div className="funding-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="funding-dialog" ref={ref} role="dialog" aria-modal="true" aria-labelledby={headingId} data-testid="dialog-funding">
    <span className="sheet-handle" aria-hidden="true" />
    <header className={`funding-header${showForm ? ' has-step' : ''}`}><div className="funding-heading">{showForm && <span className="funding-step-label">{step === 'asset' ? 1 : step === 'details' ? 2 : 3} / {depositing ? 2 : 3}</span>}<h2 id={headingId} ref={headingRef} tabIndex={-1}>{title}</h2><span className="funding-preview-tag">체험 · 실제 송금 불가</span></div><div className="funding-header-actions">{showForm && step !== 'asset' && <button type="button" className="funding-close" data-testid="funding-back" aria-label="이전 단계" onClick={back}><ArrowLeft size={20} /></button>}<button type="button" className="funding-close" aria-label="창 닫기" onClick={onClose}><X size={21} /></button></div></header>
      {copyFeedback && <p className={`funding-copy-feedback${copyFeedback.failed ? ' failed' : ''}`} role={copyFeedback.failed ? 'alert' : 'status'}>{copyFeedback.text}</p>}
    <form id={formId} className="funding-body" noValidate onSubmit={(event) => { event.preventDefault(); if (showForm) { if (readyToStart) start(); else next(); } }}>
      {missingOperation ? <div className="funding-status-message"><p>요청 내역을 찾지 못했어요.</p><p>창을 닫고 홈 화면이나 거래 내역에서 확인해 주세요.</p></div>
      : operation ? <FundingStatus operation={operation} onCopy={copy} />
      : step === 'asset' ? <div className="funding-route-step">
        {depositing && <fieldset className="funding-fieldset"><legend>보내는 곳</legend><div className="funding-origins">{ORIGINS.map(([key, name, note]) => <button type="button" key={key} className={`funding-origin${origin === key ? ' selected' : ''}`} data-testid={`funding-origin-${key}`} aria-pressed={origin === key} onClick={() => setOrigin(key)}><strong>{name}</strong><span>{note}</span></button>)}</div></fieldset>}
        {!depositing && <fieldset className="funding-fieldset" data-testid="funding-destinations"><legend>받는 곳</legend><div className="funding-network-options">{DESTINATIONS.map(([key, name, note]) => <button type="button" key={key} className={`funding-network-option${destination === key ? ' selected' : ''}`} data-testid={`funding-destination-${key}`} aria-pressed={destination === key} onClick={() => { if (destination !== key) chooseDestination(key); }}><span><strong>{name}</strong><small>{note}</small></span><span className="funding-selection-mark">{destination === key && <Check size={15} />}</span></button>)}</div><p className="funding-help">다른 사람의 개인 지갑이나 신고하지 않은 거래소로는 보낼 수 없어요.</p></fieldset>}
        <fieldset className="funding-fieldset"><legend>코인</legend><div className="funding-coins">{symbols.map((asset) => <button type="button" className={`funding-coin${symbol === asset ? ' selected' : ''}`} key={asset} data-testid={`funding-asset-${asset}`} aria-pressed={symbol === asset} onClick={() => chooseAsset(asset)}><CoinIcon symbol={asset} size={34} /><span className="funding-coin-main"><strong>{FUNDING_ASSETS[asset].name}</strong><span>{depositing ? asset === 'KRWS' ? '잔액과 1:1' : '받으면 원화 스테이블로 바뀌어요' : asset === 'KRWS' ? '전환 수수료 없음' : `전환 수수료 ${percent(POLICY.conversionFee)}`}</span></span><span className="funding-selection-mark">{symbol === asset && <Check size={15} />}</span></button>)}</div>{!depositing && <p className="funding-help">{symbol === 'KRWS' ? '원화 스테이블을 그대로 보내요. 네트워크 비용만 들어요.' : `원화 스테이블을 ${symbol}로 바꿔서 보내요.`}</p>}</fieldset>
        <fieldset className="funding-fieldset" data-testid="funding-network"><legend>네트워크</legend><div className="funding-network-options">{networks.map((option, index) => <button type="button" className={`funding-network-option${network === option.id ? ' selected' : ''}`} key={option.id} data-testid={`funding-network-${option.id}`} aria-pressed={network === option.id} onClick={() => chooseNetwork(option.id)}><span><strong>{option.label}{networks.length > 1 && index === 0 && <em className="funding-recommend">추천</em>}</strong><small>{depositing ? `${option.confirmationLabel} · ${option.estimatedTime}` : `네트워크 비용 ${money(option.feeWon)}`}</small></span><span className="funding-selection-mark">{network === option.id && <Check size={15} />}</span></button>)}</div><p className="funding-help">{depositing ? '보내는 곳에서도 같은 코인과 네트워크를 골라 주세요.' : '받는 곳이 같은 네트워크를 지원하는지 확인해 주세요.'}</p></fieldset>
        {!depositing && <div className="funding-route-note"><span>예상 처리 시간</span><strong>{selectedNetwork.estimatedTime}</strong></div>}
      </div>
      : step === 'details' ? <div className="funding-details-step">{!depositing && <div className="funding-route-label"><strong>{label}</strong><span>{selectedNetwork.label}</span><span>잔액에서</span></div>}
        {depositing ? <><div className="funding-receive">
          <div className="funding-receive-head"><CoinIcon symbol={symbol} size={40} /><div><strong>{label} 받는 주소</strong><span>{selectedNetwork.label} 네트워크 · {ORIGINS.find(([key]) => key === origin)?.[1]}</span></div></div>
          <code className="funding-receive-address" data-testid="funding-deposit-address">{sampleAddress}</code>
          <button type="button" className="funding-receive-copy" data-testid="funding-copy-address" aria-label="입금 주소 복사" onClick={() => copy(sampleAddress, '주소를 복사했어요.')}><Copy size={16} />주소 복사</button>
          <ol className="funding-guide">{guideSteps(origin, label, selectedNetwork.label).map((item) => <li key={item}>{item}</li>)}</ol>
          <dl className="funding-receive-facts"><div><dt>최소 입금</dt><dd>{money(POLICY.minimumTopup)} 상당</dd></div><div><dt>입금 확인</dt><dd>{selectedNetwork.confirmationLabel}</dd></div><div><dt>입금 수수료</dt><dd>없음</dd></div></dl>
          {origin === 'domestic' && <p className="funding-receive-note">100만원 이상 보내면 트래블룰에 따라 거래소가 받는&nbsp;곳을 물어봐요.</p>}
          {origin === 'global' && <p className="funding-receive-note">트래블룰을 지원하는 해외 거래소에서만 받을 수 있어요.</p>}
          <p className="funding-receive-warning">{label}만 {selectedNetwork.label} 네트워크로 보내 주세요. 체험용&nbsp;주소라 실제로 입금되지 않아요.</p>
        </div>
        <div className="funding-trial-head"><h3>입금 체험</h3><p>보낸 수량을 넣으면 입금 과정을 미리 볼&nbsp;수 있어요.</p></div></>
        : withdrawalFields()}
        <div className="funding-amount"><div className="funding-label-row"><label htmlFor={amountId}>{depositing ? '보낸 수량' : '보낼 금액'}</label>{!depositing && <button type="button" className="funding-text-button" data-testid="funding-max" disabled={available <= 0} onClick={maxAmount}>최대</button>}</div><div className="funding-amount-input"><AmountInput id={amountId} unit={usingUnits && symbol !== 'KRWS' ? symbol : '원'} data-testid="action-amount" decimals={usingUnits && symbol !== 'KRWS'} value={amountInput} onValueChange={editAmount} autoComplete="off" aria-invalid={Boolean(amountIssue)} /></div>{amountIssue ? <p className="funding-field-error" role="alert">{amountIssue}</p> : <p className="funding-help">{depositing ? '원화로 1,000원 이상이어야 해요.' : `보낼 수 있는 금액 ${money(available)} · 수수료 포함`}</p>}</div>
        {depositing && <>{quoteSummary(displayedQuote)}<label className="funding-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} data-testid="funding-consent" /><span>{symbol === 'KRWS' ? '입금이 확인되면 잔액에 더해지는\u00a0것을 확인했어요.' : '입금이 확인되면 원화 스테이블로 바뀌는\u00a0것을 확인했어요.'}</span></label>{simulationControl()}</>}
      </div>
      : <div className="funding-review-step"><dl className="funding-review-recipient" data-testid="funding-review-recipient"><div><dt>받는 곳</dt><dd>{exchange ? `${venueName} · ${regionName(chosenVenue?.region ?? 'domestic')}` : '내 지갑 · 서명 확인'}</dd></div><div><dt>받는 사람</dt><dd>{exchange && relation === 'other' ? recipientName : `${holder} (본인)`}</dd></div><div><dt>코인·네트워크</dt><dd>{label} · {selectedNetwork.label}</dd></div><div className="funding-review-address"><dt>받는 주소</dt><dd>{address.trim()}</dd></div></dl><p className="funding-travel-note" data-testid="funding-travel-note">{exchange ? `트래블룰에 따라 금액과 관계없이 내 이름과 받는 사람 이름을 ${venueName}에 함께 보내요. 이름이 계정과 다르면 ${josa(venueName, '이', '가')} 받지 않고 돌려보낼 수 있어요.` : '서명으로 확인한 내 지갑이에요. 확인한 기록을 이 출금과 함께 남겨요.'}</p>{quoteSummary(quote)}<div className="funding-resulting-balance"><span>보낸 뒤 잔액</span><strong>{money(Math.max(0, available - (quote?.amountWon ?? 0)))}</strong></div><label className="funding-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} data-testid="funding-consent" /><span>보낼 정보와 수수료를 확인했어요.</span></label><section className="email-check" data-testid="email-check"><div className="email-check-head"><strong>이메일 인증</strong>{emailVerified ? <span className="email-check-done" data-testid="email-verified"><Check size={16} strokeWidth={2.6} />인증 완료</span> : <button type="button" className="funding-text-button" data-testid="email-send" onClick={() => { setEmailCode(demoCode()); setEmailInput(''); }}>{emailCode ? '다시 받기' : '인증 코드 받기'}</button>}</div>{!emailVerified && <p>보내려면 {maskEmail(email)} 메일로 받은 6자리&nbsp;코드가 필요해요.</p>}{!emailVerified && emailCode && <><p className="email-check-demo" data-testid="email-demo-code">체험판이라 메일은 보내지 않아요. 인증 코드 <strong>{emailCode}</strong></p><input className="email-check-input" data-testid="email-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} aria-label="이메일 인증 코드" placeholder="6자리 코드" value={emailInput} onChange={(event) => setEmailInput(event.target.value.replace(/\D/g, ''))} /></>}</section><p className="funding-help">주소는 형식만 확인했어요. 네트워크는 직접 확인해 주세요.</p>{simulationControl()}</div>}
      {errors.general && <div className="funding-error" role="alert">{errors.general}</div>}
      {readyToStart && expired && <p className="funding-field-error" role="alert">견적이 만료됐어요. 갱신한 뒤 다시 확인해 주세요.</p>}
    </form>
    <footer className="funding-footer">{operation ? <><p className="funding-footer-note">{isFundingPending(operation) ? '창을 닫아도 요청은 그대로 있어요.' : '거래 내역에서 다시 볼\u00a0수 있어요.'}</p><div className="funding-footer-actions">{operation.status === 'awaiting_deposit' ? <button type="button" className="funding-confirm" data-testid="funding-simulate-deposit" disabled={submitting} onClick={() => operate({ type: 'SIMULATE_FUNDING_DEPOSIT', id: operation.id })}>입금 확인 체험</button> : operation.status === 'failed' || operation.status === 'cancelled' ? <button type="button" className="funding-confirm" data-testid="funding-retry" onClick={() => retry(operation)}>다시 입력</button> : <button type="button" className="funding-confirm" data-testid="funding-done" onClick={onClose}>{isFundingPending(operation) ? '나중에 확인' : '닫기'}</button>}{cancellable && <button type="button" className="funding-secondary" data-testid="funding-cancel" disabled={submitting} onClick={() => operate({ type: 'CANCEL_FUNDING', id: operation.id })}>요청 취소</button>}</div></>
      : missingOperation ? <button type="button" className="funding-confirm" onClick={onClose}>닫기</button>
      : readyToStart ? <button type="submit" form={formId} className="funding-confirm" data-testid="confirm-action" disabled={!consent || expired || submitting || quote === null || (!depositing && !emailVerified)}>{submitting ? '접수 중' : depositing ? '입금 체험하기' : `${money(quote?.amountWon ?? 0)} 보내기`}</button>
      : <button type="submit" form={formId} className="funding-confirm" data-testid="funding-next">{depositing && step === 'details' ? '보낸 수량 확인' : depositing && step === 'asset' ? '주소 보기' : '다음'}</button>}</footer>
  </section></div>;
}

function FundingStatus({ operation, onCopy }: { operation: FundingOperation; onCopy: (value: string, message: string) => Promise<void> }) {
  const incoming = operation.kind === 'deposit';
  const terminalError = operation.status === 'failed' || operation.status === 'cancelled';
  const statuses: FundingOperation['status'][] = incoming ? ['awaiting_deposit', 'confirming', 'converting', 'completed'] : ['reviewing', 'broadcasting', 'completed'];
  const stages = terminalError ? [statuses[0], operation.status] : statuses;
  const index = terminalError ? 1 : statuses.indexOf(operation.status);
  const pending = isFundingPending(operation);
  const restoration = money(operation.amountWon);
  return <div className="funding-status-view"><div className={`funding-status-heading ${operation.status}`} data-testid="funding-status" data-status={operation.status} role="status" aria-live="polite"><span>{fundingStatusLabel(operation.status)}</span><strong>{incoming ? money(operation.netWon) : money(operation.amountWon)}</strong><p>{incoming ? operation.status === 'completed' ? '잔액에 더한 금액' : terminalError ? '입금 예정이던 금액' : '입금이 확인되면 잔액에 더할 금액' : '수수료를 포함해 신청한 금액'}</p></div>
    <ol className="funding-timeline">{stages.map((status, position) => <li key={status} className={position < index || operation.status === 'completed' ? 'done' : position === index ? 'current' : ''} aria-current={position === index ? 'step' : undefined}><span className="funding-timeline-marker">{position + 1}</span><div><strong>{terminalError && position === 0 ? '요청 접수' : fundingStatusLabel(status)}</strong>{position === index && <span>{shortDate(operation.updatedAt)}</span>}</div></li>)}</ol>
    <div className="funding-status-message">{operation.status === 'awaiting_deposit' ? <><p>아직 입금이 확인되지 않아 잔액은 그대로예요.</p><p>입금 확인 체험을 누르면 다음 단계로 넘어가요.</p></> : operation.status === 'completed' ? <p>{incoming ? `${money(operation.netWon)}이 잔액에 들어왔어요.` : `잔액에서 ${money(operation.amountWon)}이 나갔어요.`}</p> : terminalError ? <><p>{operation.failureReason ?? (operation.status === 'cancelled' ? '요청을 취소했어요.' : '처리하지 못했어요.')}</p><p>{incoming ? '잔액은 바뀌지 않았어요.' : `보류했던 ${restoration}을 모두 돌려드렸어요. 수수료는 빼지 않았어요.`}</p></> : <><p>{incoming ? operation.symbol === 'KRWS' ? '입금을 확인하고 있어요.' : '입금을 확인하고 원화 스테이블로 바꾸고 있어요.' : `보내는 동안 ${restoration}은 쓸 수 없어요.`}</p><p>홈 화면이나 거래 내역에서 이어서 확인할 수 있어요.</p></>}</div>
    {incoming && operation.status === 'awaiting_deposit' && <div className="funding-destination"><div className="funding-destination-heading"><h3>입금 주소</h3><button type="button" aria-label="입금 주소 복사" onClick={() => onCopy(operation.address, '주소를 복사했어요.')}><Copy size={15} />복사</button></div><code>{operation.address}</code><p>체험용&nbsp;주소라 실제로 입금되지 않아요.</p></div>}
    <details className="funding-operation-details" open={!pending}><summary>요청 상세</summary><dl><div><dt>코인·네트워크</dt><dd>{fundingLabel(operation.symbol)} · {getFundingNetworks(operation.symbol).find((option) => option.id === operation.network)?.label}</dd></div>{!incoming && <>{operation.destination && <div><dt>받는 곳</dt><dd>{operation.destination.kind === 'own_wallet' ? '내 지갑 · 서명 확인' : `${destinationName(operation.destination)} · ${regionName(venueOf(operation.destination.venue)?.region ?? 'domestic')}`}</dd></div>}<div><dt>받는 사람</dt><dd>{operation.recipient}</dd></div><div className="address"><dt>받는 주소</dt><dd>{operation.address}</dd></div></>}<div><dt>접수 일시</dt><dd>{shortDate(operation.createdAt)}</dd></div><div><dt>{terminalError ? '견적 전환 수수료' : '전환 수수료'}</dt><dd>{money(operation.feeWon)}</dd></div><div><dt>{terminalError ? '견적 네트워크 비용' : '네트워크 비용'}</dt><dd>{money(operation.networkFeeWon)}</dd></div>{terminalError && <div><dt>실제로 낸 수수료</dt><dd>{money(0)}</dd></div>}{!incoming && <div><dt>{terminalError ? '받을 예정이던 금액' : '받는 금액'}</dt><dd>{amountOf(operation.symbol, operation.outputUnits)}</dd></div>}</dl><div className="funding-operation-reference"><span>요청 번호</span><code>{operation.requestId}</code><button type="button" aria-label="요청 번호 복사" data-testid="funding-copy-request" onClick={() => onCopy(operation.requestId, '요청 번호를 복사했어요.')}><Copy size={15} />복사</button></div></details>
  </div>;
}
