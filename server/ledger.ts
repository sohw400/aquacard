import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { AccountSnapshot, CardPaymentRecord, MemberProfile, TransferRecord, TransferResult } from '../shared/api';
import type { Database } from './database';
import { LedgerError } from './errors';
import { readRewardsSnapshot } from './reward-read';
export { LedgerError } from './errors';

export interface UserRecord extends MemberProfile { passwordHash: string }

interface UserRow extends QueryResultRow {
  id: string; email: string; name: string; tag: string; password_hash: string; created_at: string; email_verified_at?: string | null;
}
interface AccountRow extends QueryResultRow { id: string; user_id: string | null; balance_won: string }
interface JournalRow extends QueryResultRow {
  id: string; kind: 'member_transfer' | 'sandbox_credit'; amount_won: string; sender_id: string | null; recipient_id: string;
  sender_name: string; sender_tag: string; recipient_name: string; recipient_tag: string;
  request_payload: string; balance_after_won: string; created_at: string;
}
interface CardRow extends QueryResultRow {
  id: string; merchant_name: string; status: CardPaymentRecord['status']; authorized_won: string; held_won: string;
  captured_won: string; released_won: string; refunded_won: string; created_at: string; updated_at: string;
  policy_version: string | null; month: string | null; rate_bps: number | null;
  principal_authorized_won: string | null; principal_held_won: string | null; principal_captured_won: string | null;
  principal_released_won: string | null; principal_refunded_won: string | null;
  reward_authorized_won: string | null; reward_held_won: string | null; reward_captured_won: string | null;
  reward_released_won: string | null; reward_refunded_won: string | null;
  cashback_pending_won: string | null; cashback_awarded_won: string | null; cashback_reversed_won: string | null;
  cashback_offset_won: string | null; closed_at: string | null;
}
interface NewUser { id: string; email: string; name: string; tag: string; passwordHash: string; createdAt: number }

const MAX_WON = Number.MAX_SAFE_INTEGER;
const MAX_INTEGER = BigInt(MAX_WON);
const DAY_MS = 86_400_000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;
const CONTROL_ACCOUNT = 'system:sandbox';
const normalizeEmail = (value: string) => value.trim().toLowerCase();
const normalizeTag = (value: string) => value.trim().replace(/^@/, '').toLowerCase();
const userAccountId = (id: string) => `user:${id}`;
const holdAccountId = (id: string) => `hold:${id}`;
const profile = ({ passwordHash: _hash, ...user }: UserRecord): MemberProfile => user;

/** PostgreSQL BIGINT stays decimal text until this checked HTTP/domain boundary. */
function safeInteger(value: unknown): number {
  const text = typeof value === 'string' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
  if (!/^\d+$/.test(text)) throw new LedgerError(500, 'INVALID_LEDGER', '원장의 정수 금액을 확인할 수 없습니다.');
  const integer = BigInt(text);
  if (integer > MAX_INTEGER) throw new LedgerError(500, 'INVALID_LEDGER', '원장의 금액이 처리 범위를 초과합니다.');
  return Number(integer);
}

function rowToUser(row: UserRow | undefined): UserRecord | undefined {
  return row ? { id: row.id, email: row.email, name: row.name, tag: row.tag, passwordHash: row.password_hash, createdAt: safeInteger(row.created_at),
    emailVerifiedAt: row.email_verified_at == null ? null : safeInteger(row.email_verified_at) } : undefined;
}

function maskName(value: string): string {
  const letters = Array.from(value.trim());
  if (letters.length < 2) return `${letters[0] ?? ''}*`;
  if (letters.length === 2) return `${letters[0]}*`;
  return `${letters[0]}${'*'.repeat(letters.length - 2)}${letters.at(-1)}`;
}

function checkAmount(value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new LedgerError(400, 'INVALID_AMOUNT', `${minimum.toLocaleString('ko-KR')}원 이상의 정수 금액을 입력해 주세요.`);
}

function checkRequestKey(value: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new LedgerError(400, 'INVALID_INPUT', '올바른 요청 번호를 입력해 주세요.');
}

