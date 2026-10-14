import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { AtSign, Check, ChevronLeft, ChevronRight, QrCode as QrIcon, Search, Wallet, X } from 'lucide-react';
import { useModal } from './useModal';
import QrCode from './QrCode';
import { AmountInput } from './ui';
import { EMAIL_SEARCH, findMember, findMemberByEmail, findMemberByPhone, formatPhone, maskName, MEMBERS, normalizeTag, PHONE_SEARCH, phoneDigits, TAG_PATTERN, tagLink, type Member } from '../lib/directory';
import { money, particle, shortDate, won } from '../lib/format';
import { POLICY } from '../lib/policy';
import type { Action, AppState } from '../lib/types';
import './InternalTransferDialog.css';
import './SendSheet.css';

type Step = 'choose' | 'tag' | 'scan' | 'amount' | 'review' | 'done';
type Origin = 'tag' | 'phone' | 'email' | 'scan';
const FOUND_BY: Record<Origin, string> = { tag: '', phone: ' · 휴대폰 번호로 찾음', email: ' · 이메일로 찾음', scan: ' · QR로 찾음' };

/** Codes the demo can "scan": the camera stays off, so a member's code is picked instead. */
const SCAN_SAMPLES = MEMBERS.filter((member) => ['minji.k', 'junho', 'haneul', 'aqua.coffee'].includes(member.tag));
/** A demo number and email shown as hints; both belong to fictional members. */
const SAMPLE_PHONE = MEMBERS.find((member) => member.phone)?.phone ?? '';
const SAMPLE_EMAIL = MEMBERS.find((member) => member.email)?.email ?? '';

