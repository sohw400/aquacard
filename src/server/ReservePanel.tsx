import { useState, type ReactNode } from 'react';
import type { ReserveSnapshot } from '../../shared/api';
import { api } from './api';
import { useMemberAction } from './useMemberAction';
import './ReservePanel.css';

type ReserveAction = { direction: 'in' | 'out'; amountWon: number } | { autoUse: boolean; expectedVersion: number };
function isReserveAction(raw: unknown): raw is ReserveAction {
  if (!raw || typeof raw !== 'object') return false;
  if ('direction' in raw) return (raw.direction === 'in' || raw.direction === 'out')
    && 'amountWon' in raw && typeof raw.amountWon === 'number' && Number.isSafeInteger(raw.amountWon) && raw.amountWon >= 1;
  return 'autoUse' in raw && typeof raw.autoUse === 'boolean' && 'expectedVersion' in raw
    && typeof raw.expectedVersion === 'number' && Number.isSafeInteger(raw.expectedVersion) && raw.expectedVersion >= 0;
}

export default function ReservePanel({ owner, reserve, useFirst, rewardControls, canTransact, refresh }: {
  owner: string; useFirst: boolean; rewardControls: ReactNode; reserve: ReserveSnapshot | undefined; canTransact: boolean; refresh: () => void;
}) {
  const [amount, setAmount] = useState('');
  const action = useMemberAction('aqua.reserve.' + owner, isReserveAction,
    (command, key) => 'direction' in command ? api.reserveMove(command, key, owner) : api.reservePreference(command, key, owner), refresh);
  const disabled = !reserve || !canTransact || action.busy || action.blocked || !!action.pending;
  const numeric = /^\d+$/.test(amount) ? Number(amount) : 0;
  const invalid = !Number.isSafeInteger(numeric) || numeric < 1;
  return <section className="sa-transactions sa-reserve" aria-labelledby="reserve-title" data-testid="server-reserve">
    <div className="sa-section-heading"><h2 id="reserve-title">리저브 잔액</h2><strong data-testid="server-reserve-balance">{reserve ? reserve.availableWon.toLocaleString('ko-KR') + '원' : '확인 중'}</strong></div>
    {reserve?.accrual && <dl className="sa-reserve-accrual">
      <div><dt>연 보상률</dt><dd>{(reserve.accrual.rateBps / 100).toLocaleString('ko-KR')}%</dd></div>
      <div><dt>리워드 지급 대기</dt><dd>{BigInt(reserve.accrual.pendingWon).toLocaleString('ko-KR')}원</dd></div>
    </dl>}
    <details><summary>리저브 관리</summary>
      <label>옮길 금액 (원)<input inputMode="numeric" value={amount} disabled={disabled} onChange={event => setAmount(event.target.value)} placeholder="1원 이상" /></label>
      <div className="sa-balance-actions">{(['in','out'] as const).map(direction => <button type="button" className="sa-secondary" key={direction}
        disabled={disabled || invalid} onClick={() => void action.submit({ direction, amountWon: numeric })}>{direction === 'in' ? '지갑에서 넣기' : '지갑으로 빼기'}</button>)}</div>
    </details>
    <h3>카드 결제 설정</h3>
    {rewardControls}
    <div className="sa-rewards-preference">
      <div><strong id="reserve-fallback-label">지갑 부족분을 리저브에서 결제</strong><p>지갑이 모자라면 리저브에서 남은 금액만 써요.</p></div>
      <button type="button" role="switch" aria-labelledby="reserve-fallback-label" aria-checked={reserve?.autoUse ?? false}
        className={'sa-rewards-switch' + (reserve?.autoUse ? ' on' : '')} disabled={disabled}
        onClick={() => reserve && void action.submit({ autoUse: !reserve.autoUse, expectedVersion: reserve.preferenceVersion })}><span /></button>
    </div>
    <p className="sa-reserve-order" aria-live="polite">사용 순서 · {[...(useFirst ? ['리워드'] : []), '지갑', ...(reserve?.autoUse ? ['리저브'] : [])].join(' → ')}</p>
    {action.pending && <button type="button" className="sa-secondary" disabled={action.busy || action.blocked} onClick={() => action.pending && void action.submit(action.pending.command)}>이전 요청 확인</button>}
    {action.message && <p role="status">{action.message}</p>}
  </section>;
}
