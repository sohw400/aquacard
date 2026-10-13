import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, CreditCard, Percent, RefreshCw, RotateCcw, Waves, type LucideIcon } from 'lucide-react';
import CoinIcon from './CoinIcon';
import { dayLabel, money, shortDate, timeLabel } from '../lib/format';
import type { AppState, FundingOperation, FundingSymbol, Payment, Transaction } from '../lib/types';

export type Tone = '' | 'accent' | 'warning' | 'danger';

const ICONS: Record<Transaction['kind'], LucideIcon> = {
  deposit: ArrowDownLeft, transfer: ArrowLeftRight, convert: RefreshCw, payment: CreditCard,
  refund: RotateCcw, reward: Waves, payback: Percent, rate: Percent, card: CreditCard,
};

export function statusOf(item: Transaction): [string, Tone] | null {
  if (item.status === 'pending') return [item.fundingId ? '처리 중' : '승인 중', 'accent'];
  if (item.status === 'failed') return [item.amount < 0 ? '실패 · 잔액 복원' : '실패 · 입금 안 됨', 'danger'];
  if (item.status === 'cancelled') return ['취소', ''];
  if (item.status === 'refunded') return ['전액 환불', ''];
  if (item.status === 'partially_refunded') return ['부분 환불', ''];
  return null;
}

export const signed = (amount: number, positive: boolean, plain = false) => amount === 0 ? money(0) : `${plain ? '' : amount < 0 ? '−' : positive ? '+' : ''}${money(Math.abs(amount))}`;

function ActivityRow({ item, payment, coin, onRefund, onFunding, onDetail, detailed }: { item: Transaction; payment?: Payment; coin?: FundingSymbol; onRefund: (payment: Payment) => void; onFunding?: (id: string) => void; onDetail?: (item: Transaction) => void; detailed: boolean }) {
  const refundable = detailed && payment && ['completed', 'partially_refunded'].includes(payment.status);
  const unsettled = Boolean(item.fundingId) && item.status !== 'completed';
  const received = item.kind === 'transfer' && Boolean(item.member) && item.amount > 0;
  const positive = !unsettled && (['deposit', 'refund', 'reward', 'payback', 'card'].includes(item.kind) || received) && item.amount > 0;
  const Icon = item.kind === 'transfer' && item.amount < 0 ? ArrowUpRight : received ? ArrowDownLeft : ICONS[item.kind];
  const status = statusOf(item);
  return <div className="activity-row">
    {coin ? <CoinIcon symbol={coin} /> : <span className={`activity-icon${item.kind === 'payment' ? ' merchant' : ''}`} aria-hidden="true">{item.kind === 'payment' ? item.title.trim().charAt(0) : <Icon />}</span>}
    <div className="activity-copy">
      <strong>{item.title}</strong>
      <span>{detailed ? timeLabel(item.timestamp) : shortDate(item.timestamp)}{status && <em className={`status-text ${status[1]}`}>{status[0]}</em>}</span>
      {detailed && onDetail && <button type="button" className="detail-link" data-testid={`tx-detail-${item.id}`} aria-label={`${item.title} 상세`} onClick={() => onDetail(item)}>상세</button>}
    </div>
    <div className={`activity-amount${positive ? ' positive' : ''}${item.kind === 'payment' && item.status === 'refunded' ? ' refunded' : ''}${unsettled ? ' unsettled' : ''}`}>
      {item.amount !== 0 || item.kind === 'payment' || item.fundingId ? <strong>{signed(item.amount, positive, unsettled)}</strong> : null}
      {item.fundingId && onFunding && <button className="pill-button" data-testid={`funding-open-${item.fundingId}`} onClick={() => onFunding(item.fundingId!)} aria-label={`${item.title} 처리 내역`}>처리 내역</button>}
      {refundable && <button className="pill-button" onClick={() => onRefund(payment)} aria-label={`${payment.merchant} 환불`}>환불</button>}
    </div>
  </div>;
}

export function ActivityList({ items, onRefund, payments, operations, onFunding, onDetail, detailed = false, empty = '아직 거래가 없어요.' }: { items: Transaction[]; onRefund: (payment: Payment) => void; payments: Payment[]; operations: FundingOperation[]; onFunding?: (id: string) => void; onDetail?: (item: Transaction) => void; detailed?: boolean; empty?: string }) {
  if (!items.length) return <p className="empty-text">{empty}</p>;
  const row = (item: Transaction) => <ActivityRow key={item.id} item={item} payment={item.kind === 'payment' ? payments.find((p) => p.id === item.paymentId) : undefined} coin={item.fundingId ? operations.find((operation) => operation.id === item.fundingId)?.symbol : undefined} onRefund={onRefund} onFunding={onFunding} onDetail={onDetail} detailed={detailed} />;
  if (!detailed) return <div className="activity-list">{items.map(row)}</div>;
  const days = new Map<string, Transaction[]>();
  items.forEach((item) => { const day = dayLabel(item.timestamp); days.set(day, [...(days.get(day) ?? []), item]); });
  return <div className="activity-list detailed">{[...days].map(([day, list]) => <div className="activity-day" key={day}><h2>{day}</h2>{list.map(row)}</div>)}</div>;
}

/** Credits from paybacks and Reserve, and what card payments took out of rewards. */
export function RewardHistory({ state }: { state: AppState }) {
  const credits = state.transactions.filter((item) => (item.kind === 'payback' || item.kind === 'reward') && item.amount > 0).map((item) => {
    const payment = item.paymentId ? state.payments.find((value) => value.id === item.paymentId) : undefined;
    return { id: item.id, title: item.title, detail: payment?.refunded ? '환불 조정 반영' : '', amount: payment ? payment.cashback - payment.cashbackReversed : item.amount, timestamp: item.timestamp, use: false };
  });
  const uses = state.payments.filter((payment) => payment.fromRewards > 0).map((payment) => ({
    id: `${payment.id}-rewards`, title: `${payment.merchant} 결제에 사용`,
    detail: payment.refunded ? '환불로 돌려받음' : payment.status === 'pending' ? '승인 중' : '',
    amount: -(payment.fromRewards - payment.rewardsRestored), timestamp: payment.timestamp, use: true,
  }));
  const items = [...credits, ...uses].sort((a, b) => b.timestamp - a.timestamp).slice(0, 8);
  if (!items.length) return <p className="empty-text">결제하면 페이백이 여기에 쌓여요.</p>;
  return <div className="plain-list">{items.map((item) => <div className="plain-row" key={item.id}><span className="row-main"><strong>{item.title}</strong><span>{shortDate(item.timestamp)}{item.detail && ` · ${item.detail}`}</span></span><strong className={`row-value${item.use ? '' : ' positive'}`}>{signed(item.amount, true)}</strong></div>)}</div>;
}
