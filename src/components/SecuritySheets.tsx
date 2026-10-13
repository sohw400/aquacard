import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useModal } from './useModal';
import { pinIssue } from '../lib/engine';
import { hashPassword, passwordIssue } from '../lib/auth';
import './InternalTransferDialog.css';
import './WalletSheet.css';

function Sheet({ title, lead, testId, children, footer, onClose, onSubmit }: { title: string; lead: string; testId: string; children: ReactNode; footer: ReactNode; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const id = useId();
  useModal(panel, onClose, heading);
  return <div className="itd-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="internal-transfer-dialog wallet-sheet" ref={panel} role="dialog" aria-modal="true" aria-labelledby={`${id}-heading`} tabIndex={-1} data-testid={testId}>
      <header className="itd-header"><div><h2 id={`${id}-heading`} ref={heading} tabIndex={-1}>{title}</h2><p>{lead}</p></div><button type="button" className="itd-close" aria-label="창 닫기" onClick={onClose}><X size={20} /></button></header>
      <form className="sheet-form" noValidate onSubmit={onSubmit}>
        <div className="itd-body">{children}</div>
        <footer className="itd-footer">{footer}</footer>
      </form>
    </section>
  </div>;
}

/** Four-digit card PIN, entered twice. Only the fact that a PIN exists is kept. */
export function PinSheet({ mode, onSubmit, onClose }: { mode: 'activate' | 'change'; onSubmit: (pin: string) => boolean; onClose: () => void }) {
  const id = useId();
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const issue = pin.length === 4 ? pinIssue(pin) : '';
  const ready = pin.length === 4 && !issue && again === pin;
  const digits = (value: string) => value.replace(/\D/g, '').slice(0, 4);
  return <Sheet testId="pin-sheet" title={mode === 'activate' ? '실물카드 활성화' : '카드 비밀번호 변경'} lead={mode === 'activate' ? '매장에서 카드를 꽂아 결제할 때 쓸 비밀번호를 정합니다.' : '새 비밀번호는 바로 적용됩니다.'} onClose={onClose}
    onSubmit={(event) => { event.preventDefault(); if (!ready) { setError(again !== pin ? '두 번 넣은 비밀번호가 다릅니다.' : issue); return; } if (onSubmit(pin)) onClose(); }}
    footer={<button type="submit" className="itd-button itd-primary" data-testid="pin-submit" disabled={!ready}>{mode === 'activate' ? '활성화' : '바꾸기'}</button>}>
    <div className="form-field"><label htmlFor={`${id}-pin`}>카드 비밀번호 4자리</label><input id={`${id}-pin`} data-testid="pin-input" type="password" inputMode="numeric" autoComplete="off" maxLength={4} value={pin} onChange={(event) => { setPin(digits(event.target.value)); setError(''); }} /></div>
    {issue && <p className="sheet-hint bad">{issue}</p>}
    <div className="form-field"><label htmlFor={`${id}-again`}>한 번 더</label><input id={`${id}-again`} data-testid="pin-again" type="password" inputMode="numeric" autoComplete="off" maxLength={4} value={again} onChange={(event) => { setAgain(digits(event.target.value)); setError(''); }} /></div>
    {again.length === 4 && again !== pin && <p className="sheet-hint bad">두 번 넣은 비밀번호가 다릅니다.</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <p className="itd-demo-note">같은 숫자나 이어지는 숫자는 쓸 수 없습니다. 비밀번호는 Aqua에 저장하지 않습니다.</p>
  </Sheet>;
}

export function PasswordSheet({ email, onSubmit, onClose }: { email: string; onSubmit: (currentHash: string, nextHash: string) => boolean; onClose: () => void }) {
  const id = useId();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const issue = next ? passwordIssue(next) : '';
  const ready = Boolean(current) && Boolean(next) && !issue && confirm === next && !busy;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    const done = onSubmit(await hashPassword(email, current), await hashPassword(email, next));
    setBusy(false);
    if (done) onClose();
  }
  return <Sheet testId="password-sheet" title="비밀번호 변경" lead="로그인과 출금 확인에 쓰는 비밀번호입니다." onClose={onClose} onSubmit={submit}
    footer={<button type="submit" className="itd-button itd-primary" data-testid="password-submit" disabled={!ready}>바꾸기</button>}>
    <div className="form-field"><label htmlFor={`${id}-current`}>지금 비밀번호</label><input id={`${id}-current`} data-testid="password-current" type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} /></div>
    <div className="form-field"><label htmlFor={`${id}-next`}>새 비밀번호</label><input id={`${id}-next`} data-testid="password-next" type="password" autoComplete="new-password" value={next} onChange={(event) => setNext(event.target.value)} /></div>
    <p className={`sheet-hint${issue ? ' bad' : ''}`}>{issue || '영문과 숫자를 섞어 8자 이상'}</p>
    <div className="form-field"><label htmlFor={`${id}-confirm`}>새 비밀번호 확인</label><input id={`${id}-confirm`} data-testid="password-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} /></div>
    {confirm && confirm !== next && <p className="sheet-hint bad">새 비밀번호가 서로 다릅니다.</p>}
  </Sheet>;
}
