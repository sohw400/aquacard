import { useId, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useModal } from './useModal';
import { money } from '../lib/format';
import './InternalTransferDialog.css';
import './WalletSheet.css';

/** Confirms a card change that costs money or cannot be undone: what happens, what it costs, then one button. */
export default function CardActionSheet({ title, lead, points, cost, spend, confirmLabel, danger = false, consent, onConfirm, onDeposit, onClose }: {
  title: string;
  lead?: string;
  points: ReactNode[];
  /** Taken from the spend balance on confirm; the button stays off while the balance is short. */
  cost?: number;
  spend: number;
  confirmLabel: string;
  danger?: boolean;
  consent?: string;
  onConfirm: () => boolean;
  onDeposit: () => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = `${useId()}-heading`;
  const [agreed, setAgreed] = useState(!consent);
  useModal(panel, onClose, heading);
  const short = cost && cost > spend ? cost - spend : 0;

  return <div className="itd-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="internal-transfer-dialog wallet-sheet card-sheet" ref={panel} role="dialog" aria-modal="true" aria-labelledby={headingId} tabIndex={-1} data-testid="card-sheet">
      <header className="itd-header"><div><h2 id={headingId} ref={heading} tabIndex={-1}>{title}</h2>{lead && <p>{lead}</p>}</div><button type="button" className="itd-close" aria-label="창 닫기" onClick={onClose}><X size={20} /></button></header>
      <div className="itd-body">
        <ul className="card-sheet-points">{points.map((point, index) => <li key={index}>{point}</li>)}</ul>
        {cost ? <dl className="card-sheet-cost"><div><dt>잔액에서 낼 금액</dt><dd data-testid="card-sheet-cost">{money(cost)}</dd></div><div><dt>지금 잔액</dt><dd>{money(spend)}</dd></div></dl> : null}
        {short > 0 && <div className="card-sheet-short" role="alert"><p>잔액이 {money(short)} 부족해요.</p><button type="button" className="itd-button itd-secondary" data-testid="card-sheet-deposit" onClick={() => { onClose(); onDeposit(); }}>충전하기</button></div>}
        {consent && <label className="wallet-terms"><input type="checkbox" data-testid="card-sheet-consent" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} /><span>{consent}</span></label>}
      </div>
      <footer className="itd-footer"><button type="button" className={`itd-button itd-primary${danger ? ' card-sheet-danger' : ''}`} data-testid="card-sheet-confirm" disabled={!agreed || short > 0} onClick={() => { if (onConfirm()) onClose(); }}>{confirmLabel}</button></footer>
    </section>
  </div>;
}
