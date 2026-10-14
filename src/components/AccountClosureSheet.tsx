import { useId, useRef, useState } from 'react';
import { CircleAlert, X } from 'lucide-react';
import { useModal } from './useModal';
import { accountClosureBlockers, recordsKeptUntil } from '../lib/engine';
import { hashPassword } from '../lib/auth';
import { dateLabel, money } from '../lib/format';
import type { AppState } from '../lib/types';
import './InternalTransferDialog.css';
import './WalletSheet.css';

/**
 * Account deletion: lists what still has to be settled, then, once everything is clear, what goes now and what the law
 * keeps and until when, and asks for the password.
 */
export default function AccountClosureSheet({ state, onDelete, onClose }: {
  state: AppState;
  /** Gets the date the kept records go, to show on the screen after deletion. */
  onDelete: (passwordHash: string, keptUntil: number) => boolean;
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
  const keptUntil = recordsKeptUntil(Date.now() + state.clockOffsetMs);

  async function submit() {
    if (!state.account || !ready || !agreed || !password || busy) return;
    setBusy(true);
    const done = onDelete(await hashPassword(state.account.email, password), keptUntil);
    setBusy(false);
    if (done) onClose();
  }

  return <div className="itd-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="internal-transfer-dialog wallet-sheet card-sheet" ref={panel} role="dialog" aria-modal="true" aria-labelledby={headingId} tabIndex={-1} data-testid="account-closure">
      <header className="itd-header"><div><h2 id={headingId} ref={heading} tabIndex={-1}>회원 탈퇴</h2><p>신청하면 바로 처리되고, 끝나면 가입한 이메일로 알려 드려요.</p></div><button type="button" className="itd-close" aria-label="창 닫기" onClick={onClose}><X size={20} /></button></header>
      <div className="itd-body">
        {ready ? <>
          <section className="closure-section" aria-labelledby={`${headingId}-deleted`} data-testid="closure-deleted">
            <h3 id={`${headingId}-deleted`}>바로 지우는 정보</h3>
            <ul className="card-sheet-points">
              <li>비밀번호. 다시 로그인할 수 없어요.</li>
              <li>내 태그와 QR, 휴대폰 번호·이메일로 찾기 설정</li>
              <li>알림 설정과 광고성 정보 수신 동의</li>
              {state.rewards > 0 && <li>남은 리워드 {money(state.rewards)}. 밖으로 보낼 수 없어서 함께 사라져요.</li>}
            </ul>
          </section>
          <section className="closure-section" aria-labelledby={`${headingId}-kept`} data-testid="closure-kept">
            <h3 id={`${headingId}-kept`}>법에 따라 따로 보관하는 정보</h3>
            <ul className="card-sheet-points">
              <li>고객확인 기록: 이름, 생년월일, 주소, 연락처, 신분증과 본인확인 결과, 직업·거래 목적·자금 출처</li>
              <li>거래 기록: 충전, 보내기와 받기(트래블룰로 주고받은 정보 포함), 카드 결제와 연회비</li>
            </ul>
            <p className="closure-kept-until" data-testid="closure-kept-until">특정금융정보법에 따라 <strong>{dateLabel(keptUntil)}</strong>까지 보관한 뒤 지워요. 감독 검사나 수사기관 요청처럼 법에서 정한 경우에만 써요.</p>
          </section>
          <p className="closure-note">같은 이메일로 다시 가입할 수 있어요. 그때는 본인확인과 고객확인을 처음부터 다시 해요.</p>
          <div className="form-field"><label htmlFor={`${headingId}-password`}>비밀번호</label><input id={`${headingId}-password`} type="password" data-testid="closure-password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></div>
          <label className="wallet-terms"><input type="checkbox" data-testid="closure-consent" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} /><span>위 내용을 확인했어요.</span></label>
          <p className="itd-demo-note">체험판이라 이 브라우저에 남은 기록까지 모두 지워요.</p>
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
