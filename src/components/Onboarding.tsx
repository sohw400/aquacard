import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Check, ChevronLeft, CircleAlert } from 'lucide-react';
import AddressSheet from './AddressSheet';
import CardHero from './CardHero';
import Logo from './Logo';
import { addressLine } from '../lib/address';
import { EMAIL_PATTERN } from '../lib/engine';
import { josa } from '../lib/format';
import {
  BANK_SENDS, BANK_TRIES, BANKS, CARRIERS, demoCode, EVIDENCE, FUND_SOURCES, hashPassword, ID_TYPES, needsEvidence, OCCUPATIONS,
  passwordIssue, PURPOSES, RECHECK_YEARS,
} from '../lib/auth';
import type { Action, AppState, KycAnswers, ShippingAddress } from '../lib/types';
import './Onboarding.css';

type Screen = 'welcome' | 'terms' | 'account' | 'phone' | 'identity' | 'bank' | 'questions' | 'evidence' | 'review' | 'login' | 'reset';
type Scan = 'none' | 'checking' | 'done';
const SIGNUP_STEPS: [Screen, string][] = [['terms', '약관'], ['account', '계정'], ['phone', '휴대폰'], ['identity', '신분증'], ['bank', '계좌'], ['questions', '고객확인']];
const SAMPLE = { email: 'demo@aqua.example', name: '아쿠아 사용자', birth: '19950412', phone: '01012345678', bank: '신한은행', account: '123456789012' };
const SCAN_MS = 700;

/**
 * The terms sign-up asks for. What the law itself requires is told, not asked (the notice under them), and face data is
 * asked for at the face check, where the alternative is.
 */
const TERMS = [
  { key: 'service', title: '서비스 이용약관', detail: '카드, 잔액, 리저브, 보내기를 쓰는 조건과 수수료, 책임 범위를 정해요.' },
  { key: 'privacy', title: '개인정보 수집·이용', detail: '이메일, 휴대폰 번호, 직업·거래 목적·자금 출처, 기기 정보를 회원 관리와 본인확인, 이상거래 방지에 써요. 탈퇴하면 지체 없이 지우고, 법으로 보관해야 하는 정보만 따로 보관해요.' },
  { key: 'unique', title: '고유식별정보 처리', detail: '신분증이 진짜인지 확인할 때 운전면허번호 같은 신분증 번호를 처리해요. 거래가 끝난 뒤 5년 동안 보관해요.' },
] as const;
type TermKey = typeof TERMS[number]['key'];

/** What the demo's ID check can be told to find. A launch turns copies, screens and covered IDs away on its own. */
const ID_PROBLEMS = {
  copy: '복사본이나 화면을 찍은 사진은 받을 수 없어요. 신분증 원본을 찍어 주세요.',
  masked: '가린 곳이 있어요. 신분증 전체가 보이게 다시 찍어 주세요.',
} as const;
type IdOutcome = 'original' | keyof typeof ID_PROBLEMS;

function useScan(state: string, done: () => void) {
  useEffect(() => {
    if (state !== 'checking') return;
    const timer = setTimeout(done, SCAN_MS);
    return () => clearTimeout(timer);
  }, [state, done]);
}

/**
 * A status line that, while its step is under way, keeps the height of its longest wording, so pressing the
 * button never moves the rows below. Once the step is done, or turned back, it fits the result.
 */
function CheckText({ steps, current, done, bad = false, testId }: { steps: string[]; current: number; done: string | null; bad?: boolean; testId?: string }) {
  if (done !== null) return <p className={`onboarding-check-text${bad ? ' bad' : ''}`} data-testid={testId} role={bad ? 'alert' : undefined}>{done}</p>;
  return <p className="onboarding-check-text">{steps.map((text, index) => <span key={index} className={index === current ? undefined : 'reserve'} aria-hidden={index === current ? undefined : true}>{text}</span>)}</p>;
}

/** Demo-only switch for an outcome the real service decides. */
function Simulation<T extends string>({ label, value, options, onChange, testId }: { label: string; value: T; options: [T, string][]; onChange: (value: T) => void; testId: string }) {
  const name = useId();
  return <details className="onboarding-simulation" data-testid={testId}><summary>{label}</summary><div>{options.map(([key, text]) => <label key={key}><input type="radio" name={name} checked={value === key} onChange={() => onChange(key)} data-testid={`${testId}-${key}`} />{text}</label>)}</div></details>;
}

