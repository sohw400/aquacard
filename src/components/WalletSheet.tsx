import { useEffect, useId, useRef, useState } from 'react';
import { BadgePercent, Check, LockKeyhole, ScanFace, X } from 'lucide-react';
import CardVisual from './CardVisual';
import { useModal } from './useModal';
import { demoCode, maskPhone } from '../lib/auth';
import type { CardState, MobileWallet } from '../lib/types';
import './InternalTransferDialog.css';
import './WalletSheet.css';

export const WALLET_NAMES: Record<MobileWallet, string> = { samsung: '삼성페이', apple: 'Apple Pay' };

type Step = 'intro' | 'verify' | 'done';

/** Adds the card to a phone wallet: terms, a code to the signed-up phone, then confirmation. */
export default function WalletSheet({ wallet, card, phone, onAdd, onClose }: {
  wallet: MobileWallet;
  card: CardState;
  phone: string;
  onAdd: () => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>('intro');
  const [terms, setTerms] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = `${useId()}-heading`;
  const name = WALLET_NAMES[wallet];
  const verified = code !== null && input === code;
  useModal(panel, onClose, heading);
  useEffect(() => { heading.current?.focus(); }, [step]);

  function add() {
    if (!verified) return;
    onAdd();
    setStep('done');
  }

  return <div className="itd-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="internal-transfer-dialog wallet-sheet" ref={panel} role="dialog" aria-modal="true" aria-labelledby={headingId} tabIndex={-1} data-testid="dialog-wallet">
      <header className="itd-header"><div><h2 id={headingId} ref={heading} tabIndex={-1}>{step === 'done' ? `${name}에 추가했습니다` : `${name}에 카드 추가`}</h2>{step !== 'done' && <p>{step === 'intro' ? '휴대폰을 결제 단말기에 대면 Aqua 카드로 결제합니다.' : '가입할 때 확인한 휴대폰으로 본인임을 확인합니다.'}</p>}</div><button type="button" className="itd-close" aria-label="창 닫기" onClick={onClose}><X size={20} /></button></header>
      <div className="itd-body">
        <div className="wallet-card"><CardVisual card={card} compact /><div><strong>{name}</strong><span>Aqua {card.plan === 'plus' ? 'Plus' : 'Basic'} · <span className="nowrap">끝번호 {card.last4}</span></span></div></div>
        {step === 'intro' && <>
          <ul className="wallet-points">
            <li><ScanFace size={18} aria-hidden="true" />결제할 때마다 휴대폰 잠금 해제로 확인합니다.</li>
            <li><LockKeyhole size={18} aria-hidden="true" />카드를 잠그면 {name} 결제도 함께 막힙니다.</li>
            <li><BadgePercent size={18} aria-hidden="true" />페이백과 리워드 사용은 카드로 결제할 때와 같습니다.</li>
          </ul>
          <label className="wallet-terms"><input type="checkbox" data-testid="wallet-terms" checked={terms} onChange={(event) => setTerms(event.target.checked)} /><span>카드 정보를 {name}에 등록하는 데 동의합니다.</span></label>
        </>}
        {step === 'verify' && <>
          {code ? <>
            <p className="wallet-code-note" data-testid="wallet-demo-code">체험판이라 문자를 보내지 않습니다. <span className="nowrap">{maskPhone(phone)}</span>로 보낸 인증번호는 <strong>{code}</strong>입니다.</p>
            <div className="form-field"><label htmlFor={`${headingId}-code`}>인증번호 6자리</label><input id={`${headingId}-code`} data-testid="wallet-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={input} onChange={(event) => setInput(event.target.value.replace(/\D/g, ''))} /></div>
            {verified && <p className="wallet-verified"><Check size={16} strokeWidth={2.6} />확인했습니다.</p>}
          </> : <p className="wallet-code-note"><span className="nowrap">{maskPhone(phone)}</span>로 인증번호를 보냅니다.</p>}
        </>}
        {step === 'done' && <div className="itd-completed wallet-done" data-testid="wallet-done-view">
          <span className="itd-result-icon"><Check size={27} strokeWidth={1.8} /></span>
          <p>결제할 때 {name}에서 끝번호 {card.last4} 카드를 고르세요.</p>
        </div>}
        <p className="itd-demo-note">실제 지원 여부는 카드 발급사와 {name}의 제휴로 정해집니다. 체험에서는 추가 과정만 보여줍니다.</p>
      </div>
      <footer className="itd-footer">{step === 'intro' ? <button type="button" className="itd-button itd-primary" data-testid="wallet-next" disabled={!terms} onClick={() => setStep('verify')}>다음</button>
        : step === 'verify' ? code ? <button type="button" className="itd-button itd-primary" data-testid="wallet-confirm" disabled={!verified} onClick={add}>{name}에 추가</button>
          : <button type="button" className="itd-button itd-primary" data-testid="wallet-send-code" onClick={() => { setCode(demoCode()); setInput(''); }}>인증번호 받기</button>
        : <button type="button" className="itd-button itd-primary" data-testid="wallet-done" onClick={onClose}>확인</button>}</footer>
    </section>
  </div>;
}
