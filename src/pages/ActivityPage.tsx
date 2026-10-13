import { ActivityList } from '../components/Activity';
import { money } from '../lib/format';
import { PLANS } from '../lib/policy';
import type { AppState, Payment, Transaction } from '../lib/types';

export type ActivityFilter = 'all' | 'payment' | 'cash';
const FILTERS: [ActivityFilter, string][] = [['all', '전체'], ['payment', '카드'], ['cash', '입출금']];

export default function ActivityPage({ state, filter, onFilter, onFunding, onDetail, onRefund }: {
  state: AppState; filter: ActivityFilter; onFilter: (filter: ActivityFilter) => void;
  onFunding: (id: string) => void; onDetail: (item: Transaction) => void; onRefund: (payment: Payment) => void;
}) {
  const items = state.transactions.filter((item) => filter === 'all' || (filter === 'payment' ? ['payment', 'refund', 'card'].includes(item.kind) : ['deposit', 'convert', 'transfer'].includes(item.kind)));
  return <div className="page activity-page">
    <div className="segmented" role="group" aria-label="거래 종류">{FILTERS.map(([key, label]) => <button type="button" key={key} className={filter === key ? 'selected' : ''} aria-pressed={filter === key} onClick={() => onFilter(key)}>{label}</button>)}</div>
    <ActivityList detailed onFunding={onFunding} onDetail={onDetail} items={items} payments={state.payments} operations={state.fundingOperations} onRefund={onRefund}
      empty={filter === 'payment' ? '카드로 결제한 내역이 없어요.' : filter === 'cash' ? '충전하거나 보낸 내역이 없어요.' : '아직 거래가 없어요.'} />
    <details className="rule-details plain-section"><summary>이번 달 카드 이용</summary><dl className="breakdown plain"><div><dt>이번 달 결제</dt><dd>{money(state.monthlySpent)}</dd></div><div><dt>오늘 결제</dt><dd>{money(state.dailySpent)}</dd></div><div><dt>받은 페이백</dt><dd>{money(state.monthlyCashback)} / {money(PLANS[state.card.plan].cashbackCap)}</dd></div></dl></details>
  </div>;
}