function domainError(error: unknown): never {
  const pg = error as { code?: string; constraint?: string; message?: string };
  if (pg.message === 'EMAIL_VERIFICATION_REQUIRED') throw new LedgerError(403, 'EMAIL_VERIFICATION_REQUIRED', '이메일 확인을 마친 뒤 거래해 주세요.');
  if (pg.message === 'CUSTOMER_ACCESS_REQUIRED') throw new LedgerError(403, 'CUSTOMER_ACCESS_REQUIRED', '현재 고객 상태에서는 이 거래를 진행할 수 없습니다.');
  if (pg.code === '23505') {
    if (pg.constraint === 'users_email_key') throw new LedgerError(409, 'EMAIL_TAKEN', '이미 가입한 이메일입니다.');
    if (pg.constraint === 'users_tag_key') throw new LedgerError(409, 'TAG_TAKEN', '이미 사용하는 태그입니다.');
    if (pg.constraint === 'users_pkey') throw new LedgerError(409, 'ID_TAKEN', '이미 있는 회원 번호입니다.');
    throw new LedgerError(409, 'IDEMPOTENCY_CONFLICT', '같은 요청 번호에 다른 내용이 있습니다.');
  }
  if (pg.code === '55P03' || pg.code === '40P01' || pg.code === '40001') throw new LedgerError(503, 'DATABASE_BUSY', '다른 요청을 처리하고 있습니다. 같은 요청 번호로 다시 시도해 주세요.');
  if (pg.code === '22003') throw new LedgerError(409, 'LEDGER_CAPACITY', '원장의 금액이 처리 범위를 초과합니다.');
  throw error;
}

/** PostgreSQL migrations are explicit; constructing a store performs no I/O. */
export class LedgerStore {
  readonly database: Database;
  readonly db: Database;
  private readonly clock: () => number;

  constructor(database: Database, options: { now?: () => number } = {}) {
    this.database = database; this.db = database; this.clock = options.now ?? Date.now;
  }

