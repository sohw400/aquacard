import { PLANS } from './policy';
import type { AppState } from './types';

export interface CashbackSummary {
  month: string;
  confirmed: number;
  pending: number;
  remaining: number;
  rate: number;
  cap: number;
  allocated: number;
}

/** Cashback belongs to the original purchase month, even when confirmed or refunded later. */
export function getCashbackSummary(state: AppState): CashbackSummary {
  const plan = PLANS[state.card.plan];
  const payments = state.payments.filter((payment) => payment.cashbackMonth === state.cashbackMonth);
  const pending = payments.reduce((sum, payment) => sum + (payment.status === 'pending' ? payment.cashback : 0), 0);
  const confirmed = payments.reduce((sum, payment) => sum + (payment.status !== 'pending' ? payment.cashback - payment.cashbackReversed : 0), 0);
  return {
    month: state.cashbackMonth,
    confirmed,
    pending,
    remaining: Math.max(0, plan.cashbackCap - state.monthlyCashback),
    allocated: state.monthlyCashback,
    rate: plan.cashbackRate,
    cap: plan.cashbackCap,
  };
}
