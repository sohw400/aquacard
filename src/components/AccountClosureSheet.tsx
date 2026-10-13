import { useId, useRef, useState } from 'react';
import { CircleAlert, X } from 'lucide-react';
import { useModal } from './useModal';
import { accountClosureBlockers } from '../lib/engine';
import { hashPassword } from '../lib/auth';
import { money } from '../lib/format';
import type { AppState } from '../lib/types';
import './InternalTransferDialog.css';
import './WalletSheet.css';

/** Account deletion: lists what still has to be settled, then asks for the password once everything is clear. */
export default function AccountClosureSheet({ state, onDelete, onClose }: {
  state: AppState;
  onDelete: (passwordHash: string) => boolean;
  onClose: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = `${useId()}-heading`;
  const [password, setPassword] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  useModal(panel, onClose, heading);
  const blockers = accountClosureBlockers(state);
  const ready = blockers.length === 0;

  async function submit() {
    if (!state.account || !ready || !agreed || !password || busy) return;
    setBusy(true);
    const done = onDelete(await hashPassword(state.account.email, password));
    setBusy(false);
    if (done) onClose();
  }

  return <div className="itd-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="internal-transfer-dialog wallet-sheet card-sheet" ref={panel} role="dialog" aria-modal="true" aria-labelledby={headingId} tabIndex={-1} data-testid="account-closure">
      <header className="itd-header"><div><h2 id={headingId} ref={heading} tabIndex={-1}>회원 탈퇴</h2><p>탈퇴하면 이 브라우저에 저장된 계정과 내역이 지워져요.</p></div><button type="button" className="itd-close" aria-label="창 닫기" onClick={onClose}><X size={20} /></button></header>
      <div className="itd-body">
        {ready ? <>
          <ul className="card-sheet-points">
            {state.rewards > 0 && <li>리워드 {money(state.rewards)}은 밖으로 보낼 수 없어서 함께 사라져요.</li>}
            <li>고객확인 기록은 법에 따라 거래가 끝난 뒤 5년 동안 따로 보관해요.</li>
            <li>같은 이메일로 다시 가입할 수 있어요.</li>
          </ul>
          <div className="form-field"><label htmlFor={`${headingId}-password`}>비밀번호</label><input id={`${headingId}-password`} type="password" data-testid="closure-password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></div>
          <label className="wallet-terms"><input type="checkbox" data-testid="closure-consent" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} /><span>위 내용을 확인했어요.</span></label>
        </> : <>
          <p className="closure-lead">탈퇴하기 전에 아래를 먼저 정리해 주세요.</p>
          <ul className="closure-blockers" data-testid="closure-blockers">{blockers.map((item) => <li key={item}><CircleAlert size={17} aria-hidden="true" />{item}</li>)}</ul>
        </>}
      </div>
      <footer className="itd-footer">{ready
        ? <button type="button" className="itd-button itd-primary card-sheet-danger" data-testid="closure-confirm" disabled={!agreed || !password || busy} onClick={submit}>탈퇴하기</button>
        : <button type="button" className="itd-button itd-primary" onClick={onClose}>확인</button>}</footer>
    </section>
  </div>;
}
