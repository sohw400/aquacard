import { ArrowDownLeft, ArrowUpRight, ChevronRight } from 'lucide-react';
import { money, shortDate } from '../lib/format';
import { fundingStatusLabel, getFundingNetworks, isFundingPending } from '../lib/movements';
import type { FundingOperation } from '../lib/types';
import './FundingHistory.css';

export default function FundingHistory({ operations, onOpen, onAll }: {
  operations: FundingOperation[];
  onOpen: (operation: FundingOperation) => void;
  onAll: () => void;
}) {
  if (!operations.length) return null;
  const pending = operations.filter(isFundingPending);
  const recent = operations.filter((item) => !isFundingPending(item)).slice(0, 3);
  return <section className="funding-history" aria-label="입출금 현황">
    <div className="section-head"><h2>입출금 현황</h2><button className="text-button" onClick={onAll}>전체 내역<ChevronRight size={16} /></button></div>
    {pending.length > 0 && <p className="funding-history-count">진행 중 {pending.length}건</p>}
    {[...pending, ...recent].map((operation) => {
      const active = isFundingPending(operation);
      const stopped = operation.status === 'failed' || operation.status === 'cancelled';
      const deposit = operation.kind === 'deposit';
      const Icon = deposit ? ArrowDownLeft : ArrowUpRight;
      const network = getFundingNetworks(operation.symbol).find((item) => item.id === operation.network)?.label;
      return <button className={`funding-history-row${active ? ' pending' : ''}`} key={operation.id} onClick={() => onOpen(operation)} data-testid={`funding-open-${operation.id}`}>
        <span className="funding-history-icon"><Icon size={19} /></span>
        <span className="funding-history-copy"><strong>{operation.symbol} {deposit ? '입금' : '출금'}</strong><small>{network} · {shortDate(operation.createdAt)}</small></span>
        <span className="funding-history-amount"><strong>{money(deposit ? operation.netWon : operation.amountWon)}</strong><small className={stopped ? 'stopped' : active ? 'pending' : ''}>{fundingStatusLabel(operation.status)}</small></span>
        <ChevronRight size={16} />
      </button>;
    })}
    {pending.length > 0 && <p className="section-description">화면을 닫아도 진행 상황은 이곳에 남습니다.</p>}
  </section>;
}
