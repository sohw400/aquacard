import type { FundingInput, MemberFunding } from '../shared/funding';
import type { Database } from './database';
import { LedgerError } from './errors';

const errors: Record<string, [number,string]> = {
  INVALID_FUNDING_INPUT: [400,'코인, 네트워크, 수량과 체험용 목적지를 확인해 주세요.'],
  FUNDING_NOT_FOUND: [404,'입출금 요청을 찾을 수 없어요.'],
  FUNDING_KEY_CONFLICT: [409,'같은 요청 번호로 다른 작업을 진행할 수 없어요.'],
  FUNDING_STATE_CONFLICT: [409,'입출금 처리 상태를 다시 확인해 주세요.'],
  FUNDING_QUOTE_EXPIRED: [409,'견적 시간이 지나 새 견적이 필요해요.'],
  FUNDING_OPEN_LIMIT: [409,'처리 중인 입출금을 마치거나 사용하지 않는 요청을 취소해 주세요.'],
  FUNDING_REVIEW_REQUIRED: [409,'이전에 받은 입금을 확인 중이에요.'],
  FUNDING_BALANCE_LOW: [409,'사용할 수 있는 지갑 잔액이 부족해요.'],
  RECIPIENT_BALANCE_LIMIT: [409,'지갑 잔액의 처리 한도에 도달했어요.'],
  CUSTOMER_ACCESS_REQUIRED: [403,'본인 확인과 거래 가능 상태를 확인해 주세요.'],
  EMAIL_VERIFICATION_REQUIRED: [403,'가입 이메일 확인이 필요해요.'],
  FUNDING_OBSERVATION_MISMATCH: [409,'확인된 이체 정보와 요청 정보가 달라요.'],
  FUNDING_DUPLICATE_TRANSFER: [409,'이미 다른 요청에서 처리한 이체예요.'],
  FUNDING_CONFIRMATIONS_REQUIRED: [409,'네트워크 확인 횟수가 부족해요.'],
};
async function read<T>(db: Database, sql: string, params: unknown[]): Promise<T> {
  try {
    const result = await db.query<{ result:T }>(sql,params);
    return result.rows[0].result;
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (Object.hasOwn(errors,code)) {
      const [status,message]=errors[code];
      throw new LedgerError(status,code,message);
    }
    throw error;
  }
}
export class FundingStore {
  constructor(readonly db: Database, private readonly now: () => number = Date.now) {}
  history(user: string) { return read<MemberFunding[]>(this.db,'SELECT funding_member_history($1) AS result',[user]); }
  intent(user: string, key: string, input: FundingInput) {
    return read<MemberFunding>(this.db,'SELECT funding_intent($1,$2,$3::jsonb,$4) AS result',[user,key,JSON.stringify(input),this.now()]);
  }
  event(input: Record<string,unknown>) {
    return read<MemberFunding>(this.db,'SELECT funding_operator_event($1::jsonb,$2) AS result',[JSON.stringify(input),this.now()]);
  }
}
