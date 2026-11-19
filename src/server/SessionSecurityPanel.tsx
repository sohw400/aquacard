import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Monitor, RefreshCw, X } from 'lucide-react';
import type { AuthSessionRecord, SessionSecuritySnapshot } from '../../shared/api';
import { useModal } from '../components/useModal';
import { ApiError, api, errorMessage } from './api';
import './SessionSecurityPanel.css';

type Target = { kind: 'one'; session: AuthSessionRecord } | { kind: 'others' };

const dateTime = (timestamp: number) => new Intl.DateTimeFormat('ko-KR', {
  year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul',
}).format(timestamp);

function checkedSnapshot(value: SessionSecuritySnapshot): SessionSecuritySnapshot {
  const validTime = (time: unknown) => typeof time === 'number' && Number.isSafeInteger(time) && time >= 0 && time <= 8.64e15;
  if (!value || !Array.isArray(value.sessions) || value.sessions.length === 0
    || value.sessions.filter((session) => session.current === true).length !== 1
    || new Set(value.sessions.map((session) => session.id)).size !== value.sessions.length
    || (value.reauthenticatedUntil !== null && !validTime(value.reauthenticatedUntil))
    || value.sessions.some((session) => !session || typeof session.id !== 'string' || !session.id
      || typeof session.deviceLabel !== 'string' || !session.deviceLabel || typeof session.current !== 'boolean'
      || !validTime(session.createdAt) || !validTime(session.lastSeenAt) || !validTime(session.expiresAt))) {
    throw new Error('Invalid session list.');
  }
  return value;
}

