import FundingPanel from './FundingPanel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, ArrowDownUp, ChevronDown, ChevronRight, Copy, CreditCard, List, LogOut, RefreshCw, Send, UserRound } from 'lucide-react';
import type { AccountSnapshot, MemberProfile } from '../../shared/api';
import Logo from '../components/Logo';
import AuthPanel from './AuthPanel';
import TransferDialog from './TransferDialog';
import ActivityPages from './ActivityPages';
import CardPaymentsPanel from './CardPaymentsPanel';
import CardDeclinesPanel from './CardDeclinesPanel';
import IssuerCardPanel from './IssuerCardPanel';
import ReservePanel from './ReservePanel';
import RewardsPanel, { RewardControls } from './RewardsPanel';
import CustomerAccessPanel from './CustomerAccessPanel';
import SessionSecurityPanel from './SessionSecurityPanel';
import EmailVerificationPanel from './EmailVerificationPanel';
import { ApiError, api, errorMessage } from './api';
import { readPending, type PendingTransfer } from './pending';
import { clearRewardPreference, newRewardPreferenceKey, readRewardPreference, storeRewardPreference, type RewardPreferenceIntent } from './rewardPreference';
import './Server.css';
import './Dashboard.css';

const money = (value: number) => `${value.toLocaleString('ko-KR')}원`;
const time = (value: number) => new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' }).format(value);

const destinations = [
  { id: 'home', name: '카드 홈', icon: CreditCard },
  { id: 'history', name: '이용 내역', icon: List },
  { id: 'account', name: '내 계정', icon: UserRound },
] as const;
type Screen = typeof destinations[number]['id'];

function requestedScreen(): Screen {
  return destinations.find(({ id }) => location.hash === `#${id}`)?.id ?? 'home';
}

