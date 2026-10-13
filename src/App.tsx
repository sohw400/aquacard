import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowDownLeft, ArrowUpRight, CheckCircle2, ChevronRight, ChevronLeft,
  Clock3, CreditCard, Info, List, RefreshCw, LockKeyhole, CirclePercent, Menu,
  Wallet, Waves, X,
} from 'lucide-react';
import CardApplication from './components/CardApplication';
import CardVisual from './components/CardVisual';
import FundingDialog from './components/FundingDialog';
import RewardsSummary from './components/RewardsSummary';
import PaymentReceipt, { type PaymentReceiptData } from './components/PaymentReceipt';
import { applyAction, availableToSpend, createInitialState, loadState, portfolioValue, saveState } from './lib/engine';
import { money, percent, shortDate, won } from './lib/format';
import { ASSETS, PLANS, POLICY } from './lib/policy';
import { getCashbackSummary } from './lib/rewards';
import type { Action, AppState, AssetSymbol, CardStage, Payment, Transaction } from './lib/types';

type Page = 'home' | 'wallet' | 'benefits' | 'card' | 'reserve' | 'activity' | 'settings';
type Dialog =
  | { type: 'fund'; bucket: 'spend' | 'reserve' }
  | { type: 'withdraw'; bucket: 'spend' | 'reserve' }
  | { type: 'transfer'; direction: 'in' | 'out' }
  | { type: 'asset'; symbol: AssetSymbol; mode: 'deposit' | 'withdraw' }
  | { type: 'convert'; symbol: AssetSymbol }
  | { type: 'payment' }
  | { type: 'refund'; payment: Payment }
  | { type: 'guide' }
  | { type: 'reset' };
type Toast = { message: string; type: 'success' | 'error' | 'info' };

const SYMBOLS: AssetSymbol[] = ['USDC', 'USDT', 'BTC', 'ETH'];
const MAIN_PAGES: Page[] = ['home', 'wallet', 'benefits', 'settings'];
const COIN_GLYPHS: Record<AssetSymbol, string> = { USDC: '$', USDT: '₮', BTC: '₿', ETH: 'Ξ' };
const STAGE_NAMES: Record<CardStage, string> = {
  not_applied: '미발급', identity: '신청 중', plan: '신청 중', details: '신청 중',
  review: '신청 중', submitted: '심사 중', needs_info: '보완 필요', approved: '발급 승인',
  issued: '활성화 대기', active: '사용 가능', rejected: '신청 미승인',
};
const PAGES = {
  home: { title: '카드', icon: CreditCard },
  wallet: { title: '자산', icon: Wallet },
  benefits: { title: '혜택', icon: CirclePercent },
  card: { title: '카드 관리', icon: CreditCard },
  reserve: { title: '리저브', icon: Waves },
  activity: { title: '이용 내역', icon: List },
  settings: { title: '전체', icon: Menu },
};

function sourcesFor(state: AppState, amount: number) {
  const rewards = state.rewardsAuto ? Math.min(state.rewards, Math.max(0, amount)) : 0;
  const spend = Math.min(state.spend, Math.max(0, amount - rewards));
  const reserve = state.reserveAuto ? Math.min(state.reserve, Math.max(0, amount - rewards - spend)) : 0;
  const shortfall = Math.max(0, amount - rewards - spend - reserve);
  const plan = PLANS[state.card.plan];
  const cashback = Math.min(Math.floor(Math.max(0, amount - rewards) * plan.cashbackRate), Math.max(0, plan.cashbackCap - state.monthlyCashback));
  return { rewards, spend, reserve, shortfall, cashback };
}

function CoinIcon({ symbol }: { symbol: AssetSymbol }) {
  return <span className={`coin-icon coin-${symbol.toLowerCase()}`} style={{ backgroundColor: ASSETS[symbol].color }} aria-hidden="true">{COIN_GLYPHS[symbol]}</span>;
}

function Toggle({ checked, onChange, label, detail, testId }: { checked: boolean; onChange: (value: boolean) => void; label: string; detail: string; testId?: string }) {
  return <div className="toggle-row"><div><strong>{label}</strong><p>{detail}</p></div><button type="button" className={`switch${checked ? ' on' : ''}`} role="switch" aria-checked={checked} aria-label={label} data-testid={testId} onClick={() => onChange(!checked)}><span /></button></div>;
}

