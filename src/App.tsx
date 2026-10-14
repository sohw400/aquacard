import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { CheckCircle2, ChevronLeft, Clock3, Info, X } from 'lucide-react';
import CardApplication from './components/CardApplication';
import Logo from './components/Logo';
import TierCard from './components/TierCard';
import { AmountInput } from './components/ui';
import Onboarding from './components/Onboarding';
import AccountClosureSheet from './components/AccountClosureSheet';
import { PasswordSheet } from './components/SecuritySheets';
import { ChannelsPage, FaqPage, LimitsPage, NotificationsPage, TermsPage } from './components/SettingsPages';
import TransactionSheet from './components/TransactionSheet';
import FundingDialog from './components/FundingDialog';
import InternalTransferDialog from './components/InternalTransferDialog';
import SendSheet from './components/SendSheet';
import ReceiveSheet from './components/ReceiveSheet';
import PaymentReceipt, { type PaymentReceiptData } from './components/PaymentReceipt';
import { statusOf } from './components/Activity';
import Home from './pages/Home';
import Benefits from './pages/Benefits';
import Reserve from './pages/Reserve';
import Settings from './pages/Settings';
import ActivityPage, { type ActivityFilter } from './pages/ActivityPage';
import Statement from './pages/Statement';
import { applyAction, createInitialState, loadState, saveState } from './lib/engine';
import { money, percent, won } from './lib/format';
import { PLANS } from './lib/policy';
import type { Action, AppState, CardStage, FundingSymbol, Payment, PaymentChannel, Transaction } from './lib/types';

type Page = 'home' | 'card' | 'benefits' | 'settings' | 'reserve' | 'activity' | 'statement' | 'limits' | 'channels' | 'notifications' | 'faq' | 'terms';
type MainPage = 'home' | 'card' | 'benefits' | 'settings';
type Dialog = { type: 'payment' } | { type: 'refund'; payment: Payment } | { type: 'reset' };
type Toast = { message: string; type: 'success' | 'error' | 'info' };

const MAIN_PAGES: MainPage[] = ['home', 'card', 'benefits', 'settings'];
const STAGE_NAMES: Record<CardStage, string> = {
  not_applied: '없음', identity: '신청 중', plan: '신청 중', details: '신청 중', review: '신청 중',
  submitted: '만드는 중', needs_info: '확인 필요', approved: '만드는 중', issued: '만드는 중', active: '사용 중', rejected: '승인 안 됨',
};
const PAGE_TITLES: Record<Page, string> = {
  home: '홈', card: '카드', benefits: '혜택', settings: '전체',
  reserve: '리저브', activity: '거래 내역', statement: '연간 거래 내역', limits: '결제 한도', channels: '온라인·해외 결제', notifications: '알림', faq: '자주 묻는 질문', terms: '약관 및 정책',
};
const PAYMENT_PRESETS = [['한강커피', 5_800, 'store'], ['온라인 쇼핑', 89_000, 'online'], ['도쿄 카페', 7_200, 'overseas']] as const;
const CHANNELS: [PaymentChannel, string][] = [['store', '매장'], ['online', '온라인'], ['overseas', '해외']];

function sourcesFor(state: AppState, amount: number) {
  const rewards = state.rewardsAuto ? Math.min(state.rewards, Math.max(0, amount)) : 0;
  const spend = Math.min(state.spend, Math.max(0, amount - rewards));
  const reserve = state.reserveAuto ? Math.min(state.reserve, Math.max(0, amount - rewards - spend)) : 0;
  const shortfall = Math.max(0, amount - rewards - spend - reserve);
  const plan = PLANS[state.card.plan];
  const cashback = Math.min(Math.floor(Math.max(0, amount - rewards) * plan.cashbackRate), Math.max(0, plan.cashbackCap - state.monthlyCashback));
  return { rewards, spend, reserve, shortfall, cashback };
}

