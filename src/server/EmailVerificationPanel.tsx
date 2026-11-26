import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { RefreshCw } from 'lucide-react';
import { ApiError, api, errorMessage, type EmailVerificationSnapshot } from './api';
import './EmailVerificationPanel.css';

function checkedSnapshot(value: EmailVerificationSnapshot, email: string): EmailVerificationSnapshot {
  if (!value || value.email !== email || typeof value.canRequest !== 'boolean'
    || !(value.verifiedAt === null || (Number.isSafeInteger(value.verifiedAt) && value.verifiedAt >= 0 && value.verifiedAt <= 8.64e15))) {
    throw new Error('Invalid email verification response.');
  }
  return value;
}

export default function EmailVerificationPanel({ ownerId, email, onVerified, onSessionExpired }: {
  ownerId: string;
  email: string;
  onVerified: () => void;
  onSessionExpired: () => void;
}) {
  const [snapshot, setSnapshot] = useState<EmailVerificationSnapshot | null>(null);
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'request' | 'confirm' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(true);
  const generation = useRef(0);
  const read = useRef<AbortController | null>(null);
  const flight = useRef<AbortController | null>(null);
  const lastVerified = useRef<boolean | null>(null);
  const callbacks = useRef({ onVerified, onSessionExpired });
  callbacks.current = { onVerified, onSessionExpired };
  const titleId = useId();
  const tokenId = useId();
  const helpId = useId();
  const errorId = useId();

  const handleError = useCallback((issue: unknown) => {
    if (issue instanceof ApiError && (issue.status === 401 || issue.code === 'SESSION_CHANGED')) callbacks.current.onSessionExpired();
    else setError(errorMessage(issue));
  }, []);

  const refresh = useCallback(async (preserveError = false) => {
    if (flight.current) return;
    read.current?.abort();
    const controller = new AbortController();
    const version = ++generation.current;
    read.current = controller;
    setLoading(true);
    try {
      const result = checkedSnapshot(await api.emailVerification(ownerId, controller.signal), email);
      if (!mounted.current || version !== generation.current) return;
      const wasVerified = lastVerified.current;
      lastVerified.current = result.verifiedAt !== null;
      setSnapshot(result);
      if (!preserveError || result.verifiedAt !== null) setError('');
      if (result.verifiedAt !== null) setToken('');
      if (wasVerified === false && result.verifiedAt !== null) callbacks.current.onVerified();
    } catch (issue) {
      if (mounted.current && version === generation.current && !controller.signal.aborted) handleError(issue);
    } finally {
      if (mounted.current && version === generation.current) setLoading(false);
      if (read.current === controller) read.current = null;
    }
  }, [ownerId, email, handleError]);

  useEffect(() => {
    mounted.current = true;
    lastVerified.current = null;
    setSnapshot(null); setToken(''); setNotice(''); setError('');
    void refresh();
    const foreground = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', foreground);
    document.addEventListener('visibilitychange', foreground);
    return () => {
      mounted.current = false; generation.current++;
      read.current?.abort(); flight.current?.abort();
      window.removeEventListener('focus', foreground);
      document.removeEventListener('visibilitychange', foreground);
    };
  }, [refresh]);

  async function mutate(action: 'request' | 'confirm') {
    if (flight.current || !snapshot || snapshot.verifiedAt !== null) return;
    const submittedToken = token.trim();
    if (action === 'confirm' && !/^[a-f0-9]{64}$/.test(submittedToken)) {
      setError('이메일에 있는 인증 코드를 그대로 붙여 넣어 주세요.'); return;
    }
    if (action === 'request' && !snapshot.canRequest) return;
    read.current?.abort(); read.current = null;
    const version = ++generation.current;
    const controller = new AbortController();
    flight.current = controller;
    setLoading(false); setBusy(action); setError(''); setNotice('');
    if (action === 'confirm') setToken('');
    try {
      const response = action === 'request'
        ? await api.requestEmailVerification(ownerId, controller.signal)
        : await api.confirmEmailVerification(submittedToken, ownerId, controller.signal);
      if (response.ok !== true) throw new Error('Invalid email verification acknowledgement.');
      if (!mounted.current || version !== generation.current) return;
      if (action === 'request') {
        setToken('');
        setNotice('인증 안내를 요청했습니다. 이메일이 도착하면 가장 최근에 요청한 인증 코드를 입력해 주세요.');
      } else {
        setNotice('이메일을 확인했습니다. 계정의 거래 상태를 다시 확인하고 있습니다.');
        lastVerified.current = true;
        callbacks.current.onVerified();
      }
    } catch (issue) {
      if (!mounted.current || version !== generation.current || controller.signal.aborted) return;
      if (issue instanceof ApiError && (issue.status === 401 || issue.code === 'SESSION_CHANGED')) callbacks.current.onSessionExpired();
      else if (issue instanceof ApiError && issue.status < 500) setError(issue.message);
      else setError(action === 'request'
        ? '요청 결과를 확인하지 못했습니다. 이메일이 도착했는지 확인한 뒤 다시 요청해 주세요.'
        : '확인 결과를 불러오지 못했습니다. 상태를 새로고침하거나 같은 코드를 다시 입력해 주세요.');
    } finally {
      if (flight.current === controller) flight.current = null;
      if (mounted.current && version === generation.current) {
        setBusy(null);
        // A response can be lost after a successful confirmation. Read the current proof.
        if (action === 'confirm') void refresh(true);
      }
    }
  }

  const verified = snapshot?.verifiedAt !== null && snapshot?.verifiedAt !== undefined;
  const submit = (event: FormEvent) => { event.preventDefault(); void mutate('confirm'); };
  return <section className="sa-email-panel" aria-labelledby={titleId} aria-busy={loading || busy !== null} data-testid="email-verification-panel"
    data-verified={snapshot ? String(verified) : 'loading'}>
    <div className="sa-section-heading"><div><h2 id={titleId}>이메일 확인</h2><p className="sa-email-address" data-testid="email-address">{email}</p></div>
      <button type="button" className="sa-icon-button" aria-label="이메일 확인 상태 새로고침" data-testid="email-refresh" disabled={loading || busy !== null} onClick={() => void refresh()}><RefreshCw size={18} /></button></div>
    {!snapshot ? <p className="sa-muted" role="status">{loading ? '이메일 확인 상태를 불러오고 있습니다.' : '상태를 불러오지 못했습니다. 다시 확인해 주세요.'}</p>
      : verified ? <div className="sa-email-confirmed" data-testid="email-verified"><strong>확인된 이메일입니다.</strong><p>이메일 확인과 거래 자격 심사는 별도로 진행됩니다.</p></div>
      : <><p className="sa-muted">가입한 이메일을 확인해 주세요. 이메일 확인 후에도 계정의 거래 제한이 해제되어야 새 거래를 할 수 있습니다.</p>
        <button type="button" className="sa-secondary sa-email-request" data-testid="email-request" disabled={busy !== null || loading || !snapshot.canRequest} onClick={() => void mutate('request')}>{busy === 'request' ? '요청 중' : '인증 이메일 요청'}</button>
        {!snapshot.canRequest && <p className="sa-field-help" role="status">지금은 인증 이메일을 요청할 수 없습니다. 이미 받은 코드는 아래에 입력할 수 있습니다.</p>}
        <form onSubmit={submit} className="sa-email-form">
          <div className="sa-field"><label htmlFor={tokenId}>인증 코드</label><input id={tokenId} type="text" data-testid="email-token" value={token}
            onChange={(event) => { setToken(event.target.value); setError(''); }} autoComplete="off" autoCapitalize="none" spellCheck={false}
            maxLength={128} required disabled={busy !== null || loading} aria-describedby={`${helpId}${error ? ` ${errorId}` : ''}`} />
            <p id={helpId} className="sa-field-help">가장 최근에 요청한 인증 코드로 확인해 주세요. 비밀번호 복구 코드는 사용할 수 없습니다.</p></div>
          <button className="sa-primary" type="submit" data-testid="email-confirm" disabled={busy !== null || loading || !token.trim()}>{busy === 'confirm' ? '확인 중' : '이메일 확인'}</button>
        </form></>}
    {error && <p id={errorId} className="sa-error" role="alert" data-testid="email-error">{error}</p>}
    {notice && <p className="sa-notice" role="status" data-testid="email-notice">{notice}</p>}
  </section>;
}
