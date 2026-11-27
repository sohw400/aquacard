import type { CardPaymentRecord, RewardRecord, TransferRecord } from './api';

export type ActivityKind = 'cards' | 'transfers' | 'declines' | 'rewards';
export interface ActivityPage<T> { items: T[]; nextCursor: string | null }
export type CardActivityPage = ActivityPage<CardPaymentRecord>;
export type TransferActivityPage = ActivityPage<TransferRecord>;

export interface CardDeclineRecord {
  id: string;
  createdAt: number;
  reason: 'card_locked' | 'card_unavailable' | 'email_verification' | 'unavailable';
}
export type CardDeclinePage = ActivityPage<CardDeclineRecord>;

export type RewardActivityPage = ActivityPage<RewardRecord>;
