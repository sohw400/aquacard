import { useState, type FormEvent } from 'react';
import type { MemberProfile } from '../../shared/api';
import { api, errorMessage } from './api';

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
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  function changeView(next: AuthView) { setView(next); setError(''); setMessage(''); setPassword(''); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    setError(''); setMessage('');
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedTag = tag.trim().replace(/^@/, '').toLowerCase();
    if (view === 'signup') {
      const normalizedName = name.trim().normalize('NFC');
      if (Array.from(normalizedName).length < 2 || Array.from(normalizedName).length > 40 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(normalizedName) || !/[\p{L}\p{N}]/u.test(normalizedName)) { setError('이름은 2~40자로 입력해 주세요.'); return; }
      if (!/^[a-z0-9][a-z0-9._]{1,18}[a-z0-9]$/.test(normalizedTag) || normalizedTag.includes('..') || /^\d+$/.test(normalizedTag)) { setError('태그는 영문·숫자로 시작하고 끝나는 3~20자로 입력해 주세요. 숫자로만 만들거나 점을 연속해서 사용할 수 없습니다.'); return; }
    }
    if ((view === 'signup' || view === 'recovery-confirm') && !validPassword(password)) { setError(PASSWORD_HELP); return; }
    try {
      setBusy(true);
      if (view === 'recovery-request') {
        await api.requestRecovery(normalizedEmail);
        setMessage('해당 계정이 있으면 복구 안내가 생성됩니다. 전달받은 복구 코드를 입력해 주세요.');
        setView('recovery-confirm');
      } else if (view === 'recovery-confirm') {
        await api.confirmRecovery(token.trim(), password);
        setPassword(''); setToken(''); setView('login');
        setMessage('비밀번호를 변경했습니다. 다시 로그인해 주세요.');
      } else {
        const result = view === 'signup' ? await api.signup({ name: name.trim().normalize('NFC'), email: normalizedEmail, tag: normalizedTag, password }) : await api.login({ email: normalizedEmail, password });
        setPassword(''); onAuthenticated(result.user);
      }
    } catch (issue) { setError(errorMessage(issue)); }
    finally { setBusy(false); }
  }

  const recovery = view.startsWith('recovery');
  return <div className="sa-auth-layout"><section className="sa-auth-intro"><span className="sa-overline">Aqua 계정</span><h1>태그로 찾고,<br />계정으로 보내세요.</h1><p>회원 간 송금을 위한 테스트 서비스입니다.<br />잔액과 거래 내역은 서버에서 관리됩니다.</p><div className="sa-intro-note"><strong>실제 자금이 아닙니다.</strong><p>입금과 카드 발급은 아직 연결되지 않았습니다.</p></div></section><section className="sa-auth-card" aria-label="계정 인증">
    {!recovery ? <div className="sa-auth-tabs" role="tablist" aria-label="계정 메뉴"><button role="tab" aria-selected={view === 'login'} data-testid="auth-login-tab" onClick={() => changeView('login')}>로그인</button><button role="tab" aria-selected={view === 'signup'} data-testid="auth-signup-tab" onClick={() => changeView('signup')}>회원가입</button></div> : <div className="sa-auth-heading"><button className="sa-text-button" onClick={() => changeView('login')}>로그인으로 돌아가기</button><h2>비밀번호 재설정</h2></div>}
    {(message || notice) && <p className="sa-notice" role="status">{message || notice}</p>}
    <form onSubmit={submit}>
      {view === 'signup' && <div className="sa-field"><label htmlFor="server-name">이름</label><input id="server-name" data-testid="auth-name" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" minLength={2} maxLength={40} required /></div>}
      {view !== 'recovery-confirm' && <div className="sa-field"><label htmlFor="server-email">이메일</label><input id="server-email" data-testid="auth-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" maxLength={254} required /></div>}
      {view === 'signup' && <div className="sa-field"><label htmlFor="server-tag">Aqua 태그</label><div className="sa-tag-input"><span>@</span><input id="server-tag" data-testid="auth-tag" value={tag} onChange={(event) => setTag(event.target.value.replace(/^@/, '').toLowerCase())} autoComplete="off" autoCapitalize="none" spellCheck={false} minLength={3} maxLength={20} placeholder="aqua.member" required /></div><p className="sa-field-help">영문 소문자·숫자·점·밑줄, 3~20자</p></div>}
      {view === 'recovery-confirm' && <div className="sa-field"><label htmlFor="server-recovery-token">복구 코드</label><input id="server-recovery-token" data-testid="recovery-token" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" spellCheck={false} required /><p className="sa-field-help">전달받은 코드를 직접 입력해 주세요.</p></div>}
      {view !== 'recovery-request' && <div className="sa-field"><label htmlFor="server-password">{view === 'recovery-confirm' ? '새 비밀번호' : '비밀번호'}</label><input id="server-password" data-testid={view === 'recovery-confirm' ? 'recovery-password' : 'auth-password'} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={view === 'login' ? 'current-password' : 'new-password'} minLength={12} maxLength={128} required />{view !== 'login' && <p className="sa-field-help">{PASSWORD_HELP}</p>}</div>}
      {error && <p className="sa-error" role="alert" data-testid="auth-error">{error}</p>}
      <button className="sa-primary sa-full" data-testid={view === 'recovery-request' ? 'recovery-request' : view === 'recovery-confirm' ? 'recovery-confirm' : 'auth-submit'} disabled={busy} type="submit">{busy ? '확인 중' : view === 'signup' ? '계정 만들기' : view === 'recovery-request' ? '복구 안내 요청' : view === 'recovery-confirm' ? '비밀번호 변경' : '로그인'}</button>
    </form>
    {!recovery && <button className="sa-text-button sa-auth-recovery" data-testid="auth-recovery" onClick={() => changeView('recovery-request')}>비밀번호를 잊으셨나요?</button>}{view === 'recovery-request' && <button className="sa-text-button sa-auth-recovery" onClick={() => changeView('recovery-confirm')}>복구 코드가 있어요</button>}
    {view === 'signup' && <p className="sa-auth-footnote">새 계정의 잔액은 0원으로 시작합니다.</p>}
  </section></div>;
}