const bankDate = (timestamp: number) => {
  const parts = new Intl.DateTimeFormat('ko-KR', { month: '2-digit', day: '2-digit', timeZone: 'Asia/Seoul' }).formatToParts(timestamp);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('month')}.${part('day')}`;
};

/**
 * A bank app's history with the 1원 deposit on top and the four digits to type marked. Before sending it is an example;
 * after, the demo shows its own code here because it sends nothing. The real app keeps the example and never shows the code.
 */
function BankGuide({ code, now }: { code: string | null; now: number }) {
  const digits = code ?? '1234';
  return <figure className="bank-guide" data-testid="kyc-bank-guide">
    <div className="bank-guide-screen" role="img" aria-label={`은행 앱 입출금 내역${code ? '' : ' 예시'}: 입금자명 아쿠아 ${digits}, 1원 입금`}>
      <p className="bank-guide-head"><span>입출금 내역</span>{!code && <span>예시</span>}</p>
      <p className="bank-guide-row current"><span>{bankDate(now)}</span><span>아쿠아 <mark data-testid={code ? 'kyc-bank-demo-code' : undefined}>{digits}</mark></span><strong>+1원</strong></p>
      <p className="bank-guide-row"><span>{bankDate(now - 86_400_000)}</span><span>편의점</span><strong>−3,200원</strong></p>
    </div>
    <figcaption>{code ? '체험판이라 1원은 보내지 않고 은행 앱에 찍힐 내역을 여기 보여 드려요.' : '1원이 들어오면 입금자명 뒤 숫자 4자리를 넣으면 돼요.'}</figcaption>
  </figure>;
}

/** Sign-up with KYC, sign-in and password reset. Codes are shown on screen because the demo sends no mail, SMS or 1원 transfer. */
export default function Onboarding({ state, dispatch }: { state: AppState; dispatch: (action: Action) => AppState }) {
  const [screen, setScreen] = useState<Screen>(state.account ? 'login' : 'welcome');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;

  // Terms
  const [agreed, setAgreed] = useState<Record<TermKey, boolean>>({ service: false, privacy: false, unique: false });
  const [openTerm, setOpenTerm] = useState<TermKey | null>(null);
  const allAgreed = TERMS.every((item) => agreed[item.key]);
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
  // ID, then the face: matched by the biometric check with its own consent, or by a video call for those who decline it.
  const [idType, setIdType] = useState<KycAnswers['idType']>('resident');
  const [idScan, setIdScan] = useState<Scan>('none');
  const [idOutcome, setIdOutcome] = useState<IdOutcome>('original');
  const [idProblem, setIdProblem] = useState<keyof typeof ID_PROBLEMS | null>(null);
  const [match, setMatch] = useState<KycAnswers['match']>('face');
  const [faceConsent, setFaceConsent] = useState(false);
  const [faceScan, setFaceScan] = useState<Scan>('none');
  // 1원 account check: proves the holder is the person verified above; the account is never used for money.
  const [bank, setBank] = useState('');
  const [bankAccount, setBankAccount] = useState('');
  const [bankCode, setBankCode] = useState<string | null>(null);
  const [bankInput, setBankInput] = useState('');
  const [bankTries, setBankTries] = useState(0);
  const [bankSends, setBankSends] = useState(0);
  const bankVerified = bankCode !== null && bankInput === bankCode;
  // Customer questions, and enhanced due diligence when they call for it.
  const [occupation, setOccupation] = useState('');
  const [purpose, setPurpose] = useState('');
  const [source, setSource] = useState('');
  const [homeAddress, setHomeAddress] = useState<ShippingAddress | null>(null);
  const [addressOpen, setAddressOpen] = useState(false);
  const [owner, setOwner] = useState<'self' | 'other' | null>(null);
  const [pep, setPep] = useState<'yes' | 'no' | null>(null);
  const [evidence, setEvidence] = useState('');
  const [evidenceScan, setEvidenceScan] = useState<Scan>('none');
  const [reviewOutcome, setReviewOutcome] = useState<'approved' | 'rejected'>('approved');
  const [review, setReview] = useState<Scan | 'rejected'>('none');
  const [appealed, setAppealed] = useState(false);
  const extraCheck = needsEvidence({ pep: pep === 'yes', source });
  const risk = extraCheck ? 'high' : 'standard';
  // Sign-in and reset
  const [loginPassword, setLoginPassword] = useState('');
  const [notice, setNotice] = useState('');

  // Scans finish after a moment; the ID and the review read the demo's chosen outcome when they do.
  const outcome = useRef({ id: idOutcome, review: reviewOutcome, appealed });
  outcome.current = { id: idOutcome, review: reviewOutcome, appealed };
  useScan(idScan, useRef(() => {
    const found = outcome.current.id;
    if (found === 'original') { setIdScan('done'); return; }
    setIdProblem(found); setIdScan('none'); setIdOutcome('original');
  }).current);
  useScan(faceScan, useRef(() => setFaceScan('done')).current);
  useScan(evidenceScan, useRef(() => setEvidenceScan('done')).current);
  useScan(review, useRef(() => setReview(outcome.current.review === 'rejected' && !outcome.current.appealed ? 'rejected' : 'done')).current);
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
    if (age < 19) { setError('만 19세 이상만 가입할 수 있어요.'); return; }
    if (!/^01[016789]\d{7,8}$/.test(phone)) { setError('휴대폰 번호를 확인해 주세요.'); return; }
    setPhoneCode(demoCode()); setPhoneInput(''); setError('');
  }
  function sendBankCode() {
    if (!bank) { setError('은행을 골라 주세요.'); return; }
    if (!/^\d{10,14}$/.test(bankAccount)) { setError('계좌번호 10~14자리를 확인해 주세요.'); return; }
    if (bankSends >= BANK_SENDS) { setError(`1원은 하루 ${BANK_SENDS}번까지 보낼 수 있어요. 내일 다시 해 주세요.`); return; }
    setBankSends(bankSends + 1); setBankTries(0);
    setBankCode(demoCode(4)); setBankInput(''); setError('');
  }
  /** Four wrong digits count as a try; after the last one that 1원 no longer counts and a new one is needed. */
  function typeBankCode(value: string) {
    const digits = value.replace(/\D/g, '').slice(0, 4);
    if (digits.length < 4 || digits === bankCode) { setBankInput(digits); if (digits === bankCode) setError(''); return; }
    const tries = bankTries + 1;
    setBankTries(tries); setBankInput('');
    if (tries >= BANK_TRIES) { setBankCode(null); setError(`${BANK_TRIES}번 틀려서 이 1원으로는 확인할 수 없어요. 1원을 다시 보내 주세요.`); }
    else setError(`숫자가 달라요. ${BANK_TRIES - tries}번 더 틀리면 1원을 다시 보내야 해요.`);
  }
  function submitAnswers() {
    setAppealed(false); setReview('checking'); go('review');
  }
  function appeal() {
    setAppealed(true); setReview('checking'); setError('');
  }

  async function finishSignup() {
    if (busy || !homeAddress) return;
    setBusy(true);
    try {
      const passwordHash = await hashPassword(email, password);
      dispatch({ type: 'COMPLETE_SIGNUP', email: email.trim(), passwordHash, name: name.trim(), birthDate, phone,
        kyc: { idType, occupation, purpose, source, match, address: homeAddress, pep: pep === 'yes', evidence: extraCheck ? evidence : null } });
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
      setNotice('비밀번호를 바꿨어요. 새 비밀번호로 로그인해 주세요.');
      go('login');
    } catch (failure) { setError(failure instanceof Error ? failure.message : '입력한 내용을 확인해 주세요.'); }
    finally { setBusy(false); }
  }

  const stepIndex = SIGNUP_STEPS.findIndex(([key]) => key === (screen === 'evidence' ? 'questions' : screen));
  const progress = stepIndex >= 0 && <div className="onboarding-progress"><div className="onboarding-bars" aria-hidden="true">{SIGNUP_STEPS.map(([key], index) => <span key={key} className={index <= stepIndex ? 'filled' : ''} />)}</div><p>가입 {stepIndex + 1}/{SIGNUP_STEPS.length} · {SIGNUP_STEPS[stepIndex][1]}</p></div>;
  const errorBox = error && <p className="form-error" role="alert">{error}</p>;
  const field = (key: string, label: string, input: ReactNode, aside?: ReactNode) => <div className="form-field"><div className="onboarding-label-row"><label htmlFor={id(key)}>{label}</label>{aside}</div>{input}</div>;
  const select = (key: string, label: string, value: string, options: readonly string[], set: (value: string) => void, disabled = false) => field(key, label,
    <select id={id(key)} data-testid={`kyc-${key}`} value={value} disabled={disabled} onChange={(event) => { set(event.target.value); setError(''); }}><option value="" disabled>선택해 주세요</option>{options.map((item) => <option key={item} value={item}>{item}</option>)}</select>);
  const choice = <T extends string>(legend: string, value: T | null, options: [T, string][], set: (value: T) => void, testId: string) => <fieldset className="onboarding-choice"><legend>{legend}</legend><div>{options.map(([key, text]) => <button type="button" key={key} data-testid={`${testId}-${key}`} className={value === key ? 'selected' : ''} aria-pressed={value === key} onClick={() => { set(key); setError(''); }}>{text}</button>)}</div></fieldset>;
  const required = <em className="onboarding-required">필수</em>;
  const back = (target: Screen, label = '이전') => <button type="button" className="onboarding-back" onClick={() => go(target)}><ChevronLeft size={18} />{label}</button>;
  const emailBlock = (prefix: 'signup' | 'reset') => <>
    {field(`${prefix}-email`, '이메일', <input id={id(`${prefix}-email`)} data-testid={`${prefix}-email`} type="email" inputMode="email" autoComplete="email" value={email} placeholder="name@example.com" disabled={emailVerified} onChange={(event) => { setEmail(event.target.value); setEmailCode(null); setError(''); }} />,
      emailVerified ? <span className="onboarding-done" data-testid={`${prefix}-email-verified`}><Check size={15} strokeWidth={2.6} />인증 완료</span>
        : prefix === 'signup' ? <button type="button" className="onboarding-text-button" data-testid="signup-email-sample" onClick={() => { setEmail(SAMPLE.email); setEmailCode(null); setError(''); }}>체험용 주소 넣기</button> : undefined)}
    {!emailVerified && (emailCode ? <>
      <p className="onboarding-code-note" data-testid={`${prefix}-demo-code`}>체험판이라 메일은 보내지 않아요. 인증 코드 <strong>{emailCode}</strong></p>
      {field(`${prefix}-code`, '인증 코드 6자리', <input id={id(`${prefix}-code`)} data-testid={`${prefix}-code`} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={emailInput} onChange={(event) => setEmailInput(event.target.value.replace(/\D/g, ''))} />, <button type="button" className="onboarding-text-button" onClick={sendEmailCode}>다시 받기</button>)}
    </> : <button type="button" className="btn neutral block" data-testid={`${prefix}-send-code`} disabled={!EMAIL_PATTERN.test(email.trim())} onClick={sendEmailCode}>인증 코드 받기</button>)}
  </>;
  const passwordBlock = (prefix: 'signup' | 'reset') => emailVerified && <>
    {field(`${prefix}-password`, prefix === 'signup' ? '비밀번호' : '새 비밀번호', <input id={id(`${prefix}-password`)} data-testid={`${prefix}-password`} type="password" autoComplete="new-password" value={password} onChange={(event) => { setPassword(event.target.value); setError(''); }} aria-invalid={Boolean(passwordProblem)} />)}
    <p className={`onboarding-hint${passwordProblem ? ' bad' : ''}`}>{passwordProblem || '영문과 숫자를 섞어 8자 이상'}</p>
    {field(`${prefix}-password-confirm`, '비밀번호 확인', <input id={id(`${prefix}-password-confirm`)} data-testid={`${prefix}-password-confirm`} type="password" autoComplete="new-password" value={confirm} onChange={(event) => { setConfirm(event.target.value); setError(''); }} />)}
    {confirm && password !== confirm && <p className="onboarding-hint bad">비밀번호가 서로 달라요.</p>}
  </>;

  let body: ReactNode;
  if (screen === 'welcome') {
    body = <div className="onboarding-form welcome">
      <CardHero className="onboarding-hero" alt="Aqua 카드 두 장" />
      <h1 ref={heading} tabIndex={-1}>코인을 보내면<br />원화로 쓰는 카드</h1>
      <p className="onboarding-lead">받은 코인은 바로 원화 스테이블 잔액이 돼요. 카드로 쓸&nbsp;때마다 1%를 돌려받고, 리저브에 둔 돈에는 1초마다 보상이 쌓여요.</p>
      <div className="onboarding-actions"><button type="button" className="btn primary block" data-testid="auth-signup" onClick={() => go('terms')}>시작하기</button><button type="button" className="btn neutral block" data-testid="auth-login" onClick={() => go('login')}>로그인</button></div>
    </div>;
  } else if (screen === 'terms') {
    body = <form className="onboarding-form" noValidate onSubmit={(event) => { event.preventDefault(); if (allAgreed) go('account'); }}>
      {back('welcome', '처음으로')}
      <h1 ref={heading} tabIndex={-1}>약관에 동의해 주세요</h1>
      <p className="onboarding-lead">Aqua를 쓰려면 아래 약관에 모두 동의해야 해요.</p>
      <label className="onboarding-consent terms-all"><input type="checkbox" data-testid="terms-all" checked={allAgreed} onChange={(event) => setAgreed({ service: event.target.checked, privacy: event.target.checked, unique: event.target.checked })} /><span>모두 동의해요</span></label>
      <ul className="terms-list">{TERMS.map((item) => <li key={item.key}>
        <label className="onboarding-consent"><input type="checkbox" data-testid={`terms-${item.key}`} checked={agreed[item.key]} onChange={(event) => setAgreed((current) => ({ ...current, [item.key]: event.target.checked }))} /><span>{required}{item.title}</span></label>
        <button type="button" className="terms-toggle" data-testid={`terms-toggle-${item.key}`} aria-expanded={openTerm === item.key} aria-controls={id(`term-${item.key}`)} onClick={() => setOpenTerm(openTerm === item.key ? null : item.key)}>{openTerm === item.key ? '접기' : '보기'}</button>
        {openTerm === item.key && <p className="terms-detail" id={id(`term-${item.key}`)} data-testid={`terms-detail-${item.key}`}>{item.detail}</p>}
      </li>)}</ul>
      <section className="terms-notice" data-testid="terms-notice"><strong>법에 따라 확인하는 정보</strong><p>실명, 주민등록번호, 주소, 연락처는 특정금융정보법에 따라 꼭 확인해야 해서 동의를 따로 받지 않아요. 거래가 끝난 뒤 5년 동안 보관해요.</p></section>
      <p className="onboarding-hint">얼굴 정보는 신분증 단계에서 따로 여쭤봐요.</p>
      <div className="onboarding-actions"><button type="submit" className="btn primary block" data-testid="terms-next" disabled={!allAgreed}>동의하고 계속하기</button></div>
    </form>;
  } else if (screen === 'account') {
    body = <form className="onboarding-form" noValidate onSubmit={(event) => { event.preventDefault(); if (emailVerified && passwordsReady) go('phone'); }}>
      {back('terms')}
      <h1 ref={heading} tabIndex={-1}>계정 만들기</h1>
      <p className="onboarding-lead">로그인하고 출금을 확인할 때 쓰는 이메일이에요.</p>
      {emailBlock('signup')}
      {passwordBlock('signup')}
      {errorBox}
      <div className="onboarding-actions"><button type="submit" className="btn primary block" data-testid="signup-next" disabled={!emailVerified || !passwordsReady}>다음</button></div>
    </form>;
  } else if (screen === 'phone') {
    body = <form className="onboarding-form" noValidate onSubmit={(event) => { event.preventDefault(); if (phoneVerified) go('identity'); }}>
      {back('account')}
      <h1 ref={heading} tabIndex={-1}>휴대폰 본인인증</h1>
      <p className="onboarding-lead">본인 명의 휴대폰으로 인증해 주세요. 카드를 만들고 충전하려면 법에 따라 본인확인이 필요해요.</p>
      {field('name', '이름', <input id={id('name')} data-testid="kyc-name" autoComplete="name" maxLength={30} value={name} disabled={phoneVerified} onChange={(event) => { setName(event.target.value); setPhoneCode(null); setError(''); }} />,
        !phoneVerified ? <button type="button" className="onboarding-text-button" data-testid="kyc-sample" onClick={() => { setName(SAMPLE.name); setBirth(SAMPLE.birth); setPhone(SAMPLE.phone); setPhoneCode(null); setError(''); }}>샘플 정보 채우기</button> : undefined)}
      {field('birth', '생년월일 8자리', <input id={id('birth')} data-testid="kyc-birth" inputMode="numeric" maxLength={8} placeholder="19950412" value={birth} disabled={phoneVerified} onChange={(event) => { setBirth(event.target.value.replace(/\D/g, '')); setPhoneCode(null); setError(''); }} />)}
      <fieldset className="onboarding-choice"><legend>통신사</legend><div>{CARRIERS.map((item) => <button type="button" key={item} className={carrier === item ? 'selected' : ''} aria-pressed={carrier === item} disabled={phoneVerified} onClick={() => setCarrier(item)}>{item}</button>)}</div></fieldset>
      {field('phone', '휴대폰 번호', <input id={id('phone')} data-testid="kyc-phone" inputMode="numeric" autoComplete="tel-national" maxLength={11} placeholder="01012345678" value={phone} disabled={phoneVerified} onChange={(event) => { setPhone(event.target.value.replace(/\D/g, '')); setPhoneCode(null); setError(''); }} />,
        phoneVerified ? <span className="onboarding-done" data-testid="kyc-phone-verified"><Check size={15} strokeWidth={2.6} />인증 완료</span> : undefined)}
      {!phoneVerified && (phoneCode ? <>
        <p className="onboarding-code-note" data-testid="kyc-demo-code">체험판이라 문자는 보내지 않아요. 인증번호 <strong>{phoneCode}</strong></p>
        {field('phone-code', '인증번호 6자리', <input id={id('phone-code')} data-testid="kyc-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={phoneInput} onChange={(event) => setPhoneInput(event.target.value.replace(/\D/g, ''))} />, <button type="button" className="onboarding-text-button" onClick={sendPhoneCode}>다시 받기</button>)}
      </> : <button type="button" className="btn neutral block" data-testid="kyc-send-code" onClick={sendPhoneCode}>인증번호 받기</button>)}
      {errorBox}
      <div className="onboarding-actions"><button type="submit" className="btn primary block" data-testid="kyc-next" disabled={!phoneVerified}>다음</button></div>
    </form>;
  } else if (screen === 'identity') {
    const idDone = idScan === 'done';
    const faceDone = faceScan === 'done';
    body = <div className="onboarding-form">
      {back('phone')}
      <h1 ref={heading} tabIndex={-1}>신분증과 얼굴 확인</h1>
      <p className="onboarding-lead">신분증을 찍고, 신분증 사진과 같은 사람인지 확인해요.</p>
      <fieldset className="onboarding-choice"><legend>신분증</legend><div>{(Object.keys(ID_TYPES) as KycAnswers['idType'][]).map((key) => <button type="button" key={key} data-testid={`kyc-id-${key}`} className={idType === key ? 'selected' : ''} aria-pressed={idType === key} disabled={idScan !== 'none'} onClick={() => setIdType(key)}>{ID_TYPES[key]}</button>)}</div></fieldset>
      <div className={`onboarding-check${idDone ? ' done' : ''}`}>
        <strong>{ID_TYPES[idType]} 촬영</strong>
        {idDone ? <span className="onboarding-done" data-testid="kyc-id-done"><Check size={18} strokeWidth={2.6} />완료</span> : <button type="button" className="btn small neutral" data-testid="kyc-id-scan" disabled={idScan === 'checking'} onClick={() => { setIdProblem(null); setIdScan('checking'); }}>{idScan === 'checking' ? '확인 중' : idProblem ? '다시 찍기' : '촬영하기'}</button>}
        <CheckText current={idScan === 'checking' ? 1 : 0} steps={['빛이 반사되지 않게 네 모서리가 다 보이도록 찍어 주세요.', '진짜 신분증인지 확인하고 있어요.']}
          done={idDone ? `${name} · ${birth.slice(0, 4)}.${birth.slice(4, 6)}.${birth.slice(6, 8)}` : idProblem && idScan === 'none' ? ID_PROBLEMS[idProblem] : null} bad={!idDone && idProblem !== null} testId={!idDone && idProblem ? 'kyc-id-rejected' : undefined} />
      </div>
      {!idDone && <Simulation label="촬영 결과 체험" value={idOutcome} options={[['original', '원본 신분증'], ['copy', '복사본·화면'], ['masked', '일부를 가림']]} onChange={setIdOutcome} testId="kyc-id-outcome" />}
      {match === 'face' ? <>
        <div className={`onboarding-check${faceDone ? ' done' : ''}`}>
          <strong>얼굴 확인</strong>
          {faceDone ? <span className="onboarding-done" data-testid="kyc-face-done"><Check size={18} strokeWidth={2.6} />완료</span> : <button type="button" className="btn small neutral" data-testid="kyc-face-scan" disabled={!idDone || !faceConsent || faceScan === 'checking'} onClick={() => setFaceScan('checking')}>{faceScan === 'checking' ? '확인 중' : '촬영하기'}</button>}
          <CheckText current={faceScan === 'checking' ? 3 : !idDone ? 0 : faceConsent ? 2 : 1} steps={['신분증부터 찍어 주세요.', '아래 얼굴 정보 처리에 동의해 주세요.', '안내에 따라 고개를 천천히 돌려 주세요.', '얼굴을 맞춰 보고 있어요.']} done={faceDone ? '신분증 사진과 같은 사람이에요.' : null} />
        </div>
        {!faceDone && <>
          <label className="onboarding-consent"><input type="checkbox" data-testid="kyc-face-consent" checked={faceConsent} disabled={faceScan === 'checking'} onChange={(event) => setFaceConsent(event.target.checked)} /><span>{required}얼굴 사진과 얼굴 특징 정보(민감정보)를 본인확인에만 쓰는 데 동의해요.</span></label>
          <button type="button" className="onboarding-text-button" data-testid="kyc-video-switch" disabled={faceScan === 'checking'} onClick={() => { setMatch('video'); setFaceScan('none'); }}>얼굴 확인 대신 영상통화로 할게요</button>
        </>}
      </> : <>
        <div className={`onboarding-check${faceDone ? ' done' : ''}`}>
          <strong>영상통화 확인</strong>
          {faceDone ? <span className="onboarding-done" data-testid="kyc-video-done"><Check size={18} strokeWidth={2.6} />완료</span> : <button type="button" className="btn small neutral" data-testid="kyc-video-call" disabled={!idDone || faceScan === 'checking'} onClick={() => setFaceScan('checking')}>{faceScan === 'checking' ? '연결 중' : '연결하기'}</button>}
          <CheckText current={faceScan === 'checking' ? 2 : idDone ? 1 : 0} steps={['신분증부터 찍어 주세요.', '상담원이 영상으로 신분증과 얼굴을 확인해요. 5분쯤 걸려요.', '상담원과 연결하고 있어요.']} done={faceDone ? '상담원이 신분증과 얼굴을 확인했어요.' : null} />
        </div>
        {!faceDone && <button type="button" className="onboarding-text-button" data-testid="kyc-face-switch" disabled={faceScan === 'checking'} onClick={() => { setMatch('face'); setFaceScan('none'); }}>얼굴 확인으로 할게요</button>}
      </>}
      <p className="onboarding-hint">체험판이라 카메라는 켜지 않고 과정만 보여 드려요. 실제 앱은 신분증에서 주민등록번호를 읽어 암호화해 보관해요.</p>
      <div className="onboarding-actions"><button type="button" className="btn primary block" data-testid="kyc-id-next" disabled={!idDone || !faceDone} onClick={() => go('bank')}>다음</button></div>
    </div>;
  } else if (screen === 'bank') {
    body = <form className="onboarding-form" noValidate onSubmit={(event) => { event.preventDefault(); if (bankVerified) go('questions'); }}>
      {back('identity')}
      <h1 ref={heading} tabIndex={-1}>본인 계좌 확인</h1>
      <p className="onboarding-lead">본인 확인용으로 1원을 보내요. 이 계좌로 돈을 주고받지는 않아요.</p>
      {select('bank', '은행', bank, BANKS, (value) => { setBank(value); setBankCode(null); }, bankVerified)}
      {field('account', '계좌번호', <input id={id('account')} data-testid="kyc-account" inputMode="numeric" autoComplete="off" maxLength={14} placeholder="숫자만 입력" value={bankAccount} disabled={bankVerified} onChange={(event) => { setBankAccount(event.target.value.replace(/\D/g, '')); setBankCode(null); setError(''); }} />,
        bankVerified ? <span className="onboarding-done" data-testid="kyc-bank-verified"><Check size={15} strokeWidth={2.6} />인증 완료</span>
          : <button type="button" className="onboarding-text-button" data-testid="kyc-bank-sample" onClick={() => { setBank(SAMPLE.bank); setBankAccount(SAMPLE.account); setBankCode(null); setError(''); }}>샘플 계좌 채우기</button>)}
      <p className="onboarding-hint" data-testid="kyc-bank-hint">예금주가 {name.trim()}님인 계좌만 확인할 수 있어요.<br />실제 계좌는 넣지 말고 샘플 계좌를 써&nbsp;주세요.</p>
      {!bankVerified && <BankGuide code={bankCode} now={Date.now() + state.clockOffsetMs} />}
      {!bankVerified && (bankCode ? <>
        {field('bank-code', '입금자명 숫자 4자리', <input id={id('bank-code')} data-testid="kyc-bank-code" inputMode="numeric" autoComplete="off" maxLength={4} value={bankInput} onChange={(event) => typeBankCode(event.target.value)} />, <button type="button" className="onboarding-text-button" data-testid="kyc-bank-resend" onClick={sendBankCode}>다시 보내기</button>)}
      </> : <button type="button" className="btn neutral block" data-testid="kyc-bank-send" onClick={sendBankCode}>1원 보내기</button>)}
      {errorBox}
      <div className="onboarding-actions"><button type="submit" className="btn primary block" data-testid="kyc-bank-next" disabled={!bankVerified}>다음</button></div>
    </form>;
  } else if (screen === 'questions') {
    const ready = occupation && purpose && source && homeAddress && owner === 'self' && pep !== null;
    body = <form className="onboarding-form" noValidate onSubmit={(event) => { event.preventDefault(); if (!ready) return; if (extraCheck) go('evidence'); else submitAnswers(); }}>
      {back('bank')}
      <h1 ref={heading} tabIndex={-1}>몇 가지만 여쭤볼게요</h1>
      <p className="onboarding-lead">가상자산을 다루는 서비스라 법에 따라 주소와 거래 목적, 자금&nbsp;출처를 확인해요.</p>
      {select('occupation', '직업', occupation, OCCUPATIONS, setOccupation)}
      {select('purpose', '주로 쓰려는 목적', purpose, PURPOSES, setPurpose)}
      {select('source', '자금 출처', source, FUND_SOURCES, (value) => { setSource(value); setEvidence(''); setEvidenceScan('none'); })}
      <div className="form-field"><div className="onboarding-label-row"><span className="onboarding-label">집 주소</span>{homeAddress && <button type="button" className="onboarding-text-button" data-testid="kyc-address-open" onClick={() => setAddressOpen(true)}>바꾸기</button>}</div>
        {homeAddress ? <p className="onboarding-address" data-testid="kyc-address-line">{addressLine(homeAddress)}<small>{homeAddress.zip}</small></p>
          : <button type="button" className="btn neutral block" data-testid="kyc-address-open" onClick={() => setAddressOpen(true)}>주소 찾기</button>}</div>
      {choice('누구를 위해 거래하나요?', owner, [['self', '나를 위해'], ['other', '다른 사람을 위해']], setOwner, 'kyc-owner')}
      {owner === 'other' && <p className="onboarding-block" role="alert" data-testid="kyc-owner-blocked">다른 사람을 위해 거래하는 계정은 만들 수 없어요. 본인이 직접 쓰는 계정만 열 수 있어요.</p>}
      {choice('외국 정부나 국제기구의 고위직이었거나 그 가족인가요?', pep, [['no', '아니요'], ['yes', '예']], (value) => { setPep(value); setEvidence(''); setEvidenceScan('none'); }, 'kyc-pep')}
      <p className="onboarding-hint">외국의 국가원수, 장관, 고위 법관·군인, 국제기구 임원과 그 가족, 가까운 사람이 해당해요.</p>
      <Simulation label="심사 결과 체험" value={reviewOutcome} options={[['approved', '승인'], ['rejected', '자동 거절']]} onChange={setReviewOutcome} testId="kyc-review-outcome" />
      {errorBox}
      <div className="onboarding-actions"><button type="submit" className="btn primary block" data-testid="kyc-submit" disabled={!ready}>{extraCheck ? '다음' : '제출하기'}</button></div>
      {addressOpen && <AddressSheet initial={homeAddress} holder={null} title="집 주소" lead="고객확인에 쓰는 주소예요. 카드를 받을 주소로도 고를 수 있어요." confirmLabel="이 주소로 할게요"
        onClose={() => setAddressOpen(false)} onSave={(address) => { setHomeAddress(address); setAddressOpen(false); setError(''); }} />}
    </form>;
  } else if (screen === 'evidence') {
    const evidenceDone = evidenceScan === 'done';
    body = <form className="onboarding-form" noValidate onSubmit={(event) => { event.preventDefault(); if (evidenceDone) submitAnswers(); }}>
      {back('questions')}
      <h1 ref={heading} tabIndex={-1}>추가 확인이 필요해요</h1>
      <p className="onboarding-lead">{pep === 'yes' ? '외국 정부나 국제기구의 고위직이거나 그 가족이면 법에 따라 자금 출처를 서류로 더 확인해요.' : '자금 출처를 기타로 고르셨어요. 어디서 생긴 돈인지 서류로 확인해요.'}</p>
      {select('evidence', '올릴 서류', evidence, EVIDENCE, (value) => { setEvidence(value); setEvidenceScan('none'); }, evidenceScan !== 'none')}
      <div className={`onboarding-check${evidenceDone ? ' done' : ''}`}>
        <strong>서류 올리기</strong>
        {evidenceDone ? <span className="onboarding-done" data-testid="kyc-evidence-done"><Check size={18} strokeWidth={2.6} />완료</span> : <button type="button" className="btn small neutral" data-testid="kyc-evidence-upload" disabled={!evidence || evidenceScan === 'checking'} onClick={() => setEvidenceScan('checking')}>{evidenceScan === 'checking' ? '올리는 중' : '올리기'}</button>}
        <CheckText current={evidenceScan === 'checking' ? 2 : evidence ? 1 : 0} steps={['올릴 서류를 먼저 골라 주세요.', '서류를 사진이나 PDF로 올려 주세요.', '서류를 올리고 있어요.']} done={evidenceDone ? `${josa(evidence, '을', '를')} 받았어요.` : null} />
      </div>
      {pep === 'yes' && <p className="onboarding-hint">고위 경영진이 승인해야 가입이 끝나요. 보통 1~2영업일 걸리는데 체험판에서는 바로 넘어가요.</p>}
      <p className="onboarding-hint">체험판이라 파일은 받지 않아요.</p>
      <div className="onboarding-actions"><button type="submit" className="btn primary block" data-testid="kyc-evidence-submit" disabled={!evidenceDone}>제출하기</button></div>
    </form>;
  } else if (screen === 'review') {
    const rejected = review === 'rejected';
    body = <div className="onboarding-form review" data-testid="kyc-review" data-status={review}>
      {review === 'done' ? <span className="onboarding-review-icon" aria-hidden="true"><Check size={28} strokeWidth={2.4} /></span>
        : rejected ? <span className="onboarding-review-icon muted" aria-hidden="true"><CircleAlert size={28} strokeWidth={2.2} /></span> : <span className="onboarding-spinner" aria-hidden="true" />}
      <h1 ref={heading} tabIndex={-1}>{review === 'done' ? '가입을 마쳤어요' : rejected ? '가입을 승인하지 못했어요' : appealed ? '담당자가 다시 보고 있어요' : '확인하고 있어요'}</h1>
      <p className="onboarding-lead">{review === 'done' ? `${name}님, 이제 코인을 보내 충전하고 카드를 만들 수 있어요.`
        : rejected ? '자동 심사에서 승인되지 않았어요. 사람이 다시 보도록 요청할 수 있어요.'
        : appealed ? '보통 1~2영업일 걸리고 결과는 메일로 알려 드려요. 체험판에서는 바로 끝나요.' : '보통 몇 분 걸리는데 체험판에서는 바로 끝나요.'}</p>
      {review === 'done' && <p className="onboarding-hint" data-testid="kyc-recheck">{appealed ? '담당자가 다시 보고 승인했어요. ' : ''}고객확인은 {RECHECK_YEARS[risk]}년마다 다시 해요.</p>}
      {errorBox}
      {review === 'done' && <div className="onboarding-actions"><button type="button" className="btn primary block" data-testid="signup-finish" disabled={busy} onClick={finishSignup}>시작하기</button></div>}
      {rejected && <div className="onboarding-actions"><button type="button" className="btn primary block" data-testid="kyc-appeal" onClick={appeal}>다시 검토 요청</button><button type="button" className="btn neutral block" data-testid="kyc-review-back" onClick={() => go('questions')}>답변 고치기</button></div>}
    </div>;
  } else if (screen === 'login') {
    body = <form className="onboarding-form" noValidate onSubmit={signIn}>
      {!state.account && back('welcome', '처음으로')}
      <h1 ref={heading} tabIndex={-1}>로그인</h1>
      {notice && <p className="onboarding-code-note" role="status">{notice}</p>}
      {!state.account && <p className="onboarding-lead">이 브라우저에는 가입한 계정이 없어요. 먼저 가입해 주세요.</p>}
      {field('login-email', '이메일', <input id={id('login-email')} data-testid="login-email" type="email" inputMode="email" autoComplete="email" value={email} onChange={(event) => { setEmail(event.target.value); setError(''); }} />)}
      {field('login-password', '비밀번호', <input id={id('login-password')} data-testid="login-password" type="password" autoComplete="current-password" value={loginPassword} onChange={(event) => { setLoginPassword(event.target.value); setError(''); }} />)}
      {errorBox}
      <div className="onboarding-actions"><button type="submit" className="btn primary block" data-testid="login-submit" disabled={busy || !email || !loginPassword}>로그인</button>
        <div className="onboarding-links"><button type="button" data-testid="login-forgot" onClick={() => { setEmailCode(null); setEmailInput(''); setPassword(''); setConfirm(''); setNotice(''); go('reset'); }}>비밀번호 찾기</button>{!state.account && <button type="button" data-testid="login-signup" onClick={() => go('terms')}>가입하기</button>}</div></div>
    </form>;
  } else {
    body = <form className="onboarding-form" noValidate onSubmit={resetPassword}>
      {back('login', '로그인으로')}
      <h1 ref={heading} tabIndex={-1}>비밀번호 찾기</h1>
      <p className="onboarding-lead">가입한 이메일로 받은 코드를 넣고 새&nbsp;비밀번호를 정해요.</p>
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
      <p className="onboarding-note">체험판이에요. 실제 이름, 휴대폰 번호, 주소, 신분증, 계좌&nbsp;정보는 넣지 마세요. 입력한 내용은 이&nbsp;브라우저에만 남고 비밀번호는 해시로만 저장돼요.</p>
    </div>
  </main>;
}
