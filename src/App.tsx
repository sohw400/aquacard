import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowDownLeft, ArrowLeftRight, ArrowUpRight, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight,
  Clock3, CreditCard, Info, LockKeyhole, Percent, RefreshCw, RotateCcw, Waves, X, type LucideIcon,
} from 'lucide-react';
import CardApplication from './components/CardApplication';
import CardVisual from './components/CardVisual';
import CoinIcon from './components/CoinIcon';
import Logo from './components/Logo';
import Onboarding from './components/Onboarding';
import AccountClosureSheet from './components/AccountClosureSheet';
import { PasswordSheet } from './components/SecuritySheets';
import { ChannelsPage, FaqPage, LimitsPage, NotificationsPage, TermsPage } from './components/SettingsPages';
import TransactionSheet from './components/TransactionSheet';
import FundingDialog from './components/FundingDialog';
import InternalTransferDialog from './components/InternalTransferDialog';
import FundingHistory from './components/FundingHistory';
import RewardsSummary from './components/RewardsSummary';
import PaymentReceipt, { type PaymentReceiptData } from './components/PaymentReceipt';
import { applyAction, availableToSpend, createInitialState, liveRewards, loadState, portfolioValue, reserveEarnings, saveState } from './lib/engine';
import { maskEmail, maskPhone } from './lib/auth';
import { dateLabel, dayLabel, money, monthDay, percent, shortDate, timeLabel, won } from './lib/format';
import { ASSETS, fundingLabel, PLANS, POLICY } from './lib/policy';
import { fundingStatusLabel, getHeldFundingWon, isFundingPending } from './lib/movements';
import { getCashbackSummary } from './lib/rewards';
import type { Action, AppState, AssetSymbol, CardStage, FundingOperation, FundingSymbol, Payment, PaymentChannel, Transaction } from './lib/types';

type Page = 'home' | 'wallet' | 'benefits' | 'card' | 'reserve' | 'activity' | 'settings' | 'limits' | 'channels' | 'notifications' | 'faq' | 'terms';
type MainPage = 'home' | 'wallet' | 'benefits' | 'settings';
type Dialog =
  | { type: 'payment' }
  | { type: 'refund'; payment: Payment }
  | { type: 'guide' }
  | { type: 'reset' };
type InternalTransfer = { mode: 'reserve'; direction: 'in' | 'out' };
type Toast = { message: string; type: 'success' | 'error' | 'info' };
type Tone = '' | 'accent' | 'warning' | 'danger';

const DEPOSIT_COINS: FundingSymbol[] = ['KRWS', 'USDC', 'USDT', 'BTC', 'ETH'];
const MAIN_PAGES: MainPage[] = ['home', 'wallet', 'benefits', 'settings'];
const STAGE_NAMES: Record<CardStage, string> = {
  not_applied: '미발급', identity: '신청 중', plan: '신청 중', details: '신청 중',
  review: '신청 중', submitted: '심사 중', needs_info: '보완 필요', approved: '발급 승인',
  issued: '활성화 대기', active: '사용 가능', rejected: '신청 미승인',
};
const STAGE_TONES: Record<CardStage, Tone> = {
  not_applied: '', identity: '', plan: '', details: '', review: '', submitted: '',
  needs_info: 'warning', approved: '', issued: '', active: 'accent', rejected: 'danger',
};
const PAGE_TITLES: Record<Page, string> = {
  home: '홈', wallet: '자산', benefits: '혜택', settings: '전체',
  card: '카드 관리', reserve: '리저브', activity: '이용 내역',
  limits: '결제 한도', channels: '온라인·해외 결제', notifications: '알림 설정', faq: '자주 묻는 질문', terms: '약관 및 정책',
};
const ACTIVITY_ICONS: Record<Transaction['kind'], LucideIcon> = {
  deposit: ArrowDownLeft, transfer: ArrowLeftRight, convert: RefreshCw, payment: CreditCard,
  refund: RotateCcw, reward: Waves, payback: Percent, rate: Percent, card: CreditCard,
};
const PAYMENT_PRESETS = [['한강커피', 5_800, 'store'], ['온라인 쇼핑', 89_000, 'online'], ['도쿄 카페', 7_200, 'overseas']] as const;
const CHANNELS: [PaymentChannel, string][] = [['store', '매장'], ['online', '온라인'], ['overseas', '해외']];

function statusOf(item: Transaction): [string, Tone] | null {
  if (item.status === 'pending') return [item.fundingId ? '처리 중' : '승인 중', 'accent'];
  if (item.status === 'failed') return [item.amount < 0 ? '실패 · 잔액 복원' : '실패 · 입금 미반영', 'danger'];
  if (item.status === 'cancelled') return ['취소', ''];
  if (item.status === 'refunded') return ['전액 환불', ''];
  if (item.status === 'partially_refunded') return ['부분 환불', ''];
  return null;
}

function sourcesFor(state: AppState, amount: number) {
  const rewards = state.rewardsAuto ? Math.min(state.rewards, Math.max(0, amount)) : 0;
  const spend = Math.min(state.spend, Math.max(0, amount - rewards));
  const reserve = state.reserveAuto ? Math.min(state.reserve, Math.max(0, amount - rewards - spend)) : 0;
  const shortfall = Math.max(0, amount - rewards - spend - reserve);
  const plan = PLANS[state.card.plan];
  const cashback = Math.min(Math.floor(Math.max(0, amount - rewards) * plan.cashbackRate), Math.max(0, plan.cashbackCap - state.monthlyCashback));
  return { rewards, spend, reserve, shortfall, cashback };
}

const signed = (amount: number, positive: boolean, plain = false) => amount === 0 ? money(0) : `${plain ? '' : amount < 0 ? '−' : positive ? '+' : ''}${money(Math.abs(amount))}`;

/** Large amounts set the unit smaller so the figure carries the weight. */
function Won({ value, className = '', testId }: { value: number; className?: string; testId?: string }) {
  return <strong className={`won ${className}`} data-testid={testId}>{won(value)}<small>원</small></strong>;
}

