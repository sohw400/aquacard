import { fundingLabel } from './policy';
import type { AppState, FundingOperation, Transaction } from './types';

/** One year of money in, money out and benefits, in Korean calendar years. */
export interface YearSummary {
  year: number;
  /** Completed deposits, as credited to the balance. */
  deposits: { count: number; won: number };
  /** Coins other than the won stablecoin, sold on arrival: what a tax filing may treat as disposals. */
  coinSales: { count: number; won: number };
  /** Completed sends to wallet addresses, with what they cost. */
  withdrawals: { count: number; won: number; fees: number };
  sentToMembers: { count: number; won: number };
  receivedFromMembers: { count: number; won: number };
  /** Card payments less what was refunded. */
  cardSpent: { count: number; won: number };
  payback: number;
  reserveRewards: number;
  /** Membership fees and other card costs, less refunds of them. */
  cardFees: number;
}

const yearOf = (timestamp: number) => Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric' }).format(timestamp));

/** Years with any activity, newest first; the demo clock's current year is always there. */
export function statementYears(state: AppState, now: number): number[] {
  const years = new Set(state.transactions.map((item) => yearOf(item.timestamp)));
  years.add(yearOf(now));
  return [...years].sort((left, right) => right - left);
}

const operationOf = (state: AppState, item: Transaction): FundingOperation | undefined =>
  item.fundingId ? state.fundingOperations.find((operation) => operation.id === item.fundingId) : undefined;

export function summarizeYear(state: AppState, year: number): YearSummary {
  const summary: YearSummary = {
    year, deposits: { count: 0, won: 0 }, coinSales: { count: 0, won: 0 }, withdrawals: { count: 0, won: 0, fees: 0 },
    sentToMembers: { count: 0, won: 0 }, receivedFromMembers: { count: 0, won: 0 }, cardSpent: { count: 0, won: 0 },
    payback: 0, reserveRewards: 0, cardFees: 0,
  };
  const add = (bucket: { count: number; won: number }, won: number) => { bucket.count += 1; bucket.won += won; };
  for (const item of state.transactions) {
    if (yearOf(item.timestamp) !== year) continue;
    const operation = operationOf(state, item);
    if (operation) {
      if (operation.status !== 'completed') continue;
      if (operation.kind === 'deposit') {
        add(summary.deposits, operation.netWon);
        if (operation.symbol !== 'KRWS') add(summary.coinSales, operation.amountWon);
      } else {
        add(summary.withdrawals, operation.amountWon);
        summary.withdrawals.fees += operation.feeWon + operation.networkFeeWon;
      }
    } else if (item.kind === 'transfer' && item.member) {
      if (item.amount < 0) add(summary.sentToMembers, -item.amount);
      else add(summary.receivedFromMembers, item.amount);
    } else if (item.kind === 'convert' && item.amount > 0) {
      add(summary.coinSales, item.amount);
    } else if (item.kind === 'reward' && item.amount > 0) {
      summary.reserveRewards += item.amount;
    } else if (item.kind === 'card') {
      summary.cardFees -= item.amount;
    }
  }
  // Payments carry their own refunds and payback reversals, so both net out here.
  for (const payment of state.payments) {
    if (yearOf(payment.timestamp) !== year) continue;
    add(summary.cardSpent, payment.amount - payment.refunded);
    if (payment.status !== 'pending') summary.payback += payment.cashback - payment.cashbackReversed;
  }
  return summary;
}

const STATUS: Record<Transaction['status'], string> = {
  pending: '처리 중', completed: '완료', refunded: '전액 환불', partially_refunded: '부분 환불', failed: '실패', cancelled: '취소',
};

function kindName(item: Transaction, operation?: FundingOperation): string {
  if (operation) return operation.kind === 'deposit' ? '충전' : '지갑으로 보내기';
  if (item.kind === 'transfer') return item.member ? item.amount < 0 ? '회원에게 보내기' : '회원에게 받기' : '리저브 이동';
  return { deposit: '충전', transfer: '이동', convert: '코인 전환', payment: '카드 결제', refund: '환불', reward: '리저브 보상', payback: '페이백', rate: '체험 설정', card: '카드' }[item.kind];
}

const stamp = (timestamp: number) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(timestamp);
// Tabs split columns when pasted into a spreadsheet, so they and line breaks never appear inside a cell.
const cell = (value: string | number) => String(value).replace(/[\t\r\n]+/g, ' ').trim();

export const STATEMENT_COLUMNS = ['일시', '구분', '내용', '금액(원)', '상태', '코인', '수량', '상대', '메모'];

/** The year's rows, oldest first, as tab-separated text that pastes into Excel or Google Sheets as columns. */
export function statementText(state: AppState, year: number): { text: string; rows: number } {
  const lines = state.transactions.filter((item) => yearOf(item.timestamp) === year).slice().reverse().map((item) => {
    const operation = operationOf(state, item);
    const coin = operation ? fundingLabel(operation.symbol) : '';
    const units = operation ? String(operation.kind === 'deposit' ? operation.units : operation.outputUnits) : '';
    const counterpart = item.member ? `@${item.member}` : operation?.kind === 'withdrawal' ? operation.recipient : '';
    return [stamp(item.timestamp), kindName(item, operation), item.title, item.amount, STATUS[item.status], coin, units, counterpart, item.note].map(cell).join('\t');
  });
  return { text: [STATEMENT_COLUMNS.join('\t'), ...lines].join('\n'), rows: lines.length };
}