function ActivityList({ items, onRefund, payments, detailed = false }: { items: Transaction[]; onRefund: (payment: Payment) => void; payments: Payment[]; detailed?: boolean }) {
  if (!items.length) return <div className="empty-state"><p>이용 내역이 없습니다.</p></div>;
  return <div className={`activity-list${detailed ? ' detailed' : ''}`}>{items.map((item) => {
    const payment = item.kind === 'payment' ? payments.find((p) => p.id === item.paymentId) : undefined;
    const refundable = payment && ['completed', 'partially_refunded'].includes(payment.status);
    const positive = ['deposit', 'refund', 'reward', 'payback'].includes(item.kind) && item.amount > 0;
    const Icon = item.kind === 'payment' ? CreditCard : item.amount < 0 ? ArrowUpRight : ArrowDownLeft;
    return <div className="activity-row" key={item.id}>
      <span className="activity-icon"><Icon size={18} /></span>
      <div className="activity-copy"><strong>{item.title}</strong><span>{shortDate(item.timestamp)}{item.status === 'pending' ? ' · 승인 중' : item.status === 'refunded' ? ' · 전액 환불' : item.status === 'partially_refunded' ? ' · 부분 환불' : ''}</span>{detailed && <details className="transaction-details"><summary>상세</summary><p>{item.note}</p></details>}</div>
      <div className={`activity-amount${positive ? ' positive' : ''}`}><strong>{item.amount === 0 ? money(0) : `${item.amount < 0 ? '−' : positive ? '+' : ''}${money(Math.abs(item.amount))}`}</strong>{refundable && <button className="text-button" onClick={() => onRefund(payment)} aria-label={`${payment.merchant} 환불`}>환불</button>}</div>
    </div>;
  })}</div>;
}

function RewardHistory({ state }: { state: AppState }) {
  const credits = state.transactions.filter((item) => (item.kind === 'payback' || item.kind === 'reward') && item.amount > 0).map((item) => {
    const payment = item.paymentId ? state.payments.find((value) => value.id === item.paymentId) : undefined;
    return {
      id: item.id,
      title: item.kind === 'reward' ? '리저브 보상' : item.title,
      detail: payment?.refunded ? '확정금액 · 환불 조정 반영' : '확정금액',
      amount: payment ? payment.cashback - payment.cashbackReversed : item.amount,
      timestamp: item.timestamp,
      kind: 'credit',
    };
  });
  const uses = state.payments.filter((payment) => payment.fromRewards > 0).map((payment) => ({
    id: `${payment.id}-rewards`,
    title: `${payment.merchant} 리워드 사용`,
    detail: payment.refunded ? '환불 복원 반영' : payment.status === 'pending' ? '승인 중' : '결제 완료',
    amount: -(payment.fromRewards - payment.rewardsRestored),
    timestamp: payment.timestamp,
    kind: 'use',
  }));
  const items = [...credits, ...uses].sort((a, b) => b.timestamp - a.timestamp).slice(0, 8);
  return <section className="reward-history"><h3>최근 혜택 내역</h3>{items.length ? items.map((item) => <div className="reward-history-row" key={item.id}><div><strong>{item.title}</strong><span>{shortDate(item.timestamp)} · {item.detail}</span></div><strong className={`reward-history-amount${item.kind === 'use' ? ' negative' : ' positive'}`}>{item.amount === 0 ? money(0) : `${item.amount < 0 ? '−' : '+'}${money(Math.abs(item.amount))}`}</strong></div>) : <p className="small-note">혜택 내역이 없습니다.</p>}</section>;
}

