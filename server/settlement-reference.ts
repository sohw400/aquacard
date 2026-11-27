import { createHmac } from 'node:crypto';

type ReferenceKind = 'event' | 'payment';
export type SettlementReferenceReader = (kind: ReferenceKind, value: unknown) => string | undefined;

const sourceShape = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const panDigits = /(?:^|\D)\d{13,19}(?!\d)/;
const groupedPan = /(?:^|\D)(?:\d{4}[-:._]\d{4}[-:._]\d{4}[-:._]\d{1,4}|\d{4}[-:._]\d{6}[-:._]\d{5})(?!\d)/;

export function isStatementReference(value: unknown): value is string {
  return typeof value === 'string' && sourceShape.test(value) && !panDigits.test(value) && !groupedPan.test(value);
}

const prefixes = { event: '~e1.', payment: '~p1.' } as const;

export const readSettlementReference: SettlementReferenceReader = (kind, value) => {
  if (isStatementReference(value)) return value;
  if (typeof value === 'string' && value.startsWith(prefixes[kind]) && /^[a-f0-9]{64}$/.test(value.slice(4))) return value;
};

export function sourceReferenceReader(key: Buffer): SettlementReferenceReader {
  if (key.length !== 32) throw new Error('INVALID_SETTLEMENT_REFERENCE_KEY');
  return (kind, value) => {
    // Raw issuer identifiers cannot claim an already normalized alias.
    if (typeof value !== 'string' || !sourceShape.test(value)) return;
    if (isStatementReference(value)) return value;
    const digest = createHmac('sha256', key).update('AquaCard/settlement-reference/v1/' + kind + ':' + value, 'utf8')
      .digest('hex');
    return prefixes[kind] + digest;
  };
}
