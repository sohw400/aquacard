import type { Database } from './database';
import { LedgerError } from './errors';

import type { CardApplication, CardApplicationSnapshot } from '../shared/api';

export type ApplicationForm = CardApplication['form'];
type DenialReason = NonNullable<CardApplication['reason']>;
type ProviderAction = 'approve' | 'decline' | 'issue' | 'dispatch' | 'deliver';
export interface ApplicationProviderEvent {
  applicationId: string; expectedVersion: number; eventId: string; action: ProviderAction; reason?: DenialReason;
}
type Submit = {userId: string; form: ApplicationForm; idempotencyKey: string};
type Activate = {userId: string; applicationId: string; expectedVersion: number; idempotencyKey: string};

const failures: Record<string, [number, string]> = {
  INVALID_CARD_APPLICATION: [400, '카드 신청 내용을 확인해 주세요.'],
  CARD_APPLICATION_NOT_FOUND: [404, '카드 신청을 찾을 수 없어요.'],
  CARD_APPLICATION_EXISTS: [409, '이미 카드가 있거나 신청이 진행 중이에요.'],
  CARD_APPLICATION_VERSION_CHANGED: [409, '신청 상태가 바뀌었어요. 최신 상태를 확인해 주세요.'],
  CARD_APPLICATION_STATE_CONFLICT: [409, '현재 신청 상태에서는 진행할 수 없어요.'],
  OUTBOX_CARD_CONFLICT: [409, '이미 다른 카드가 연결되어 있어요.'],
  CUSTOMER_ACCESS_REQUIRED: [403, '계정의 거래 자격을 확인해 주세요.'],
  EMAIL_VERIFICATION_REQUIRED: [403, '이메일 인증을 먼저 완료해 주세요.'],
  IDEMPOTENCY_CONFLICT: [409, '같은 요청 번호에 다른 내용이 있어요.'],
};
export class CardApplicationStore {
  constructor(private readonly database: Database, private readonly now: () => number = Date.now) {}

  async snapshot(userId: string): Promise<CardApplicationSnapshot> {
    const { rows } = await this.database.query<{result: CardApplicationSnapshot}>(
      'SELECT member_card_application($1::text) AS result', [userId]);
    return rows[0].result;
  }

  private async send(command: 'submit_card_application' | 'activate_card_application' | 'apply_card_application_event',
    input: Submit | Activate | ApplicationProviderEvent): Promise<CardApplication> {
    try {
      const { rows } = await this.database.query<{result: CardApplication}>(
        `SELECT ${command}($1::jsonb,$2::bigint) AS result`, [JSON.stringify(input), this.now()]);
      return rows[0].result;
    } catch (error) {
      const pg = error as {code?: string; message?: string};
      const known = pg.message && Object.hasOwn(failures, pg.message) ? failures[pg.message] : undefined;
      if (known) throw new LedgerError(known[0],pg.message!,known[1]);
      if (pg.code === '55P03' || pg.code === '40P01' || pg.code === '40001') {
        throw new LedgerError(503,'DATABASE_BUSY','처리 중이에요. 같은 요청 번호로 다시 확인해 주세요.');
      }
      throw error;
    }
  }

  submit(input: Submit) { return this.send('submit_card_application',input); }
  activate(input: Activate) { return this.send('activate_card_application',input); }
  providerEvent(input: ApplicationProviderEvent) { return this.send('apply_card_application_event',input); }
}
