import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowDownLeft, ArrowDownToLine, ArrowLeftRight, ArrowRight, ArrowUpRight,
  Bell, Check, CheckCircle2, ChevronRight, Clock3, CreditCard, Info,
  LayoutDashboard, LockKeyhole, Plus, RefreshCw, Settings, ShieldCheck,
  Sparkles, Wallet, Waves, X,
} from 'lucide-react';
import CardApplication from './components/CardApplication';
import { applyAction, availableToSpend, createInitialState, loadState, portfolioValue, saveState } from './lib/engine';
import { money, percent, shortDate, won } from './lib/format';
import { ASSETS, PLANS, POLICY } from './lib/policy';
import type { Action, AppState, AssetSymbol, CardStage, Payment, Transaction } from './lib/types';

type Page = 'home' | 'wallet' | 'card' | 'reserve' | 'activity' | 'settings';
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
const COIN_GLYPHS: Record<AssetSymbol, string> = { USDC: '$', USDT: '₮', BTC: '₿', ETH: 'Ξ' };
const STAGE_NAMES: Record<CardStage, string> = {
  not_applied: '발급 전', identity: '신청 중', plan: '신청 중', details: '신청 중',
  review: '신청 중', submitted: '심사 중', needs_info: '보완 필요', approved: '발급 승인',
  issued: '활성화 대기', active: '사용 가능', rejected: '신청 미승인',
};
const PAGES = {
  home: { title: '나의 Aqua', subtitle: '내 자산과 일상의 결제를 한눈에.', icon: LayoutDashboard },
  wallet: { title: '지갑', subtitle: '다양한 자산을 담고, 필요한 만큼 결제 잔액으로.', icon: Wallet },
  card: { title: '카드', subtitle: '신청부터 첫 결제까지, 나만의 Aqua Card.', icon: CreditCard },
  reserve: { title: 'Reserve', subtitle: '머무는 자산이 만드는, 매일의 리워드.', icon: Waves },
  activity: { title: '이용 내역', subtitle: '입금, 결제, 리워드까지 모든 흐름을 확인하세요.', icon: ArrowLeftRight },
  settings: { title: '설정', subtitle: '내 결제 방식과 체험 환경을 관리하세요.', icon: Settings },
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

function AquaMark({ small = false }: { small?: boolean }) {
  return <span className={`logo-mark${small ? ' small' : ''}`} aria-hidden="true"><Waves size={small ? 19 : 25} strokeWidth={2.3} /></span>;
}

function Toggle({ checked, onChange, label, detail, testId }: { checked: boolean; onChange: (value: boolean) => void; label: string; detail: string; testId?: string }) {
  return <div className="toggle-row"><div><strong>{label}</strong><p>{detail}</p></div><button type="button" className={`switch${checked ? ' on' : ''}`} role="switch" aria-checked={checked} aria-label={label} data-testid={testId} onClick={() => onChange(!checked)}><span /></button></div>;
}

function CardPreview({ state, compact = false }: { state: AppState; compact?: boolean }) {
  const issued = ['issued', 'active'].includes(state.card.stage);
  return <div className={`card-preview${compact ? ' compact' : ''}`} aria-label={issued ? `Aqua 카드 끝 번호 ${state.card.last4}` : 'Aqua 카드 디자인 미리보기'}>
    <div className="card-brand"><Waves size={23} /><span>aqua<span className="card-brand-dot">.</span></span><span className="card-plan">{state.card.plan === 'plus' ? 'PLUS' : 'BASIC'}</span></div>
    <span className="card-watermark" aria-hidden="true">a</span>
    <div className="card-chip" aria-hidden="true"><span /><span /><span /></div>
    <div className="card-number">••••&nbsp; ••••&nbsp; ••••&nbsp; {issued ? state.card.last4 : '••••'}</div>
    <div className="card-footer"><span>AQUA MEMBER</span><span>VIRTUAL</span></div>
  </div>;
}

function ActivityList({ items, onRefund, payments, detailed = false }: { items: Transaction[]; onRefund: (payment: Payment) => void; payments: Payment[]; detailed?: boolean }) {
  if (!items.length) return <div className="empty-state"><span className="empty-icon"><ArrowLeftRight size={26} /></span><strong>첫 번째 흐름을 기다리고 있어요</strong><p>지갑을 충전하거나 카드 결제를 체험하면<br />이곳에 이용 내역이 차곡차곡 쌓여요.</p></div>;
  return <div className={`activity-list${detailed ? ' detailed' : ''}`}>{items.map((item) => {
    const payment = item.kind === 'payment' ? payments.find((p) => p.id === item.paymentId) : undefined;
    const refundable = payment && ['completed', 'partially_refunded'].includes(payment.status);
    const positive = ['deposit', 'refund', 'reward', 'payback'].includes(item.kind) && item.amount > 0;
    const Icon = item.kind === 'payment' ? CreditCard : ['reward', 'payback'].includes(item.kind) ? Sparkles : item.amount < 0 ? ArrowUpRight : ArrowDownLeft;
    return <div className="activity-row" key={item.id}>
      <span className={`activity-icon${positive ? ' positive' : ''}`}><Icon size={18} /></span>
      <div className="activity-copy"><strong>{item.title}</strong><span>{shortDate(item.timestamp)}{item.status === 'pending' ? ' · 승인 처리 중' : item.status === 'refunded' ? ' · 전액 환불' : item.status === 'partially_refunded' ? ' · 부분 환불' : ''}</span>{detailed && <p>{item.note}</p>}</div>
      <div className={`activity-amount${positive ? ' positive' : ''}`}><strong>{item.amount === 0 ? '—' : `${item.amount < 0 ? '−' : positive ? '+' : ''}${money(Math.abs(item.amount))}`}</strong>{refundable && <button className="text-button" onClick={() => onRefund(payment)} aria-label={`${payment.merchant} 환불`}>환불</button>}</div>
    </div>;
  })}</div>;
}

export default function App() {
  const [state, setState] = useState<AppState>(() => loadState());
  const stateRef = useRef(state);
  const [page, setPage] = useState<Page>('home');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmationTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const closeDialog = useCallback(() => setDialog(null), []);

  const notify = useCallback((message: string, type: Toast['type'] = 'success') => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ message, type });
    toastTimer.current = setTimeout(() => setToast(null), 5_000);
  }, []);

  const dispatch = useCallback((action: Action): AppState => {
    const next = applyAction(stateRef.current, action);
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
      notify(error instanceof Error ? error.message : '처리하지 못했습니다. 다시 확인해 주세요.', 'error');
      return null;
    }
  }, [dispatch, notify]);

  const confirmPayment = useCallback((id: string) => {
    const timer = setTimeout(() => {
      confirmationTimers.current.delete(timer);
      const result = perform({ type: 'CONFIRM_PAYMENT', id });
      const payment = result?.payments.find((item) => item.id === id);
      if (payment) notify(`${payment.merchant} 결제 완료${payment.cashback ? ` · 페이백 ${money(payment.cashback)}` : ''}`);
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
    if (state.card.stage !== 'active') {
      setPage('card');
      notify('카드를 신청하고 활성화하면 결제를 체험할 수 있어요.', 'info');
      return;
    }
    if (state.card.locked) {
      setPage('card');
      notify('카드 잠금을 해제한 뒤 결제해 주세요.', 'info');
      return;
    }
    setDialog({ type: 'payment' });
  }

  function resetDemo() {
    confirmationTimers.current.forEach((timer) => clearTimeout(timer));
    confirmationTimers.current.clear();
    const next = createInitialState();
    stateRef.current = next;
    setState(next);
    setDialog(null);
    notify('모의 잔액과 카드 신청 내역을 초기화했어요.');
  }

  const currentPage = PAGES[page];
  const plan = PLANS[state.card.plan];
  const coinValue = SYMBOLS.reduce((sum, symbol) => sum + state.holdings[symbol] * ASSETS[symbol].price, 0);
  const accruedDisplay = state.accrued.toLocaleString('ko-KR', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  const dailyReward = Math.min(state.reserve, POLICY.reserveEligibleCap) * state.reserveRate / 365;
  const cardStatus = state.card.locked && state.card.stage === 'active' ? '잠금 상태' : STAGE_NAMES[state.card.stage];

  const assetRows = (all = false) => <div className="assets-table">{SYMBOLS.slice(0, all ? 4 : 3).map((symbol) => <div className="asset-row" key={symbol}><CoinIcon symbol={symbol} /><div className="asset-name"><strong>{symbol}</strong><span>{ASSETS[symbol].name}</span></div><div className="asset-holding">{state.holdings[symbol].toLocaleString('en-US', { maximumFractionDigits: 8 })}<span>{symbol}</span></div><strong className="asset-value">{money(state.holdings[symbol] * ASSETS[symbol].price)}</strong></div>)}</div>;

  const reserveToggle = <Toggle checked={state.reserveAuto} onChange={(enabled) => perform({ type: 'SET_RESERVE_AUTO', enabled }, `Reserve 자동 사용을 ${enabled ? '켰어요' : '껐어요'}.`)} label="Reserve 자동 사용" detail="결제 잔액이 부족할 때 Reserve 원금을 사용해요." testId="reserve-auto" />;
  const rewardsToggle = <Toggle checked={state.rewardsAuto} onChange={(enabled) => perform({ type: 'SET_REWARDS_AUTO', enabled }, `리워드 우선 사용을 ${enabled ? '켰어요' : '껐어요'}.`)} label="리워드 우선 사용" detail="사용 가능한 리워드를 카드 결제에 먼저 써요." testId="rewards-auto" />;

  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" onClick={() => setPage('home')} aria-label="Aqua 홈"><AquaMark /><span className="brand-copy">aqua<span>card</span></span></button>
      <div className="sidebar-caption">나의 일상, 나의 자산</div>
      <nav className="sidebar-nav" aria-label="주 메뉴">{(Object.keys(PAGES) as Page[]).map((key) => {
        const Icon = PAGES[key].icon;
        return <button key={key} className={`nav-item${page === key ? ' active' : ''}`} aria-current={page === key ? 'page' : undefined} data-testid={`nav-${key}`} onClick={() => setPage(key)}><Icon size={20} /><span>{key === 'home' ? '홈' : PAGES[key].title}</span>{key === 'card' && state.card.stage === 'not_applied' && <span className="nav-dot" />}</button>;
      })}</nav>
      <div className="sidebar-footer"><div className="sidebar-support"><ShieldCheck size={21} /><div><strong>편안한 자산의 흐름</strong><span>입금부터 결제까지, Aqua</span></div></div><div className="environment-status"><i />모의 환경 <span>v0.1</span></div></div>
    </aside>

    <main className="main-content">
      <header className="topbar"><div className="page-heading"><div className="breadcrumbs">AQUA CARD <span>/</span> {page === 'home' ? 'OVERVIEW' : page.toUpperCase()}</div><h1>{currentPage.title}</h1><p>{currentPage.subtitle}</p></div><div className="topbar-actions"><span className="demo-pill"><i />PRODUCT POC</span><button className="notification-btn" aria-label="서비스 안내" onClick={() => setDialog({ type: 'guide' })}><Bell size={19} /></button><span className="user-avatar" aria-label="샘플 사용자">A</span></div></header>
      <div className="demo-notice"><Info size={16} /><span><strong>서비스 체험</strong> 모의 자산으로 충전·카드 발급·결제를 경험하세요. 실제 자금은 이동하지 않아요.</span><button className="text-button" onClick={() => setDialog({ type: 'guide' })}>체험 안내 <ChevronRight size={14} /></button></div>

      {page === 'home' && <div className="dashboard-grid">
        <div className="dashboard-main">
          <section className="balance-hero" aria-label="사용 가능한 결제 잔액"><div className="hero-top"><span className="eyebrow">오늘, 바로 쓸 수 있는 잔액</span><span className="hero-badge"><ShieldCheck size={14} /> MY AQUA</span></div><div className="hero-total" data-testid="available-balance">{money(availableToSpend(state))}</div><p className="hero-subtitle">보유 자산은 {money(portfolioValue(state))}<span>리워드 별도</span></p><div className="balance-parts"><div className="balance-part"><span><i className="balance-dot spend" />결제 지갑</span><strong>{money(state.spend)}</strong></div><div className="balance-part"><span><i className="balance-dot rewards" />사용 가능 리워드</span><strong>{money(state.rewards)}</strong></div><div className="balance-part"><span><i className="balance-dot reserve" />Reserve</span><strong>{money(state.reserve)}</strong><small>{state.reserveAuto ? '부족할 때 자동 사용' : '자동 사용 꺼짐'}</small></div></div><div className="hero-actions"><button className="btn dark" data-testid="open-deposit" onClick={() => setDialog({ type: 'fund', bucket: 'spend' })}><Plus size={18} />충전하기</button><button className="btn hero-secondary" data-testid="open-payment" onClick={startPayment}><CreditCard size={18} />결제하기</button><button className="hero-wallet-link" onClick={() => setPage('wallet')}>지갑 보기 <ArrowUpRight size={17} /></button></div></section>

          <section className="panel reserve-panel"><div className="section-head"><div><span className="eyebrow">MAKE YOUR MONEY FLOW</span><h2><Waves size={21} />Aqua Reserve</h2></div><button className="text-button" onClick={() => setPage('reserve')}>자세히 <ArrowUpRight size={16} /></button></div><div className="reserve-top"><div><span className="muted">보상 기준 잔액</span><div className="reserve-balance">{money(state.reserve)}</div></div><span className="rate-pill">연 {percent(state.reserveRate)} <span>변동</span></span></div><div className="reserve-earned"><div><span className="live-dot" />실시간 적립 중</div><strong data-testid="live-accrual">+ ₩{accruedDisplay}</strong><span>1원부터 리워드로 수령</span></div><div className="reserve-bottom"><span>자유롭게 넣고, 필요할 때 꺼내세요.</span><button className="btn secondary small" onClick={() => setDialog({ type: 'transfer', direction: 'in' })}>Reserve로 이동 <ArrowRight size={15} /></button></div></section>

          <section className="panel"><div className="section-head"><div><h2>내 디지털 자산</h2><p>결제 잔액으로 전환할 수 있어요.</p></div><button className="text-button" onClick={() => setPage('wallet')}>모두 보기 <ChevronRight size={15} /></button></div>{assetRows()}<div className="panel-footnote"><span className="tiny-dot" />모의 고정 시세 · 원화 스테이블은 파트너 발행 후 추가 예정</div></section>

          <section className="panel"><div className="section-head"><div><h2>최근 이용 내역</h2></div><button className="text-button" onClick={() => setPage('activity')}>모두 보기 <ChevronRight size={15} /></button></div><ActivityList items={state.transactions.slice(0, 4)} payments={state.payments} onRefund={(payment) => setDialog({ type: 'refund', payment })} /></section>
        </div>
        <div className="dashboard-side">
          <section className="panel card-panel"><div className="section-head"><h2>나의 카드</h2><span className={`tag${state.card.stage === 'active' && !state.card.locked ? ' green' : ''}`}>{cardStatus}</span></div><CardPreview state={state} /><div className="card-details"><strong>{plan.name}</strong><span>결제할 때마다 {percent(plan.cashbackRate)} 페이백</span></div><button className="btn primary full" onClick={() => setPage('card')} data-testid="card-cta">{state.card.stage === 'not_applied' ? 'Aqua Card 신청하기' : state.card.stage === 'active' ? '카드 관리하기' : '신청 이어하기'}<ArrowRight size={17} /></button><p className="card-panel-note">디지털 카드로 먼저, 일상 결제를 가깝게.</p></section>

          <section className="panel payback-panel"><div className="section-head"><h2><Sparkles size={18} />이번 달 페이백</h2><span className="tag">{percent(plan.cashbackRate)}</span></div><div className="cashback-number">{money(state.monthlyCashback)}<span>/ {money(plan.cashbackCap)}</span></div><div className="progress-track"><span className="progress-fill" style={{ width: `${Math.min(100, state.monthlyCashback / plan.cashbackCap * 100)}%` }} /></div><div className="payback-foot"><span>남은 월 한도</span><strong>{money(Math.max(0, plan.cashbackCap - state.monthlyCashback))}</strong></div><div className="rewards-box"><span>결제에 쓸 수 있는 리워드</span><strong data-testid="available-rewards">{money(state.rewards)} <ArrowUpRight size={16} /></strong></div><p className="small-note">Reserve 보상과 페이백을 모아 카드 결제에 사용해요.</p></section>

          <section className="panel quick-panel"><div className="section-head"><h2>빠른 실행</h2></div><div className="quick-action-grid"><button onClick={() => setDialog({ type: 'asset', symbol: 'USDC', mode: 'deposit' })}><span><ArrowDownLeft size={20} /></span>코인 입금</button><button onClick={() => setDialog({ type: 'convert', symbol: 'USDC' })}><span><ArrowLeftRight size={20} /></span>잔액 전환</button><button onClick={() => setDialog({ type: 'withdraw', bucket: 'spend' })}><span><ArrowUpRight size={20} /></span>출금</button><button onClick={() => setPage('reserve')}><span><Waves size={20} /></span>리워드 수령</button></div></section>
          <div className="hint-box"><span><Waves size={21} /></span><div><strong>내 일상에 더 자연스럽게</strong><p>다양한 코인을 담고,<br />원화로 편안하게 결제하세요.</p></div></div>
        </div>
      </div>}

      {page === 'wallet' && <div className="page-stack"><div className="wallet-topgrid"><section className="panel stat-panel"><span className="eyebrow">총 보유 자산</span><strong className="display-value">{money(portfolioValue(state))}</strong><p>결제 지갑 + Reserve + 코인 · 리워드 별도</p></section><section className="panel stat-panel"><span className="eyebrow">결제 지갑</span><strong className="display-value">{money(state.spend)}</strong><div className="actions"><button className="text-button" onClick={() => setDialog({ type: 'fund', bucket: 'spend' })}><Plus size={14} />충전</button><button className="text-button" onClick={() => setDialog({ type: 'withdraw', bucket: 'spend' })}><ArrowUpRight size={14} />출금</button></div></section><section className="panel stat-panel"><span className="eyebrow">보유 코인 평가액</span><strong className="display-value">{money(coinValue)}</strong><p>모의 고정 시세 기준</p></section></div><div className="section-head standalone"><div><h2>디지털 자산</h2><p>코인을 입금하고 결제 잔액으로 전환하세요.</p></div><span className="tag">4개 지원 자산</span></div><div className="asset-cards-grid">{SYMBOLS.map((symbol) => <section className="panel asset-card" key={symbol}><div className="asset-card-head"><CoinIcon symbol={symbol} /><div><h3>{symbol}</h3><p>{ASSETS[symbol].name}</p></div><span className="tag">{state.holdings[symbol] > 0 ? '보유 중' : '미보유'}</span></div><div className="asset-card-value">{money(state.holdings[symbol] * ASSETS[symbol].price)}</div><div className="asset-card-units">{state.holdings[symbol].toLocaleString('en-US', { maximumFractionDigits: 8 })} {symbol}</div><div className="asset-quote"><span>1 {symbol}</span><strong>{money(ASSETS[symbol].price)}</strong><span>고정 데모 시세</span></div><div className="asset-actions"><button className="btn primary small" onClick={() => setDialog({ type: 'asset', symbol, mode: 'deposit' })} aria-label={`${symbol} 입금`}>입금</button><button className="btn secondary small" onClick={() => setDialog({ type: 'convert', symbol })} aria-label={`${symbol} 전환`}>전환</button><button className="btn ghost small" onClick={() => setDialog({ type: 'asset', symbol, mode: 'withdraw' })} aria-label={`${symbol} 출금`}>출금</button></div></section>)}</div><div className="info-box"><Info size={18} /><div><strong>원화로 쓰기 전에, 전환 한 번</strong><p>보유 코인은 결제 잔액으로 전환한 뒤 사용할 수 있어요. 전환 수수료 {percent(POLICY.conversionFee)}, 견적 유효 시간 {POLICY.quoteTtlSeconds}초. 원화 스테이블 자산은 발행사 제휴 후 지원할 예정입니다.</p></div></div><section className="panel"><div className="section-head"><div><h2>내 지갑 사이에서</h2><p>결제 잔액과 Reserve를 수수료 없이 이동해요.</p></div></div><div className="wallet-transfer-row"><div><span className="muted">결제 지갑</span><strong>{money(state.spend)}</strong></div><ArrowLeftRight size={22} /><div><span className="muted">Reserve</span><strong>{money(state.reserve)}</strong></div><button className="btn secondary" onClick={() => setDialog({ type: 'transfer', direction: 'in' })}>Reserve로 이동</button><button className="btn secondary" onClick={() => setDialog({ type: 'transfer', direction: 'out' })}>결제 지갑으로 이동</button></div></section></div>}

      {page === 'card' && <div className="card-page"><CardApplication card={state.card} onChange={(card) => { perform({ type: 'SET_CARD', card }); }} onNotify={(message) => notify(message)} /><section className="panel card-payment-panel"><div><h2>첫 결제를 체험해 볼까요?</h2><p>카드 활성화 후 모의 가맹점에서 결제하고 페이백을 확인하세요.</p></div><button className="btn primary" onClick={startPayment} data-testid="card-payment"><CreditCard size={18} />카드 결제 체험</button></section></div>}

      {page === 'reserve' && <div className="page-stack"><div className="reserve-detail-grid"><section className="panel reserve-feature-card"><div className="section-head"><div><span className="eyebrow">AQUA RESERVE</span><h2>자산이 머무는 동안, 보상은 흐르도록.</h2></div><Waves size={36} /></div><span className="muted">내 Reserve 잔액</span><strong className="display-value" data-testid="reserve-principal">{money(state.reserve)}</strong><div className="reserve-rate-line"><span className="rate-pill">연 {percent(state.reserveRate)} <span>변동 보상률</span></span><span>입출금 제한 없음 · 최소 1,000원</span></div><div className="actions"><button className="btn primary" onClick={() => setDialog({ type: 'transfer', direction: 'in' })}><Plus size={17} />Reserve로 이동</button><button className="btn secondary" onClick={() => setDialog({ type: 'transfer', direction: 'out' })}><ArrowUpRight size={17} />결제 지갑으로</button></div><div className="reserve-direct-actions"><button className="text-button" onClick={() => setDialog({ type: 'fund', bucket: 'reserve' })}>데모 직접 충전</button><span>·</span><button className="text-button" onClick={() => setDialog({ type: 'withdraw', bucket: 'reserve' })}>외부 출금 체험</button></div></section><section className="panel accrual-panel"><div className="section-head"><h2><span className="live-dot" />실시간 적립</h2><span className="tag">단리</span></div><strong className="live-value" data-testid="reserve-accrual">₩{accruedDisplay}</strong><p>매초 계산되는 결제 전용 보상</p><div className="accrual-estimate"><span>현재 잔액의 예상 일 보상</span><strong>약 {money(dailyReward)}</strong></div><button className="btn primary full" data-testid="claim-rewards" disabled={state.accrued < 1 - 1e-9} onClick={() => perform({ type: 'REDEEM_ACCRUAL' }, '적립 보상을 결제용 리워드로 수령했어요.')}><Sparkles size={17} />{state.accrued < 1 ? '1원부터 수령할 수 있어요' : `${money(Math.floor(state.accrued + 1e-9))} 리워드 수령`}</button><span className="small-note">소수점 잔여 적립은 다음 수령까지 유지돼요.</span></section></div><section className="panel"><div className="section-head"><div><h2>필요할 때, 결제에도</h2><p>원금 사용과 리워드 사용을 따로 설정하세요.</p></div><CreditCard size={23} /></div>{reserveToggle}{rewardsToggle}<div className="funding-order"><span className={state.rewardsAuto ? 'enabled' : ''}>1. 리워드{!state.rewardsAuto && ' (꺼짐)'}</span><ChevronRight size={15} /><span className="enabled">2. 결제 지갑</span><ChevronRight size={15} /><span className={state.reserveAuto ? 'enabled' : ''}>3. Reserve{!state.reserveAuto && ' (꺼짐)'}</span></div><p className="small-note">Reserve 원금이 사용되면 사용 시점부터 남은 잔액을 기준으로 보상이 적립됩니다.</p></section><div className="reserve-detail-grid"><section className="panel"><div className="section-head"><h2>사용 가능 리워드</h2><Sparkles size={20} /></div><strong className="display-value">{money(state.rewards)}</strong><p className="small-note">수령한 Reserve 보상 + 카드 페이백. 카드 결제 전용이며 현금 출금·코인 전환은 지원하지 않아요.</p>{state.rewardDebt > 0 && <div className="form-note">페이백 조정 {money(state.rewardDebt)}은 앞으로 적립될 리워드에서 먼저 반영됩니다.</div>}<button className="btn secondary" onClick={startPayment}>리워드로 결제하기 <ArrowRight size={16} /></button></section><section className="panel"><div className="section-head"><h2>보상률 기록</h2><span className="tag">시점별 적용</span></div><div className="rate-history">{state.rateHistory.slice().reverse().slice(0, 5).map((item, index) => <div key={`${item.timestamp}-${index}`}><span><Clock3 size={15} />{shortDate(item.timestamp)}</span><strong>연 {percent(item.rate)}</strong>{index === 0 && <span className="tag green">현재</span>}</div>)}</div></section></div><div className="info-box"><Info size={18} /><div><strong>Reserve 보상 안내</strong><p>체험 기본 보상률은 연 5%, 단리이며 최대 {money(POLICY.reserveEligibleCap)}까지 보상 계산에 반영합니다. 지급률은 변동할 수 있고 원금 보장 예금이 아닙니다. 실제 운용·수탁·상환 조건은 파트너 계약 후 확정됩니다.</p></div></div></div>}

      {page === 'activity' && <div className="page-stack"><div className="wallet-topgrid"><section className="panel stat-panel"><span className="eyebrow">이번 달 카드 이용</span><strong className="display-value">{money(state.monthlySpent)}</strong><p>승인 누적 기준 · 월 한도 {money(POLICY.monthlyPaymentLimit)}</p></section><section className="panel stat-panel"><span className="eyebrow">오늘 카드 이용</span><strong className="display-value">{money(state.dailySpent)}</strong><p>일 한도 {money(POLICY.dailyPaymentLimit)}</p></section><section className="panel stat-panel"><span className="eyebrow">이번 달 페이백</span><strong className="display-value">{money(state.monthlyCashback)}</strong><p>{plan.name} · 월 최대 {money(plan.cashbackCap)}</p></section></div><section className="panel"><div className="section-head"><div><h2>모든 이용 내역</h2><p>결제 확정 후 전액·부분 환불을 체험할 수 있어요.</p></div><span className="tag">{state.transactions.length}건</span></div><ActivityList detailed items={state.transactions} payments={state.payments} onRefund={(payment) => setDialog({ type: 'refund', payment })} /></section></div>}

      {page === 'settings' && <div className="settings-grid"><section className="panel settings-panel"><div className="section-head"><div><h2>결제 설정</h2><p>내 자금이 사용되는 방식을 선택하세요.</p></div><Wallet size={22} /></div>{rewardsToggle}{reserveToggle}<div className="settings-limits"><h3>결제 한도</h3><div><span>1회</span><strong>{money(POLICY.perPaymentLimit)}</strong></div><div><span>1일</span><strong>{money(POLICY.dailyPaymentLimit)}</strong></div><div><span>1개월</span><strong>{money(POLICY.monthlyPaymentLimit)}</strong></div></div></section><section className="panel settings-panel"><div className="section-head"><div><h2>나의 혜택</h2><p>현재 선택한 카드 플랜 기준</p></div><Sparkles size={22} /></div><div className="settings-limits"><div><span>카드 플랜</span><strong>{plan.name}</strong></div><div><span>월 이용료</span><strong>{plan.monthlyFee ? money(plan.monthlyFee) : '무료'}</strong></div><div><span>카드 페이백</span><strong>{percent(plan.cashbackRate)} · 월 {money(plan.cashbackCap)}</strong></div><div><span>Reserve 보상률</span><strong>연 {percent(state.reserveRate)} · 변동</strong></div></div><p className="small-note">페이백은 리워드 사용분을 제외한 결제 원금에 적용해요. 모의 이용료는 안내만 하고 잔액에서 차감하지 않습니다.</p><button className="btn secondary" onClick={() => setPage('card')}>카드 플랜 보기 <ArrowRight size={16} /></button></section><section className="panel settings-panel demo-settings"><div className="section-head"><div><span className="eyebrow">PRODUCT POC</span><h2>데모 설정</h2><p>보상과 지급률 변화를 빠르게 검증해 보세요.</p></div><RefreshCw size={22} /></div><div className="demo-control"><div><strong>하루 뒤로 시간 진행</strong><p>현재 잔액과 보상률로 24시간 적립을 계산해요.</p></div><button className="btn secondary" data-testid="advance-day" onClick={() => perform({ type: 'ADVANCE_DAY' }, '데모 시간을 하루 진행했어요. Reserve에서 보상을 수령해 보세요.')}><Clock3 size={16} />+1일</button></div><div className="demo-control"><div><strong>Reserve 보상률 변경</strong><p>이미 적립된 보상은 유지하고 이후부터 적용해요.</p></div><div className="rate-buttons">{[0.03, 0.05, 0.08].map((rate) => <button key={rate} className={`btn small${state.reserveRate === rate ? ' primary' : ' secondary'}`} aria-pressed={state.reserveRate === rate} data-testid={`rate-${rate * 100}`} onClick={() => perform({ type: 'CHANGE_RATE', rate }, `Reserve 보상률을 연 ${percent(rate)}로 변경했어요.`)}>{percent(rate)}</button>)}</div></div><div className="demo-control"><div><strong>체험 데이터 초기화</strong><p>잔액, 카드 신청, 이용 내역을 처음 상태로 되돌려요.</p></div><button className="btn danger small" data-testid="reset-demo" onClick={() => setDialog({ type: 'reset' })}>초기화</button></div><p className="small-note">체험 데이터는 이 브라우저에 저장됩니다. 본인 확인 자료나 실제 계좌 정보는 저장하지 않아요.</p></section><section className="panel settings-panel"><div className="section-head"><h2>Aqua Card에 대해</h2><AquaMark small /></div><p className="about-copy">디지털 자산을 일상의 결제로 연결하는<br />한국을 위한 카드·지갑 서비스.</p><div className="settings-limits"><div><span>지원 자산</span><strong>USDC · USDT · BTC · ETH</strong></div><div><span>원화 스테이블</span><strong>파트너 발행 후 지원 예정</strong></div><div><span>현재 버전</span><strong>Product PoC 0.1</strong></div></div><button className="text-button" onClick={() => setDialog({ type: 'guide' })}>전체 체험 안내 <ArrowRight size={15} /></button></section></div>}

      <footer className="app-footer"><span>© 2026 Aqua Card</span><span>새로운 자산, 자연스러운 일상.</span><span>Product concept · Korea</span></footer>
    </main>
    {dialog && <ActionDialog dialog={dialog} state={state} onClose={closeDialog} dispatch={dispatch} notify={notify} onPaid={confirmPayment} onReset={resetDemo} />}
    {toast && <div className={`toast ${toast.type}`} role={toast.type === 'error' ? 'alert' : 'status'}><span className="toast-icon">{toast.type === 'success' ? <CheckCircle2 size={20} /> : <Info size={20} />}</span><span className="toast-copy">{toast.message}</span><button className="toast-close" aria-label="알림 닫기" onClick={() => setToast(null)}><X size={17} /></button></div>}
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
  const [symbol, setSymbol] = useState<AssetSymbol>(dialog.type === 'convert' || dialog.type === 'asset' ? dialog.symbol : 'USDC');
  const [bucket, setBucket] = useState<'spend' | 'reserve'>(dialog.type === 'fund' || dialog.type === 'withdraw' ? dialog.bucket : 'spend');
  const [direction, setDirection] = useState<'in' | 'out'>(dialog.type === 'transfer' ? dialog.direction : 'in');
  const [error, setError] = useState('');
  const [quoteAt, setQuoteAt] = useState(Date.now());
  const [clock, setClock] = useState(Date.now());
  const modalRef = useRef<HTMLDivElement>(null);
  const number = Number(amount);
  const validNumber = Number.isFinite(number) && number > 0;
  const quoteSeconds = Math.max(0, POLICY.quoteTtlSeconds - Math.floor((clock - quoteAt) / 1_000));
  const source = sourcesFor(state, validNumber ? number : 0);
  const gross = validNumber ? number * ASSETS[symbol].price : 0;
  const net = Math.floor(gross * (1 - POLICY.conversionFee));
  const formId = 'aqua-action-form';
  const titles: Record<Dialog['type'], string> = { fund: '모의 잔액 충전', withdraw: '원화 출금 체험', transfer: '내 지갑 사이에서 이동', asset: dialog.type === 'asset' && dialog.mode === 'withdraw' ? '코인 출금 체험' : '코인 입금 체험', convert: '결제 잔액으로 전환', payment: '카드 결제 체험', refund: '결제 환불', guide: 'Aqua를 만나보세요', reset: '체험 데이터를 초기화할까요?' };

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const target = modalRef.current;
    const timer = setTimeout(() => {
      const input = target?.querySelector<HTMLInputElement>('input:not([type="checkbox"]), select, textarea');
      (input ?? target?.querySelector<HTMLButtonElement>('button'))?.focus();
    }, 0);
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

  function renewQuote() {
    const now = Date.now();
    setQuoteAt(now); setClock(now); setError('');
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    if (!validNumber) { setError('0보다 큰 금액 또는 수량을 입력해 주세요.'); return; }
    try {
      let action: Action;
      let message: string;
      switch (dialog.type) {
        case 'fund': action = { type: 'DEPOSIT', bucket, amount: number }; message = `${bucket === 'spend' ? '결제 지갑' : 'Reserve'}에 ${money(number)}을 충전했어요.`; break;
        case 'withdraw': action = { type: 'WITHDRAW_FUNDS', bucket, amount: number }; message = `${money(number)} 모의 출금을 완료했어요.`; break;
        case 'transfer': action = { type: 'TRANSFER_RESERVE', direction, amount: number }; message = `${direction === 'in' ? 'Reserve' : '결제 지갑'}로 ${money(number)}을 이동했어요.`; break;
        case 'asset': action = { type: dialog.mode === 'deposit' ? 'DEPOSIT_ASSET' : 'WITHDRAW_ASSET', symbol, units: number }; message = `${number} ${symbol} 모의 ${dialog.mode === 'deposit' ? '입금' : '출금'}을 완료했어요.`; break;
        case 'convert': action = { type: 'CONVERT', symbol, units: number, quotedAt: quoteAt }; message = `${symbol}을 결제 잔액 ${money(net)}으로 전환했어요.`; break;
        case 'payment': action = { type: 'PAY', merchant, amount: number }; message = `${merchant} 결제를 승인하고 있어요.`; break;
        case 'refund': action = { type: 'REFUND', id: dialog.payment.id, amount: number }; message = `${money(number)} 환불을 완료했어요. 페이백 조정도 반영했어요.`; break;
        default: return;
      }
      const next = dispatch(action);
      if (dialog.type === 'payment') {
        const payment = next.payments.find((item) => item.status === 'pending' && !state.payments.some((old) => old.id === item.id));
        if (payment) onPaid(payment.id);
      }
      notify(message);
      onClose();
    } catch (issue) { setError(issue instanceof Error ? issue.message : '입력 내용을 확인해 주세요.'); }
  }

  const isAsset = dialog.type === 'asset' || dialog.type === 'convert';
  const buttonLabels: Record<Dialog['type'], string> = { fund: '충전 반영하기', withdraw: '모의 출금하기', transfer: '이동하기', asset: dialog.type === 'asset' && dialog.mode === 'withdraw' ? '모의 출금하기' : '입금 반영하기', convert: '전환 확정하기', payment: `${money(validNumber ? number : 0)} 결제하기`, refund: '환불하기', guide: '확인했어요', reset: '초기화하기' };

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="modal" ref={modalRef} role="dialog" aria-modal="true" aria-labelledby="dialog-title" data-testid={`dialog-${dialog.type}`}>
    <div className="modal-head"><div><span className="eyebrow">AQUA CARD</span><h2 id="dialog-title">{titles[dialog.type]}</h2></div><button className="icon-button" onClick={onClose} aria-label="창 닫기"><X size={21} /></button></div>
    <div className="modal-body">
      {dialog.type === 'guide' ? <div className="guide-content"><div className="guide-intro"><AquaMark /><h3>새로운 자산, 자연스러운 일상.</h3><p>한국을 위한 디지털 자산 카드·지갑의<br />첫 제품 경험을 함께 살펴보세요.</p></div><ol className="guide-steps"><li><span>1</span><div><strong>지갑에 자산을 담으세요</strong><p>모의 원화 충전이나 USDC·USDT·BTC·ETH 입금을 체험해요.</p></div></li><li><span>2</span><div><strong>카드를 신청하고 활성화하세요</strong><p>본인 확인, 플랜 선택, 신청·심사·발급 흐름을 차례로 경험해요.</p></div></li><li><span>3</span><div><strong>결제하고 리워드를 받으세요</strong><p>Reserve 보상과 카드 페이백을 결제에 사용해요. 설정에서 +1일로 적립을 빠르게 확인할 수 있어요.</p></div></li></ol><div className="form-note"><Info size={16} /><span>모든 자산·시세·발급·송금은 시뮬레이션입니다. 실제 금융 서비스에 가입하거나 자금이 이동하지 않습니다.</span></div></div>
      : dialog.type === 'reset' ? <div><div className="reset-icon"><RefreshCw size={30} /></div><p className="reset-description">모의 잔액, 카드 신청, 결제 및 이용 내역이<br />처음 상태로 돌아갑니다.</p><div className="form-note">현재 브라우저에 저장된 체험 데이터가 초기화됩니다.</div></div>
      : <form id={formId} onSubmit={submit}>
        {dialog.type === 'fund' && <div className="form-field"><label htmlFor="fund-bucket">충전할 지갑</label><select id="fund-bucket" value={bucket} onChange={(event) => setBucket(event.target.value as 'spend' | 'reserve')}><option value="spend">결제 지갑 · {money(state.spend)}</option><option value="reserve">Reserve · {money(state.reserve)}</option></select></div>}
        {dialog.type === 'withdraw' && <><div className="form-field"><label htmlFor="withdraw-bucket">출금할 지갑</label><select id="withdraw-bucket" value={bucket} onChange={(event) => setBucket(event.target.value as 'spend' | 'reserve')}><option value="spend">결제 지갑 · {money(state.spend)}</option><option value="reserve">Reserve · {money(state.reserve)}</option></select></div><div className="form-note"><ShieldCheck size={16} /><span>원금만 출금할 수 있어요. 결제 전용 리워드는 출금되지 않습니다.</span></div></>}
        {dialog.type === 'transfer' && <div className="form-field"><label htmlFor="transfer-direction">이동 방향</label><select id="transfer-direction" value={direction} onChange={(event) => setDirection(event.target.value as 'in' | 'out')}><option value="in">결제 지갑 → Reserve</option><option value="out">Reserve → 결제 지갑</option></select><span className="field-help">이동 가능: {money(direction === 'in' ? state.spend : state.reserve)} · 수수료 0원</span></div>}
        {isAsset && <><div className="form-field"><label htmlFor="asset-symbol">자산 선택</label><select id="asset-symbol" value={symbol} onChange={(event) => { const next = event.target.value as AssetSymbol; setSymbol(next); setAmount(next === 'BTC' ? '0.0001' : next === 'ETH' ? '0.01' : '10'); renewQuote(); }}><option value="USDC">USDC · USD Coin</option><option value="USDT">USDT · Tether</option><option value="BTC">BTC · Bitcoin</option><option value="ETH">ETH · Ethereum</option></select><span className="field-help">보유 수량: {state.holdings[symbol].toLocaleString('en-US', { maximumFractionDigits: 8 })} {symbol}</span></div>{dialog.type === 'asset' && <div className="asset-network-note"><CoinIcon symbol={symbol} /><div><strong>{ASSETS[symbol].network}</strong><span>모의 네트워크 · 실제 지갑 주소 없이 체험해요.</span></div></div>}</>}
        {dialog.type === 'payment' && <><div className="payment-card-tag"><CreditCard size={19} /><span>{PLANS[state.card.plan].name} · •••• {state.card.last4}</span><ShieldCheck size={16} /></div><div className="form-field"><label htmlFor="merchant">결제처</label><input id="merchant" value={merchant} onChange={(event) => setMerchant(event.target.value)} required maxLength={40} autoComplete="off" /></div></>}
        {dialog.type === 'refund' && <div className="refund-summary"><strong>{dialog.payment.merchant}</strong><span>원 결제 {money(dialog.payment.amount)}</span><span>환불 가능 {money(dialog.payment.amount - dialog.payment.refunded)}</span></div>}
        <div className="form-field"><label htmlFor="action-amount">{isAsset ? '자산 수량' : dialog.type === 'refund' ? '환불 금액' : dialog.type === 'payment' ? '결제 금액' : '금액'}</label><div className="input-affix"><input id="action-amount" data-testid="action-amount" type="number" inputMode={isAsset ? 'decimal' : 'numeric'} min={isAsset ? '0.00000001' : dialog.type === 'payment' || dialog.type === 'refund' ? 1 : 1_000} step={isAsset ? 'any' : 1} value={amount} onChange={(event) => { setAmount(event.target.value); setError(''); if (dialog.type === 'convert') renewQuote(); }} required /><span>{isAsset ? symbol : '원'}</span></div>{!isAsset && dialog.type !== 'payment' && dialog.type !== 'refund' && <span className="field-help">최소 1,000원부터 가능해요.</span>}</div>
        {dialog.type === 'fund' && <div className="preset-amounts">{[10_000, 50_000, 100_000].map((value) => <button type="button" key={value} className="btn secondary small" onClick={() => setAmount(String(value))}>{won(value)}원</button>)}</div>}
        {dialog.type === 'convert' && <div className="quote-preview"><div className="quote-head"><strong>전환 견적</strong><span className={quoteSeconds === 0 ? 'expired' : ''}>{quoteSeconds > 0 ? `${quoteSeconds}초 남음` : '견적 만료'}</span><button type="button" className="text-button" onClick={renewQuote} aria-label="견적 갱신"><RefreshCw size={14} />갱신</button></div><div><span>모의 시세</span><strong>1 {symbol} = {money(ASSETS[symbol].price)}</strong></div><div><span>전환 전 평가액</span><strong>{money(gross)}</strong></div><div><span>수수료 {percent(POLICY.conversionFee)}</span><strong>−{money(Math.ceil(gross - net))}</strong></div><div className="quote-total"><span>받을 결제 잔액</span><strong>{money(net)}</strong></div></div>}
        {dialog.type === 'payment' && <div className="payment-sources"><div className="quote-head"><strong>결제에 사용할 잔액</strong><span>자동 사용 순서</span></div><div className="source-row"><span><i className="balance-dot rewards" />리워드{!state.rewardsAuto && ' · 자동 사용 꺼짐'}</span><strong>{money(source.rewards)}</strong></div><div className="source-row"><span><i className="balance-dot spend" />결제 지갑</span><strong>{money(source.spend)}</strong></div><div className="source-row"><span><i className="balance-dot reserve" />Reserve{!state.reserveAuto && ' · 자동 사용 꺼짐'}</span><strong>{money(source.reserve)}</strong></div>{source.shortfall > 0 && <div className="form-error">잔액이 {money(source.shortfall)} 부족해요. 충전하거나 Reserve 자동 사용을 켜 주세요.</div>}<div className="quote-total"><span><Sparkles size={15} />예상 페이백</span><strong>+{money(source.cashback)}</strong></div><p className="small-note">리워드 사용분은 페이백 대상에서 제외돼요. 결제 확정 후 지급됩니다.</p></div>}
        {dialog.type === 'refund' && <div className="form-note"><Info size={16} /><span>원금은 결제 지갑으로, 사용한 리워드는 리워드 잔액으로 반환돼요. 해당 결제의 페이백은 환불 비율에 따라 조정됩니다.</span></div>}
        {['fund', 'withdraw', 'asset'].includes(dialog.type) && <div className="form-note"><Info size={16} /><span>{dialog.type === 'withdraw' ? '모의 출금 후 화면의 잔액만 변경됩니다. 실제 은행이나 외부 지갑으로 전송하지 않습니다.' : dialog.type === 'asset' ? '자산 수량을 입력하면 모의 잔액에 반영됩니다. 실제 블록체인 거래를 전송하지 않습니다.' : '체험용 원화 잔액을 추가합니다. 은행 입금이나 실제 결제는 발생하지 않습니다.'}</span></div>}
        {error && <div className="form-error" role="alert"><Info size={16} />{error}</div>}
      </form>}
    </div>
    <div className="modal-footer">{dialog.type !== 'guide' && <button className="btn secondary" onClick={onClose}>취소</button>}<button className={`btn${dialog.type === 'reset' ? ' danger' : ' primary'}`} type={dialog.type === 'guide' || dialog.type === 'reset' ? 'button' : 'submit'} form={dialog.type === 'guide' || dialog.type === 'reset' ? undefined : formId} data-testid="confirm-action" disabled={dialog.type === 'convert' && quoteSeconds === 0 || dialog.type === 'payment' && source.shortfall > 0} onClick={dialog.type === 'guide' ? onClose : dialog.type === 'reset' ? onReset : undefined}>{dialog.type === 'payment' ? <LockKeyhole size={16} /> : dialog.type === 'guide' ? <Check size={16} /> : null}{buttonLabels[dialog.type]}</button></div>
  </div></div>;
}