function NavIcon({ name }: { name: MainPage }) {
  const stroke = { stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
  return <svg className="nav-icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
    {name === 'home' && <path className="nav-shape" {...stroke} d="M4.5 10.4 12 4.4l7.5 6V19a1.2 1.2 0 0 1-1.2 1.2H15v-5.3H9v5.3H5.7A1.2 1.2 0 0 1 4.5 19Z" />}
    {name === 'card' && <><rect className="nav-shape" {...stroke} x="3.4" y="5.6" width="17.2" height="12.8" rx="2.6" /><path className="nav-cut-line" d="M3.6 9.8h16.8" strokeWidth="1.8" /><path className="nav-cut-line" d="M7 14.8h3.2" strokeWidth="1.8" strokeLinecap="round" /></>}
    {name === 'benefits' && <><path className="nav-shape" {...stroke} d="M6.6 5.6h10.8a2 2 0 0 1 2 2v2.1a2.3 2.3 0 0 0 0 4.6v2.1a2 2 0 0 1-2 2H6.6a2 2 0 0 1-2-2v-2.1a2.3 2.3 0 0 0 0-4.6V7.6a2 2 0 0 1 2-2Z" /><path className="nav-cut-line" d="M14.6 8.2v7.6" strokeWidth="1.8" strokeLinecap="round" strokeDasharray="1.4 2.4" /></>}
    {name === 'settings' && [[4.6, 4.6], [13.4, 4.6], [4.6, 13.4], [13.4, 13.4]].map(([x, y]) => <rect key={`${x}-${y}`} className="nav-shape" {...stroke} x={x} y={y} width="6" height="6" rx="1.8" />)}
  </svg>;
}

/** True while any modal sheet or dialog is on screen, including the ones the card page opens itself. */
function useModalOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const check = () => setOpen(document.querySelector('[role="dialog"][aria-modal="true"]') !== null);
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    check();
    return () => observer.disconnect();
  }, []);
  return open;
}

