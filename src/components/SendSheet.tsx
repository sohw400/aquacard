import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { AtSign, Check, ChevronLeft, ChevronRight, Wallet, X } from 'lucide-react';
import { useModal } from './useModal';
import { findMember, maskName, MEMBERS, normalizeTag, ownTag, TAG_PATTERN, type Member } from '../lib/directory';
import { money, shortDate, won } from '../lib/format';
import { POLICY } from '../lib/policy';
import type { Action, AppState } from '../lib/types';
import './InternalTransferDialog.css';
import './SendSheet.css';

type Step = 'choose' | 'tag' | 'amount' | 'review' | 'done';

/** Send to another Aqua member by tag (free, instant) or hand over to the on-chain send flow. */
export default function SendSheet({ state, onClose, onWallet, dispatch, notify }: {
  state: AppState; onClose: () => void; onWallet: () => void;
  dispatch: (action: Action) => AppState; notify: (message: string, type?: 'success' | 'error' | 'info') => void;
}) {
  const [step, setStep] = useState<Step>('choose');
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
  const typed = normalizeTag(query);
  const matches = typed ? MEMBERS.filter((item) => item.tag.includes(typed) || item.name.includes(query.trim())) : MEMBERS;
  const amountIssue = value.trim() === '' ? '' : !Number.isSafeInteger(amount) || amount < POLICY.minimumTopup ? '1,000원 이상 원 단위로 넣어 주세요.' : amount > state.spend ? '잔액보다 많이 보낼 수 없어요.' : '';
  const titles: Record<Step, string> = { choose: '보내기', tag: '누구에게 보낼까요?', amount: '얼마를 보낼까요?', review: '이대로 보낼까요?', done: '보냈어요' };

  function pick(next: Member) { setMember(next); setError(''); setStep('amount'); }
  function findTag(event: FormEvent) {
    event.preventDefault();
    if (!TAG_PATTERN.test(typed)) { setError('태그는 영문 소문자, 숫자, 점(.), 밑줄(_)로 3~20자예요.'); return; }
    const found = findMember(typed);
    if (!found) { setError(`@${typed} 회원을 찾지 못했어요. 태그를 다시 확인해 주세요.`); return; }
    pick(found);
  }
  function send() {
    if (!member) return;
    try {
      dispatch({ type: 'SEND_TO_MEMBER', tag: member.tag, amount });
      setSentAt(Date.now());
      setStep('done');
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : '보내지 못했어요. 다시 시도해 주세요.';
      setError(message);
      notify(message, 'error');
    }
  }
  const back = () => { setError(''); setStep(step === 'review' ? 'amount' : step === 'amount' ? 'tag' : 'choose'); };

  return <div className="itd-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="internal-transfer-dialog send-sheet" ref={panel} role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`} tabIndex={-1} data-testid="send-sheet">
      <header className="itd-header">
        <div className="send-head">{step !== 'choose' && step !== 'done' && <button type="button" className="itd-close send-back" aria-label="이전" onClick={back}><ChevronLeft size={22} /></button>}<h2 id={`${uid}-title`} ref={heading} tabIndex={-1}>{titles[step]}</h2></div>
        <button type="button" className="itd-close" aria-label="창 닫기" onClick={onClose}><X size={20} /></button>
      </header>
      <div className="itd-body">
        {step === 'choose' && <div className="send-options">
          <button type="button" className="send-option" data-testid="send-member" onClick={() => setStep('tag')}><span className="send-option-icon" aria-hidden="true"><AtSign size={20} /></span><span><strong>Aqua 회원에게</strong><small>태그로 바로 보내요. 수수료가 없어요.</small></span><ChevronRight size={18} aria-hidden="true" /></button>
          <button type="button" className="send-option" data-testid="send-wallet" onClick={onWallet}><span className="send-option-icon" aria-hidden="true"><Wallet size={20} /></span><span><strong>지갑 주소로</strong><small>코인으로 바꿔 보내요. 네트워크 비용이 들어요.</small></span><ChevronRight size={18} aria-hidden="true" /></button>
          {state.account && <p className="send-own-tag" data-testid="send-own-tag">내 태그 <strong>@{ownTag(state.account.email)}</strong> · 다른 회원은 이 태그로 바로 보낼 수 있어요.</p>}
        </div>}

        {step === 'tag' && <form onSubmit={findTag} noValidate>
          <label className="send-tag-field" htmlFor={`${uid}-tag`}><span aria-hidden="true">@</span><input ref={tagInput} id={`${uid}-tag`} data-testid="send-tag" value={query} onChange={(event) => { setQuery(event.target.value); setError(''); }} placeholder="태그 또는 이름" autoComplete="off" autoCapitalize="none" spellCheck={false} /></label>
          {error && <p className="itd-error" role="alert">{error}</p>}
          <p className="send-list-title">{typed ? '찾은 회원' : '체험용 회원'}</p>
          {matches.length ? <ul className="send-members">{matches.map((item) => <li key={item.tag}><button type="button" data-testid={`send-pick-${item.tag}`} onClick={() => pick(item)}><span className="send-avatar" aria-hidden="true">{item.name.charAt(0)}</span><span><strong>{maskName(item.name)}</strong><small>@{item.tag}</small></span></button></li>)}</ul> : <p className="send-empty">맞는 회원이 없어요. 태그 전체를 넣고 찾기를 눌러 주세요.</p>}
          <button type="submit" className="itd-button itd-secondary send-find" disabled={!typed}>@{typed || '태그'} 찾기</button>
        </form>}

        {step === 'amount' && member && <form onSubmit={(event) => { event.preventDefault(); if (value && !amountIssue) setStep('review'); }} noValidate>
          <div className="send-to"><span className="send-avatar" aria-hidden="true">{member.name.charAt(0)}</span><span><strong>{maskName(member.name)}</strong><small>@{member.tag}</small></span></div>
          <div className="itd-amount"><label htmlFor={`${uid}-amount`}>보낼 금액</label><div className="itd-input"><input id={`${uid}-amount`} data-testid="send-amount" type="number" inputMode="numeric" min={POLICY.minimumTopup} step={1} value={value} onChange={(event) => { setValue(event.target.value); setError(''); }} autoComplete="off" ref={amountInput} /><span>원</span></div>
            <div className="itd-available"><span>보낼 수 있는 금액</span><strong>{money(state.spend)}</strong></div></div>
          <div className="itd-presets">{[10_000, 30_000, 50_000].map((preset) => <button type="button" key={preset} disabled={preset > state.spend} onClick={() => setValue(String(preset))}>{won(preset)}원</button>)}</div>
          {amountIssue && <p className="itd-error" role="alert">{amountIssue}</p>}
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