export default function ServerApp() {
  const [user, setUser] = useState<MemberProfile | null>(null);
  const [account, setAccount] = useState<AccountSnapshot | null>(null);
  const [screen, setScreen] = useState<Screen>(requestedScreen);
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const pageHeading = useRef<HTMLHeadingElement>(null);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState('');
  const [authNotice, setAuthNotice] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [pending, setPending] = useState<PendingTransfer | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [fundingOpen, setFundingOpen] = useState(false);
  const [reserveOpen, setReserveOpen] = useState(false);
  const fundingTrigger = useRef<HTMLButtonElement>(null);

  const [preferenceIntent, setPreferenceIntent] = useState<RewardPreferenceIntent | null>(null);
  const [preferenceSaving, setPreferenceSaving] = useState(false);
  const [preferenceConfirming, setPreferenceConfirming] = useState(false);
  const [preferenceMessage, setPreferenceMessage] = useState('');
  const [preferenceError, setPreferenceError] = useState('');
  const userRef = useRef<MemberProfile | null>(null);
  const requestVersion = useRef(0);
  const active = useRef(true);
  const accountRead = useRef<{ controller: AbortController; ownerId: string; promise: Promise<void>; sequence: number } | null>(null);
  const refreshQueued = useRef(false);
  const readSequence = useRef(0);
  const preferenceIntentRef = useRef<RewardPreferenceIntent | null>(null);
  const preferenceFlight = useRef<{ ownerId: string; generation: number; key: string } | null>(null);
  const preferenceAwaiting = useRef<{ ownerId: string; generation: number; minSequence: number } | null>(null);

  useEffect(() => {
    const navigate = () => {
      setScreen(requestedScreen());
      setFundingOpen(false); setReserveOpen(false);
      setNotice('');
      window.scrollTo(0, 0);
      requestAnimationFrame(() => pageHeading.current?.focus({ preventScroll: true }));
    };
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, []);

  const invalidateReads = useCallback(() => {
    setFundingOpen(false); setReserveOpen(false);
    requestVersion.current++;
    refreshQueued.current = false;
    const previous = accountRead.current;
    accountRead.current = null;
    previous?.controller.abort();
    setRefreshing(false);
    preferenceIntentRef.current = null;
    preferenceFlight.current = null;
    preferenceAwaiting.current = null;
    setPreferenceIntent(null); setPreferenceSaving(false); setPreferenceConfirming(false);
    setPreferenceMessage(''); setPreferenceError('');
  }, []);

  const expired = useCallback(() => {
    userRef.current = null; invalidateReads();
    setUser(null); setAccount(null); setPending(null); setTransferOpen(false);
    setAuthNotice('로그인이 종료되었습니다. 다시 로그인해 주세요.');
  }, [invalidateReads]);

  const loadAccount = useCallback(async (queueIfBusy = true): Promise<void> => {
    const owner = userRef.current;
    if (!owner) return;
    const current = accountRead.current;
    if (current && current.ownerId === owner.id) {
      if (queueIfBusy) refreshQueued.current = true;
      return current.promise;
    }
    const version = requestVersion.current;
    const read = { controller: new AbortController(), ownerId: owner.id, promise: Promise.resolve(), sequence: ++readSequence.current };
    accountRead.current = read;
    setRefreshing(true);
    read.promise = (async () => {
      try {
        const snapshot = await api.account(read.controller.signal, screenRef.current !== 'history');
        if (!active.current || userRef.current?.id !== owner.id || version !== requestVersion.current) return;
        if (snapshot.user.id !== owner.id) { expired(); return; }
        setAccount(snapshot); setError('');
        const awaiting = preferenceAwaiting.current;
        if (awaiting && awaiting.ownerId === owner.id && awaiting.generation === version && read.sequence >= awaiting.minSequence) {
          preferenceAwaiting.current = null;
          setPreferenceConfirming(false);
          if (preferenceIntentRef.current === null) setPreferenceMessage('현재 설정을 확인했어요.');
        }
      } catch (issue) {
        if (!active.current || userRef.current?.id !== owner.id || version !== requestVersion.current || read.controller.signal.aborted) return;
        if (issue instanceof ApiError && issue.status === 401) expired();
        else setError(errorMessage(issue));
      } finally {
        if (accountRead.current !== read) return;
        accountRead.current = null;
        const again = refreshQueued.current;
        refreshQueued.current = false;
        if (active.current && userRef.current?.id === owner.id && version === requestVersion.current) {
          if (again) void loadAccount();
          else setRefreshing(false);
        }
      }
    })();
    return read.promise;
  }, [expired]);

  useEffect(() => {
    if (screen === 'history' && userRef.current) void loadAccount();
  }, [screen, loadAccount]);

  const authenticate = useCallback((profile: MemberProfile) => {
    invalidateReads(); userRef.current = profile;
    setUser(profile); setAccount(null); setAuthNotice(''); setError(''); setNotice('');
    const saved = readPending(profile.id);
    setPending(saved); setTransferOpen(Boolean(saved));
    const savedPreference = readRewardPreference(profile.id);
    preferenceIntentRef.current = savedPreference;
    setPreferenceIntent(savedPreference);
    if (savedPreference) setPreferenceMessage('이전 설정 요청의 결과를 확인해 주세요. 같은 요청으로 다시 확인할 수 있어요.');
  }, [invalidateReads]);

  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    let mounted = true;
    api.session(controller.signal).then(({ user: profile }) => { if (mounted && profile) authenticate(profile); }).catch((issue) => { if (mounted && !(issue instanceof DOMException && issue.name === 'AbortError')) setBootError(errorMessage(issue)); }).finally(() => { if (mounted) setBooting(false); });
    return () => { mounted = false; active.current = false; controller.abort(); accountRead.current?.controller.abort(); };
  }, [authenticate]);

  useEffect(() => {
    if (!user) return;
    void loadAccount();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void loadAccount(false); }, 5_000);
    const foreground = () => { if (document.visibilityState === 'visible') void loadAccount(); };
    window.addEventListener('focus', foreground);
    document.addEventListener('visibilitychange', foreground);
    return () => { clearInterval(timer); window.removeEventListener('focus', foreground); document.removeEventListener('visibilitychange', foreground); };
  }, [user?.id, loadAccount]);

  const changeIntent = useCallback((ownerId: string, intent: PendingTransfer | null) => { if (userRef.current?.id === ownerId) setPending(intent); }, []);
  const closeTransfer = useCallback(() => setTransferOpen(false), []);

  async function submitRewardPreference(intent: RewardPreferenceIntent) {
    const owner = userRef.current;
    if (!owner || preferenceFlight.current) return;
    try { storeRewardPreference(owner.id, intent); }
    catch { setPreferenceError('설정 요청을 이 브라우저에 보관할 수 없어요. 저장 공간 설정을 확인한 뒤 다시 시도해 주세요.'); return; }
    const flight = { ownerId: owner.id, generation: requestVersion.current, key: intent.key };
    preferenceFlight.current = flight;
    const isCurrent = () => active.current && userRef.current?.id === flight.ownerId && requestVersion.current === flight.generation;
    const refreshPreference = () => {
      preferenceAwaiting.current = { ownerId: flight.ownerId, generation: flight.generation, minSequence: readSequence.current + 1 };
      setPreferenceConfirming(true);
      void loadAccount();
    };
    setPreferenceSaving(true); setPreferenceError(''); setPreferenceMessage('');
    try {
      const result = await api.rewardPreference({ useFirst: intent.useFirst, expectedVersion: intent.expectedVersion }, intent.key, flight.ownerId);
      if (typeof result.useFirst !== 'boolean' || result.useFirst !== intent.useFirst || !Number.isSafeInteger(result.version) || result.version < intent.expectedVersion) throw new Error('Unexpected preference response.');
      clearRewardPreference(flight.ownerId, intent.key);
      if (!isCurrent()) return;
      preferenceIntentRef.current = null; setPreferenceIntent(null);
      setPreferenceMessage('서버에 설정을 반영했어요. 현재 값을 확인하고 있어요.');
      refreshPreference();
    } catch (issue) {
      if (issue instanceof ApiError && issue.status === 409 && issue.code === 'PREFERENCE_CHANGED') {
        clearRewardPreference(flight.ownerId, intent.key);
        if (!isCurrent()) return;
        preferenceIntentRef.current = null; setPreferenceIntent(null);
        setPreferenceError('다른 화면에서 설정이 바뀌었어요. 최신 설정을 확인한 뒤 다시 선택해 주세요.');
        refreshPreference();
      } else {
        if (!isCurrent()) return;
        if (issue instanceof ApiError && (issue.status === 401 || issue.code === 'SESSION_CHANGED')) { expired(); return; }
        setPreferenceError(issue instanceof ApiError && issue.status === 429 ? issue.message : '설정 요청의 결과를 확인하지 못했어요. 같은 요청으로 다시 확인해 주세요.');
      }
    } finally {
      if (preferenceFlight.current === flight) {
        preferenceFlight.current = null;
        if (isCurrent()) setPreferenceSaving(false);
      }
    }
  }

  function changeRewardPriority(useFirst: boolean) {
    const owner = userRef.current;
    if (!owner || !account?.rewards || account.user.id !== owner.id || preferenceIntentRef.current || preferenceFlight.current || preferenceAwaiting.current || account.rewards.useFirst === useFirst) return;
    const intent: RewardPreferenceIntent = { key: newRewardPreferenceKey(), useFirst, expectedVersion: account.rewards.preferenceVersion, createdAt: Date.now() };
    try { storeRewardPreference(owner.id, intent); }
    catch { setPreferenceError('설정 요청을 이 브라우저에 보관할 수 없어요. 저장 공간 설정을 확인한 뒤 다시 시도해 주세요.'); return; }
    preferenceIntentRef.current = intent; setPreferenceIntent(intent);
    void submitRewardPreference(intent);
  }

  function retryRewardPreference() {
    if (preferenceIntentRef.current) void submitRewardPreference(preferenceIntentRef.current);
  }

  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true); setError('');
    try {
      const owner = userRef.current;
      if (!owner) return;
      await api.logout(owner.id); userRef.current = null; invalidateReads();
      setUser(null); setAccount(null); setPending(null); setTransferOpen(false); setNotice(''); setAuthNotice('');
    } catch (issue) {
      if (issue instanceof ApiError && (issue.status === 401 || issue.code === 'SESSION_CHANGED')) expired();
      else setError(errorMessage(issue));
    } finally { setLoggingOut(false); }
  }
  async function copyTag() {
    if (!user) return;
    try { await navigator.clipboard.writeText(`@${user.tag}`); setNotice('Aqua 태그를 복사했습니다.'); }
    catch { setNotice('복사하지 못했습니다. 태그를 직접 선택해 주세요.'); }
  }

  const ownerExpired = () => { if (user && userRef.current?.id === user.id) expired(); };
  const activePage = destinations.find(({ id }) => id === screen)!;
  const openCashback = () => {
    const heading = document.getElementById('cashback-heading');
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView({ block: 'start' });
  };
  const verified = account?.user.emailVerifiedAt != null;
  const signedIn = (profile: MemberProfile) => {
    history.replaceState(history.state, '', location.pathname + location.search);
    setScreen('home');
    authenticate(profile);
  };

  return <div className={`sa-shell${user ? ' sa-signed-in' : ''}`} data-testid="server-app">
    <header className="sa-header"><div className="sa-header-inner">
      <Logo size={27} />
      {user && <nav className="sa-navigation" aria-label="주 메뉴">
        {destinations.map(({ id, name, icon: Icon }) => <a key={id} href={`#${id}`}
          aria-current={screen === id ? 'page' : undefined} data-testid={`dashboard-${id}`}>
          <Icon size={18} aria-hidden="true" />{name}
        </a>)}
      </nav>}
      <div className="sa-header-actions">
        <span className="sa-environment">테스트 계정</span>
        {user && <button className="sa-icon-button" aria-label="로그아웃" data-testid="server-logout" disabled={loggingOut}
          onClick={() => void logout()}><LogOut size={18} /></button>}
      </div>
    </div></header>
    <main className="sa-main">
      {booting ? <div className="sa-loading" role="status">계정을 확인하고 있습니다.</div>
        : bootError ? <section className="sa-connection-error">
          <h1>연결을 확인해 주세요.</h1><p role="alert">{bootError}</p>
          <button className="sa-primary" onClick={() => location.reload()}>다시 연결</button>
        </section>
        : !user ? <AuthPanel onAuthenticated={signedIn} notice={authNotice} />
        : <div className={`sa-dashboard sa-page-${screen}`}>
          <h1 ref={pageHeading} tabIndex={-1} className="sa-page-heading">{activePage.name}
            {screen === 'account' && <span className="sa-owner-line">{user.name} · @{user.tag}</span>}
          </h1>
          {error && <p className="sa-error sa-dashboard-message" role="alert">{error}</p>}
          {/* Keep the card request and its confirmation alive when navigating between pages. */}
          <div className="sa-card-slot" hidden={screen !== 'home'}>
            <IssuerCardPanel key={user.id} ownerId={user.id} visible={screen === 'home'} access={account?.access ?? null} onSessionExpired={ownerExpired} />
          </div>
          {screen === 'home' && <section className="sa-balance-panel" aria-labelledby="wallet-title">
            <div className="sa-balance-heading"><h2 id="wallet-title">지갑 잔액</h2>
              <button className="sa-icon-button" aria-label="잔액 새로고침" data-testid="server-refresh" disabled={refreshing}
                onClick={() => void loadAccount()}><RefreshCw size={16} /></button>
            </div>
            <strong className="sa-balance-number" data-testid="server-balance">{account ? money(account.balanceWon) : '확인 중'}</strong>
            <div className="sa-wallet-actions">
              <button className="sa-primary" data-testid="server-send" disabled={!account?.access?.canTransact || Boolean(pending) || account.limits.available < 1000 || account.balanceWon < 1000}
                onClick={() => setTransferOpen(true)}><Send size={17} aria-hidden="true" />송금하기</button>
              <button ref={fundingTrigger} className="sa-secondary" type="button" aria-label="코인 입출금 보기" aria-expanded={fundingOpen} aria-controls="funding-content"
                onClick={() => setFundingOpen(open => !open)}><ArrowDownUp size={17} aria-hidden="true" />코인 입출금</button>
            </div>
            {pending && <button className="sa-secondary" data-testid="server-resume-transfer" onClick={() => setTransferOpen(true)}>이전 송금 열기</button>}
            <div className="sa-wallet-links">
              <button type="button" aria-label="리저브 잔액과 관리" onClick={() => {
                setReserveOpen(true);
                requestAnimationFrame(() => { const target = document.getElementById('reserve-management-toggle'); target?.focus({ preventScroll:true }); target?.scrollIntoView({block:'start'}); });
              }}><span>리저브<ChevronRight size={14} aria-hidden="true" /></span><strong>{account?.reserve ? money(account.reserve.availableWon) : '확인 중'}</strong></button>
              <button type="button" className="sa-payback-shortcut" onClick={openCashback}
                aria-label={`이번 달 확정 페이백 ${account?.rewards ? money(account.rewards.cashback.confirmedWon) : '확인 중'} 상세 보기`}>
                <span>이번 달 확정 페이백<ChevronRight size={14} aria-hidden="true" /></span><strong>{account?.rewards ? money(account.rewards.cashback.confirmedWon) : '확인 중'}</strong>
              </button>
            </div>
            <details className="sa-wallet-held"><summary><span>결제 대기 원금</span><b data-testid="server-held-balance">{account ? money(account.heldBalanceWon) : '확인 중'}</b><ChevronDown size={14} aria-hidden="true" /></summary>
              <div><span>지갑과 결제 대기 원금 합계</span><b data-testid="server-total-balance">{account ? money(account.totalBalanceWon) : '확인 중'}</b></div>
            </details>
            <div className="sa-wallet-tag"><span>송금받을 태그</span><button aria-label="Aqua 태그 복사" onClick={() => void copyTag()}><strong data-testid="server-tag">@{user.tag}</strong><Copy size={15} aria-hidden="true" /></button></div>
            {notice && <p role="status">{notice}</p>}
          </section>}
          {screen !== 'history' && <CustomerAccessPanel access={account?.access ?? null}
            showEmailLink={screen === 'home' && !!account && !verified} />}
          {screen === 'home' && <FundingPanel key={'funding:' + user.id} owner={user.id} open={fundingOpen} onClose={() => {
            setFundingOpen(false); requestAnimationFrame(() => fundingTrigger.current?.focus());
          }} enabled={Boolean(account?.access?.canTransact && verified)} onRefresh={() => void loadAccount()} />}
          {screen === 'home' && <ReservePanel key={'reserve:' + user.id} owner={user.id} reserve={account?.reserve} walletWon={account?.balanceWon} manageOpen={reserveOpen} onManage={setReserveOpen}
            useFirst={account?.rewards.useFirst ?? false} rewardControls={<RewardControls rewards={account?.rewards ?? null} saving={preferenceSaving || preferenceConfirming}
            unresolved={preferenceIntent !== null} message={preferenceMessage} error={preferenceError}
            onUseFirstChange={changeRewardPriority} onRetry={retryRewardPreference} />}
            canTransact={account?.access.canTransact ?? false} refresh={() => void loadAccount()} />}
          {screen === 'home' && <RewardsPanel key={'rewards:' + user.id} owner={user.id} rewards={account?.rewards ?? null} />}
          {screen === 'history' && <>
            <ActivityPages key={user.id + ':cards:' + account?.historyCursors?.cards}
              first={account?.historyCursors ? account.cardPayments : null} cursor={account?.historyCursors?.cards ?? null} owner={user.id} fetchPage={api.cardHistory}>
              {records => <CardPaymentsPanel payments={records} />}
            </ActivityPages>
            <ActivityPages key={user.id + ':declines:' + account?.historyCursors?.declines}
              first={account?.cardDeclines ?? null} cursor={account?.historyCursors?.declines ?? null} owner={user.id} fetchPage={api.declineHistory}>
              {records => <CardDeclinesPanel records={records} />}
            </ActivityPages>
            <ActivityPages key={user.id + ':transfers:' + account?.historyCursors?.transfers}
              first={account?.historyCursors ? account.transactions : null} cursor={account?.historyCursors?.transfers ?? null} owner={user.id} fetchPage={api.transferHistory}>
            {transactions =>
            <section className="sa-transactions" aria-labelledby="transfer-history-heading">
              <div className="sa-section-heading">
                <h2 id="transfer-history-heading">송금과 충전</h2>
                <span>{transactions ? `${transactions.length}건` : '확인 중'}</span>
              </div>
              {!transactions ? <div className="sa-empty-state">내역을 불러오고 있습니다.</div>
                : !transactions.length ? <div className="sa-empty-state">송금이나 충전 내역이 생기면 여기에 표시됩니다.</div>
                : <div className="sa-transaction-list" data-testid="server-transactions">
                  {transactions.map((transaction) => {
                    const sent = transaction.direction === 'sent';
                    const funded = transaction.direction === 'funded';
                    const name = transaction.counterpartyName || (funded ? '테스트 잔액 반영' : 'Aqua 회원');
                    const direction = funded ? '테스트 잔액' : sent ? '보냄' : '받음';
                    const Icon = sent ? ArrowUpRight : ArrowDownLeft;
                    return <div className="sa-transaction-row" key={transaction.id}
                      data-testid={`server-transaction-${transaction.id}`} data-direction={transaction.direction}>
                      <span className={`sa-transaction-icon${sent ? ' sent' : ''}`}><Icon size={20} aria-hidden="true" /></span>
                      <div className="sa-transaction-copy"><strong>{name}</strong>
                        <span>{time(transaction.createdAt)} · {direction}{transaction.counterpartyTag && ` · @${transaction.counterpartyTag}`}</span>
                      </div>
                      <strong className={`sa-transaction-amount${sent ? '' : ' received'}`}>{sent ? '−' : '+'}{money(transaction.amountWon)}</strong>
                    </div>;
                  })}
                </div>}
            </section>}
            </ActivityPages>
          </>}
          {screen === 'account' && <>
            <EmailVerificationPanel key={`email:${user.id}`} ownerId={user.id} email={user.email}
              onVerified={() => { if (userRef.current?.id === user.id) void loadAccount(); }} onSessionExpired={ownerExpired} />
            <SessionSecurityPanel key={`security:${user.id}`} ownerId={user.id} onSessionExpired={ownerExpired} />
          </>}
        </div>}
    </main>
    {transferOpen && account && user && <TransferDialog key={user.id} account={account} pending={pending}
      onIntentChange={changeIntent} onRefresh={() => userRef.current?.id === account.user.id ? loadAccount() : Promise.resolve()}
      onUnauthorized={ownerExpired} onClose={closeTransfer} />}
  </div>;
}