/** Send to another Aqua member by tag, phone number, email or QR code (free, instant), or hand over to the on-chain send flow. */
export default function SendSheet({ state, onClose, onWallet, onReceive, dispatch }: {
  state: AppState; onClose: () => void; onWallet: () => void; onReceive: () => void; dispatch: (action: Action) => AppState;
}) {
  const [step, setStep] = useState<Step>('choose');
  const [origin, setOrigin] = useState<Origin>('tag');
  const [query, setQuery] = useState('');
  const [member, setMember] = useState<Member | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [sentAt, setSentAt] = useState(0);
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const uid = useId();
  useModal(panel, onClose, heading);
  const tagInput = useRef<HTMLInputElement>(null);
  const amountInput = useRef<HTMLInputElement>(null);
  const firstStep = useRef(true);
  // Every step change moves focus into the new step so keyboard and screen-reader users never land on the page behind.
  useEffect(() => {
    if (firstStep.current) { firstStep.current = false; return; }
    const target = step === 'tag' ? tagInput.current : step === 'amount' ? amountInput.current : heading.current;
    target?.focus();
  }, [step]);
  const amount = Number(value);
  const digits = phoneDigits(query);
  // Three or more digits read as a phone number, and text@ as an email: those only match in full, never as you type.
  const phoneQuery = /^\d{3,}$/.test(digits);
  const email = query.trim().toLowerCase();
  const emailQuery = !phoneQuery && /^[^@\s]+@/.test(email);
  const typed = phoneQuery || emailQuery ? '' : normalizeTag(query);
  const matches = phoneQuery || emailQuery ? [] : typed ? MEMBERS.filter((item) => item.tag.includes(typed) || item.name.includes(query.trim())) : MEMBERS;
  const amountIssue = value.trim() === '' ? '' : !Number.isSafeInteger(amount) || amount < POLICY.minimumTopup ? '1,000원 이상 원 단위로 넣어 주세요.' : amount > state.spend ? '잔액보다 많이 보낼 수 없어요.' : '';
  const titles: Record<Step, string> = { choose: '보내기', tag: '누구에게 보낼까요?', scan: 'QR 코드 찍기', amount: '얼마를 보낼까요?', review: '이대로 보낼까요?', done: '보냈어요' };

  function pick(next: Member, from: Origin) { setMember(next); setOrigin(from); setError(''); setStep('amount'); }
  function find(event: FormEvent) {
    event.preventDefault();
    if (phoneQuery) {
      if (!PHONE_SEARCH.test(digits)) { setError('휴대폰 번호를 끝까지 넣어 주세요.'); return; }
      if (state.account && digits === state.account.phone) { setError('내 번호예요. 받는 사람의 번호를 넣어 주세요.'); return; }
      const found = findMemberByPhone(digits);
      if (!found) { setError('이 번호로 찾을\u00a0수 있는 회원이 없어요. 상대가 휴대폰\u00a0번호로 찾기를 켰는지 확인해 주세요.'); return; }
      pick(found, 'phone');
      return;
    }
    if (emailQuery) {
      if (!EMAIL_SEARCH.test(email)) { setError('이메일 주소를 끝까지 넣어 주세요.'); return; }
      if (state.account && email === state.account.email) { setError('내 이메일이에요. 받는 사람의 이메일을 넣어 주세요.'); return; }
      const found = findMemberByEmail(email);
      if (!found) { setError('이 이메일로 찾을\u00a0수 있는 회원이 없어요. 상대가 이메일로 찾기를 켰는지 확인해 주세요.'); return; }
      pick(found, 'email');
      return;
    }
    if (state.account && typed === state.account.tag) { setError('내 태그예요. 받는 사람의 태그를 넣어 주세요.'); return; }
    if (!TAG_PATTERN.test(typed)) { setError('태그는 영문 소문자, 숫자, 점(.), 밑줄(_)로 3~20자예요.'); return; }
    const found = findMember(typed);
    if (!found) { setError(`@${typed} 회원을 찾지 못했어요. 태그를 다시 확인해 주세요.`); return; }
    pick(found, 'tag');
  }
  function send() {
    if (!member) return;
    try {
      dispatch({ type: 'SEND_TO_MEMBER', tag: member.tag, amount });
      setSentAt(Date.now());
      setStep('done');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '보내지 못했어요. 다시 시도해 주세요.');
    }
  }
  const back = () => { setError(''); setStep(step === 'review' ? 'amount' : step === 'amount' ? origin === 'scan' ? 'scan' : 'tag' : 'choose'); };
  const findLabel = phoneQuery ? PHONE_SEARCH.test(digits) ? `${formatPhone(digits)} 찾기` : '번호로 찾기' : emailQuery ? '이메일로 찾기' : `@${typed || '태그'} 찾기`;

  return <div className="itd-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="internal-transfer-dialog send-sheet" ref={panel} role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`} tabIndex={-1} data-testid="send-sheet" data-step={step}>
      <header className="itd-header">
        <div className="send-head">{step !== 'choose' && step !== 'done' && <button type="button" className="itd-close send-back" aria-label="이전" onClick={back}><ChevronLeft size={22} /></button>}<h2 id={`${uid}-title`} ref={heading} tabIndex={-1}>{titles[step]}</h2></div>
        <button type="button" className="itd-close" aria-label="창 닫기" onClick={onClose}><X size={20} /></button>
      </header>
      <div className="itd-body">
        {step === 'choose' && <div className="send-options">
          <button type="button" className="send-option" data-testid="send-member" onClick={() => setStep('tag')}><span className="send-option-icon" aria-hidden="true"><AtSign size={20} /></span><span><strong>Aqua 회원에게</strong><small>태그, 휴대폰 번호, 이메일로 찾아 바로 보내요. 수수료가 없어요.</small></span><ChevronRight size={18} aria-hidden="true" /></button>
          <button type="button" className="send-option" data-testid="send-scan" onClick={() => setStep('scan')}><span className="send-option-icon" aria-hidden="true"><QrIcon size={20} /></span><span><strong>QR 코드 찍기</strong><small>상대의 Aqua QR을 찍어 보내요.</small></span><ChevronRight size={18} aria-hidden="true" /></button>
          <button type="button" className="send-option" data-testid="send-wallet" onClick={onWallet}><span className="send-option-icon" aria-hidden="true"><Wallet size={20} /></span><span><strong>지갑 주소로</strong><small>신고한 거래소나 내 지갑으로 보내요. 네트워크 비용이 들어요.</small></span><ChevronRight size={18} aria-hidden="true" /></button>
          {state.account && <div className="send-own-tag" data-testid="send-own-tag"><span>내 태그 <strong>@{state.account.tag}</strong></span><button type="button" className="send-own-qr" data-testid="send-own-qr" onClick={onReceive}>내 QR 보기</button></div>}
        </div>}

        {step === 'tag' && <form onSubmit={find} noValidate>
          <label className="send-tag-field send-search-field" htmlFor={`${uid}-tag`}><span aria-hidden="true"><Search size={19} /></span><input ref={tagInput} id={`${uid}-tag`} data-testid="send-tag" value={query} onChange={(event) => { setQuery(event.target.value); setError(''); }} placeholder="태그·이름·휴대폰·이메일" autoComplete="off" autoCapitalize="none" spellCheck={false} /></label>
          {error && <p className="itd-field-error" role="alert">{error}</p>}
          {!typed && !phoneQuery && !emailQuery && <p className="send-demo-note">휴대폰 번호나 이메일 전체로도 찾을&nbsp;수 있어요. 체험용 번호&nbsp;<span className="nowrap">{formatPhone(SAMPLE_PHONE)}</span>, 이메일 <span className="nowrap">{SAMPLE_EMAIL}</span>{particle(SAMPLE_EMAIL, '을', '를')} 넣어 보세요.</p>}
          {phoneQuery ? !error && <p className="send-empty" data-testid="send-phone-hint">{PHONE_SEARCH.test(digits) ? '번호를 다 넣었어요. 찾기를 눌러 주세요.' : '휴대폰 번호는 끝까지 넣어야 찾을\u00a0수 있어요.'} 번호로 찾기를 켠&nbsp;회원만 나와요.</p>
            : emailQuery ? !error && <p className="send-empty" data-testid="send-email-hint">{EMAIL_SEARCH.test(email) ? '이메일 주소를 다 넣었어요. 찾기를 눌러 주세요.' : '이메일 주소는 끝까지 넣어야 찾을\u00a0수 있어요.'} 이메일로 찾기를 켠&nbsp;회원만 나와요.</p> : <>
            {(matches.length > 0 || !error) && <p className="send-list-title">{typed ? '찾은 회원' : '체험용 회원'}</p>}
            {matches.length ? <ul className="send-members">{matches.map((item) => <li key={item.tag}><button type="button" data-testid={`send-pick-${item.tag}`} onClick={() => pick(item, 'tag')}><span className="send-avatar" aria-hidden="true">{item.name.charAt(0)}</span><span><strong>{maskName(item.name)}</strong><small>@{item.tag}</small></span></button></li>)}</ul> : !error && <p className="send-empty">맞는 회원이 없어요. 태그 전체를 넣고 찾기를 눌러 주세요.</p>}
          </>}
          <button type="submit" className="itd-button itd-primary send-find" data-testid="send-find" disabled={phoneQuery || emailQuery ? false : !typed}>{findLabel}</button>
        </form>}

        {step === 'scan' && <div data-testid="send-scan-step">
          <p className="send-scan-lead">앱에서는 카메라로 상대의 QR을 찍어요. 체험판은 카메라를 켜지 않으니, 찍을 QR을 하나 골라 주세요.</p>
          <ul className="send-qr-list">{SCAN_SAMPLES.map((item) => <li key={item.tag}><button type="button" data-testid={`send-scan-${item.tag}`} onClick={() => pick(item, 'scan')}>
            <QrCode value={tagLink(item.tag)} size={104} label={`${maskName(item.name)} QR 코드`} />
            <span><strong>{maskName(item.name)}</strong><small>@{item.tag}</small></span>
          </button></li>)}</ul>
        </div>}

        {step === 'amount' && member && <form onSubmit={(event) => { event.preventDefault(); if (value && !amountIssue) setStep('review'); }} noValidate>
          <div className="send-to"><span className="send-avatar" aria-hidden="true">{member.name.charAt(0)}</span><span><strong>{maskName(member.name)}</strong><small>@{member.tag}{FOUND_BY[origin]}</small></span></div>
          <div className="itd-amount"><label htmlFor={`${uid}-amount`}>보낼 금액</label><div className="itd-input"><AmountInput id={`${uid}-amount`} unit="원" data-testid="send-amount" value={value} onValueChange={(next) => { setValue(next); setError(''); }} autoComplete="off" ref={amountInput} aria-invalid={Boolean(amountIssue)} /></div>
            {amountIssue ? <p className="itd-field-error itd-in-place" role="alert">{amountIssue}</p> : <div className="itd-available"><span>보낼 수 있는 금액</span><strong>{money(state.spend)}</strong></div>}</div>
          <div className="itd-presets">{[10_000, 30_000, 50_000].map((preset) => <button type="button" key={preset} disabled={preset > state.spend} onClick={() => { setValue(String(preset)); setError(''); }}>{won(preset)}원</button>)}</div>
          <button type="submit" className="itd-button itd-primary send-next" data-testid="send-next" disabled={!value || Boolean(amountIssue)}>다음</button>
        </form>}

        {step === 'review' && member && <div>
          <div className="itd-review-amount"><span>{maskName(member.name)}님에게</span><strong data-testid="send-review-amount">{money(amount)}</strong></div>
          <dl className="itd-detail-list"><div><dt>받는 사람</dt><dd>{maskName(member.name)} · @{member.tag}</dd></div><div><dt>수수료</dt><dd>0원</dd></div><div><dt>보낸 뒤 잔액</dt><dd>{money(state.spend - amount)}</dd></div></dl>
          <p className="itd-demo-note">체험판이라 실제로 보내지 않아요.</p>
          {error && <p className="itd-error" role="alert">{error}</p>}
          <button type="button" className="itd-button itd-primary send-next" data-testid="send-confirm" onClick={send}>{money(amount)} 보내기</button>
        </div>}

        {step === 'done' && member && <div className="itd-completed" data-testid="send-done">
          <span className="itd-result-icon"><Check size={27} strokeWidth={1.8} /></span>
          <p>{maskName(member.name)}님에게 보냈어요</p>
          <strong className="itd-result-amount">{money(amount)}</strong>
          <dl className="itd-detail-list itd-receipt-meta"><div><dt>받는 사람</dt><dd>@{member.tag}</dd></div><div><dt>보낸 시각</dt><dd>{shortDate(sentAt)}</dd></div><div><dt>남은 잔액</dt><dd>{money(state.spend)}</dd></div></dl>
          <button type="button" className="itd-button itd-primary send-next" data-testid="send-close" onClick={onClose}>확인</button>
        </div>}
      </div>
    </section>
  </div>;
}