export default function App() {
  const [state, setState] = useState<AppState>(() => loadState());
  const stateRef = useRef(state);
  const [page, setPage] = useState<Page>('home');
  const [trail, setTrail] = useState<Page[]>([]);
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>('all');
  const [closingAccount, setClosingAccount] = useState(false);
  const [passwordSheet, setPasswordSheet] = useState(false);
  const [detailItem, setDetailItem] = useState<Transaction | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [funding, setFunding] = useState<{ mode: 'deposit' | 'withdraw'; symbol?: FundingSymbol; operationId?: string } | null>(null);
  const closeFunding = useCallback(() => setFunding(null), []);
  const [reserveMove, setReserveMove] = useState<'in' | 'out' | null>(null);
  const [sending, setSending] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const closeReserveMove = useCallback(() => setReserveMove(null), []);
  const [receipts, setReceipts] = useState<PaymentReceiptData[]>([]);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmationTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const paymentSnapshots = useRef(new Map<string, { rewardsBefore: number; rewardsAfterDebit: number }>());
  const closeDialog = useCallback(() => setDialog(null), []);
  const closeReceipt = useCallback(() => setReceipts((current) => current.slice(1)), []);

  const openFundingOperation = (id: string) => {
    const operation = state.fundingOperations.find((item) => item.id === id);
    if (operation) setFunding({ mode: operation.kind === 'deposit' ? 'deposit' : 'withdraw', symbol: operation.symbol, operationId: id });
  };
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
      notify(error instanceof Error ? error.message : '입력한 내용을 확인해 주세요.', 'error');
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
      }
    }, 450);
    confirmationTimers.current.add(timer);
  }, [perform]);

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
  const modalOpen = useModalOpen();
  // A sheet whose body has scrolled shows a hairline under its header, so the content never looks cut off.
  useEffect(() => {
    const onScroll = (event: Event) => {
      const body = event.target;
      if (body instanceof HTMLElement && body.matches('.itd-body, .funding-body, .modal-body, .receipt-body')) body.closest('[role="dialog"]')?.toggleAttribute('data-scrolled', body.scrollTop > 0);
    };
    document.addEventListener('scroll', onScroll, true);
    return () => document.removeEventListener('scroll', onScroll, true);
  }, []);
  // A sheet that opens takes over the screen: an earlier message would only reappear, out of context, after it closes.
  useEffect(() => { if (modalOpen) setToast((current) => current?.type === 'error' ? current : null); }, [modalOpen]);
  const toastView = toast && (!modalOpen || toast.type === 'error') && <div className={`toast ${toast.type}${modalOpen ? ' over-sheet' : ''}${state.signedIn ? '' : ' no-tabbar'}`} role={toast.type === 'error' ? 'alert' : 'status'}><span className="toast-icon">{toast.type === 'success' ? <CheckCircle2 /> : <Info />}</span><span className="toast-copy">{toast.message}</span><button type="button" className="toast-close" aria-label="알림 닫기" onClick={() => setToast(null)}><X size={18} /></button></div>;
  // Signing out leaves no screen, sheet or receipt behind for the next sign-in.
  useEffect(() => {
    if (state.signedIn) return;
    setPage('home'); setTrail([]); setDialog(null); setFunding(null); setReserveMove(null); setSending(false); setReceiving(false); setReceipts([]); setClosingAccount(false); setPasswordSheet(false); setDetailItem(null);
  }, [state.signedIn]);

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
  /** The card button does what the card needs next: start an application, show progress, or pay. */
  function startPayment() {
    if (state.card.stage === 'not_applied') {
      if (perform({ type: 'SET_CARD', card: { ...state.card, stage: 'identity' } })) navigate('card');
      return;
    }
    if (state.card.stage !== 'active' || state.card.locked) { navigate('card'); return; }
    setDialog({ type: 'payment' });
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
    closeReserveMove();
    closeDialog();
    notify('처음 상태로 되돌렸어요.');
  }

  const account = state.account;
  if (!account || !state.signedIn) return <><Onboarding state={state} dispatch={dispatch} />{toastView}</>;

  const locked = state.card.locked && state.card.stage === 'active';
  const cardStatus = locked ? '잠금' : STAGE_NAMES[state.card.stage];
  const mainPage = MAIN_PAGES.includes(page as MainPage);
  const activeTab = mainPage ? page : trail.find((item) => MAIN_PAGES.includes(item as MainPage)) ?? 'home';
  const openRefund = (payment: Payment) => setDialog({ type: 'refund', payment });
  const setRewardsAuto = (enabled: boolean) => perform({ type: 'SET_REWARDS_AUTO', enabled }, enabled ? '결제할 때 리워드를 먼저 써요.' : '리워드를 결제에 쓰지 않아요.');
  const setReserveAuto = (enabled: boolean) => perform({ type: 'SET_RESERVE_AUTO', enabled }, enabled ? '잔액이 모자라면 리저브에서 채워요.' : '리저브는 결제에 쓰지 않아요.');

  return <div className={`app-shell page-${page}${mainPage ? '' : ' detail'}`}>
    <header className="app-header">
      <button type="button" className="brand" onClick={() => navigate('home')} aria-label="Aqua 홈"><Logo size={26} /><span className="demo-tag">체험판</span></button>
      <nav className="primary-nav bottom-nav" aria-label="주 메뉴">{MAIN_PAGES.map((key) => <button type="button" key={key} className={`nav-item${activeTab === key ? ' active' : ''}`} aria-current={activeTab === key ? 'page' : undefined} data-testid={`nav-${key}`} onClick={() => navigate(key)}><NavIcon name={key} /><span>{PAGE_TITLES[key]}</span></button>)}</nav>
      <p className="sidebar-note">체험판이에요. 잔액과 카드는 이&nbsp;브라우저에만 저장돼요.</p>
    </header>
    <main className="main-content">
      <header className="topbar">
        <div className="page-heading">
          {!mainPage && <button type="button" className="icon-button" aria-label="이전 화면" data-testid="go-back" onClick={goBack}><ChevronLeft size={26} /></button>}
          {page === 'home' && <span className="topbar-brand" aria-hidden="true"><Logo size={24} /><span className="demo-tag">체험판</span></span>}
          <h1>{PAGE_TITLES[page]}</h1>
        </div>
        <div className="topbar-actions">
          <button type="button" className="icon-button" aria-label="거래 내역" data-testid="nav-activity" onClick={() => navigate('activity')}><Clock3 size={22} /></button>
        </div>
      </header>

      {page === 'home' && <Home state={state} onDeposit={() => setFunding({ mode: 'deposit' })} onSend={() => setSending(true)} onCard={() => navigate('card')} onPay={startPayment}
        onReserve={() => navigate('reserve')} onRewards={() => navigate('benefits')} onActivity={() => navigate('activity')} onFunding={openFundingOperation} onRefund={openRefund} />}
      {page === 'card' && <div className="page card-page"><CardApplication card={state.card} account={account} spend={state.spend} controls={state.controls} onOpenLimits={() => navigate('limits')} onOpenChannels={() => navigate('channels')} onPay={startPayment}
        onChange={(card) => { perform({ type: 'SET_CARD', card }); }} onAction={(action, message) => perform(action, message) !== null} onDeposit={() => setFunding({ mode: 'deposit' })} onNotify={(message) => notify(message)} /></div>}
      {page === 'benefits' && <Benefits state={state} onReserve={() => navigate('reserve')} onRewardsAuto={setRewardsAuto} />}
      {page === 'reserve' && <Reserve state={state} onMove={setReserveMove} onAutoUse={setReserveAuto} />}
      {page === 'activity' && <ActivityPage state={state} filter={activityFilter} onFilter={setActivityFilter} onFunding={openFundingOperation} onDetail={setDetailItem} onRefund={openRefund} onStatement={() => navigate('statement')} />}
      {page === 'statement' && <Statement state={state} now={Date.now() + state.clockOffsetMs} />}
      {page === 'settings' && <Settings state={state} account={account} cardStatus={cardStatus} go={(target) => navigate(target as Page)} onRewardsAuto={setRewardsAuto} onReserveAuto={setReserveAuto}
        onReceive={() => setReceiving(true)} onPassword={() => setPasswordSheet(true)} onSignOut={() => perform({ type: 'SIGN_OUT' })} onClose={() => setClosingAccount(true)}
        onAdvanceDay={() => perform({ type: 'ADVANCE_DAY' }, '하루치 보상을 쌓았어요.')} onRate={(rate) => perform({ type: 'CHANGE_RATE', rate }, `리저브 기본 보상률을 연 ${percent(rate)}로 바꿨어요.`)} onReset={() => setDialog({ type: 'reset' })} />}
      {page === 'limits' && <LimitsPage state={state} onSave={(limits) => perform({ type: 'SET_LIMITS', ...limits }, '결제 한도를 바꿨어요.') !== null} />}
      {page === 'channels' && <ChannelsPage state={state} onChange={(channel, enabled) => perform({ type: 'SET_CHANNEL', channel, enabled }, `${channel === 'online' ? '온라인' : '해외'} 결제를 ${enabled ? '열었어요' : '막았어요'}.`)} />}
      {page === 'notifications' && <NotificationsPage state={state} onChange={(key, enabled) => perform({ type: 'SET_NOTIFICATION', key, enabled }, key === 'marketing' ? `혜택·이벤트 소식 수신에 ${enabled ? '동의했어요' : '동의를 철회했어요'}.` : undefined)} />}
      {page === 'faq' && <FaqPage />}
      {page === 'terms' && <TermsPage />}
    </main>
    {passwordSheet && <PasswordSheet email={account.email} onClose={() => setPasswordSheet(false)} onSubmit={(currentHash, nextHash) => perform({ type: 'CHANGE_PASSWORD', currentHash, nextHash }, '비밀번호를 바꿨어요.') !== null} />}
    {detailItem && <TransactionSheet item={detailItem} payment={detailItem.kind === 'payment' && detailItem.paymentId ? state.payments.find((item) => item.id === detailItem.paymentId) : undefined} card={state.card} status={statusOf(detailItem)?.[0] ?? null} onRefund={openRefund} onFunding={openFundingOperation} onClose={() => setDetailItem(null)} />}
    {closingAccount && <AccountClosureSheet state={state} onClose={() => setClosingAccount(false)} onDelete={(passwordHash) => perform({ type: 'DELETE_ACCOUNT', passwordHash }, '탈퇴했어요. 그동안 이용해 주셔서 고마워요.') !== null} />}
    {funding && <FundingDialog key={`${funding.mode}-${funding.symbol ?? 'default'}-${funding.operationId ?? 'new'}`} {...funding} account={account} state={state} onClose={closeFunding} dispatch={dispatch} />}
    {sending && <SendSheet state={state} onClose={() => setSending(false)} onWallet={() => { setSending(false); setFunding({ mode: 'withdraw' }); }} onReceive={() => { setSending(false); setReceiving(true); }} dispatch={dispatch} />}
    {receiving && <ReceiveSheet account={account} onClose={() => setReceiving(false)} dispatch={dispatch} notify={notify} />}
    {reserveMove && <InternalTransferDialog mode="reserve" direction={reserveMove} state={state} onClose={closeReserveMove} dispatch={dispatch} />}
    {dialog && <ActionDialog dialog={dialog} state={state} onClose={closeDialog} dispatch={dispatch} notify={notify} onPaid={confirmPayment} onReset={resetDemo} />}
    {receipts[0] && !dialog && !funding && !reserveMove && !sending && !receiving && <PaymentReceipt key={receipts[0].payment.id} receipt={receipts[0]} onClose={closeReceipt} />}
    {toastView}
  </div>;
}

