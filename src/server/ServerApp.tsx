import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Copy, LogOut, RefreshCw, Send } from 'lucide-react';
import type { AccountSnapshot, MemberProfile } from '../../shared/api';
import Logo from '../components/Logo';
import AuthPanel from './AuthPanel';
import TransferDialog from './TransferDialog';
import CardPaymentsPanel from './CardPaymentsPanel';
import RewardsPanel from './RewardsPanel';
import { ApiError, api, errorMessage } from './api';
import { readPending, type PendingTransfer } from './pending';
import { clearRewardPreference, newRewardPreferenceKey, readRewardPreference, storeRewardPreference, type RewardPreferenceIntent } from './rewardPreference';
import './Server.css';

const money = (value: number) => `${value.toLocaleString('ko-KR')}원`;
const time = (value: number) => new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' }).format(value);

export default function ServerApp() {
  const [user, setUser] = useState<MemberProfile | null>(null);
  const [account, setAccount] = useState<AccountSnapshot | null>(null);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState('');
  const [authNotice, setAuthNotice] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [pending, setPending] = useState<PendingTransfer | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
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

  const invalidateReads = useCallback(() => {
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
    setAuthNotice('로그인이 만료되었습니다. 다시 로그인해 주세요.');
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
        const snapshot = await api.account(read.controller.signal);
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

  return <div className="sa-shell" data-testid="server-app"><header className="sa-header"><div className="sa-header-inner"><Logo size={29} /><span className="sa-environment">테스트 계정 · 실제 자금이 아니에요</span><div className="sa-header-actions">{user && <><span className="sa-header-name">{user.name}님</span><button className="sa-icon-button" aria-label="로그아웃" data-testid="server-logout" disabled={loggingOut} onClick={() => void logout()}><LogOut size={19} /></button></>}</div></div></header><main className="sa-main">
    {booting ? <div className="sa-loading" role="status">계정을 확인하고 있습니다.</div> : bootError ? <section className="sa-connection-error"><h1>연결을 확인해 주세요.</h1><p role="alert">{bootError}</p><button className="sa-primary" onClick={() => location.reload()}>다시 연결</button></section> : !user ? <AuthPanel onAuthenticated={authenticate} notice={authNotice} /> : <div className="sa-dashboard">
      <section className="sa-balance-panel"><div className="sa-balance-heading"><h1>사용 가능한 잔액</h1><button className="sa-icon-button" aria-label="잔액 새로고침" data-testid="server-refresh" disabled={refreshing} onClick={() => void loadAccount()}><RefreshCw size={18} /></button></div><strong className="sa-balance-number" data-testid="server-balance">{account ? money(account.balanceWon) : '불러오는 중'}</strong><p>결제대기와 카드 전용 리워드는 포함하지 않은 원금이에요.</p><dl className="sa-balance-breakdown" aria-label="잔액 구분"><div><dt>결제대기 <span>원금에서 확보한 금액</span></dt><dd data-testid="server-held-balance">{typeof account?.heldBalanceWon === 'number' ? money(account.heldBalanceWon) : '확인 중'}</dd></div><div><dt>원금 합계</dt><dd data-testid="server-total-balance">{typeof account?.totalBalanceWon === 'number' ? money(account.totalBalanceWon) : '확인 중'}</dd></div></dl><div className="sa-balance-actions"><button className="sa-primary" data-testid="server-send" disabled={!account || Boolean(pending) || account.limits.available < 1000 || account.balanceWon < 1000} onClick={() => setTransferOpen(true)}><Send size={18} />보내기</button>{pending && <button className="sa-secondary" data-testid="server-resume-transfer" onClick={() => setTransferOpen(true)}>이전 송금 결과 확인</button>}</div>{pending && <p className="sa-balance-warning">결과를 확인 중인 송금이 있습니다. 확인 후 새 송금을 진행할 수 있습니다.</p>}</section>
      <section className="sa-profile-panel"><h2>내 Aqua 태그</h2><div className="sa-profile-info"><span className="sa-person-avatar">{user.name.slice(0, 1)}</span><div><strong>{user.name}</strong><span>{user.email}</span></div></div><div className="sa-tag"><strong data-testid="server-tag">@{user.tag}</strong><button className="sa-icon-button" aria-label="Aqua 태그 복사" onClick={() => void copyTag()}><Copy size={18} /></button></div><p>상대방에게 태그를 알려주면 송금을 받을 수 있습니다.</p></section>
      {(error || notice) && <p className={error ? 'sa-error sa-dashboard-message' : 'sa-notice sa-dashboard-message'} role={error ? 'alert' : 'status'}>{error || notice}</p>}
      <RewardsPanel rewards={account?.rewards ?? null} saving={preferenceSaving || preferenceConfirming} unresolved={preferenceIntent !== null} message={preferenceMessage} error={preferenceError} onUseFirstChange={changeRewardPriority} onRetry={retryRewardPreference} />
      <section className="sa-transactions"><div className="sa-section-heading"><div><h2>거래 내역</h2><p>받은 송금은 자동으로 갱신됩니다.</p></div><span>{account?.transactions.length ?? 0}건</span></div>{!account ? <div className="sa-empty-state">내역을 불러오고 있습니다.</div> : !account.transactions.length ? <div className="sa-empty-state"><p>아직 거래 내역이 없습니다.</p></div> : <div className="sa-transaction-list" data-testid="server-transactions">{account.transactions.map((transaction) => {
        const sent = transaction.direction === 'sent';
        return <div className="sa-transaction-row" key={transaction.id} data-testid={`server-transaction-${transaction.id}`} data-direction={transaction.direction}><span className={`sa-transaction-icon${sent ? ' sent' : ''}`}>{sent ? <ArrowUpRight size={20} /> : <ArrowDownLeft size={20} />}</span><div className="sa-transaction-copy"><strong>{transaction.counterpartyName || (transaction.direction === 'funded' ? '테스트 잔액 반영' : 'Aqua 회원')}</strong><span>{time(transaction.createdAt)} · {sent ? '보냄' : transaction.direction === 'received' ? '받음' : '테스트 잔액'}{transaction.counterpartyTag ? ` · @${transaction.counterpartyTag}` : ''}</span></div><strong className={`sa-transaction-amount${sent ? '' : ' received'}`}>{sent ? '−' : '+'}{money(transaction.amountWon)}</strong></div>;
      })}</div>}</section><CardPaymentsPanel payments={account?.cardPayments ?? null} /><p className="sa-service-note">입금·출금과 실제 카드 발급·결제망은 아직 연결되지 않았어요.</p>
    </div>}
  </main>{transferOpen && account && user && <TransferDialog key={user.id} account={account} pending={pending} onIntentChange={changeIntent} onRefresh={() => userRef.current?.id === account.user.id ? loadAccount() : Promise.resolve()} onUnauthorized={() => { if (userRef.current?.id === account.user.id) expired(); }} onClose={closeTransfer} />}</div>;
}