export default function App() {
  const [state, setState] = useState<AppState>(() => loadState());
  const stateRef = useRef(state);
  const [page, setPage] = useState<Page>('home');
  const [trail, setTrail] = useState<Page[]>([]);
  const [activityFilter, setActivityFilter] = useState<'all' | 'payment' | 'cash'>('all');
  const [selectedAsset, setSelectedAsset] = useState<AssetSymbol | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [funding, setFunding] = useState<{ mode: 'deposit' | 'withdraw'; symbol?: AssetSymbol } | null>(null);
  const closeFunding = useCallback(() => setFunding(null), []);
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
    setTrail(MAIN_PAGES.includes(next) ? [] : [...trail, page]);
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
    setSelectedAsset(null);
    closeDialog();
    notify('체험 데이터를 초기화했습니다.');
  }

  const plan = PLANS[state.card.plan];
  const accruedDisplay = state.accrued.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dailyReward = Math.min(state.reserve, POLICY.reserveEligibleCap) * state.reserveRate / 365;
  const cardStatus = state.card.locked && state.card.stage === 'active' ? '일시 잠금' : STAGE_NAMES[state.card.stage];
  const cardAction = state.card.stage === 'not_applied' ? '카드 신청' : state.card.stage === 'active' ? state.card.locked ? '잠금 해제' : '결제 체험' : state.card.stage === 'needs_info' ? '정보 확인' : ['submitted', 'approved', 'issued'].includes(state.card.stage) ? '발급 상태' : state.card.stage === 'rejected' ? '다시 신청' : '신청 이어하기';
  const activeTab = MAIN_PAGES.includes(page) ? page : trail.find((item) => MAIN_PAGES.includes(item)) ?? 'home';
  const cashback = getCashbackSummary(state);
  const filteredTransactions = state.transactions.filter((item) => activityFilter === 'all' || (activityFilter === 'payment' ? item.kind === 'payment' || item.kind === 'refund' : ['deposit', 'convert', 'transfer'].includes(item.kind)));
  const claimRewards = () => perform({ type: 'REDEEM_ACCRUAL' }, '리워드를 받았습니다.');
  const reserveToggle = <Toggle checked={state.reserveAuto} onChange={(enabled) => perform({ type: 'SET_RESERVE_AUTO', enabled }, `리저브 자동 사용 ${enabled ? '켜짐' : '꺼짐'}`)} label="리저브 자동 사용" detail="결제 잔액이 부족할 때만 원금을 사용합니다. 사용한 금액은 적립이 중단됩니다." testId="reserve-auto" />;
  const rewardsToggle = <Toggle checked={state.rewardsAuto} onChange={(enabled) => perform({ type: 'SET_REWARDS_AUTO', enabled }, `리워드 우선 사용 ${enabled ? '켜짐' : '꺼짐'}`)} label="리워드 우선 사용" detail="카드 결제에 리워드를 먼저 사용합니다." testId="rewards-auto" />;

  return <div className={`app-shell page-${page}`}>
    <header className="app-header">
      <button className="brand" onClick={() => navigate('home')} aria-label="Aqua Card 첫 화면">Aqua Card</button>
      <nav className="primary-nav bottom-nav" aria-label="주 메뉴">{MAIN_PAGES.map((key) => {
        const Icon = PAGES[key].icon;
        return <button key={key} className={`nav-item${activeTab === key ? ' active' : ''}`} aria-current={activeTab === key ? 'page' : undefined} data-testid={`nav-${key}`} onClick={() => navigate(key)}><Icon size={21} /><span>{PAGES[key].title}</span></button>;
      })}</nav>
    </header>
    <main className="main-content">
      <header className="topbar"><div className="page-heading">{!MAIN_PAGES.includes(page) && <button className="icon-button" aria-label="이전 화면" data-testid="go-back" onClick={goBack}><ChevronLeft size={24} /></button>}<h1>{page === 'home' ? '내 카드' : PAGES[page].title}</h1></div><div className="topbar-actions"><button className="utility-button" aria-label="이용 내역" data-testid="nav-activity" onClick={() => navigate('activity')}><Clock3 size={21} /></button><button className="utility-button" aria-label="체험 안내" onClick={() => setDialog({ type: 'guide' })}><Info size={20} /></button></div></header>
      <p className="demo-notice">체험 화면입니다. 실제 자금 이동과 카드 발급은 없습니다.</p>

      {page === 'home' && <div className="card-home">
        <section className="card-center" aria-label="내 Aqua 카드">
          <div className="card-center-heading"><span>{plan.name}</span><span className="card-state">{cardStatus}</span></div>
          <div className="hero-card-stage"><CardVisual card={state.card} variant="hero" /></div>
          <button className="card-manage-link" data-testid="card-cta" onClick={() => navigate('card')}>카드 관리<ChevronRight size={16} /></button>
        </section>
        <section className="home-account" aria-label="카드 잔액과 결제">
          <details className="balance-disclosure"><summary className="spendable-summary" aria-label="카드 사용 가능 금액과 잔액 구성"><span>결제 가능 금액<ChevronRight size={14} /></span><strong data-testid="available-balance">{money(availableToSpend(state))}</strong></summary><dl className="account-breakdown"><div><dt>결제 잔액</dt><dd>{money(state.spend)}</dd></div><div><dt>리워드 <span>{state.rewardsAuto ? '사용 중' : '사용 꺼짐'}</span></dt><dd>{money(state.rewardsAuto ? state.rewards : 0)}</dd></div><div><dt>리저브 <span>{state.reserveAuto ? '자동 사용' : '사용 꺼짐'}</span></dt><dd>{money(state.reserveAuto ? state.reserve : 0)}</dd></div></dl></details>
          <div className="card-main-actions"><button className="btn secondary" data-testid="open-deposit" onClick={() => setFunding({ mode: 'deposit' })}>충전</button><button className="btn primary" data-testid="open-payment" onClick={startPayment}>{cardAction}</button></div>
          {state.card.locked && <p className="card-lock-notice"><LockKeyhole size={14} />카드 관리에서 잠금을 해제해 주세요.</p>}
          <div className="home-benefit-links"><button className="account-link" data-testid="open-rewards" onClick={() => navigate('benefits')}><span>이번 달 페이백{cashback.pending > 0 && <small>{money(cashback.pending)} 확정 대기</small>}</span><strong data-testid="home-cashback-confirmed">{money(cashback.confirmed)}</strong><ChevronRight size={16} /></button><button className="account-link" onClick={() => navigate('benefits')}><span>사용 가능 리워드</span><strong data-testid="available-rewards">{money(state.rewards)}</strong><ChevronRight size={16} /></button></div>
        </section>
        <section className="home-transactions"><div className="section-head"><h2>최근 카드 이용</h2><button className="text-button" onClick={() => navigate('activity')}>전체 내역<ChevronRight size={16} /></button></div><ActivityList items={state.transactions.filter((item) => item.kind === 'payment' || item.kind === 'refund').slice(0, 4)} payments={state.payments} onRefund={(payment) => setDialog({ type: 'refund', payment })} /></section>
      </div>}

      {page === 'wallet' && <div className="page-stack wallet-page">
        <section className="account-section wallet-cash"><h2>결제 잔액</h2><strong className="display-value">{money(state.spend)}</strong><p className="section-description">카드 결제와 코인 출금에 사용할 수 있습니다.</p><div className="actions"><button className="btn primary" data-testid="wallet-deposit" onClick={() => setFunding({ mode: 'deposit' })}>충전</button><button className="btn secondary" data-testid="wallet-withdraw" onClick={() => setFunding({ mode: 'withdraw' })}>출금</button></div></section>
        <section className="account-section wallet-reserve"><button className="account-link reserve-link" data-testid="open-reserve" onClick={() => navigate('reserve')}><span>리저브<small>연 {percent(state.reserveRate)} 보상률, 변동 가능</small></span><strong>{money(state.reserve)}</strong><ChevronRight size={17} /></button><p className="section-description">결제 잔액에서 옮겨 보관하는 금액입니다.</p></section>
        <section className="account-section wallet-coins"><div className="section-head"><h2>보유 코인</h2><span className="muted">모의 시세</span></div><div className="wallet-asset-list">{SYMBOLS.map((symbol) => <div className={`asset-card${selectedAsset === symbol ? ' selected' : ''}`} key={symbol}><button className="wallet-asset-button" data-testid={`asset-select-${symbol}`} aria-expanded={selectedAsset === symbol} aria-controls={`asset-detail-${symbol}`} onClick={() => setSelectedAsset((current) => current === symbol ? null : symbol)}><CoinIcon symbol={symbol} /><span className="asset-name"><strong>{symbol}</strong><span>{state.holdings[symbol].toLocaleString('en-US', { maximumFractionDigits: 8 })} {symbol}</span></span><strong className="asset-value">{money(state.holdings[symbol] * ASSETS[symbol].price)}</strong><ChevronRight size={16} /></button>{selectedAsset === symbol && <div className="asset-expanded" id={`asset-detail-${symbol}`}><div className="asset-quote"><span>1 {symbol} = {money(ASSETS[symbol].price)}</span><span>{ASSETS[symbol].network}</span></div><div className="asset-actions" data-testid={`asset-actions-${symbol}`}><button className="btn primary" onClick={() => setDialog({ type: 'convert', symbol })} aria-label={`${symbol} 전환`}>원화로 전환</button><button className="btn secondary" onClick={() => setDialog({ type: 'asset', symbol, mode: 'withdraw' })} aria-label={`${symbol} 출금`}>코인 출금</button></div></div>}</div>)}</div><p className="section-description">기존에 보유한 코인입니다. 새로 입금하는 코인은 견적 확인 후 원화 결제 잔액으로 전환됩니다.</p></section>
        <details className="rule-details"><summary>자산 계산 및 입출금 안내</summary><p>총 보유 자산 {money(portfolioValue(state))}은 결제 잔액, 리저브 원금, 코인 평가액의 합계입니다. 결제 전용 리워드는 포함하지 않습니다.</p><p>원화 스테이블은 발행사 제휴 후 지원 예정입니다. 현재 잔액과 입출금은 모두 모의 처리됩니다.</p></details>
      </div>}

      {page === 'benefits' && <div className="page-stack benefits-page" data-testid="page-benefits">
        <section className="account-section rewards-account"><h2>사용 가능 리워드</h2><strong className="display-value" data-testid="reward-balance">{money(state.rewards)}</strong><p className="section-description">카드 결제 전용입니다. 출금할 수 없습니다.</p>{rewardsToggle}</section>
        <section className="account-section"><RewardsSummary state={state} /><details className="rule-details"><summary>페이백 적립 기준</summary><p>리워드 사용분을 제외한 결제 금액에 {percent(plan.cashbackRate)}를 적립합니다. 월 최대 {money(plan.cashbackCap)}까지 받을 수 있습니다.</p><p>확정 페이백은 이번 달 결제에서 확정된 금액에 환불 조정을 반영한 금액입니다. 현재 사용 가능한 리워드 잔액과는 다릅니다.</p><p>지난달 결제가 이번 달에 확정되어도 지난달 페이백으로 집계합니다. 이전 페이백 조정이 있으면 새 적립액에서 먼저 반영합니다.</p></details></section>
        <section className="account-section reserve-pending"><div className="section-head"><h2>리저브에서 받을 보상</h2><button className="text-button" onClick={() => navigate('reserve')}>리저브 보기<ChevronRight size={16} /></button></div><strong className="pending-value" data-testid="reserve-pending-rewards">{money(Math.floor(state.accrued))}</strong><p className="section-description">아직 받지 않은 보상입니다. 받은 뒤 카드 결제에 사용할 수 있습니다.</p><button className="btn secondary" data-testid="claim-rewards" disabled={state.accrued < 1 - 1e-9} onClick={claimRewards}>리워드 받기</button></section>
        {state.rewardDebt > 0 && <p className="adjustment-note">이전 페이백 조정 {money(state.rewardDebt)}은 앞으로 받을 리워드에서 반영됩니다.</p>}
        <RewardHistory state={state} />
      </div>}

      {page === 'card' && <div className="card-page"><CardApplication card={state.card} onChange={(card) => { perform({ type: 'SET_CARD', card }); }} onNotify={(message) => notify(message)} /></div>}

      {page === 'reserve' && <div className="page-stack reserve-page">
        <section className="account-section reserve-main"><h2>리저브 잔액</h2><strong className="display-value" data-testid="reserve-principal">{money(state.reserve)}</strong><div className="actions"><button className="btn primary" onClick={() => setDialog({ type: 'transfer', direction: 'in' })}>넣기</button><button className="btn secondary" onClick={() => setDialog({ type: 'transfer', direction: 'out' })}>빼기</button></div><p className="section-description">결제 잔액과 이동할 때 추가 전환이나 수수료가 없습니다.</p></section>
        <section className="account-section reserve-reward"><div className="section-head"><h2>적립 중인 보상</h2><span className="rate-label">연 {percent(state.reserveRate)}<span>변동</span></span></div><strong className="live-value" data-testid="reserve-accrual">{accruedDisplay}원</strong><dl className="account-breakdown"><div><dt>현재 잔액의 예상 일 보상</dt><dd>약 {money(dailyReward)}</dd></div></dl><button className="btn secondary" data-testid="claim-rewards" disabled={state.accrued < 1 - 1e-9} onClick={claimRewards}>리워드 받기</button><p className="section-description">1원부터 받을 수 있습니다. 받은 리워드는 카드 결제에 사용합니다.</p></section>
        <section className="account-section">{reserveToggle}</section>
        <details className="rule-details"><summary>보상 및 이용 조건</summary><div className="details-body"><ul><li>연 보상률은 변동할 수 있으며 단리로 계산합니다.</li><li>최대 {money(POLICY.reserveEligibleCap)}까지 보상을 계산합니다.</li><li>넣기와 빼기는 최소 1,000원부터 가능합니다.</li><li>원금을 사용하면 이후에는 남은 잔액을 기준으로 적립합니다.</li><li>받은 리워드는 출금하거나 코인으로 전환할 수 없습니다.</li><li>원금 보장 예금이 아닙니다. 실제 운용 및 상환 조건은 제휴 후 확정됩니다.</li></ul><div className="rate-history"><h3>보상률 변경 기록</h3>{state.rateHistory.slice().reverse().slice(0, 5).map((item, index) => <div key={`${item.timestamp}-${index}`}><span>{shortDate(item.timestamp)}</span><strong>연 {percent(item.rate)}</strong></div>)}</div><p>외부로 출금하려면 결제 잔액으로 빼낸 뒤 자산 화면에서 출금해 주세요.</p></div></details>
      </div>}

      {page === 'activity' && <div className="page-stack activity-page"><div className="list-tabs" role="group" aria-label="내역 종류">{([['all', '전체'], ['payment', '카드'], ['cash', '입출금']] as const).map(([key, label]) => <button key={key} className={activityFilter === key ? 'selected' : ''} aria-pressed={activityFilter === key} onClick={() => setActivityFilter(key)}>{label}</button>)}</div><ActivityList detailed items={filteredTransactions} payments={state.payments} onRefund={(payment) => setDialog({ type: 'refund', payment })} /><details className="rule-details"><summary>카드 이용 현황</summary><dl className="account-breakdown"><div><dt>이번 달 승인액</dt><dd>{money(state.monthlySpent)}</dd></div><div><dt>오늘 승인액</dt><dd>{money(state.dailySpent)}</dd></div><div><dt>이번 달 페이백 한도 사용</dt><dd>{money(state.monthlyCashback)} / {money(plan.cashbackCap)}</dd></div></dl></details></div>}

      {page === 'settings' && <div className="page-stack settings-page"><section className="account-section"><div className="section-head"><h2>카드 및 이용 내역</h2></div><button className="menu-row" onClick={() => navigate('card')}><span>카드 관리</span><span>{plan.name}<ChevronRight size={17} /></span></button><button className="menu-row" onClick={() => navigate('activity')}><span>이용 내역</span><ChevronRight size={17} /></button></section><section className="account-section settings-section"><h2>결제 설정</h2>{rewardsToggle}{reserveToggle}<details className="rule-details"><summary>결제 한도</summary><dl className="account-breakdown"><div><dt>1회</dt><dd>{money(POLICY.perPaymentLimit)}</dd></div><div><dt>1일</dt><dd>{money(POLICY.dailyPaymentLimit)}</dd></div><div><dt>1개월</dt><dd>{money(POLICY.monthlyPaymentLimit)}</dd></div></dl></details></section><section className="account-section"><h2>카드 요금</h2><dl className="account-breakdown"><div><dt>월 이용료</dt><dd>{plan.monthlyFee ? money(plan.monthlyFee) : '무료'}</dd></div><div><dt>페이백</dt><dd>{percent(plan.cashbackRate)}</dd></div></dl><p className="section-description">체험 중에는 이용료를 청구하지 않습니다.</p></section><details className="demo-tools" data-testid="demo-tools"><summary>체험 설정</summary><div className="details-body"><div className="demo-control"><div><strong>시간 진행</strong><p>현재 잔액으로 하루 보상을 계산합니다.</p></div><button className="btn secondary" data-testid="advance-day" onClick={() => perform({ type: 'ADVANCE_DAY' }, '하루 보상을 반영했습니다.')}><Clock3 size={16} />1일 진행</button></div><div className="demo-control"><div><strong>연 보상률</strong><p>변경한 이후의 적립에 적용합니다.</p></div><div className="rate-buttons">{[0.03, 0.05, 0.08].map((rate) => <button key={rate} className={`btn${state.reserveRate === rate ? ' primary' : ' secondary'}`} aria-pressed={state.reserveRate === rate} data-testid={`rate-${rate * 100}`} onClick={() => perform({ type: 'CHANGE_RATE', rate }, `연 보상률을 ${percent(rate)}로 변경했습니다.`)}>{percent(rate)}</button>)}</div></div><div className="demo-control"><div><strong>데이터 초기화</strong><p>잔액과 이용 내역을 처음으로 되돌립니다.</p></div><button className="btn danger" data-testid="reset-demo" onClick={() => setDialog({ type: 'reset' })}>초기화</button></div><p className="section-description">체험 데이터는 현재 브라우저에 저장됩니다.</p></div></details></div>}
    </main>
    {funding && <FundingDialog key={`${funding.mode}-${funding.symbol ?? 'USDC'}`} {...funding} state={state} onClose={closeFunding} dispatch={dispatch} notify={notify} />}
    {dialog && <ActionDialog dialog={dialog} state={state} onClose={closeDialog} dispatch={dispatch} notify={notify} onPaid={confirmPayment} onReset={resetDemo} />}
    {receipts[0] && !dialog && !funding && <PaymentReceipt key={receipts[0].payment.id} receipt={receipts[0]} onClose={closeReceipt} />}
    {toast && !dialog && !funding && !receipts[0] && <div className={`toast ${toast.type}`} role={toast.type === 'error' ? 'alert' : 'status'}><span className="toast-icon">{toast.type === 'success' ? <CheckCircle2 size={20} /> : <Info size={20} />}</span><span className="toast-copy">{toast.message}</span><button className="toast-close" aria-label="알림 닫기" onClick={() => setToast(null)}><X size={17} /></button></div>}
  </div>;
}

