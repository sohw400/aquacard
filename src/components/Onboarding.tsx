import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Check, ChevronLeft } from 'lucide-react';
import Logo from './Logo';
import { EMAIL_PATTERN } from '../lib/engine';
import { CARRIERS, demoCode, FUND_SOURCES, hashPassword, ID_TYPES, OCCUPATIONS, passwordIssue, PURPOSES } from '../lib/auth';
import type { Action, AppState, KycAnswers } from '../lib/types';
import './Onboarding.css';

type Screen = 'welcome' | 'account' | 'phone' | 'identity' | 'questions' | 'review' | 'login' | 'reset';
type Scan = 'none' | 'checking' | 'done';
const SIGNUP_STEPS: [Screen, string][] = [['account', '계정'], ['phone', '휴대폰'], ['identity', '신분증'], ['questions', '고객확인']];
const SAMPLE = { email: 'demo@aqua.example', name: '아쿠아 사용자', birth: '19950412', phone: '01012345678' };
const SCAN_MS = 700;

function useScan(state: Scan, done: () => void) {
  useEffect(() => {
    if (state !== 'checking') return;
    const timer = setTimeout(done, SCAN_MS);
    return () => clearTimeout(timer);
  }, [state, done]);
}

/** Sign-up with KYC, sign-in and password reset. Codes are shown on screen because the demo sends no mail or SMS. */
export default function Onboarding({ state, dispatch }: { state: AppState; dispatch: (action: Action) => AppState }) {
  const [screen, setScreen] = useState<Screen>(state.account ? 'login' : 'welcome');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;

  // Account
  const [email, setEmail] = useState(state.account?.email ?? '');
  const [emailCode, setEmailCode] = useState<string | null>(null);
  const [emailInput, setEmailInput] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const emailVerified = emailCode !== null && emailInput === emailCode;
  // Phone
  const [name, setName] = useState('');
  const [birth, setBirth] = useState('');
  const [carrier, setCarrier] = useState<string>(CARRIERS[0]);
  const [phone, setPhone] = useState('');
  const [phoneCode, setPhoneCode] = useState<string | null>(null);
  const [phoneInput, setPhoneInput] = useState('');
  const phoneVerified = phoneCode !== null && phoneInput === phoneCode;
  // Identity and questions
  const [idType, setIdType] = useState<KycAnswers['idType']>('resident');
  const [idScan, setIdScan] = useState<Scan>('none');
  const [faceScan, setFaceScan] = useState<Scan>('none');
  const [occupation, setOccupation] = useState('');
  const [purpose, setPurpose] = useState('');
  const [source, setSource] = useState('');
  const [consent, setConsent] = useState(false);
  const [review, setReview] = useState<Scan>('none');
  // Sign-in and reset
  const [loginPassword, setLoginPassword] = useState('');
  const [notice, setNotice] = useState('');

  useScan(idScan, useRef(() => setIdScan('done')).current);
  useScan(faceScan, useRef(() => setFaceScan('done')).current);
  useScan(review, useRef(() => setReview('done')).current);
  useEffect(() => { heading.current?.focus(); }, [screen]);

  const birthDate = /^\d{8}$/.test(birth) ? `${birth.slice(0, 4)}-${birth.slice(4, 6)}-${birth.slice(6, 8)}` : '';
  const passwordProblem = password ? passwordIssue(password) : '';
  const passwordsReady = password !== '' && !passwordProblem && password === confirm;

  function go(next: Screen) { setError(''); setScreen(next); }
  function sendEmailCode() {
    if (!EMAIL_PATTERN.test(email.trim())) { setError('이메일 주소를 확인해 주세요.'); return; }
    setEmailCode(demoCode()); setEmailInput(''); setError('');
  }
  function sendPhoneCode() {
    if (name.trim().length < 2 || !birthDate) { setError('이름과 생년월일 8자리를 먼저 입력해 주세요.'); return; }
    const [year, month, day] = birthDate.split('-').map(Number);
    const today = new Date();
    const age = today.getFullYear() - year - (today.getMonth() + 1 < month || (today.getMonth() + 1 === month && today.getDate() < day) ? 1 : 0);
    if (new Date(year, month - 1, day).getDate() !== day || age > 120) { setError('생년월일을 확인해 주세요.'); return; }
    if (age < 19) { setError('만 19세 이상만 가입할 수 있습니다.'); return; }
    if (!/^01[016789]\d{7,8}$/.test(phone)) { setError('휴대폰 번호를 확인해 주세요.'); return; }
    setPhoneCode(demoCode()); setPhoneInput(''); setError('');
  }

  async function finishSignup() {
    if (busy) return;
    setBusy(true);
    try {
      const passwordHash = await hashPassword(email, password);
      dispatch({ type: 'COMPLETE_SIGNUP', email: email.trim(), passwordHash, name: name.trim(), birthDate, phone, kyc: { idType, occupation, purpose, source } });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '입력한 내용을 확인해 주세요.');
      setBusy(false);
    }
  }
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try { dispatch({ type: 'SIGN_IN', email, passwordHash: await hashPassword(email, loginPassword) }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '로그인 정보를 확인해 주세요.'); setBusy(false); }
  }
  async function resetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !emailVerified || !passwordsReady) return;
    setBusy(true);
    try {
      dispatch({ type: 'RESET_PASSWORD', email, passwordHash: await hashPassword(email, password) });
      setPassword(''); setConfirm(''); setEmailCode(null); setEmailInput(''); setLoginPassword('');
      setNotice('비밀번호를 바꿨습니다. 새 비밀번호로 로그인해 주세요.');
      go('login');
    } catch (failure) { setError(failure instanceof Error ? failure.message : '입력한 내용을 확인해 주세요.'); }
    finally { setBusy(false); }
  }

  const stepIndex = SIGNUP_STEPS.findIndex(([key]) => key === screen);
  const progress = stepIndex >= 0 && <ol className="onboarding-steps" aria-label="가입 단계">{SIGNUP_STEPS.map(([key, label], index) => <li key={key} className={index < stepIndex ? 'done' : index === stepIndex ? 'current' : ''} aria-current={index === stepIndex ? 'step' : undefined}><span>{index < stepIndex ? <Check size={12} strokeWidth={3} /> : index + 1}</span>{label}</li>)}</ol>;
  const errorBox = error && <p className="form-error" role="alert">{error}</p>;
  const field = (key: string, label: string, input: ReactNode, aside?: ReactNode) => <div className="form-field"><div className="onboarding-label-row"><label htmlFor={id(key)}>{label}</label>{aside}</div>{input}</div>;
  const back = (target: Screen, label = '이전') => <button type="button" className="onboarding-back" onClick={() => go(target)}><ChevronLeft size={18} />{label}</button>;
  const emailBlock = (prefix: 'signup' | 'reset') => <>
    {field(`${prefix}-email`, '이메일', <input id={id(`${prefix}-email`)} data-testid={`${prefix}-email`} type="email" inputMode="email" autoComplete="email" value={email} placeholder="name@example.com" disabled={emailVerified} onChange={(event) => { setEmail(event.target.value); setEmailCode(null); setError(''); }} />,
      prefix === 'signup' && !emailVerified ? <button type="button" className="onboarding-text-button" data-testid="signup-email-sample" onClick={() => { setEmail(SAMPLE.email); setEmailCode(null); setError(''); }}>체험용 주소 넣기</button> : undefined)}
    {!emailVerified && (emailCode ? <>
      <p className="onboarding-code-note" data-testid={`${prefix}-demo-code`}>체험판이라 메일을 보내지 않습니다. 인증 코드는 <strong>{emailCode}</strong>입니다.</p>
      {field(`${prefix}-code`, '인증 코드 6자리', <input id={id(`${prefix}-code`)} data-testid={`${prefix}-code`} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={emailInput} onChange={(event) => setEmailInput(event.target.value.replace(/\D/g, ''))} />, <button type="button" className="onboarding-text-button" onClick={sendEmailCode}>다시 받기</button>)}
    </> : <button type="button" className="btn neutral block" data-testid={`${prefix}-send-code`} disabled={!EMAIL_PATTERN.test(email.trim())} onClick={sendEmailCode}>인증 코드 받기</button>)}
    {emailVerified && <p className="onboarding-verified" data-testid={`${prefix}-email-verified`}><Check size={16} strokeWidth={2.6} />이메일을 확인했습니다.</p>}
  </>;
  const passwordBlock = (prefix: 'signup' | 'reset') => emailVerified && <>
    {field(`${prefix}-password`, prefix === 'signup' ? '비밀번호' : '새 비밀번호', <input id={id(`${prefix}-password`)} data-testid={`${prefix}-password`} type="password" autoComplete="new-password" value={password} onChange={(event) => { setPassword(event.target.value); setError(''); }} aria-invalid={Boolean(passwordProblem)} />)}
    <p className={`onboarding-hint${passwordProblem ? ' bad' : ''}`}>{passwordProblem || '영문과 숫자를 섞어 8자 이상'}</p>
    {field(`${prefix}-password-confirm`, '비밀번호 확인', <input id={id(`${prefix}-password-confirm`)} data-testid={`${prefix}-password-confirm`} type="password" autoComplete="new-password" value={confirm} onChange={(event) => { setConfirm(event.target.value); setError(''); }} />)}
    {confirm && password !== confirm && <p className="onboarding-hint bad">비밀번호가 서로 다릅니다.</p>}
  </>;

  let body: ReactNode;
  if (screen === 'welcome') {
    body = <div className="onboarding-form welcome">
      <h1 ref={heading} tabIndex={-1}>코인을 넣으면<br />바로 쓰는 카드</h1>
      <p className="onboarding-lead">받은 코인은 원화 스테이블로 바뀌어 결제 잔액이 됩니다. 리저브에 두면 보상이 계속 쌓입니다.</p>
      <dl className="onboarding-facts"><div><dt>입금 수수료</dt><dd>없음</dd></div><div><dt>리저브 보상</dt><dd>1초마다 적립</dd></div><div><dt>카드 페이백</dt><dd>결제액의 1%부터</dd></div></dl>
      <div className="onboarding-actions"><button type="button" className="btn primary block" data-testid="auth-signup" onClick={() => go('account')}>가입하기</button><button type="button" className="btn neutral block" data-testid="auth-login" onClick={() => go('login')}>로그인</button></div>
    </div>;
  } else if (screen === 'account') {
    body = <form className="onboarding-form" noValidate onSubmit={(event) => { event.preventDefault(); if (emailVerified && passwordsReady) go('phone'); }}>
      {back('welcome', '처음으로')}
      <h1 ref={heading} tabIndex={-1}>계정 만들기</h1>
      <p className="onboarding-lead">로그인과 출금 확인에 쓸 이메일입니다.</p>
      {emailBlock('signup')}
      {passwordBlock('signup')}
      {errorBox}
      <div className="onboarding-actions"><button type="submit" className="btn primary block" data-testid="signup-next" disabled={!emailVerified || !passwordsReady}>다음</button></div>
    </form>;
  } else if (screen === 'phone') {
    body = <form className="onboarding-form" noValidate onSubmit={(event) => { event.preventDefault(); if (phoneVerified) go('identity'); }}>
      {back('account')}
      <h1 ref={heading} tabIndex={-1}>휴대폰 본인인증</h1>
      <p className="onboarding-lead">본인 명의 휴대폰으로 확인합니다. 코인을 받아 원화 스테이블로 바꾸려면 가입할 때 본인확인(KYC)이 필요합니다.</p>
      <button type="button" className="onboarding-text-button" data-testid="kyc-sample" onClick={() => { setName(SAMPLE.name); setBirth(SAMPLE.birth); setPhone(SAMPLE.phone); setPhoneCode(null); setError(''); }}>샘플 정보 채우기</button>
      {field('name', '이름', <input id={id('name')} data-testid="kyc-name" autoComplete="name" maxLength={30} value={name} disabled={phoneVerified} onChange={(event) => { setName(event.target.value); setPhoneCode(null); setError(''); }} />)}
      {field('birth', '생년월일 8자리', <input id={id('birth')} data-testid="kyc-birth" inputMode="numeric" maxLength={8} placeholder="19950412" value={birth} disabled={phoneVerified} onChange={(event) => { setBirth(event.target.value.replace(/\D/g, '')); setPhoneCode(null); setError(''); }} />)}
      <fieldset className="onboarding-choice"><legend>통신사</legend><div>{CARRIERS.map((item) => <button type="button" key={item} className={carrier === item ? 'selected' : ''} aria-pressed={carrier === item} disabled={phoneVerified} onClick={() => setCarrier(item)}>{item}</button>)}</div></fieldset>
      {field('phone', '휴대폰 번호', <input id={id('phone')} data-testid="kyc-phone" inputMode="numeric" autoComplete="tel-national" maxLength={11} placeholder="01012345678" value={phone} disabled={phoneVerified} onChange={(event) => { setPhone(event.target.value.replace(/\D/g, '')); setPhoneCode(null); setError(''); }} />)}
      {!phoneVerified && (phoneCode ? <>
        <p className="onboarding-code-note" data-testid="kyc-demo-code">체험판이라 문자를 보내지 않습니다. 인증번호는 <strong>{phoneCode}</strong>입니다.</p>
        {field('phone-code', '인증번호 6자리', <input id={id('phone-code')} data-testid="kyc-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={phoneInput} onChange={(event) => setPhoneInput(event.target.value.replace(/\D/g, ''))} />, <button type="button" className="onboarding-text-button" onClick={sendPhoneCode}>다시 받기</button>)}
      </> : <button type="button" className="btn neutral block" data-testid="kyc-send-code" onClick={sendPhoneCode}>인증번호 받기</button>)}
      {phoneVerified && <p className="onboarding-verified" data-testid="kyc-phone-verified"><Check size={16} strokeWidth={2.6} />{carrier} 휴대폰으로 확인했습니다.</p>}
      {errorBox}
      <div className="onboarding-actions"><button type="submit" className="btn primary block" data-testid="kyc-next" disabled={!phoneVerified}>다음</button></div>
    </form>;
  } else if (screen === 'identity') {
    body = <div className="onboarding-form">
      {back('phone')}
      <h1 ref={heading} tabIndex={-1}>신분증과 얼굴 확인</h1>
      <p className="onboarding-lead">신분증 진위를 확인하고, 사진 속 얼굴이 본인인지 맞춰 봅니다.</p>
      <fieldset className="onboarding-choice"><legend>신분증</legend><div>{(Object.keys(ID_TYPES) as KycAnswers['idType'][]).map((key) => <button type="button" key={key} data-testid={`kyc-id-${key}`} className={idType === key ? 'selected' : ''} aria-pressed={idType === key} disabled={idScan !== 'none'} onClick={() => setIdType(key)}>{ID_TYPES[key]}</button>)}</div></fieldset>
      <div className="onboarding-check">
        <div><strong>{ID_TYPES[idType]} 촬영</strong><p>{idScan === 'done' ? `${name} · ${birth.slice(0, 4)}.${birth.slice(4, 6)}.${birth.slice(6, 8)} 일치 · 진위 확인 완료` : idScan === 'checking' ? '진위를 확인하고 있습니다.' : '빛 반사 없이 네 모서리가 보이게 찍습니다.'}</p></div>
        {idScan === 'done' ? <span className="onboarding-done" data-testid="kyc-id-done"><Check size={18} strokeWidth={2.6} />완료</span> : <button type="button" className="btn small neutral" data-testid="kyc-id-scan" disabled={idScan === 'checking'} onClick={() => setIdScan('checking')}>{idScan === 'checking' ? '확인 중' : '촬영 체험'}</button>}
      </div>
      <div className="onboarding-check">
        <div><strong>얼굴 확인</strong><p>{faceScan === 'done' ? '신분증 사진과 같은 사람입니다.' : faceScan === 'checking' ? '얼굴을 맞춰 보고 있습니다.' : idScan === 'done' ? '화면 안내에 따라 고개를 천천히 돌립니다.' : '신분증을 먼저 확인해 주세요.'}</p></div>
        {faceScan === 'done' ? <span className="onboarding-done" data-testid="kyc-face-done"><Check size={18} strokeWidth={2.6} />완료</span> : <button type="button" className="btn small neutral" data-testid="kyc-face-scan" disabled={idScan !== 'done' || faceScan === 'checking'} onClick={() => setFaceScan('checking')}>{faceScan === 'checking' ? '확인 중' : '촬영 체험'}</button>}
      </div>
      <p className="onboarding-hint">체험에서는 카메라를 켜지 않고 확인 과정만 보여줍니다.</p>
      <div className="onboarding-actions"><button type="button" className="btn primary block" data-testid="kyc-id-next" disabled={idScan !== 'done' || faceScan !== 'done'} onClick={() => go('questions')}>다음</button></div>
    </div>;
  } else if (screen === 'questions') {
    const select = (key: string, label: string, value: string, options: readonly string[], set: (value: string) => void) => field(key, label,
      <select id={id(key)} data-testid={`kyc-${key}`} value={value} onChange={(event) => { set(event.target.value); setError(''); }}><option value="" disabled>선택해 주세요</option>{options.map((item) => <option key={item} value={item}>{item}</option>)}</select>);
    const ready = occupation && purpose && source && consent;
    body = <form className="onboarding-form" noValidate onSubmit={(event) => { event.preventDefault(); if (ready) { setReview('checking'); go('review'); } }}>
      {back('identity')}
      <h1 ref={heading} tabIndex={-1}>고객확인 질문</h1>
      <p className="onboarding-lead">가상자산 서비스는 법에 따라 거래 목적과 자금 출처를 확인합니다.</p>
      {select('occupation', '직업', occupation, OCCUPATIONS, setOccupation)}
      {select('purpose', '주로 쓰려는 목적', purpose, PURPOSES, setPurpose)}
      {select('source', '자금 출처', source, FUND_SOURCES, setSource)}
      <label className="onboarding-consent"><input type="checkbox" data-testid="kyc-consent" checked={consent} onChange={(event) => setConsent(event.target.checked)} /><span>입력한 본인확인 정보를 수집·이용하고, 고객확인 기록으로 거래가 끝난 뒤 5년간 보관하는 데 동의합니다.</span></label>
      {errorBox}
      <div className="onboarding-actions"><button type="submit" className="btn primary block" data-testid="kyc-submit" disabled={!ready}>제출</button></div>
    </form>;
  } else if (screen === 'review') {
    body = <div className="onboarding-form review" data-testid="kyc-review" data-status={review}>
      {review === 'done' ? <span className="onboarding-review-icon" aria-hidden="true"><Check size={28} strokeWidth={2.4} /></span> : <span className="onboarding-spinner" aria-hidden="true" />}
      <h1 ref={heading} tabIndex={-1}>{review === 'done' ? '가입을 마쳤습니다' : '확인하고 있습니다'}</h1>
      <p className="onboarding-lead">{review === 'done' ? `${name}님, 이제 코인을 넣고 카드를 신청할 수 있습니다.` : '보통 몇 분 걸리지만 체험에서는 바로 끝납니다.'}</p>
      {errorBox}
      {review === 'done' && <div className="onboarding-actions"><button type="button" className="btn primary block" data-testid="signup-finish" disabled={busy} onClick={finishSignup}>시작하기</button></div>}
    </div>;
  } else if (screen === 'login') {
    body = <form className="onboarding-form" noValidate onSubmit={signIn}>
      {!state.account && back('welcome', '처음으로')}
      <h1 ref={heading} tabIndex={-1}>로그인</h1>
      {notice && <p className="onboarding-code-note" role="status">{notice}</p>}
      {!state.account && <p className="onboarding-hint">이 브라우저에는 가입 기록이 없습니다. 먼저 가입해 주세요.</p>}
      {field('login-email', '이메일', <input id={id('login-email')} data-testid="login-email" type="email" inputMode="email" autoComplete="email" value={email} onChange={(event) => { setEmail(event.target.value); setError(''); }} />)}
      {field('login-password', '비밀번호', <input id={id('login-password')} data-testid="login-password" type="password" autoComplete="current-password" value={loginPassword} onChange={(event) => { setLoginPassword(event.target.value); setError(''); }} />)}
      {errorBox}
      <div className="onboarding-actions"><button type="submit" className="btn primary block" data-testid="login-submit" disabled={busy || !email || !loginPassword}>로그인</button>
        <div className="onboarding-links"><button type="button" data-testid="login-forgot" onClick={() => { setEmailCode(null); setEmailInput(''); setPassword(''); setConfirm(''); setNotice(''); go('reset'); }}>비밀번호 찾기</button>{!state.account && <button type="button" data-testid="login-signup" onClick={() => go('account')}>가입하기</button>}</div></div>
    </form>;
  } else {
    body = <form className="onboarding-form" noValidate onSubmit={resetPassword}>
      {back('login', '로그인으로')}
      <h1 ref={heading} tabIndex={-1}>비밀번호 찾기</h1>
      <p className="onboarding-lead">가입한 이메일로 받은 코드를 넣고 새 비밀번호를 정합니다.</p>
      {emailBlock('reset')}
      {passwordBlock('reset')}
      {errorBox}
      <div className="onboarding-actions"><button type="submit" className="btn primary block" data-testid="reset-submit" disabled={busy || !emailVerified || !passwordsReady}>비밀번호 바꾸기</button></div>
    </form>;
  }

  return <main className="onboarding" data-testid="onboarding">
    <div className="onboarding-inner">
      <div className="onboarding-brand"><Logo size={30} /><span className="demo-tag">체험판</span></div>
      {progress}
      {body}
      <p className="onboarding-note">체험판입니다. 실제 이름, 휴대폰 번호, 신분증 정보를 넣지 마세요. 입력한 내용은 이 브라우저에만 저장되고 비밀번호는 해시로만 남습니다.</p>
    </div>
  </main>;
}