function RevokeConfirmation({ target, ownerId, reauthenticatedUntil, onClose, onComplete, onExpired }: {
  target: Target;
  ownerId: string;
  reauthenticatedUntil: number | null;
  onClose: () => void;
  onComplete: (notice: string) => void;
  onExpired: () => void;
}) {
  const [password, setPassword] = useState('');
  const [needsPassword, setNeedsPassword] = useState(!reauthenticatedUntil || reauthenticatedUntil <= Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const panel = useRef<HTMLDivElement>(null);
  const initialFocus = useRef<HTMLButtonElement>(null);
  const flight = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const headingId = useId();
  const descriptionId = useId();
  const passwordId = useId();
  const errorId = useId();
  const close = useCallback(() => { if (!flight.current) onClose(); }, [onClose]);
  useModal(panel, close, initialFocus);

  useEffect(() => {
    mounted.current = true;
    const shell = document.querySelector<HTMLElement>('.sa-shell');
    const previous = shell?.inert;
    if (shell) shell.inert = true;
    return () => {
      mounted.current = false;
      flight.current?.abort();
      if (shell) shell.inert = previous ?? false;
    };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (flight.current || (needsPassword && !password)) return;
    const request = new AbortController();
    flight.current = request;
    const submittedPassword = password;
    setPassword(''); setBusy(true); setError('');
    let authenticating = needsPassword;
    try {
      if (needsPassword) {
        const result = await api.reauthenticate(submittedPassword, ownerId, request.signal);
        if (!Number.isSafeInteger(result.reauthenticatedUntil) || result.reauthenticatedUntil < 0) throw new Error('Invalid authentication response.');
        authenticating = false;
      }
      if (!mounted.current) return;
      if (target.kind === 'one') {
        const result = await api.revokeSession(target.session.id, ownerId, request.signal);
        if (typeof result.revokedCurrent !== 'boolean') throw new Error('Invalid revocation response.');
        if (!mounted.current) return;
        if (result.revokedCurrent) { onExpired(); return; }
        onComplete('선택한 기기의 로그인을 해제했습니다.');
      } else {
        const result = await api.revokeOtherSessions(ownerId, request.signal);
        if (!Number.isSafeInteger(result.revokedCount) || result.revokedCount < 0) throw new Error('Invalid revocation response.');
        if (!mounted.current) return;
        onComplete(result.revokedCount ? '다른 기기의 로그인을 모두 해제했습니다.' : '다른 기기에 남아 있는 로그인이 없습니다.');
      }
    } catch (issue) {
      if (!mounted.current || request.signal.aborted) return;
      if (issue instanceof ApiError && authenticating && issue.code === 'INVALID_PASSWORD') {
        setNeedsPassword(true); setError(issue.message);
      } else if (issue instanceof ApiError && (issue.code === 'SESSION_CHANGED' || issue.status === 401)) {
        onExpired();
      } else if (issue instanceof ApiError && issue.code === 'REAUTHENTICATION_REQUIRED') {
        setNeedsPassword(true); setError('비밀번호를 확인한 뒤 다시 진행해 주세요.');
      } else if (issue instanceof ApiError && issue.code === 'SESSION_NOT_FOUND') {
        onComplete('선택한 로그인은 이미 종료되었습니다.');
      } else {
        setError(issue instanceof ApiError && issue.status < 500 ? issue.message
          : '처리 결과를 확인하지 못했습니다. 다시 시도하거나 창을 닫고 로그인 목록을 새로고침해 주세요.');
      }
    } finally {
      if (flight.current === request) flight.current = null;
      if (mounted.current) setBusy(false);
    }
  }

  const title = target.kind === 'others' ? '다른 기기를 모두 로그아웃할까요?' : target.session.current ? '이 기기를 로그아웃할까요?' : '선택한 기기를 로그아웃할까요?';
  return createPortal(<div className="sa-security-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div ref={panel} className="sa-security-dialog" role="dialog" aria-modal="true" aria-labelledby={headingId} aria-describedby={descriptionId}
      tabIndex={-1} data-testid="security-revoke-dialog" aria-busy={busy}>
      <button className="sa-security-close" type="button" aria-label="로그아웃 확인 창 닫기" disabled={busy} onClick={close}><X size={20} /></button>
      <h2 id={headingId}>{title}</h2>
      <p id={descriptionId}>{target.kind === 'others' ? '지금 사용 중인 기기는 유지됩니다. 다른 기기에서는 다시 로그인해야 합니다.'
        : `${target.session.deviceLabel}에서 다시 사용하려면 로그인이 필요합니다.`}</p>
      <form onSubmit={(event) => void submit(event)}>
        {needsPassword && <div className="sa-security-field"><label htmlFor={passwordId}>현재 비밀번호</label>
          <input id={passwordId} data-testid="security-password" type="password" autoComplete="current-password" value={password}
            maxLength={128} disabled={busy} required aria-describedby={error ? errorId : undefined}
            onChange={(event) => { setPassword(event.target.value); setError(''); }} />
          <p>계정 보호를 위해 비밀번호를 한 번 더 확인합니다.</p>
        </div>}
        {error && <p id={errorId} className="sa-security-error" role="alert" data-testid="security-dialog-error">{error}</p>}
        <div className="sa-security-dialog-actions"><button ref={initialFocus} type="button" className="sa-secondary" disabled={busy} onClick={close}>취소</button>
          <button type="submit" className="sa-primary" data-testid="security-confirm-revoke" disabled={busy || (needsPassword && !password)}>{busy ? '처리 중' : '로그아웃'}</button></div>
      </form>
    </div>
  </div>, document.body);
}

export default function SessionSecurityPanel({ ownerId, onSessionExpired }: { ownerId: string; onSessionExpired: () => void }) {
  const [snapshot, setSnapshot] = useState<SessionSecuritySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [target, setTarget] = useState<Target | null>(null);
  const active = useRef(true);
  const generation = useRef(0);
  const read = useRef<AbortController | null>(null);
  const expired = useRef(onSessionExpired);
  expired.current = onSessionExpired;
  const headingId = useId();

  const refresh = useCallback(async () => {
    read.current?.abort();
    const request = new AbortController();
    const version = ++generation.current;
    read.current = request;
    setLoading(true); setError('');
    try {
      const result = checkedSnapshot(await api.sessions(ownerId, request.signal));
      if (!active.current || version !== generation.current) return;
      setSnapshot(result);
    } catch (issue) {
      if (!active.current || version !== generation.current || request.signal.aborted) return;
      if (issue instanceof ApiError && (issue.status === 401 || issue.code === 'SESSION_CHANGED')) expired.current();
      else setError(errorMessage(issue));
    } finally {
      if (active.current && version === generation.current) setLoading(false);
      if (read.current === request) read.current = null;
    }
  }, [ownerId]);

  useEffect(() => {
    active.current = true;
    setSnapshot(null); setTarget(null); setNotice('');
    void refresh();
    const foreground = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', foreground);
    document.addEventListener('visibilitychange', foreground);
    return () => {
      active.current = false; generation.current++; read.current?.abort();
      window.removeEventListener('focus', foreground);
      document.removeEventListener('visibilitychange', foreground);
    };
  }, [refresh]);

  const close = useCallback(() => setTarget(null), []);
  const others = snapshot?.sessions.filter((session) => !session.current) ?? [];
  return <section className="sa-security-panel" aria-labelledby={headingId} data-testid="security-sessions-panel" aria-busy={loading}>
    <div className="sa-section-heading"><div><h2 id={headingId}>로그인된 기기</h2><p>사용하지 않는 기기의 로그인을 해제할 수 있습니다.</p></div>
      <button className="sa-icon-button" type="button" aria-label="로그인 목록 새로고침" data-testid="security-refresh" disabled={loading || Boolean(target)} onClick={() => void refresh()}><RefreshCw size={18} /></button></div>
    {!snapshot ? <p className="sa-security-loading" role="status">{loading ? '로그인 정보를 확인하고 있습니다.' : '로그인 정보를 불러오지 못했습니다.'}</p>
      : <ul className="sa-security-sessions">{snapshot.sessions.map((session) => <li key={session.id} data-testid="security-session" data-session-id={session.id} data-current={session.current}>
        <span className="sa-security-device-icon" aria-hidden="true"><Monitor size={19} /></span>
        <div className="sa-security-device"><div className="sa-security-device-title"><strong>{session.deviceLabel}</strong>{session.current && <span>현재 기기</span>}</div>
          <dl><div><dt>로그인</dt><dd><time dateTime={new Date(session.createdAt).toISOString()}>{dateTime(session.createdAt)}</time></dd></div>
            <div><dt>최근 활동</dt><dd><time dateTime={new Date(session.lastSeenAt).toISOString()}>{dateTime(session.lastSeenAt)}</time></dd></div>
            <div><dt>로그인 만료</dt><dd><time dateTime={new Date(session.expiresAt).toISOString()}>{dateTime(session.expiresAt)}</time></dd></div></dl>
        </div>
        <button className="sa-text-button" type="button" data-testid="security-revoke-session" disabled={loading || Boolean(error) || Boolean(target)}
          aria-label={`${session.deviceLabel}${session.current ? ' 현재 기기' : ''} 로그아웃`} onClick={() => { setNotice(''); setTarget({ kind: 'one', session }); }}>로그아웃</button>
      </li>)}</ul>}
    {error && <p className="sa-error" role="alert" data-testid="security-error">{error}</p>}
    {notice && <p className="sa-notice" role="status" data-testid="security-notice">{notice}</p>}
    <div className="sa-security-footer"><p>기기 정보는 브라우저에서 제공한 정보를 바탕으로 표시합니다.<br />시간은 한국 시간 기준입니다.</p>
      <button className="sa-secondary" type="button" data-testid="security-revoke-others" disabled={loading || Boolean(error) || Boolean(target) || others.length === 0}
        onClick={() => { setNotice(''); setTarget({ kind: 'others' }); }}>다른 기기 모두 로그아웃</button></div>
    {target && <RevokeConfirmation key={target.kind === 'one' ? target.session.id : 'others'} target={target} ownerId={ownerId}
      reauthenticatedUntil={snapshot?.reauthenticatedUntil ?? null} onClose={close} onExpired={() => expired.current()}
      onComplete={(message) => { setTarget(null); setNotice(message); void refresh(); }} />}
  </section>;
}
