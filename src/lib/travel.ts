import type { WithdrawalDestination } from './types';

/** An exchange a withdrawal can go to. The travel rule sends the sender's and recipient's names along, so the other side must be reachable through it. */
export interface Venue {
  id: string;
  name: string;
  region: 'domestic' | 'global';
}

/**
 * The demo's directory. The four Korean won-market exchanges are reporting businesses; the overseas ones are made up.
 * A launch reads the list from the travel rule networks (CODE, VerifyVASP) and leaves out anything unreported.
 */
export const VENUES: readonly Venue[] = [
  { id: 'upbit', name: '업비트', region: 'domestic' },
  { id: 'bithumb', name: '빗썸', region: 'domestic' },
  { id: 'coinone', name: '코인원', region: 'domestic' },
  { id: 'korbit', name: '코빗', region: 'domestic' },
  { id: 'demo-sg', name: '싱가포르 체험 거래소', region: 'global' },
  { id: 'demo-jp', name: '일본 체험 거래소', region: 'global' },
];

export const venueOf = (id: string) => VENUES.find((item) => item.id === id);
export const regionName = (region: Venue['region']) => region === 'domestic' ? '국내 거래소' : '해외 거래소';

export const UNLISTED_VENUE = '신고하지 않았거나 트래블룰로 확인되지 않는 거래소에는 보낼 수 없어요.';

/** Names as an exchange account holds them: letters, with single spaces, dots, hyphens or apostrophes between words. */
const RECIPIENT_NAME = /^\p{L}+(?:(?:[.'-] ?| )\p{L}+)*\.?$/u;
export const normalizeName = (value: string) => value.trim().replace(/\s+/g, ' ');
export const validRecipientName = (name: string) => name.length >= 2 && name.length <= 30 && RECIPIENT_NAME.test(name);

/** Where it went, in a few words: the exchange's name, or 내 지갑. */
export const destinationName = (destination: WithdrawalDestination) => destination.kind === 'own_wallet' ? '내 지갑' : venueOf(destination.venue)?.name ?? '거래소';