  private now(): number {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0 || now > 8.64e15 - KST_OFFSET_MS) throw new LedgerError(500, 'INVALID_CLOCK', '서버 시간을 확인할 수 없습니다.');
    return now;
  }

  private async write<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    try { return await this.database.transaction(work, { isolation: 'read committed' }); }
    catch (error) { return domainError(error); }
  }

  /** An optional client participates in the caller's transaction, e.g. atomic signup + session. */
  async createUser(input: NewUser, client?: PoolClient): Promise<UserRecord> {
    if (typeof input.id !== 'string' || !input.id.trim() || input.id.length > 128 || typeof input.email !== 'string'
      || typeof input.name !== 'string' || typeof input.tag !== 'string' || typeof input.passwordHash !== 'string'
      || !input.passwordHash || input.passwordHash.length > 1024 || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0 || input.createdAt > 8.64e15) {
      throw new LedgerError(400, 'INVALID_INPUT', '회원 정보를 확인해 주세요.');
    }
    const email = normalizeEmail(input.email), name = input.name.trim(), tag = normalizeTag(input.tag);
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name || name.length > 100
      || !/^[a-z0-9][a-z0-9._]{1,18}[a-z0-9]$/.test(tag) || tag.includes('..') || /^\d+$/.test(tag)) {
      throw new LedgerError(400, 'INVALID_INPUT', '이메일, 이름 또는 태그를 확인해 주세요.');
    }
    const create = async (connection: PoolClient) => {
      const result = await connection.query<UserRow>('INSERT INTO users(id, email, name, tag, password_hash, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        [input.id, email, name, tag, input.passwordHash, input.createdAt]);
      await connection.query("INSERT INTO ledger_accounts(id, user_id, kind) VALUES ($1, $2, 'user_spend')", [userAccountId(input.id), input.id]);
      return rowToUser(result.rows[0])!;
    };
    if (!client) return this.write(create);
    try { return await create(client); } catch (error) { return domainError(error); }
  }

  async getUserById(id: string): Promise<UserRecord | undefined> {
    if (typeof id !== 'string') return undefined;
    return rowToUser((await this.database.query<UserRow>('SELECT * FROM users WHERE id = $1', [id])).rows[0]);
  }

  async getUserByEmail(email: string): Promise<UserRecord | undefined> {
    if (typeof email !== 'string') return undefined;
    return rowToUser((await this.database.query<UserRow>('SELECT * FROM users WHERE email = $1', [normalizeEmail(email)])).rows[0]);
  }

  async getUserByTag(tag: string): Promise<UserRecord | undefined> {
    if (typeof tag !== 'string') return undefined;
    return rowToUser((await this.database.query<UserRow>('SELECT * FROM users WHERE tag = $1', [normalizeTag(tag)])).rows[0]);
  }

  private async requireUser(client: PoolClient, id: string): Promise<UserRecord> {
    const user = typeof id === 'string' ? rowToUser((await client.query<UserRow>('SELECT * FROM users WHERE id = $1', [id])).rows[0]) : undefined;
    if (!user) throw new LedgerError(404, 'USER_NOT_FOUND', '회원을 찾을 수 없습니다.');
    return user;
  }

  private async accountRows(client: PoolClient, ids: string[], lock = false): Promise<AccountRow[]> {
    const result = await client.query<AccountRow>(`SELECT id, user_id, balance_won FROM ledger_accounts WHERE id = ANY($1::text[]) ORDER BY id${lock ? ' FOR UPDATE' : ''}`, [ids]);
    if (result.rows.length !== new Set(ids).size) throw new LedgerError(500, 'INVALID_LEDGER', '계정의 원장을 확인할 수 없습니다.');
    return result.rows;
  }

  private cardRecord(row: CardRow): CardPaymentRecord {
    return { id: row.id, merchantName: row.merchant_name, status: row.status,
      authorizedWon: safeInteger(row.authorized_won), heldWon: safeInteger(row.held_won), capturedWon: safeInteger(row.captured_won),
      releasedWon: safeInteger(row.released_won), refundedWon: safeInteger(row.refunded_won),
      createdAt: safeInteger(row.created_at), updatedAt: safeInteger(row.updated_at),
      ...(row.policy_version === null ? {} : {
        funding: {
          principal: { authorizedWon: safeInteger(row.principal_authorized_won), heldWon: safeInteger(row.principal_held_won),
            capturedWon: safeInteger(row.principal_captured_won), releasedWon: safeInteger(row.principal_released_won), refundedWon: safeInteger(row.principal_refunded_won) },
          rewards: { authorizedWon: safeInteger(row.reward_authorized_won), heldWon: safeInteger(row.reward_held_won),
            capturedWon: safeInteger(row.reward_captured_won), releasedWon: safeInteger(row.reward_released_won), refundedWon: safeInteger(row.reward_refunded_won) },
        },
        cashback: { policyVersion: row.policy_version!, month: row.month!, rateBps: safeInteger(row.rate_bps),
          pendingWon: safeInteger(row.cashback_pending_won), awardedWon: safeInteger(row.cashback_awarded_won),
          reversedWon: safeInteger(row.cashback_reversed_won), offsetWon: safeInteger(row.cashback_offset_won),
          closedAt: row.closed_at === null ? null : safeInteger(row.closed_at) },
      }),
    };
  }

  private async limits(client: PoolClient, user: UserRecord, balanceWon: number, now: number): Promise<AccountSnapshot['limits']> {
    const shifted = new Date(now + KST_OFFSET_MS);
    const year = shifted.getUTCFullYear(), month = shifted.getUTCMonth(), day = shifted.getUTCDate();
    const monthStart = Date.UTC(year, month, 1) - KST_OFFSET_MS, monthEnd = Date.UTC(year, month + 1, 1) - KST_OFFSET_MS;
    const dayStart = Date.UTC(year, month, day) - KST_OFFSET_MS, dayEnd = dayStart + DAY_MS;
    const { rows } = await client.query<{ today: string; month: string }>(`SELECT
      COALESCE(SUM(CASE WHEN created_at >= $1 AND created_at < $2 THEN amount_won ELSE 0 END), 0)::text AS today,
      COALESCE(SUM(amount_won), 0)::text AS month FROM journals
      WHERE kind = 'member_transfer' AND sender_id = $3 AND created_at >= $4 AND created_at < $5`, [dayStart, dayEnd, user.id, monthStart, monthEnd]);
    const sentToday = safeInteger(rows[0].today), sentMonth = safeInteger(rows[0].month);
    const share = now < user.createdAt + 30 * DAY_MS ? 2 : 1;
    const perTransfer = 1_000_000 / share, daily = 2_000_000 / share, monthly = 5_000_000 / share;
    return { perTransfer, daily, monthly, sentToday, sentMonth,
      available: Math.max(0, Math.min(balanceWon, perTransfer, daily - sentToday, monthly - sentMonth)) };
  }

  private record(row: JournalRow, userId: string): TransferRecord {
    const sent = row.sender_id === userId;
    return { id: row.id, direction: row.kind === 'sandbox_credit' ? 'funded' : sent ? 'sent' : 'received', amountWon: safeInteger(row.amount_won),
      counterpartyName: sent ? row.recipient_name : row.sender_name, counterpartyTag: sent ? row.recipient_tag : row.sender_tag, createdAt: safeInteger(row.created_at) };
  }

  async snapshot(userId: string): Promise<AccountSnapshot> {
    return this.database.transaction(async (client) => {
      const now = this.now();
      const user = await this.requireUser(client, userId);
      const accounts = await this.accountRows(client, [userAccountId(userId), holdAccountId(userId)]);
      const balanceWon = safeInteger(accounts.find((row) => row.id === userAccountId(userId))!.balance_won);
      const heldBalanceWon = safeInteger(accounts.find((row) => row.id === holdAccountId(userId))!.balance_won);
      const totalBalanceWon = safeInteger(String(BigInt(balanceWon) + BigInt(heldBalanceWon)));
      const history = await client.query<JournalRow>(`SELECT * FROM journals WHERE kind IN ('member_transfer', 'sandbox_credit')
        AND (sender_id = $1 OR recipient_id = $1) ORDER BY created_at DESC, id DESC`, [userId]);
      const payments = await client.query<CardRow>(`SELECT p.*, a.policy_version, a.month, a.rate_bps,
        a.principal_authorized_won, a.principal_held_won, a.principal_captured_won, a.principal_released_won, a.principal_refunded_won,
        a.reward_authorized_won, a.reward_held_won, a.reward_captured_won, a.reward_released_won, a.reward_refunded_won,
        a.cashback_pending_won, a.cashback_awarded_won, a.cashback_reversed_won, a.cashback_offset_won, a.closed_at
        FROM card_payments p LEFT JOIN card_reward_allocations a ON a.payment_id = p.id
        WHERE p.user_id = $1 ORDER BY p.created_at DESC, p.id DESC`, [userId]);
      const access = (await client.query<{ result: AccountSnapshot['access'] }>('SELECT customer_access_snapshot($1::text) AS result', [userId])).rows[0].result;
      return { user: profile(user), access, balanceWon, heldBalanceWon, totalBalanceWon, rewards: await readRewardsSnapshot(client, userId, now), cardPayments: payments.rows.map((row) => this.cardRecord(row)),
        transactions: history.rows.map((row) => this.record(row, userId)), limits: await this.limits(client, user, balanceWon, now) };
    }, { isolation: 'repeatable read' });
  }

  private async replay(client: PoolClient, ownerId: string, key: string, payload: string): Promise<TransferResult | undefined> {
    const row = (await client.query<JournalRow>('SELECT * FROM journals WHERE request_owner_id = $1 AND idempotency_key = $2', [ownerId, key])).rows[0];
    if (!row) return undefined;
    if (row.request_payload !== payload) throw new LedgerError(409, 'IDEMPOTENCY_CONFLICT', '같은 요청 번호에 다른 내용이 있습니다.');
    return { transfer: this.record(row, ownerId), balanceWon: safeInteger(row.balance_after_won) };
  }

  async transfer(input: { senderId: string; recipientTag: string; amountWon: number; idempotencyKey: string }): Promise<TransferResult> {
    checkAmount(input.amountWon, 1_000); checkRequestKey(input.idempotencyKey);
    return this.write(async (client) => {
      const sender = await this.requireUser(client, input.senderId);
      const recipient = typeof input.recipientTag === 'string' ? rowToUser((await client.query<UserRow>('SELECT * FROM users WHERE tag = $1', [normalizeTag(input.recipientTag)])).rows[0]) : undefined;
      if (!recipient) throw new LedgerError(404, 'RECIPIENT_NOT_FOUND', '받는 회원을 찾을 수 없습니다.');
      if (recipient.id === sender.id) throw new LedgerError(400, 'SELF_TRANSFER', '자신에게는 보낼 수 없습니다.');
      const payload = JSON.stringify({ kind: 'member_transfer', recipientId: recipient.id, amountWon: input.amountWon });
      // Resolve repeated requests before applying a newer access restriction.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':aqua:transfer:' || $1 || ':' || $2, 0))", [sender.id, input.idempotencyKey]);
      const prior = await this.replay(client, sender.id, input.idempotencyKey, payload);
      if (prior) return prior;
      // Policy locks precede monetary account locks and are retained through commit.
      await client.query('SELECT customer_require_active($1::text[])', [[sender.id, recipient.id]]);
      const accounts = await this.accountRows(client, [userAccountId(sender.id), userAccountId(recipient.id)], true);
      const repeated = await this.replay(client, sender.id, input.idempotencyKey, payload);
      if (repeated) return repeated;
      const balanceWon = safeInteger(accounts.find((account) => account.id === userAccountId(sender.id))!.balance_won);
      const recipientBalance = safeInteger(accounts.find((account) => account.id === userAccountId(recipient.id))!.balance_won);
      // Every card command also owns this spend row before changing holds, so it is the aggregate-balance mutex.
      const [recipientHold] = await this.accountRows(client, [holdAccountId(recipient.id)]);
      const recipientHeld = safeInteger(recipientHold.balance_won);
      const now = this.now(), limits = await this.limits(client, sender, balanceWon, now);
      if (input.amountWon > balanceWon) throw new LedgerError(409, 'INSUFFICIENT_FUNDS', '보낼 수 있는 잔액이 부족합니다.');
      if (input.amountWon > limits.perTransfer || input.amountWon + limits.sentToday > limits.daily || input.amountWon + limits.sentMonth > limits.monthly) throw new LedgerError(409, 'LIMIT_EXCEEDED', '한 번 또는 이번 기간에 보낼 수 있는 한도를 초과했습니다.');
      if (BigInt(input.amountWon) + BigInt(recipientBalance) + BigInt(recipientHeld) > MAX_INTEGER) throw new LedgerError(409, 'RECIPIENT_BALANCE_LIMIT', '받는 회원의 잔액 한도를 초과합니다.');
      const result = await client.query<JournalRow>(`INSERT INTO journals(id, kind, from_account_id, to_account_id, amount_won, sender_id, recipient_id,
        sender_name, sender_tag, recipient_name, recipient_tag, request_owner_id, idempotency_key, request_payload, balance_after_won, created_at)
        VALUES ($1, 'member_transfer', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
      [randomUUID(), userAccountId(sender.id), userAccountId(recipient.id), input.amountWon, sender.id, recipient.id, maskName(sender.name), sender.tag,
        maskName(recipient.name), recipient.tag, sender.id, input.idempotencyKey, payload, balanceWon - input.amountWon, now]);
      return { transfer: this.record(result.rows[0], sender.id), balanceWon: safeInteger(result.rows[0].balance_after_won) };
    });
  }

  /** Explicit operator CLI/test credit only. No HTTP funding endpoint exists. */
  async creditSandbox(input: { userId: string; amountWon: number; idempotencyKey: string }): Promise<TransferResult> {
    checkAmount(input.amountWon, 1); checkRequestKey(input.idempotencyKey);
    return this.write(async (client) => {
      const user = await this.requireUser(client, input.userId);
      const payload = JSON.stringify({ kind: 'sandbox_credit', recipientId: user.id, amountWon: input.amountWon });
      const prior = await this.replay(client, user.id, input.idempotencyKey, payload);
      if (prior) return prior;
      const accounts = await this.accountRows(client, [CONTROL_ACCOUNT, userAccountId(user.id)], true);
      const repeated = await this.replay(client, user.id, input.idempotencyKey, payload);
      if (repeated) return repeated;
      const balance = safeInteger(accounts.find((account) => account.id === userAccountId(user.id))!.balance_won);
      const [hold] = await this.accountRows(client, [holdAccountId(user.id)]);
      if (BigInt(input.amountWon) + BigInt(balance) + BigInt(safeInteger(hold.balance_won)) > MAX_INTEGER) throw new LedgerError(409, 'RECIPIENT_BALANCE_LIMIT', '충전 후 잔액이 처리 범위를 초과합니다.');
      const result = await client.query<JournalRow>(`INSERT INTO journals(id, kind, from_account_id, to_account_id, amount_won, sender_id, recipient_id,
        sender_name, sender_tag, recipient_name, recipient_tag, request_owner_id, idempotency_key, request_payload, balance_after_won, created_at)
        VALUES ($1, 'sandbox_credit', $2, $3, $4, NULL, $5, '테스트 충전', 'sandbox', $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [randomUUID(), CONTROL_ACCOUNT, userAccountId(user.id), input.amountWon, user.id, maskName(user.name), user.tag, user.id, input.idempotencyKey, payload, balance + input.amountWon, this.now()]);
      return { transfer: this.record(result.rows[0], user.id), balanceWon: safeInteger(result.rows[0].balance_after_won) };
    });
  }

  /** The injected Database owns its Pool; the application closes it once on shutdown. */
  async close(): Promise<void> {}
}
