import { ChevronRight } from 'lucide-react';
import CoinIcon from './CoinIcon';
import { money, shortDate } from '../lib/format';
import { fundingStatusLabel, getFundingNetworks, isFundingPending } from '../lib/movements';
import { fundingLabel } from '../lib/policy';
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
  return <section className="panel flush funding-history" aria-label="입출금 현황">
    <div className="panel-head"><h2>입출금 현황</h2><button className="link-button" onClick={onAll}>전체 내역<ChevronRight size={17} /></button></div>
    {pending.length > 0 && <p className="funding-history-count">진행 중 {pending.length}건</p>}
    {[...pending, ...recent].map((operation) => {
      const active = isFundingPending(operation);
      const stopped = operation.status === 'failed' || operation.status === 'cancelled';
      const deposit = operation.kind === 'deposit';
      const network = getFundingNetworks(operation.symbol).find((item) => item.id === operation.network)?.label;
      return <button className={`list-row funding-history-row${active ? ' pending' : ''}`} key={operation.id} onClick={() => onOpen(operation)} data-testid={`funding-open-${operation.id}`}>
        <CoinIcon symbol={operation.symbol} />
        <span className="row-main"><strong>{fundingLabel(operation.symbol)} {deposit ? '입금' : '출금'}</strong><span>{network} · {shortDate(operation.createdAt)}</span></span>
        <span className="funding-history-amount"><strong>{money(deposit ? operation.netWon : operation.amountWon)}</strong><small className={stopped ? 'stopped' : active ? 'pending' : 'done'}>{fundingStatusLabel(operation.status)}</small></span>
        <ChevronRight className="row-chevron" size={20} />
      </button>;
    })}
    {pending.length > 0 && <p className="panel-footnote">화면을 닫아도 진행 상황은 이곳에 남습니다.</p>}
  </section>;
}
