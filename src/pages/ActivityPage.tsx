import { useRef } from 'react';
import { CalendarDays, ChevronRight } from 'lucide-react';
import { ActivityList, listedTransactions } from '../components/Activity';
import { money } from '../lib/format';
import { getCashbackSummary } from '../lib/rewards';
import type { AppState, Payment, Transaction } from '../lib/types';
import './AccountPages.css';

export type ActivityFilter = 'all' | 'payment' | 'cash';
const FILTERS: [ActivityFilter, string][] = [['all', '전체'], ['payment', '카드'], ['cash', '입출금']];
const EMPTY: Record<ActivityFilter, string> = {
  all: '아직 거래가 없어요.',
  payment: '카드로 결제한 내역이 없어요.',
  cash: '입출금 내역이 없어요.',
};

export default function ActivityPage({ state, filter, onFilter, onFunding, onDetail, onRefund, onStatement }: {
  state: AppState; filter: ActivityFilter; onFilter: (filter: ActivityFilter) => void;
  onFunding: (id: string) => void; onDetail: (item: Transaction) => void; onRefund: (payment: Payment) => void; onStatement: () => void;
}) {
  const allFilter = useRef<HTMLButtonElement>(null);
  const cashback = getCashbackSummary(state);
  const transactions = listedTransactions(state.transactions);
  const items = transactions.filter((item) => filter === 'all' || (filter === 'payment' ? ['payment', 'refund', 'card'].includes(item.kind) : ['deposit', 'convert', 'transfer'].includes(item.kind)));
  const filterName = FILTERS.find(([key]) => key === filter)?.[1];
  return <div className="page activity-page">
    <section className="activity-overview" aria-label="카드 이용 요약">
      <details className="rule-details activity-month">
        <summary><span>이번 달 카드 이용<strong>{money(state.monthlySpent)}</strong></span></summary>
        <dl className="breakdown">
          <div><dt>오늘 결제</dt><dd>{money(state.dailySpent)}</dd></div>
          <div><dt>확정 페이백</dt><dd>{money(cashback.confirmed)}</dd></div>
          {cashback.pending > 0 && <div><dt>확정 전 페이백</dt><dd>{money(cashback.pending)}</dd></div>}
          <div><dt>남은 페이백 한도</dt><dd>{money(cashback.remaining)}</dd></div>
        </dl>
      </details>
      <button type="button" className="activity-year-link" data-testid="open-statement" onClick={onStatement}>
        <CalendarDays size={17} aria-hidden="true" /><span>연간 거래 내역</span><ChevronRight size={16} aria-hidden="true" />
      </button>
    </section>
    <section className="activity-results" aria-label="거래 목록">
      <div className="segmented" role="group" aria-label="거래 종류">
        {FILTERS.map(([key, label]) => <button type="button" key={key} ref={key === 'all' ? allFilter : undefined} className={filter === key ? 'selected' : ''} aria-pressed={filter === key} onClick={() => onFilter(key)}>{label}</button>)}
      </div>
      <span className="sr-only" role="status">{filterName} 거래 {items.length}건</span>
      {items.length > 0 ? <ActivityList detailed onFunding={onFunding} onDetail={onDetail} items={items} payments={state.payments}
        operations={state.fundingOperations} onRefund={onRefund} /> :
        <div className="activity-empty">
          <p>{EMPTY[filter]}</p>
          {filter !== 'all' && transactions.length > 0 && <button type="button" className="btn small neutral" onClick={() => { onFilter('all'); allFilter.current?.focus(); }}>전체 내역 보기</button>}
        </div>}
    </section>
  </div>;
}