function ActionDialog({ dialog, state, onClose, dispatch, notify, onPaid, onReset }: {
  dialog: Dialog; state: AppState; onClose: () => void; dispatch: (action: Action) => AppState;
  notify: (message: string, type?: Toast['type']) => void; onPaid: (id: string) => void; onReset: () => void;
}) {
  const [amount, setAmount] = useState(dialog.type === 'refund' ? String(dialog.payment.amount - dialog.payment.refunded) : '5800');
  const [merchant, setMerchant] = useState('한강커피');
  const [channel, setChannel] = useState<PaymentChannel>('store');
  const [error, setError] = useState('');
  const modalRef = useRef<HTMLDivElement>(null);
  const number = Number(amount);
  const validNumber = Number.isFinite(number) && number > 0;
  const source = sourcesFor(state, validNumber ? number : 0);
  const formId = 'aqua-action-form';
  const titles: Record<Dialog['type'], string> = { payment: '결제해 보기', refund: '환불', reset: '처음으로 되돌리기' };

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
    if (!validNumber) { setError('0보다 큰 금액을 넣어 주세요.'); return; }
    try {
      let action: Action;
      let message: string;
      switch (dialog.type) {
        case 'payment': action = { type: 'PAY', merchant, amount: number, channel }; message = '결제를 승인하고 있어요.'; break;
        case 'refund': action = { type: 'REFUND', id: dialog.payment.id, amount: number }; message = `${money(number)}을 환불했어요.`; break;
        default: return;
      }
      const next = dispatch(action);
      if (dialog.type === 'payment') { const payment = next.payments.find((item) => item.status === 'pending' && !state.payments.some((old) => old.id === item.id)); if (payment) onPaid(payment.id); }
      notify(message);
      onClose();
    } catch (issue) { setError(issue instanceof Error ? issue.message : '입력한 내용을 확인해 주세요.'); }
  }

  const buttonLabels: Record<Dialog['type'], string> = { payment: `${money(validNumber ? number : 0)} 결제`, refund: '환불하기', reset: '되돌리기' };

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="modal" ref={modalRef} role="dialog" aria-modal="true" aria-labelledby="dialog-title" data-testid={`dialog-${dialog.type}`}>
    <div className="modal-head"><h2 id="dialog-title">{titles[dialog.type]}</h2><button type="button" className="icon-button" onClick={onClose} aria-label="창 닫기"><X size={22} /></button></div>
    <div className="modal-body">
      {dialog.type === 'reset' ? <div><p className="reset-copy">잔액, 카드 신청, 거래 내역을 처음 상태로 돌려요.</p><p className="small-note">이 브라우저에 남은 체험 데이터가 지워져요.</p></div>
      : <form id={formId} onSubmit={submit}>
        {dialog.type === 'payment' && <><div className="payment-card-tag"><TierCard plan={state.card.plan} className="payment-card-thumb" /><span>{PLANS[state.card.plan].name}</span><span>끝번호 {state.card.last4}</span></div><div className="form-field"><label htmlFor="merchant">결제할 곳</label><input id="merchant" value={merchant} onChange={(event) => setMerchant(event.target.value)} required maxLength={40} autoComplete="off" /></div></>}
        {dialog.type === 'refund' && <div className="dialog-route"><strong>{dialog.payment.merchant}</strong><span>환불할 수 있는 금액 {money(dialog.payment.amount - dialog.payment.refunded)}</span></div>}
        <div className="form-field"><label htmlFor="action-amount">{dialog.type === 'refund' ? '환불할 금액' : '결제 금액'}</label><div className="input-affix"><AmountInput id="action-amount" unit="원" data-testid="action-amount" value={amount} onValueChange={(next) => { setAmount(next); setError(''); }} required aria-invalid={Boolean(error)} /></div></div>
        {dialog.type === 'payment' && <div className="preset-amounts" aria-label="예시 결제">{PAYMENT_PRESETS.map(([name, value, kind]) => <button type="button" key={name} onClick={() => { setMerchant(name); setAmount(String(value)); setChannel(kind); setError(''); }}><span>{name}</span><b>{won(value)}원</b></button>)}</div>}
        {dialog.type === 'payment' && <fieldset className="channel-choice"><legend>어디서 결제하나요</legend><div className="segmented">{CHANNELS.map(([key, label]) => <button type="button" key={key} className={channel === key ? 'selected' : ''} aria-pressed={channel === key} data-testid={`pay-channel-${key}`} onClick={() => { setChannel(key); setError(''); }}>{label}</button>)}</div>{channel !== 'store' && !state.controls[channel] && <p className="channel-blocked">{channel === 'online' ? '온라인' : '해외'} 결제를 막아 두었어요. 전체 › 온라인·해외 결제에서 열 수 있어요.</p>}</fieldset>}
        {dialog.type === 'payment' && <div className="payment-sources"><h3>이렇게 빠져요</h3>{source.rewards > 0 && <div className="source-row"><span>리워드</span><strong>{money(source.rewards)}</strong></div>}{source.spend > 0 && <div className="source-row"><span>잔액</span><strong>{money(source.spend)}</strong></div>}{source.reserve > 0 && <div className="source-row"><span>리저브</span><strong>{money(source.reserve)}</strong></div>}{source.shortfall > 0 && <div className="form-error">{money(source.shortfall)}이 모자라요. 충전하거나 리저브 결제를 켜 주세요.</div>}<div className="quote-total"><span>받을 페이백</span><strong>{money(source.cashback)}</strong></div><p className="small-note">리워드로 낸 금액은 페이백에서 빠지고, 결제가 확정되면 쌓여요.</p></div>}
        {dialog.type === 'refund' && <details className="rule-details"><summary>환불 기준</summary><p>낸 돈은 잔액으로, 쓴 리워드는 리워드로 돌려드려요. 받은 페이백은 환불한 만큼 줄고, 모자라면 다음에 쌓일 리워드에서 빼요.</p></details>}
        {error && <div className="form-error" role="alert">{error}</div>}
      </form>}
    </div>
    <div className="modal-footer"><button type="button" className="btn neutral" onClick={onClose}>취소</button><button className={`btn ${dialog.type === 'reset' ? 'danger' : 'primary'}`} type={dialog.type === 'reset' ? 'button' : 'submit'} form={dialog.type === 'reset' ? undefined : formId} data-testid="confirm-action" disabled={dialog.type === 'payment' && source.shortfall > 0} onClick={dialog.type === 'reset' ? onReset : undefined}>{buttonLabels[dialog.type]}</button></div>
  </div></div>;
}