/** Re-renders only the live figure, not the whole app. */
function useTicker(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const timer = setInterval(() => setNow(Date.now()), reduce ? 1_000 : 100);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const fraction = (value: number) => (Math.floor(Math.min(Math.max(value, 0), 0.9999) * 10_000) / 10_000).toFixed(4).slice(1);

/** Whole won come from the ledger; only the fraction moves between engine ticks. */
function LiveRewards({ state, testId }: { state: AppState; testId?: string }) {
  const now = useTicker();
  return <span className="live-figure"><strong data-testid={testId}>{won(state.rewards)}</strong><span className="live-fraction">{fraction(liveRewards(state, now) - state.rewards)}</span><small>원</small></span>;
}

function LiveEarnings({ state, period, testId }: { state: AppState; period: 'today' | 'total'; testId?: string }) {
  const value = reserveEarnings(state, useTicker())[period];
  const whole = Math.floor(value + 1e-9);
  return <span className="live-figure small"><strong data-testid={testId}>+{won(whole)}</strong><span className="live-fraction">{fraction(value - whole)}</span><small>원</small></span>;
}

function NavIcon({ name }: { name: MainPage }) {
  const stroke = { stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
  return <svg className="nav-icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
    {name === 'home' && <path className="nav-shape" {...stroke} d="M4.5 10.4 12 4.4l7.5 6V19a1.2 1.2 0 0 1-1.2 1.2H15v-5.3H9v5.3H5.7A1.2 1.2 0 0 1 4.5 19Z" />}
    {name === 'wallet' && <><path {...stroke} fill="none" d="M6.5 6.4V5.9a1.8 1.8 0 0 1 2.2-1.8l8.6 2.3" /><rect className="nav-shape" {...stroke} x="3.8" y="6.4" width="16.4" height="13.4" rx="3" /><circle className="nav-cut" cx="16.2" cy="13.1" r="1.25" /></>}
    {name === 'benefits' && <><path className="nav-shape" {...stroke} d="M6.6 5.6h10.8a2 2 0 0 1 2 2v2.1a2.3 2.3 0 0 0 0 4.6v2.1a2 2 0 0 1-2 2H6.6a2 2 0 0 1-2-2v-2.1a2.3 2.3 0 0 0 0-4.6V7.6a2 2 0 0 1 2-2Z" /><path className="nav-cut-line" d="M14.6 8.2v7.6" strokeWidth="1.8" strokeLinecap="round" strokeDasharray="1.4 2.4" /></>}
    {name === 'settings' && [[4.6, 4.6], [13.4, 4.6], [4.6, 13.4], [13.4, 13.4]].map(([x, y]) => <rect key={`${x}-${y}`} className="nav-shape" {...stroke} x={x} y={y} width="6" height="6" rx="1.8" />)}
  </svg>;
}

function Toggle({ checked, onChange, label, detail, testId }: { checked: boolean; onChange: (value: boolean) => void; label: string; detail: string; testId?: string }) {
  return <div className="toggle-row"><div><strong>{label}</strong><p>{detail}</p></div><button type="button" className={`switch${checked ? ' on' : ''}`} role="switch" aria-checked={checked} aria-label={label} data-testid={testId} onClick={() => onChange(!checked)}><span /></button></div>;
}

function ActivityRow({ item, payment, coin, onRefund, onFunding, onDetail, detailed }: { item: Transaction; payment?: Payment; coin?: FundingSymbol; onRefund: (payment: Payment) => void; onFunding?: (id: string) => void; onDetail?: (item: Transaction) => void; detailed: boolean }) {
  const refundable = detailed && payment && ['completed', 'partially_refunded'].includes(payment.status);
  const unsettled = Boolean(item.fundingId) && item.status !== 'completed';
  const positive = !unsettled && ['deposit', 'refund', 'reward', 'payback', 'card'].includes(item.kind) && item.amount > 0;
  const Icon = item.kind === 'transfer' && item.amount < 0 ? ArrowUpRight : ACTIVITY_ICONS[item.kind];
  const status = statusOf(item);
  return <div className="activity-row">
    {coin ? <CoinIcon symbol={coin} /> : <span className="activity-icon" aria-hidden="true">{item.kind === 'payment' ? item.title.trim().charAt(0) : <Icon />}</span>}
    <div className="activity-copy">
      <strong>{item.title}</strong>
      <span>{detailed ? timeLabel(item.timestamp) : shortDate(item.timestamp)}{status && <em className={`status-text ${status[1]}`}>{status[0]}</em>}</span>
      {detailed && onDetail && <button type="button" className="detail-link" data-testid={`tx-detail-${item.id}`} aria-label={`${item.title} 상세`} onClick={() => onDetail(item)}>상세</button>}
    </div>
    <div className={`activity-amount${positive ? ' positive' : ''}${item.kind === 'payment' && item.status === 'refunded' ? ' refunded' : ''}${unsettled ? ' unsettled' : ''}`}>
      {item.amount !== 0 || item.kind === 'payment' || item.fundingId ? <strong>{signed(item.amount, positive, unsettled)}</strong> : null}
      {item.fundingId && onFunding && <button className="pill-button" data-testid={`funding-open-${item.fundingId}`} onClick={() => onFunding(item.fundingId!)} aria-label={`${item.title} 처리 내역`}>처리 내역</button>}
      {refundable && <button className="pill-button" onClick={() => onRefund(payment)} aria-label={`${payment.merchant} 환불`}>환불</button>}
    </div>
  </div>;
}

function ActivityList({ items, onRefund, payments, operations, onFunding, onDetail, detailed = false }: { items: Transaction[]; onRefund: (payment: Payment) => void; payments: Payment[]; operations: FundingOperation[]; onFunding?: (id: string) => void; onDetail?: (item: Transaction) => void; detailed?: boolean }) {
  if (!items.length) return <p className="empty-text">이용 내역이 없습니다.</p>;
  const row = (item: Transaction) => <ActivityRow key={item.id} item={item} payment={item.kind === 'payment' ? payments.find((p) => p.id === item.paymentId) : undefined} coin={item.fundingId ? operations.find((operation) => operation.id === item.fundingId)?.symbol : undefined} onRefund={onRefund} onFunding={onFunding} onDetail={onDetail} detailed={detailed} />;
  if (!detailed) return <div className="activity-list">{items.map(row)}</div>;
  const days = new Map<string, Transaction[]>();
  items.forEach((item) => { const day = dayLabel(item.timestamp); days.set(day, [...(days.get(day) ?? []), item]); });
  return <div className="activity-list detailed">{[...days].map(([day, list]) => <div className="activity-day" key={day}><h2>{day}</h2>{list.map(row)}</div>)}</div>;
}

function RewardHistory({ state }: { state: AppState }) {
  const credits = state.transactions.filter((item) => (item.kind === 'payback' || item.kind === 'reward') && item.amount > 0).map((item) => {
    const payment = item.paymentId ? state.payments.find((value) => value.id === item.paymentId) : undefined;
    return {
      id: item.id,
      title: item.title,
      detail: payment?.refunded ? '확정 · 환불 조정 반영' : '확정',
      amount: payment ? payment.cashback - payment.cashbackReversed : item.amount,
      timestamp: item.timestamp,
      kind: 'credit',
    };
  });
  const uses = state.payments.filter((payment) => payment.fromRewards > 0).map((payment) => ({
    id: `${payment.id}-rewards`,
    title: `${payment.merchant} 결제에 사용`,
    detail: payment.refunded ? '환불로 복원' : payment.status === 'pending' ? '승인 중' : '결제 완료',
    amount: -(payment.fromRewards - payment.rewardsRestored),
    timestamp: payment.timestamp,
    kind: 'use',
  }));
  const items = [...credits, ...uses].sort((a, b) => b.timestamp - a.timestamp).slice(0, 8);
  return <section className="panel reward-history"><h2 className="panel-title">리워드 내역</h2>
    {items.length ? <div className="plain-list">{items.map((item) => <div className="plain-row" key={item.id}><span className="row-main"><strong>{item.title}</strong><span>{shortDate(item.timestamp)} · {item.detail}</span></span><strong className={`row-value${item.kind === 'use' ? '' : ' positive'}`}>{signed(item.amount, true)}</strong></div>)}</div>
      : <p className="empty-text">아직 쌓인 리워드가 없습니다.</p>}
  </section>;
}

export default function App() {
  const [state, setState] = useState<AppState>(() => loadState());
  const stateRef = useRef(state);
  const [page, setPage] = useState<Page>('home');
  const [trail, setTrail] = useState<Page[]>([]);
  const [activityFilter, setActivityFilter] = useState<'all' | 'payment' | 'cash'>('all');
  const [closingAccount, setClosingAccount] = useState(false);
  const [passwordSheet, setPasswordSheet] = useState(false);
  const [detailItem, setDetailItem] = useState<Transaction | null>(null);
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [funding, setFunding] = useState<{ mode: 'deposit' | 'withdraw'; symbol?: FundingSymbol; operationId?: string } | null>(null);
  const closeFunding = useCallback(() => setFunding(null), []);
  const [internalTransfer, setInternalTransfer] = useState<InternalTransfer | null>(null);
  const closeInternalTransfer = useCallback(() => setInternalTransfer(null), []);
  const openFundingOperation = (id: string) => {
    const operation = state.fundingOperations.find((item) => item.id === id);
    if (operation) setFunding({ mode: operation.kind === 'deposit' ? 'deposit' : 'withdraw', symbol: operation.symbol, operationId: id });
  };
  const [receipts, setReceipts] = useState<PaymentReceiptData[]>([]);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmationTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const paymentSnapshots = useRef(new Map<string, { rewardsBefore: number; rewardsAfterDebit: number }>());
  const closeDialog = useCallback(() => setDialog(null), []);
  const closeReceipt = useCallback(() => setReceipts((current) => current.slice(1)), []);

  const notify = useCallback((message: string, type: Toast['type'] = 'success') => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ message, type });
    toastTimer.current = setTimeout(() => setToast(null), 5_000);
  }, []);
  const dispatch = useCallback((action: Action): AppState => {
    const previous = stateRef.current;
    const next = applyAction(previous, action);
    if (action.type === 'PAY') {
      const payment = next.payments.find((item) => !previous.payments.some((existing) => existing.id === item.id));
      if (payment) paymentSnapshots.current.set(payment.id, { rewardsBefore: previous.rewards, rewardsAfterDebit: next.rewards });
    }
    stateRef.current = next;
    setState(next);
    return next;
  }, []);
  const perform = useCallback((action: Action, message?: string): AppState | null => {
    try {
      const next = dispatch(action);
      if (message) notify(message);
      return next;
    } catch (error) {
      notify(error instanceof Error ? error.message : '입력 내용을 확인해 주세요.', 'error');
      return null;
    }
  }, [dispatch, notify]);
  const confirmPayment = useCallback((id: string) => {
    const timer = setTimeout(() => {
      confirmationTimers.current.delete(timer);
      const beforeConfirmation = stateRef.current;
      const pending = beforeConfirmation.payments.find((item) => item.id === id);
      if (!pending || pending.status !== 'pending') {
        paymentSnapshots.current.delete(id);
        return;
      }
      const result = perform({ type: 'CONFIRM_PAYMENT', id });
      const payment = result?.payments.find((item) => item.id === id);
      if (payment && result) {
        const snapshot = paymentSnapshots.current.get(id);
        paymentSnapshots.current.delete(id);
        if (snapshot) setReceipts((current) => [...current, {
          payment,
          ...snapshot,
          rewardsAfter: result.rewards,
          cashbackCredit: result.rewards - beforeConfirmation.rewards,
          cashbackOffset: beforeConfirmation.rewardDebt - result.rewardDebt,
          otherRewardDelta: beforeConfirmation.rewards - snapshot.rewardsAfterDebit,
        }]);
        notify(`${payment.merchant} 결제 완료${payment.cashback ? ` · 페이백 ${money(payment.cashback)}` : ''}`);
      }
    }, 450);
    confirmationTimers.current.add(timer);
  }, [perform, notify]);

  useEffect(() => { saveState(state); }, [state]);
  useEffect(() => {
    const timer = setInterval(() => { perform({ type: 'TICK' }); }, 1_000);
    stateRef.current.payments.filter((item) => item.status === 'pending').forEach((item) => confirmPayment(item.id));
    return () => {
      clearInterval(timer);
      confirmationTimers.current.forEach((item) => clearTimeout(item));
      confirmationTimers.current.clear();
    };
  }, [perform, confirmPayment]);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);
  // Signing out leaves no screen, sheet or receipt behind for the next sign-in.
  useEffect(() => {
    if (state.signedIn) return;
    setPage('home'); setTrail([]); setDialog(null); setFunding(null); setInternalTransfer(null); setReceipts([]); setClosingAccount(false); setPasswordSheet(false); setDetailItem(null);
  }, [state.signedIn]);

  function startPayment() {
    if (state.card.stage === 'not_applied') {
      const result = perform({ type: 'SET_CARD', card: { ...state.card, stage: 'identity' } });
      if (result) navigate('card');
      return;
    }
    if (state.card.stage !== 'active' || state.card.locked) {
      navigate('card');
      return;
    }
    setDialog({ type: 'payment' });
  }
  function navigate(next: Page) {
    if (next === page) return;
    setTrail(MAIN_PAGES.includes(next as MainPage) ? [] : [...trail, page]);
    setPage(next);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  function goBack() {
    setPage(trail.at(-1) ?? 'home');
    setTrail(trail.slice(0, -1));
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  function resetDemo() {
    confirmationTimers.current.forEach((timer) => clearTimeout(timer));
    confirmationTimers.current.clear();
    paymentSnapshots.current.clear();
    setReceipts([]);
    const next = createInitialState();
    stateRef.current = next;
    setState(next);
    closeFunding();
    closeInternalTransfer();
    closeDialog();
    notify('체험 데이터를 초기화했습니다.');
  }

  const plan = PLANS[state.card.plan];
  const heldFunding = getHeldFundingWon(state);
  const pendingFunding = state.fundingOperations.filter(isFundingPending);
  const allocation = [['cash', state.spend], ['reserve', state.reserve], ['held', heldFunding]] as const;
  const dailyReward = Math.min(state.reserve, POLICY.reserveEligibleCap) * state.reserveRate / 365;
  const locked = state.card.locked && state.card.stage === 'active';
  const cardStatus = locked ? '일시 잠금' : STAGE_NAMES[state.card.stage];
  const cardTone: Tone = locked ? 'warning' : STAGE_TONES[state.card.stage];
  const cardAction = state.card.stage === 'not_applied' ? '카드 신청' : state.card.stage === 'active' ? state.card.locked ? '잠금 해제' : '결제하기' : state.card.stage === 'needs_info' ? '정보 확인' : ['submitted', 'approved', 'issued'].includes(state.card.stage) ? '발급 상태' : state.card.stage === 'rejected' ? '다시 신청' : '신청 이어하기';
  const mainPage = MAIN_PAGES.includes(page as MainPage);
  const activeTab = mainPage ? page : trail.find((item) => MAIN_PAGES.includes(item as MainPage)) ?? 'home';
  const cashback = getCashbackSummary(state);
  const filteredTransactions = state.transactions.filter((item) => activityFilter === 'all' || (activityFilter === 'payment' ? ['payment', 'refund', 'card'].includes(item.kind) : ['deposit', 'convert', 'transfer'].includes(item.kind)));
  const openRefund = (payment: Payment) => setDialog({ type: 'refund', payment });
  const reserveToggle = <Toggle checked={state.reserveAuto} onChange={(enabled) => perform({ type: 'SET_RESERVE_AUTO', enabled }, `리저브 자동 사용 ${enabled ? '켜짐' : '꺼짐'}`)} label="리저브 자동 사용" detail="결제 잔액이 모자랄 때만 리저브에서 채웁니다. 쓴 만큼은 보상이 쌓이지 않습니다." testId="reserve-auto" />;
  const rewardsToggle = <Toggle checked={state.rewardsAuto} onChange={(enabled) => perform({ type: 'SET_REWARDS_AUTO', enabled }, `리워드 우선 사용 ${enabled ? '켜짐' : '꺼짐'}`)} label="리워드 우선 사용" detail="카드 결제에 리워드를 먼저 씁니다." testId="rewards-auto" />;

  const account = state.account;
  if (!account || !state.signedIn) return <Onboarding state={state} dispatch={dispatch} />;

  return <div className={`app-shell page-${page}${mainPage ? '' : ' detail'}`}>
    <header className="app-header">
      <button className="brand" onClick={() => navigate('home')} aria-label="Aqua Card 첫 화면"><Logo size={26} /><span className="demo-tag">체험판</span></button>
      <nav className="primary-nav bottom-nav" aria-label="주 메뉴">{MAIN_PAGES.map((key) => <button key={key} className={`nav-item${activeTab === key ? ' active' : ''}`} aria-current={activeTab === key ? 'page' : undefined} data-testid={`nav-${key}`} onClick={() => navigate(key)}><NavIcon name={key} /><span>{PAGE_TITLES[key]}</span></button>)}</nav>
      <p className="sidebar-note">잔액, 카드, 시세는 모두 체험용 데이터이며 이 브라우저에만 저장됩니다.</p>
    </header>
    <main className="main-content">
      <header className="topbar">
        <div className="page-heading">
          {!mainPage && <button className="icon-button" aria-label="이전 화면" data-testid="go-back" onClick={goBack}><ChevronLeft size={26} /></button>}
          {page === 'home' && <span className="topbar-brand" aria-hidden="true"><Logo size={24} /><span className="demo-tag">체험판</span></span>}
          <h1>{PAGE_TITLES[page]}</h1>
        </div>
        <div className="topbar-actions"><button className="icon-button" aria-label="이용 내역" data-testid="nav-activity" onClick={() => navigate('activity')}><Clock3 size={22} /></button><button className="icon-button" aria-label="체험 안내" onClick={() => setDialog({ type: 'guide' })}><Info size={22} /></button></div>
      </header>

      {page === 'home' && <div className="page-stack card-home">
        <section className="card-center" aria-label="내 Aqua 카드">
          <div className="hero-card-stage"><CardVisual card={state.card} variant="hero" /></div>
          <div className="card-caption">
            <span className="card-caption-name"><strong>{plan.name}</strong><span className={`status-text ${cardTone}`}>{cardStatus}</span></span>
            <button className="link-button" data-testid="card-cta" onClick={() => navigate('card')}>카드 관리<ChevronRight size={16} /></button>
          </div>
        </section>
        <section className="panel balance-panel" aria-label="카드 잔액과 결제">
          <div className="balance-head"><span className="panel-label">결제 가능 금액</span><button className="link-button" aria-expanded={breakdownOpen} aria-controls="balance-breakdown" onClick={() => setBreakdownOpen(!breakdownOpen)}>구성<ChevronDown size={16} /></button></div>
          <Won value={availableToSpend(state)} className="hero-amount" testId="available-balance" />
          {breakdownOpen && <dl className="breakdown" id="balance-breakdown"><div><dt>결제 잔액</dt><dd>{money(state.spend)}</dd></div><div><dt>리워드 <span className="breakdown-note">{state.rewardsAuto ? '먼저 사용' : '사용 안 함'}</span></dt><dd>{money(state.rewardsAuto ? state.rewards : 0)}</dd></div><div><dt>리저브 <span className="breakdown-note">{state.reserveAuto ? '부족할 때 사용' : '사용 안 함'}</span></dt><dd>{money(state.reserveAuto ? state.reserve : 0)}</dd></div></dl>}
          <div className="button-pair"><button className="btn neutral" data-testid="open-deposit" onClick={() => setFunding({ mode: 'deposit' })}>충전</button><button className="btn primary" data-testid="open-payment" onClick={startPayment}>{cardAction}</button></div>
          {pendingFunding[0] && <button className="home-funding-status" data-testid="home-funding-status" onClick={() => pendingFunding.length > 1 ? navigate('wallet') : openFundingOperation(pendingFunding[0].id)}><Clock3 size={17} /><span>{pendingFunding.length > 1 ? `진행 중인 입출금 ${pendingFunding.length}건` : `${fundingLabel(pendingFunding[0].symbol)} ${fundingStatusLabel(pendingFunding[0].status)}`}</span><ChevronRight size={17} /></button>}
          {state.card.locked && <p className="inline-notice warning"><LockKeyhole />카드 관리에서 잠금을 해제해 주세요.</p>}
        </section>
        <section className="live-card" aria-label="리워드">
          <div className="live-card-head"><span className="live-label">리워드</span><span className="live-rate">리저브 연 {percent(state.reserveRate)}</span></div>
          <div className="live-amount"><LiveRewards state={state} testId="available-rewards" /></div>
          <p className="live-caption">{state.reserve > 0 ? `리저브 ${money(state.reserve)}에서 보상이 1초마다 쌓입니다.` : '리저브에 넣으면 보상이 1초마다 쌓입니다.'} {state.rewardsAuto ? '결제하면 여기서 먼저 빠집니다.' : '지금은 결제에 쓰지 않도록 꺼 두었습니다.'}</p>
          <div className="live-card-foot"><span className="live-today">오늘 <LiveEarnings state={state} period="today" /></span><button className="live-card-link" data-testid="open-reserve-card" onClick={() => navigate('reserve')}>리저브<ChevronRight size={16} /></button></div>
        </section>
        <button className="panel payback-row" data-testid="open-rewards" onClick={() => navigate('benefits')}>
          <span className="payback-main"><span className="stat-label">이번 달 페이백</span><strong className="stat-value" data-testid="home-cashback-confirmed">{money(cashback.confirmed)}</strong></span>
          <span className="stat-note">{cashback.pending > 0 ? `${money(cashback.pending)} 확정 대기` : `결제액의 ${percent(plan.cashbackRate)} · 월 ${money(plan.cashbackCap)}까지`}</span>
          <ChevronRight className="row-chevron" size={20} />
        </button>
        <section className="panel home-activity">
          <div className="panel-head"><h2>최근 이용</h2><button className="link-button" onClick={() => navigate('activity')}>전체<ChevronRight size={16} /></button></div>
          <ActivityList items={state.transactions.slice(0, 5)} payments={state.payments} operations={state.fundingOperations} onRefund={openRefund} />
        </section>
        <p className="demo-notice">체험 화면입니다. 실제 자금 이동과 카드 발급은 없습니다.</p>
      </div>}

      {page === 'wallet' && <div className="page-stack wallet-page" data-testid="page-wallet">
        <section className="panel wallet-summary">
          <span className="panel-label">총 보유 자산</span>
          <Won value={portfolioValue(state)} className="hero-amount" />
          <div className="allocation" aria-hidden="true">{allocation.map(([key, value]) => value > 0 && <span key={key} className={`allocation-${key}`} style={{ flexGrow: value }} />)}</div>
          <div className="legend">
            <div className="legend-row"><i className="swatch cash" aria-hidden="true" /><span>결제 잔액 <small>원화 스테이블</small></span><strong data-testid="wallet-spend">{money(state.spend)}</strong></div>
            <button className="legend-row" data-testid="open-reserve" onClick={() => navigate('reserve')}><i className="swatch reserve" aria-hidden="true" /><span>리저브 <small>연 {percent(state.reserveRate)}</small><ChevronRight className="legend-chevron" size={15} aria-hidden="true" /></span><strong>{money(state.reserve)}</strong></button>
            {heldFunding > 0 && <div className="legend-row"><i className="swatch held" aria-hidden="true" /><span>출금 처리 중</span><strong data-testid="funding-held">{money(heldFunding)}</strong></div>}
          </div>
          {heldFunding > 0 && <p className="panel-caption">출금 처리 중인 금액은 끝날 때까지 쓸 수 없습니다.</p>}
          <div className="button-pair"><button className="btn primary" data-testid="wallet-deposit" onClick={() => setFunding({ mode: 'deposit' })}>충전</button><button className="btn neutral" data-testid="wallet-withdraw" onClick={() => setFunding({ mode: 'withdraw' })}>출금</button></div>
        </section>
        <FundingHistory operations={state.fundingOperations} onOpen={(operation: FundingOperation) => openFundingOperation(operation.id)} onAll={() => { setActivityFilter('cash'); navigate('activity'); }} />
        <section className="panel accepted-coins" data-testid="accepted-coins">
          <div className="panel-head"><h2>충전할 수 있는 코인</h2></div>
          <div className="coin-chips">{DEPOSIT_COINS.map((symbol) => <button type="button" key={symbol} className="coin-chip" data-testid={`deposit-coin-${symbol}`} onClick={() => setFunding({ mode: 'deposit', symbol })}><CoinIcon symbol={symbol} size={30} /><span>{fundingLabel(symbol)}</span></button>)}</div>
          <p className="panel-caption">보낸 코인은 확인되는 즉시 원화 스테이블로 바뀌어 결제 잔액에 들어옵니다. 코인으로 들고 있지 않으니 코인 가격이 움직여도 잔액은 그대로입니다.</p>
        </section>
        <details className="panel rule-details"><summary>입출금 안내</summary><p>결제 잔액은 원화 스테이블코인으로 보관합니다. 실제 토큰 이름과 네트워크는 발행사 제휴 후 정합니다.</p><p>입금은 수수료가 없습니다. 출금할 때만 네트워크 비용이 들고, 다른 코인으로 바꿔 보내면 전환 수수료 {percent(POLICY.conversionFee)}가 붙습니다.</p><p>리저브에 있는 금액을 밖으로 보내려면 먼저 결제 잔액으로 옮겨 주세요. 지금의 잔액과 입출금은 모두 체험 처리입니다.</p></details>
      </div>}

      {page === 'benefits' && <div className="page-stack benefits-page" data-testid="page-benefits">
        <section className="live-card" aria-label="사용 가능 리워드">
          <div className="live-card-head"><span className="live-label">사용 가능 리워드</span><span className="live-rate">리저브 연 {percent(state.reserveRate)}</span></div>
          <div className="live-amount"><LiveRewards state={state} testId="reward-balance" /></div>
          <p className="live-caption">카드 결제 전용이라 출금할 수 없습니다. 리저브 보상과 페이백은 받기 없이 바로 더해지고, 결제하면 여기서 먼저 빠집니다.</p>
        </section>
        <section className="panel">{rewardsToggle}</section>
        <section className="panel"><RewardsSummary state={state} /><details className="rule-details"><summary>페이백 기준</summary><p>리워드로 낸 금액을 뺀 결제액의 {percent(plan.cashbackRate)}를 적립합니다. 한 달에 {money(plan.cashbackCap)}까지 받을 수 있습니다.</p><p>확정 페이백은 이번 달 결제 중 확정된 금액에 환불 조정을 반영한 값이라 사용 가능 리워드와 다를 수 있습니다.</p><p>지난달 결제가 이번 달에 확정되면 지난달 페이백으로 셉니다. 이전 페이백 조정이 있으면 새 적립액에서 먼저 뺍니다.</p></details></section>
        <section className="panel reserve-earnings">
          <div className="panel-head"><h2>리저브 보상</h2><button className="link-button" onClick={() => navigate('reserve')}>리저브 보기<ChevronRight size={16} /></button></div>
          <dl className="breakdown plain"><div><dt>오늘 쌓인 보상</dt><dd><LiveEarnings state={state} period="today" testId="reserve-today" /></dd></div><div><dt>지금까지 쌓인 보상</dt><dd><LiveEarnings state={state} period="total" testId="reserve-total" /></dd></div><div><dt>하루 예상</dt><dd>약 {money(dailyReward)}</dd></div></dl>
          <p className="panel-caption">1원이 될 때마다 리워드에 바로 더해집니다.</p>
        </section>
        {state.rewardDebt > 0 && <p className="inline-notice warning">이전 페이백 조정 {money(state.rewardDebt)}은 앞으로 받을 리워드에서 먼저 뺍니다.</p>}
        <RewardHistory state={state} />
      </div>}

      {page === 'card' && <div className="card-page"><CardApplication card={state.card} account={account} spend={state.spend} controls={state.controls} onOpenLimits={() => navigate('limits')} onChange={(card) => { perform({ type: 'SET_CARD', card }); }} onAction={(action, message) => perform(action, message) !== null} onDeposit={() => setFunding({ mode: 'deposit' })} onNotify={(message) => notify(message)} /></div>}

      {page === 'reserve' && <div className="page-stack reserve-page">
        <section className="live-card reserve-live" aria-label="리저브">
          <div className="live-card-head"><span className="live-label">리저브 잔액</span><span className="live-rate">변동 보상 연 {percent(state.reserveRate)}</span></div>
          <div className="live-amount"><Won value={state.reserve} className="hero-amount" testId="reserve-principal" /></div>
          <dl className="live-stats"><div><dt>오늘 쌓인 보상</dt><dd><LiveEarnings state={state} period="today" testId="reserve-accrual" /></dd></div><div><dt>지금까지</dt><dd><LiveEarnings state={state} period="total" /></dd></div></dl>
          <div className="button-pair"><button className="btn live-primary" onClick={() => setInternalTransfer({ mode: 'reserve', direction: 'in' })}>넣기</button><button className="btn live-neutral" onClick={() => setInternalTransfer({ mode: 'reserve', direction: 'out' })}>빼기</button></div>
        </section>
        <section className="panel"><p className="panel-caption reserve-explain">보상은 1초마다 계산하고 1원이 될 때마다 리워드에 바로 더합니다. 지금 잔액이면 하루 약 {money(dailyReward)}입니다. 결제 잔액과 오갈 때 수수료는 없습니다.</p>{reserveToggle}</section>
        <details className="panel rule-details"><summary>보상 조건</summary><div className="details-body"><ul><li>보상률은 바뀔 수 있으며 단리로 계산합니다.</li><li>{money(POLICY.reserveEligibleCap)}까지 보상을 계산합니다.</li><li>넣기와 빼기는 1,000원부터 할 수 있습니다.</li><li>리저브에서 결제하면 남은 금액을 기준으로 다시 쌓입니다.</li><li>리워드는 카드 결제에만 쓰며 출금하거나 코인으로 바꿀 수 없습니다.</li><li>예금이 아니며 원금이 보장되지 않습니다. 실제 운용과 상환 조건은 제휴 후 정합니다.</li></ul><div className="rate-history"><h3>보상률 변경 기록</h3>{state.rateHistory.slice().reverse().slice(0, 5).map((item, index) => <div key={`${item.timestamp}-${index}`}><span>{shortDate(item.timestamp)}</span><strong>연 {percent(item.rate)}</strong></div>)}</div><p>밖으로 보내려면 결제 잔액으로 뺀 뒤 자산 화면에서 출금해 주세요.</p></div></details>
      </div>}

      {page === 'activity' && <div className="page-stack activity-page">
        <div className="segmented" role="group" aria-label="내역 종류">{([['all', '전체'], ['payment', '카드'], ['cash', '입출금']] as const).map(([key, label]) => <button key={key} className={activityFilter === key ? 'selected' : ''} aria-pressed={activityFilter === key} onClick={() => setActivityFilter(key)}>{label}</button>)}</div>
        <section className="panel"><ActivityList detailed onFunding={openFundingOperation} onDetail={setDetailItem} items={filteredTransactions} payments={state.payments} operations={state.fundingOperations} onRefund={openRefund} /></section>
        <details className="panel rule-details"><summary>이번 달 카드 이용</summary><dl className="breakdown plain"><div><dt>이번 달 승인액</dt><dd>{money(state.monthlySpent)}</dd></div><div><dt>오늘 승인액</dt><dd>{money(state.dailySpent)}</dd></div><div><dt>페이백 한도 사용</dt><dd>{money(state.monthlyCashback)} / {money(plan.cashbackCap)}</dd></div></dl></details>
      </div>}

      {page === 'settings' && <div className="page-stack settings-page">
        <section className="panel profile-panel"><span className="avatar" aria-hidden="true">{account?.name.charAt(0)}</span><div><strong>{account?.name}</strong><span>{plan.name} · {cardStatus}</span></div></section>
        <section className="panel flush menu-list">
          <button className="list-row" onClick={() => navigate('card')}><span className="row-main"><strong>카드 관리</strong></span><span className="row-value muted">{plan.name}</span><ChevronRight className="row-chevron" size={20} /></button>
          <button className="list-row" onClick={() => navigate('activity')}><span className="row-main"><strong>이용 내역</strong></span><ChevronRight className="row-chevron" size={20} /></button>
        </section>
        <section className="panel flush menu-list"><h2 className="panel-title">카드 설정</h2>
          <button className="list-row" data-testid="open-limits" onClick={() => navigate('limits')}><span className="row-main"><strong>결제 한도</strong></span><span className="row-value muted">1회 {won(state.controls.perPayment / 10_000)}만원</span><ChevronRight className="row-chevron" size={20} /></button>
          <button className="list-row" data-testid="open-channels" onClick={() => navigate('channels')}><span className="row-main"><strong>온라인·해외 결제</strong></span><span className="row-value muted">{state.controls.online && state.controls.overseas ? '모두 허용' : !state.controls.online && !state.controls.overseas ? '모두 막음' : state.controls.online ? '해외 막음' : '온라인 막음'}</span><ChevronRight className="row-chevron" size={20} /></button>
        </section>
        <section className="panel settings-section"><h2 className="panel-title">결제</h2>{rewardsToggle}{reserveToggle}</section>
        {account && <section className="panel settings-section account-section"><h2 className="panel-title">계정</h2><dl className="breakdown plain"><div><dt>이메일</dt><dd>{maskEmail(account.email)}</dd></div><div><dt>휴대폰</dt><dd>{maskPhone(account.phone)}</dd></div><div><dt>본인확인</dt><dd>{dateLabel(account.verifiedAt)} 완료</dd></div></dl><div className="account-links"><button className="list-row" data-testid="open-password" onClick={() => setPasswordSheet(true)}><span className="row-main"><strong>비밀번호 변경</strong></span><ChevronRight className="row-chevron" size={20} /></button><button className="list-row" data-testid="open-notifications" onClick={() => navigate('notifications')}><span className="row-main"><strong>알림 설정</strong></span><span className="row-value muted">{state.notifications.payments && state.notifications.funding ? '모두 받음' : '일부 끔'}</span><ChevronRight className="row-chevron" size={20} /></button></div><button className="btn neutral block" data-testid="sign-out" onClick={() => perform({ type: 'SIGN_OUT' })}>로그아웃</button><button className="text-danger-button" data-testid="open-closure" onClick={() => setClosingAccount(true)}>회원 탈퇴</button></section>}
        <section className="panel"><h2 className="panel-title">요금</h2><dl className="breakdown plain"><div><dt>월 이용료</dt><dd>{plan.monthlyFee ? money(plan.monthlyFee) : '무료'}</dd></div>{state.card.billingAt !== null && <div><dt>{state.card.nextPlan ? 'Basic이 되는 날' : '다음 결제일'}</dt><dd>{monthDay(state.card.billingAt)}</dd></div>}<div><dt>실물카드 발급비</dt><dd>{money(POLICY.physicalIssueFee)}</dd></div><div><dt>출금 수수료</dt><dd>네트워크 비용</dd></div></dl><p className="panel-caption">이용료와 카드 발급비는 결제 잔액에서 나갑니다. 입금과 리저브 이동은 수수료가 없습니다.</p></section>
        <section className="panel flush menu-list"><h2 className="panel-title">고객 지원</h2>
          <button className="list-row" data-testid="open-faq" onClick={() => navigate('faq')}><span className="row-main"><strong>자주 묻는 질문</strong></span><ChevronRight className="row-chevron" size={20} /></button>
          <button className="list-row" data-testid="open-terms" onClick={() => navigate('terms')}><span className="row-main"><strong>약관 및 정책</strong></span><ChevronRight className="row-chevron" size={20} /></button>
        </section>
        <details className="panel demo-tools" data-testid="demo-tools"><summary>체험 설정</summary><div className="details-body">
          <div className="demo-control"><div><strong>시간 진행</strong><p>하루가 지난 것처럼 보상을 쌓아 리워드에 더합니다.</p></div><button className="btn small neutral" data-testid="advance-day" onClick={() => perform({ type: 'ADVANCE_DAY' }, '하루 보상을 반영했습니다.')}>1일 진행</button></div>
          <div className="demo-control"><div><strong>연 보상률</strong><p>바꾼 뒤부터 새 보상률로 쌓입니다.</p></div><div className="rate-buttons">{[0.03, 0.05, 0.08].map((rate) => <button key={rate} className={`btn small${state.reserveRate === rate ? ' chosen' : ' neutral'}`} aria-pressed={state.reserveRate === rate} data-testid={`rate-${rate * 100}`} onClick={() => perform({ type: 'CHANGE_RATE', rate }, `연 보상률을 ${percent(rate)}로 변경했습니다.`)}>{percent(rate)}</button>)}</div></div>
          <div className="demo-control"><div><strong>데이터 초기화</strong><p>잔액과 내역을 처음 상태로 되돌립니다.</p></div><button className="btn small danger" data-testid="reset-demo" onClick={() => setDialog({ type: 'reset' })}>초기화</button></div>
          <p className="small-note">체험 데이터는 이 브라우저에 저장됩니다.</p>
        </div></details>
      </div>}
      {page === 'limits' && <LimitsPage state={state} onSave={(limits) => perform({ type: 'SET_LIMITS', ...limits }, '결제 한도를 바꿨습니다.') !== null} />}
      {page === 'channels' && <ChannelsPage state={state} onChange={(channel, enabled) => perform({ type: 'SET_CHANNEL', channel, enabled }, `${channel === 'online' ? '온라인' : '해외'} 결제를 ${enabled ? '열었습니다' : '막았습니다'}.`)} />}
      {page === 'notifications' && <NotificationsPage state={state} onChange={(key, enabled) => perform({ type: 'SET_NOTIFICATION', key, enabled }, key === 'marketing' ? `혜택·이벤트 소식 수신에 ${enabled ? '동의했습니다' : '동의를 철회했습니다'}.` : undefined)} />}
      {page === 'faq' && <FaqPage />}
      {page === 'terms' && <TermsPage />}
    </main>
    {passwordSheet && account && <PasswordSheet email={account.email} onClose={() => setPasswordSheet(false)} onSubmit={(currentHash, nextHash) => perform({ type: 'CHANGE_PASSWORD', currentHash, nextHash }, '비밀번호를 바꿨습니다.') !== null} />}
    {detailItem && <TransactionSheet item={detailItem} payment={detailItem.kind === 'payment' && detailItem.paymentId ? state.payments.find((item) => item.id === detailItem.paymentId) : undefined} card={state.card} status={statusOf(detailItem)?.[0] ?? null} onRefund={openRefund} onFunding={openFundingOperation} onClose={() => setDetailItem(null)} />}
    {closingAccount && <AccountClosureSheet state={state} onClose={() => setClosingAccount(false)} onDelete={(passwordHash) => perform({ type: 'DELETE_ACCOUNT', passwordHash }, '탈퇴했습니다. 이용해 주셔서 고맙습니다.') !== null} />}
    {funding && <FundingDialog key={`${funding.mode}-${funding.symbol ?? 'default'}-${funding.operationId ?? 'new'}`} {...funding} account={account} state={state} onClose={closeFunding} dispatch={dispatch} notify={notify} />}
    {internalTransfer && <InternalTransferDialog {...internalTransfer} state={state} onClose={closeInternalTransfer} dispatch={dispatch} notify={notify} />}
    {dialog && <ActionDialog dialog={dialog} state={state} onClose={closeDialog} dispatch={dispatch} notify={notify} onPaid={confirmPayment} onReset={resetDemo} />}
    {receipts[0] && !dialog && !funding && !internalTransfer && <PaymentReceipt key={receipts[0].payment.id} receipt={receipts[0]} onClose={closeReceipt} />}
    {toast && !dialog && !funding && !internalTransfer && !receipts[0] && <div className={`toast ${toast.type}`} role={toast.type === 'error' ? 'alert' : 'status'}><span className="toast-icon">{toast.type === 'success' ? <CheckCircle2 /> : <Info />}</span><span className="toast-copy">{toast.message}</span><button className="toast-close" aria-label="알림 닫기" onClick={() => setToast(null)}><X size={18} /></button></div>}
  </div>;
}

function ActionDialog({ dialog, state, onClose, dispatch, notify, onPaid, onReset }: {
  dialog: Dialog; state: AppState; onClose: () => void; dispatch: (action: Action) => AppState;
  notify: (message: string, type?: Toast['type']) => void; onPaid: (id: string) => void; onReset: () => void;
}) {
  const defaultAmount = dialog.type === 'refund' ? String(dialog.payment.amount - dialog.payment.refunded)
    : '5800';
  const [amount, setAmount] = useState(defaultAmount);
  const [merchant, setMerchant] = useState('한강커피');
  const [channel, setChannel] = useState<PaymentChannel>('store');
  const [error, setError] = useState('');
  const modalRef = useRef<HTMLDivElement>(null);
  const number = Number(amount);
  const validNumber = Number.isFinite(number) && number > 0;
  const source = sourcesFor(state, validNumber ? number : 0);
  const formId = 'aqua-action-form';
  const titles: Record<Dialog['type'], string> = { payment: '결제 체험', refund: '환불', guide: '체험 안내', reset: '데이터 초기화' };

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const target = modalRef.current;
    const timer = setTimeout(() => { const input = target?.querySelector<HTMLInputElement>('input:not([type="checkbox"]), select, textarea'); (input ?? target?.querySelector<HTMLButtonElement>('button'))?.focus(); }, 0);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const focusable = Array.from(target?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]') ?? []);
        const first = focusable[0]; const last = focusable[focusable.length - 1];
        if (!first) return;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener('keydown', keydown);
    return () => { clearTimeout(timer); document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [onClose]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    if (!validNumber) { setError('0보다 큰 금액 또는 수량을 입력해 주세요.'); return; }
    try {
      let action: Action;
      let message: string;
      switch (dialog.type) {
        case 'payment': action = { type: 'PAY', merchant, amount: number, channel }; message = '결제 승인 중입니다.'; break;
        case 'refund': action = { type: 'REFUND', id: dialog.payment.id, amount: number }; message = `${money(number)} 환불했습니다.`; break;
        default: return;
      }
      const next = dispatch(action);
      if (dialog.type === 'payment') { const payment = next.payments.find((item) => item.status === 'pending' && !state.payments.some((old) => old.id === item.id)); if (payment) onPaid(payment.id); }
      notify(message);
      onClose();
    } catch (issue) { setError(issue instanceof Error ? issue.message : '입력 내용을 확인해 주세요.'); }
  }

  const buttonLabels: Record<Dialog['type'], string> = { payment: `${money(validNumber ? number : 0)} 결제`, refund: '환불', guide: '확인', reset: '초기화' };
  const infoDialog = dialog.type === 'guide';

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="modal" ref={modalRef} role="dialog" aria-modal="true" aria-labelledby="dialog-title" data-testid={`dialog-${dialog.type}`}>
    <div className="modal-head"><h2 id="dialog-title">{titles[dialog.type]}</h2><button className="icon-button" onClick={onClose} aria-label="창 닫기"><X size={22} /></button></div>
    <div className="modal-body">
      {dialog.type === 'guide' ? <div className="guide-content"><p>체험용 잔액으로 카드와 자산을 써 볼 수 있습니다.</p><ol className="guide-steps"><li><strong>충전</strong><p>보내는 곳과 코인을 고르고, 입금 확인부터 원화 스테이블 전환까지 해 봅니다.</p></li><li><strong>카드 신청</strong><p>가입 때 확인한 정보로 신청하면 카드가 바로 발급됩니다.</p></li><li><strong>결제</strong><p>결제하면 리워드가 먼저 빠지고 페이백이 쌓이는 것을 확인합니다.</p></li></ol><p className="small-note">실제 자금 이동, 본인확인 자료 수집, 카드 발급은 없습니다. 데이터는 이 브라우저에 저장되며 전체 탭의 체험 설정에서 지울 수 있습니다.</p></div>
      : dialog.type === 'reset' ? <div><p className="reset-copy">잔액, 카드 신청, 이용 내역을 처음 상태로 되돌립니다.</p><p className="small-note">이 브라우저의 체험 데이터가 지워집니다.</p></div>
      : <form id={formId} onSubmit={submit}>
        {dialog.type === 'payment' && <><div className="payment-card-tag"><span className={`mini-card${state.card.plan === 'plus' ? ' plus' : ''}`} aria-hidden="true" /><span>{PLANS[state.card.plan].name}</span><span>끝번호 {state.card.last4}</span></div><div className="form-field"><label htmlFor="merchant">결제처</label><input id="merchant" value={merchant} onChange={(event) => setMerchant(event.target.value)} required maxLength={40} autoComplete="off" /></div></>}
        {dialog.type === 'refund' && <div className="dialog-route"><strong>{dialog.payment.merchant}</strong><span>환불 가능 {money(dialog.payment.amount - dialog.payment.refunded)}</span></div>}
        <div className="form-field"><label htmlFor="action-amount">{dialog.type === 'refund' ? '환불 금액' : '결제 금액'}</label><div className="input-affix"><input id="action-amount" data-testid="action-amount" type="number" inputMode="numeric" min={1} step={1} value={amount} onChange={(event) => { setAmount(event.target.value); setError(''); }} required /><span>원</span></div></div>
        {dialog.type === 'payment' && <div className="preset-amounts" aria-label="예시 결제">{PAYMENT_PRESETS.map(([name, value, kind]) => <button type="button" key={name} onClick={() => { setMerchant(name); setAmount(String(value)); setChannel(kind); setError(''); }}><span>{name}</span><b>{won(value)}원</b></button>)}</div>}
        {dialog.type === 'payment' && <fieldset className="channel-choice"><legend>결제 방식</legend><div className="segmented">{CHANNELS.map(([key, label]) => <button type="button" key={key} className={channel === key ? 'selected' : ''} aria-pressed={channel === key} data-testid={`pay-channel-${key}`} onClick={() => { setChannel(key); setError(''); }}>{label}</button>)}</div>{channel !== 'store' && !state.controls[channel] && <p className="channel-blocked">{channel === 'online' ? '온라인' : '해외'} 결제를 막아 두었습니다. 전체 › 온라인·해외 결제에서 열 수 있습니다.</p>}</fieldset>}
        {dialog.type === 'payment' && <div className="payment-sources"><h3>결제 구성</h3>{source.rewards > 0 && <div className="source-row"><span>리워드</span><strong>{money(source.rewards)}</strong></div>}{source.spend > 0 && <div className="source-row"><span>결제 잔액</span><strong>{money(source.spend)}</strong></div>}{source.reserve > 0 && <div className="source-row"><span>리저브</span><strong>{money(source.reserve)}</strong></div>}{source.shortfall > 0 && <div className="form-error">잔액이 {money(source.shortfall)} 부족합니다. 충전하거나 리저브 자동 사용을 켜 주세요.</div>}<div className="quote-total"><span>예상 페이백</span><strong>{money(source.cashback)}</strong></div><p className="small-note">리워드로 낸 금액은 빼고 계산하며, 결제가 확정되면 쌓입니다.</p></div>}
        {dialog.type === 'refund' && <details className="rule-details"><summary>환불 기준</summary><p>원금은 결제 잔액으로, 사용한 리워드는 리워드로 돌려드립니다. 페이백은 환불 비율만큼 줄이고, 모자라는 금액은 앞으로 쌓일 리워드에서 뺍니다.</p></details>}
        {error && <div className="form-error" role="alert">{error}</div>}
      </form>}
    </div>
    <div className="modal-footer">{!infoDialog && <button className="btn neutral" onClick={onClose}>취소</button>}<button className={`btn ${dialog.type === 'reset' ? 'danger' : 'primary'}`} type={infoDialog || dialog.type === 'reset' ? 'button' : 'submit'} form={infoDialog || dialog.type === 'reset' ? undefined : formId} data-testid="confirm-action" disabled={dialog.type === 'payment' && source.shortfall > 0} onClick={infoDialog ? onClose : dialog.type === 'reset' ? onReset : undefined}>{buttonLabels[dialog.type]}</button></div>
  </div></div>;
}