function ActionDialog({ dialog, state, onClose, dispatch, notify, onPaid, onReset }: {
  dialog: Dialog; state: AppState; onClose: () => void; dispatch: (action: Action) => AppState;
  notify: (message: string, type?: Toast['type']) => void; onPaid: (id: string) => void; onReset: () => void;
}) {
  const defaultAmount = dialog.type === 'refund' ? String(dialog.payment.amount - dialog.payment.refunded)
    : dialog.type === 'payment' ? '5800'
    : dialog.type === 'convert' || dialog.type === 'asset' ? dialog.symbol === 'BTC' ? '0.0001' : dialog.symbol === 'ETH' ? '0.01' : '10'
    : dialog.type === 'transfer' ? '50000' : dialog.type === 'withdraw' ? '10000' : '100000';
  const [amount, setAmount] = useState(defaultAmount);
  const [merchant, setMerchant] = useState('한강커피');
  const [error, setError] = useState('');
  const [quoteAt, setQuoteAt] = useState(Date.now());
  const [clock, setClock] = useState(Date.now());
  const modalRef = useRef<HTMLDivElement>(null);
  const symbol = dialog.type === 'convert' || dialog.type === 'asset' ? dialog.symbol : 'USDC';
  const number = Number(amount);
  const validNumber = Number.isFinite(number) && number > 0;
  const quoteSeconds = Math.max(0, POLICY.quoteTtlSeconds - Math.floor((clock - quoteAt) / 1_000));
  const source = sourcesFor(state, validNumber ? number : 0);
  const gross = validNumber ? number * ASSETS[symbol].price : 0;
  const net = Math.floor(gross * (1 - POLICY.conversionFee));
  const formId = 'aqua-action-form';
  const titles: Record<Dialog['type'], string> = { fund: '충전', withdraw: '출금', transfer: dialog.type === 'transfer' && dialog.direction === 'out' ? '리저브에서 빼기' : '리저브에 넣기', asset: `${symbol} ${dialog.type === 'asset' && dialog.mode === 'withdraw' ? '출금' : '입금'}`, convert: `${symbol} 전환`, payment: '결제 체험', refund: '환불', guide: '체험 안내', reset: '데이터 초기화' };

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
  useEffect(() => {
    if (dialog.type !== 'convert') return;
    const timer = setInterval(() => setClock(Date.now()), 250);
    return () => clearInterval(timer);
  }, [dialog.type]);

  function renewQuote() { const now = Date.now(); setQuoteAt(now); setClock(now); setError(''); }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    if (!validNumber) { setError('0보다 큰 금액 또는 수량을 입력해 주세요.'); return; }
    try {
      let action: Action;
      let message: string;
      switch (dialog.type) {
        case 'fund': action = { type: 'DEPOSIT', bucket: dialog.bucket, amount: number }; message = `${money(number)} 충전했습니다.`; break;
        case 'withdraw': action = { type: 'WITHDRAW_FUNDS', bucket: dialog.bucket, amount: number }; message = `${money(number)} 출금했습니다.`; break;
        case 'transfer': action = { type: 'TRANSFER_RESERVE', direction: dialog.direction, amount: number }; message = `${money(number)} 이동했습니다.`; break;
        case 'asset': action = { type: dialog.mode === 'deposit' ? 'DEPOSIT_ASSET' : 'WITHDRAW_ASSET', symbol, units: number }; message = `${number} ${symbol} ${dialog.mode === 'deposit' ? '입금' : '출금'}했습니다.`; break;
        case 'convert': action = { type: 'CONVERT', symbol, units: number, quotedAt: quoteAt }; message = `결제 잔액 ${money(net)}으로 전환했습니다.`; break;
        case 'payment': action = { type: 'PAY', merchant, amount: number }; message = '결제 승인 중입니다.'; break;
        case 'refund': action = { type: 'REFUND', id: dialog.payment.id, amount: number }; message = `${money(number)} 환불했습니다.`; break;
        default: return;
      }
      const next = dispatch(action);
      if (dialog.type === 'payment') { const payment = next.payments.find((item) => item.status === 'pending' && !state.payments.some((old) => old.id === item.id)); if (payment) onPaid(payment.id); }
      notify(message);
      onClose();
    } catch (issue) { setError(issue instanceof Error ? issue.message : '입력 내용을 확인해 주세요.'); }
  }

  const isAsset = dialog.type === 'asset' || dialog.type === 'convert';
  const buttonLabels: Record<Dialog['type'], string> = { fund: '충전', withdraw: '출금', transfer: dialog.type === 'transfer' && dialog.direction === 'out' ? '빼기' : '넣기', asset: dialog.type === 'asset' && dialog.mode === 'withdraw' ? '출금' : '입금', convert: '전환', payment: `${money(validNumber ? number : 0)} 결제`, refund: '환불', guide: '확인', reset: '초기화' };
  const bucketName = dialog.type === 'fund' || dialog.type === 'withdraw' ? dialog.bucket === 'spend' ? '결제 잔액' : '리저브' : '';
  const infoDialog = dialog.type === 'guide';

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="modal" ref={modalRef} role="dialog" aria-modal="true" aria-labelledby="dialog-title" data-testid={`dialog-${dialog.type}`}>
    <div className="modal-head"><h2 id="dialog-title">{titles[dialog.type]}</h2><button className="icon-button" onClick={onClose} aria-label="창 닫기"><X size={21} /></button></div>
    <div className="modal-body">
      {dialog.type === 'guide' ? <div className="guide-content"><p>모의 자산으로 카드와 지갑을 체험할 수 있습니다.</p><ol className="guide-steps"><li><strong>충전</strong><p>원화 잔액을 충전하거나 코인을 입금합니다.</p></li><li><strong>카드 신청</strong><p>샘플 본인확인 후 카드 발급과 활성화를 진행합니다.</p></li><li><strong>결제</strong><p>카드 결제를 체험하고 페이백을 확인합니다.</p></li></ol><p className="small-note">실제 자금 이동, 본인확인 자료 수집, 카드 발급은 없습니다. 데이터는 현재 브라우저에 저장되며 설정에서 초기화할 수 있습니다.</p></div>
      : dialog.type === 'reset' ? <div><p>잔액, 카드 신청, 이용 내역을 처음 상태로 되돌립니다.</p><p className="small-note">현재 브라우저의 체험 데이터가 삭제됩니다.</p></div>
      : <form id={formId} onSubmit={submit}>
        {(dialog.type === 'fund' || dialog.type === 'withdraw') && <div className="dialog-route"><strong>{bucketName}</strong><span>현재 {money(state[dialog.bucket])}</span></div>}
        {dialog.type === 'transfer' && <div className="dialog-route"><strong>{dialog.direction === 'in' ? '결제 잔액 → 리저브' : '리저브 → 결제 잔액'}</strong><span>이동 가능 {money(dialog.direction === 'in' ? state.spend : state.reserve)} · 수수료 없음</span></div>}
        {isAsset && <div className="dialog-route"><strong>{dialog.type === 'convert' ? `${symbol} → 원화 결제 잔액` : `${symbol} · ${ASSETS[symbol].network}`}</strong><span>보유 {state.holdings[symbol].toLocaleString('en-US', { maximumFractionDigits: 8 })} {symbol}</span></div>}
        {dialog.type === 'payment' && <><p className="payment-card-tag">{PLANS[state.card.plan].name} · 끝 번호 {state.card.last4}</p><div className="form-field"><label htmlFor="merchant">결제처</label><input id="merchant" value={merchant} onChange={(event) => setMerchant(event.target.value)} required maxLength={40} autoComplete="off" /></div></>}
        {dialog.type === 'refund' && <div className="dialog-route"><strong>{dialog.payment.merchant}</strong><span>환불 가능 {money(dialog.payment.amount - dialog.payment.refunded)}</span></div>}
        <div className="form-field"><label htmlFor="action-amount">{isAsset ? '수량' : dialog.type === 'refund' ? '환불 금액' : dialog.type === 'payment' ? '결제 금액' : '금액'}</label><div className="input-affix"><input id="action-amount" data-testid="action-amount" type="number" inputMode={isAsset ? 'decimal' : 'numeric'} min={isAsset ? '0.00000001' : dialog.type === 'payment' || dialog.type === 'refund' ? 1 : 1_000} step={isAsset ? 'any' : 1} value={amount} onChange={(event) => { setAmount(event.target.value); setError(''); if (dialog.type === 'convert') renewQuote(); }} required /><span>{isAsset ? symbol : '원'}</span></div>{!isAsset && dialog.type !== 'payment' && dialog.type !== 'refund' && <span className="field-help">최소 1,000원</span>}</div>
        {dialog.type === 'fund' && <div className="preset-amounts">{[10_000, 50_000, 100_000].map((value) => <button type="button" key={value} className="btn secondary" onClick={() => setAmount(String(value))}>{won(value)}원</button>)}</div>}
        {dialog.type === 'convert' && <div className="quote-preview"><div className="quote-head"><strong>전환 견적</strong><span className={quoteSeconds === 0 ? 'expired' : ''}>{quoteSeconds > 0 ? `${quoteSeconds}초 남음` : '만료'}</span><button type="button" className="text-button" onClick={renewQuote} aria-label="견적 갱신"><RefreshCw size={14} />갱신</button></div><div><span>평가액</span><strong>{money(gross)}</strong></div><div><span>수수료 {percent(POLICY.conversionFee)}</span><strong>−{money(Math.ceil(gross - net))}</strong></div><div className="quote-total"><span>받을 결제 잔액</span><strong>{money(net)}</strong></div></div>}
        {dialog.type === 'payment' && <div className="payment-sources"><h3>사용할 금액</h3>{source.rewards > 0 && <div className="source-row"><span>리워드</span><strong>{money(source.rewards)}</strong></div>}{source.spend > 0 && <div className="source-row"><span>결제 잔액</span><strong>{money(source.spend)}</strong></div>}{source.reserve > 0 && <div className="source-row"><span>리저브</span><strong>{money(source.reserve)}</strong></div>}{source.shortfall > 0 && <div className="form-error">잔액이 {money(source.shortfall)} 부족합니다. 충전하거나 리저브 자동 사용을 켜 주세요.</div>}<div className="quote-total"><span>예상 페이백</span><strong>{money(source.cashback)}</strong></div><p className="small-note">리워드 사용분 제외 · 결제 확정 후 적립</p></div>}
        {dialog.type === 'refund' && <details className="rule-details"><summary>환불 처리 기준</summary><p>원금은 결제 잔액으로, 사용한 리워드는 리워드로 반환합니다. 페이백은 환불 비율에 따라 조정하며 부족분은 향후 리워드에서 반영합니다.</p></details>}
        {['fund', 'withdraw', 'asset'].includes(dialog.type) && <p className="small-note">체험용 잔액에만 반영됩니다. 실제 자금은 이동하지 않습니다.</p>}
        {error && <div className="form-error" role="alert">{error}</div>}
      </form>}
    </div>
    <div className="modal-footer">{!infoDialog && <button className="btn secondary" onClick={onClose}>취소</button>}<button className={`btn${dialog.type === 'reset' ? ' danger' : ' primary'}`} type={infoDialog || dialog.type === 'reset' ? 'button' : 'submit'} form={infoDialog || dialog.type === 'reset' ? undefined : formId} data-testid="confirm-action" disabled={dialog.type === 'convert' && quoteSeconds === 0 || dialog.type === 'payment' && source.shortfall > 0} onClick={infoDialog ? onClose : dialog.type === 'reset' ? onReset : undefined}>{buttonLabels[dialog.type]}</button></div>
  </div></div>;
}
