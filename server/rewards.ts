import type { PoolClient } from 'pg';
import type { RewardGrantResult, RewardPreferenceResult, RewardsSnapshot } from '../shared/api';
import type { Database } from './database';
import { LedgerError } from './errors';
import { readRewardsSnapshot } from './reward-read';
import { throwRewardError } from './reward-errors';

type PreferenceInput = { userId: string; useFirst: boolean; expectedVersion: number; idempotencyKey: string };
type FundInput = { amountWon: number; idempotencyKey: string };
type ProgramInput = { enabled: boolean; idempotencyKey: string };
type GrantInput = { userId: string; amountWon: number; idempotencyKey: string };

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function invalid(): never { throw new LedgerError(400, 'INVALID_REWARD_COMMAND', '리워드 요청 형식을 확인해 주세요.'); }
function checkId(value: unknown): void { if (typeof value !== 'string' || !idPattern.test(value)) invalid(); }
function checkFields(value: unknown, fields: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const keys = Object.keys(value);
  if (keys.length !== fields.length || fields.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !fields.includes(key))) invalid();
}
function checkAmount(value: unknown): void { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid(); }

/** Rewards are noncash card benefits. Operator functions are denied to the runtime database role. */
export class RewardsStore {
  readonly database: Database;
  private readonly clock: () => number;
  constructor(database: Database, options: { now?: () => number } = {}) { this.database = database; this.clock = options.now ?? Date.now; }

  private now(): number {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0 || now > 8.64e15 - 9 * 60 * 60 * 1_000) throw new LedgerError(500, 'INVALID_CLOCK', '서버 시간을 확인할 수 없습니다.');
    return now;
  }

  private async command<T>(name: string, input: object): Promise<T> {
    const now = this.now();
    try {
      return await this.database.transaction(async (client) => {
        const { rows } = await client.query<{ result: T }>(`SELECT ${name}($1::jsonb, $2::bigint) AS result`, [JSON.stringify(input), now]);
        return rows[0].result;
      }, { isolation: 'read committed' });
    } catch (error) { return throwRewardError(error); }
  }

  async snapshot(userId: string, client?: PoolClient): Promise<RewardsSnapshot> {
    checkId(userId);
    const now = this.now();
    if (client) return readRewardsSnapshot(client, userId, now);
    return this.database.transaction((connection) => readRewardsSnapshot(connection, userId, now), { isolation: 'repeatable read' });
  }

  async setPreference(input: PreferenceInput): Promise<RewardPreferenceResult> {
    checkFields(input, ['userId', 'useFirst', 'expectedVersion', 'idempotencyKey']); checkId(input.userId); checkId(input.idempotencyKey);
    if (typeof input.useFirst !== 'boolean' || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) invalid();
    return this.command<RewardPreferenceResult>('apply_reward_preference', input);
  }

  async fundBudget(input: FundInput): Promise<Record<string, unknown>> {
    checkFields(input, ['amountWon', 'idempotencyKey']); checkAmount(input.amountWon); checkId(input.idempotencyKey);
    return this.command('operator_fund_reward_budget', input);
  }

  async setProgram(input: ProgramInput): Promise<Record<string, unknown>> {
    checkFields(input, ['enabled', 'idempotencyKey']); checkId(input.idempotencyKey); if (typeof input.enabled !== 'boolean') invalid();
    return this.command('operator_set_reward_program', input);
  }

  async grant(input: GrantInput): Promise<RewardGrantResult> {
    checkFields(input, ['userId', 'amountWon', 'idempotencyKey']); checkId(input.userId); checkAmount(input.amountWon); checkId(input.idempotencyKey);
    return this.command<RewardGrantResult>('operator_grant_rewards', input);
  }
}
