import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Eye, EyeOff } from 'lucide-react';
import type { MemberProfile } from '../../shared/api';
import { api, errorMessage } from './api';
import cards from '../assets/aqua-cards.webp';
import './AuthPanel.css';

type AuthView = 'login' | 'signup' | 'recovery-request' | 'recovery-confirm';
const PASSWORD_HELP = '12~128자, 영문 대문자·소문자·숫자·기호 중 3종류를 사용해 주세요.';

function validPassword(password: string): boolean {
  return password.length >= 12 && password.length <= 128 && !/[\p{Cc}\p{Cs}]/u.test(password) && [/[a-z]/, /[A-Z]/, /[0-9]/, /[^\p{L}\p{N}\s]/u].filter((pattern) => pattern.test(password)).length >= 3;
}

export default function AuthPanel({ onAuthenticated, notice }: { onAuthenticated: (user: MemberProfile) => void; notice: string }) {
  const [view, setView] = useState<AuthView>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [tag, setTag] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [invalidField, setInvalidField] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const title = useRef<HTMLHeadingElement>(null);
  const previousView = useRef(view);
  useEffect(() => {
    if (previousView.current !== view) title.current?.focus();
    previousView.current = view;
  }, [view]);

  const mounted = useRef(true);
  const flight = useRef<AbortController | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; flight.current?.abort(); };
  }, []);

  function changeView(next: AuthView) {
    if (flight.current || next === view) return;
    generation.current++;
    setInvalidField(''); setShowPassword(false);
    setView(next); setError(''); setMessage(''); setPassword(''); setToken('');
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (flight.current) return;
    setError(''); setMessage(''); setInvalidField('');
    const reject = (id: string, reason: string) => {
      setInvalidField(id);
      setError(reason);
      event.currentTarget.querySelector<HTMLInputElement>(`#${id}`)?.focus();
    };
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedTag = tag.trim().replace(/^@/, '').toLowerCase();
    if (view === 'signup') {
      const normalizedName = name.trim().normalize('NFC');
      if (Array.from(normalizedName).length < 2 || Array.from(normalizedName).length > 40 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(normalizedName) || !/[\p{L}\p{N}]/u.test(normalizedName)) { reject('server-name', '이름은 2~40자로 입력해 주세요.'); return; }
      if (!/^[a-z0-9][a-z0-9._]{1,18}[a-z0-9]$/.test(normalizedTag) || normalizedTag.includes('..') || /^\d+$/.test(normalizedTag)) { reject('server-tag', '태그는 영문·숫자로 시작하고 끝나는 3~20자로 입력해 주세요. 숫자로만 만들거나 점을 연속해서 사용할 수 없습니다.'); return; }
    }
    if ((view === 'signup' || view === 'recovery-confirm') && !validPassword(password)) { reject('server-password', PASSWORD_HELP); return; }
    const request = new AbortController();
    const version = ++generation.current;
    flight.current = request;
    const current = () => mounted.current && generation.current === version && flight.current === request;
    const submittedPassword = password;
    const submittedToken = token.trim();
    setPassword(''); setShowPassword(false);
    if (view === 'recovery-confirm') setToken('');
    try {
      setBusy(true);
      if (view === 'recovery-request') {
        const result = await api.requestRecovery(normalizedEmail, request.signal);
        if (result.ok !== true) throw new Error('Invalid recovery acknowledgement.');
        if (!current()) return;
        setMessage('입력한 이메일에 해당하는 계정이 있으면 복구 안내를 보냅니다. 이메일이 도착하면 가장 최근에 요청한 복구 코드를 입력해 주세요.');
        setView('recovery-confirm');
      } else if (view === 'recovery-confirm') {
        const result = await api.confirmRecovery(submittedToken, submittedPassword, request.signal);
        if (result.ok !== true) throw new Error('Invalid recovery confirmation.');
        if (!current()) return;
        setPassword(''); setToken(''); setView('login');
        setMessage('비밀번호를 변경했습니다. 다시 로그인해 주세요.');
      } else {
        const result = view === 'signup'
          ? await api.signup({ name: name.trim().normalize('NFC'), email: normalizedEmail, tag: normalizedTag, password: submittedPassword }, request.signal)
          : await api.login({ email: normalizedEmail, password: submittedPassword }, request.signal);
        if (!current()) return;
        // Another tab can change the shared cookie while this response is in flight.
        const session = await api.session(request.signal);
        if (!current()) return;
        if (!session.user || session.user.id !== result.user.id) {
          setError('로그인 상태가 바뀌었습니다. 현재 계정을 확인하고 다시 로그인해 주세요.');
          return;
        }
        setPassword(''); onAuthenticated(session.user);
      }
    } catch (issue) { if (current() && !request.signal.aborted) setError(errorMessage(issue)); }
    finally {
      if (flight.current === request) flight.current = null;
      if (mounted.current && generation.current === version) setBusy(false);
    }
  }

  const recovery = view.startsWith('recovery');
  const heading = {
    login: 'Aqua 계정',
    signup: '계정 만들기',
    'recovery-request': '복구 코드 받기',
    'recovery-confirm': '새 비밀번호 설정',
  }[view];
  return <div className="sa-entry" data-view={view}>
    <div className="sa-entry-art" aria-hidden="true"><img src={cards} width="960" height="630" alt="" /></div>
    <section className="sa-auth-card sa-entry-form" aria-labelledby="server-entry-title">
      {recovery && <button type="button" className="sa-text-button sa-entry-back" disabled={busy} onClick={() => changeView('login')}><ArrowLeft size={16} aria-hidden="true" />로그인으로 돌아가기</button>}
      <h1 ref={title} tabIndex={-1} id="server-entry-title">{heading}</h1>
      {!recovery ? <div className="sa-entry-switch" role="group" aria-label="계정 메뉴">
        <button type="button" aria-pressed={view === 'login'} data-testid="auth-login-tab" disabled={busy} onClick={() => changeView('login')}>로그인</button>
        <button type="button" aria-pressed={view === 'signup'} data-testid="auth-signup-tab" disabled={busy} onClick={() => changeView('signup')}>회원가입</button>
      </div> : <p className="sa-entry-instruction">{view === 'recovery-request' ? '가입할 때 사용한 이메일을 입력해 주세요.' : '복구 메일에서 받은 코드와 새 비밀번호를 입력해 주세요.'}</p>}
    {(message || notice) && <p className="sa-notice" role="status">{message || notice}</p>}
    <form onSubmit={submit} aria-busy={busy} onChange={() => { if (error) { setError(''); setInvalidField(''); } }}>
      {view === 'signup' && <div className="sa-field"><label htmlFor="server-name">이름</label><input id="server-name" data-testid="auth-name" aria-invalid={invalidField === 'server-name' || undefined} aria-describedby={invalidField === 'server-name' ? 'server-auth-error' : undefined} disabled={busy} value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" minLength={2} maxLength={40} required /></div>}
      {view !== 'recovery-confirm' && <div className="sa-field"><label htmlFor="server-email">이메일</label><input id="server-email" data-testid="auth-email" disabled={busy} type="email" placeholder="name@example.com" autoCapitalize="none" spellCheck={false} value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" maxLength={254} required /></div>}
      {view === 'signup' && <div className="sa-field"><label htmlFor="server-tag">Aqua 태그</label><div className="sa-tag-input"><span aria-hidden="true">@</span><input id="server-tag" data-testid="auth-tag" aria-invalid={invalidField === 'server-tag' || undefined} aria-describedby={invalidField === 'server-tag' ? 'server-tag-help server-auth-error' : 'server-tag-help'} disabled={busy} value={tag} onChange={(event) => setTag(event.target.value.replace(/^@/, '').toLowerCase())} autoComplete="off" autoCapitalize="none" spellCheck={false} minLength={3} maxLength={20} placeholder="aqua.member" required /></div><p id="server-tag-help" className="sa-field-help">송금받을 때 쓰는 이름이에요. 영문 소문자·숫자·점·밑줄로 3~20자를 입력해 주세요.</p></div>}
      {view === 'recovery-confirm' && <div className="sa-field"><label htmlFor="server-recovery-token">복구 코드</label><input id="server-recovery-token" data-testid="recovery-token" aria-describedby="server-code-help" maxLength={128} disabled={busy} value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} required /><p className="sa-field-help" id="server-code-help">가장 최근에 요청한 비밀번호 복구 코드를 사용해 주세요.</p></div>}
      {view !== 'recovery-request' && <div className="sa-field">
        <label htmlFor="server-password">{view === 'recovery-confirm' ? '새 비밀번호' : '비밀번호'}</label>
        <div className="sa-entry-password">
          <input id="server-password" data-testid={view === 'recovery-confirm' ? 'recovery-password' : 'auth-password'}
            type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)}
            aria-invalid={invalidField === 'server-password' || undefined}
            aria-describedby={invalidField === 'server-password' ? 'server-password-help server-auth-error' : view === 'login' ? undefined : 'server-password-help'}
            autoComplete={view === 'login' ? 'current-password' : 'new-password'} autoCapitalize="none" spellCheck={false}
            disabled={busy} minLength={12} maxLength={128} required />
          <button type="button" className="sa-entry-reveal" aria-label="비밀번호 표시" aria-pressed={showPassword}
            aria-controls="server-password" disabled={busy} onClick={() => setShowPassword(current => !current)}>
            {showPassword ? <EyeOff size={19} aria-hidden="true" /> : <Eye size={19} aria-hidden="true" />}
          </button>
        </div>
        {view !== 'login' && <p className="sa-field-help" id="server-password-help">{PASSWORD_HELP}</p>}
      </div>}
      {error && <p id="server-auth-error" className="sa-error" role="alert" data-testid="auth-error">{error}</p>}
      <button className="sa-primary sa-full" data-testid={view === 'recovery-request' ? 'recovery-request' : view === 'recovery-confirm' ? 'recovery-confirm' : 'auth-submit'} disabled={busy} type="submit">{busy ? '확인 중' : view === 'signup' ? '계정 만들기' : view === 'recovery-request' ? '복구 안내 요청' : view === 'recovery-confirm' ? '비밀번호 변경' : '로그인'}</button>
    </form>
    {view === 'login' && <button className="sa-text-button sa-auth-recovery" data-testid="auth-recovery" disabled={busy} onClick={() => changeView('recovery-request')}>비밀번호 찾기</button>}{view === 'recovery-request' && <button className="sa-text-button sa-auth-recovery" disabled={busy} onClick={() => changeView('recovery-confirm')}>복구 코드가 있어요</button>}
    {view === 'recovery-confirm' && <button type="button" className="sa-text-button sa-auth-recovery" disabled={busy} onClick={() => changeView('recovery-request')}>복구 코드 다시 요청하기</button>}
  </section></div>;
}
