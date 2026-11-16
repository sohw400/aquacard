import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AccountSnapshot, MemberProfile, TransferRecord, TransferResult } from '../shared/api';

export interface UserRecord extends MemberProfile { passwordHash: string }

export class LedgerError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'LedgerError';
    this.status = status;
    this.code = code;
  }
}

const MAX_WON = Number.MAX_SAFE_INTEGER;
const DAY_MS = 86_400_000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;
const CONTROL_ACCOUNT = 'system:sandbox';

interface UserRow {
  id: string; email: string; name: string; tag: string; password_hash: string; created_at: number;
}
interface JournalRow {
  id: string; kind: 'member_transfer' | 'sandbox_credit'; amount_won: number; sender_id: string | null; recipient_id: string;
  sender_name: string; sender_tag: string; recipient_name: string; recipient_tag: string;
  request_payload: string; balance_after_won: number; created_at: number;
}

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  tag TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at >= 0 AND created_at <= 8640000000000000)
) STRICT;
CREATE TABLE IF NOT EXISTS ledger_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  currency TEXT NOT NULL DEFAULT 'KRW' CHECK(currency = 'KRW'),
  kind TEXT NOT NULL CHECK(kind IN ('user_spend', 'sandbox_control')),
  balance_won INTEGER NOT NULL DEFAULT 0,
  CHECK(typeof(balance_won) = 'integer'),
  CHECK((kind = 'user_spend' AND user_id IS NOT NULL AND balance_won >= 0 AND balance_won <= ${MAX_WON})
    OR (kind = 'sandbox_control' AND user_id IS NULL AND balance_won <= 0))
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ledger_single_sandbox ON ledger_accounts(kind) WHERE kind = 'sandbox_control';
/* A journal stores both equal legs together, so a partial or unbalanced journal cannot be inserted. */
CREATE TABLE IF NOT EXISTS journals (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('member_transfer', 'sandbox_credit')),
  currency TEXT NOT NULL DEFAULT 'KRW' CHECK(currency = 'KRW'),
  from_account_id TEXT NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  to_account_id TEXT NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  amount_won INTEGER NOT NULL CHECK(amount_won > 0 AND amount_won <= ${MAX_WON}),
  sender_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  sender_name TEXT NOT NULL,
  sender_tag TEXT NOT NULL,
  recipient_name TEXT NOT NULL,
  recipient_tag TEXT NOT NULL,
  request_owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  request_payload TEXT NOT NULL,
  balance_after_won INTEGER NOT NULL CHECK(balance_after_won >= 0 AND balance_after_won <= ${MAX_WON}),
  created_at INTEGER NOT NULL CHECK(created_at >= 0 AND created_at <= 8640000000000000),
  UNIQUE(request_owner_id, idempotency_key),
  CHECK(from_account_id <> to_account_id),
  CHECK((kind = 'member_transfer' AND sender_id IS NOT NULL AND sender_id <> recipient_id AND request_owner_id = sender_id)
    OR (kind = 'sandbox_credit' AND sender_id IS NULL AND request_owner_id = recipient_id))
) STRICT;
CREATE INDEX IF NOT EXISTS journals_outgoing ON journals(sender_id, created_at) WHERE kind = 'member_transfer';
CREATE INDEX IF NOT EXISTS journals_incoming ON journals(recipient_id, created_at);
CREATE VIEW IF NOT EXISTS journal_entries AS
  SELECT id AS journal_id, from_account_id AS account_id, -amount_won AS amount_won, currency, created_at FROM journals
  UNION ALL
  SELECT id AS journal_id, to_account_id AS account_id, amount_won, currency, created_at FROM journals;
CREATE TRIGGER IF NOT EXISTS journals_no_update BEFORE UPDATE ON journals
BEGIN SELECT RAISE(ABORT, 'journal history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS journals_no_delete BEFORE DELETE ON journals
BEGIN SELECT RAISE(ABORT, 'journal history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS journals_no_replace BEFORE INSERT ON journals
WHEN EXISTS (SELECT 1 FROM journals WHERE id = NEW.id OR (request_owner_id = NEW.request_owner_id AND idempotency_key = NEW.idempotency_key))
BEGIN SELECT RAISE(ABORT, 'journal history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS ledger_accounts_start_empty BEFORE INSERT ON ledger_accounts
WHEN NEW.balance_won <> 0
BEGIN SELECT RAISE(ABORT, 'ledger accounts must start empty'); END;
CREATE TRIGGER IF NOT EXISTS ledger_account_identity_no_update
BEFORE UPDATE OF id, user_id, currency, kind ON ledger_accounts
BEGIN SELECT RAISE(ABORT, 'ledger account identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS ledger_balance_matches_journal BEFORE UPDATE OF balance_won ON ledger_accounts
WHEN NEW.balance_won <> COALESCE((SELECT SUM(amount_won) FROM journal_entries WHERE account_id = OLD.id), 0)
BEGIN SELECT RAISE(ABORT, 'ledger balance must match the journal'); END;
CREATE TRIGGER IF NOT EXISTS journals_validate BEFORE INSERT ON journals
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM ledger_accounts WHERE id = NEW.to_account_id AND user_id = NEW.recipient_id AND kind = 'user_spend' AND currency = NEW.currency
  ) THEN RAISE(ABORT, 'invalid recipient ledger account') END;
  SELECT CASE WHEN NEW.kind = 'member_transfer' AND NOT EXISTS (
    SELECT 1 FROM ledger_accounts WHERE id = NEW.from_account_id AND user_id = NEW.sender_id AND kind = 'user_spend' AND currency = NEW.currency
      AND balance_won - NEW.amount_won = NEW.balance_after_won
  ) THEN RAISE(ABORT, 'invalid sender ledger account') END;
  SELECT CASE WHEN NEW.kind = 'sandbox_credit' AND NOT EXISTS (
    SELECT 1 FROM ledger_accounts AS source, ledger_accounts AS target
    WHERE source.id = NEW.from_account_id AND source.kind = 'sandbox_control' AND source.currency = NEW.currency
      AND target.id = NEW.to_account_id AND target.balance_won + NEW.amount_won = NEW.balance_after_won
  ) THEN RAISE(ABORT, 'invalid sandbox posting') END;
END;
CREATE TRIGGER IF NOT EXISTS journals_post_balances AFTER INSERT ON journals
BEGIN
  UPDATE ledger_accounts SET balance_won = balance_won - NEW.amount_won WHERE id = NEW.from_account_id;
  UPDATE ledger_accounts SET balance_won = balance_won + NEW.amount_won WHERE id = NEW.to_account_id;
END;
CREATE TABLE IF NOT EXISTS ledger_schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT;
`;

const normalizeEmail = (value: string) => value.trim().toLowerCase();
const normalizeTag = (value: string) => value.trim().replace(/^@/, '').toLowerCase();
const userAccountId = (userId: string) => `user:${userId}`;
const profile = ({ passwordHash: _passwordHash, ...user }: UserRecord): MemberProfile => user;
const maskName = (value: string) => {
  const letters = Array.from(value.trim());
  if (letters.length < 2) return `${letters[0] ?? ''}*`;
  if (letters.length === 2) return `${letters[0]}*`;
  return `${letters[0]}${'*'.repeat(letters.length - 2)}${letters.at(-1)}`;
};

function amount(value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new LedgerError(400, 'INVALID_AMOUNT', `${minimum.toLocaleString('ko-KR')}원 이상의 정수 금액을 입력해 주세요.`);
  }
}

function requestKey(value: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new LedgerError(400, 'INVALID_INPUT', '올바른 요청 번호를 입력해 주세요.');
  }
}

function serverNow(): number {
  const now = Date.now();
  if (!Number.isSafeInteger(now) || now < 0 || now > 8.64e15 - KST_OFFSET_MS) throw new LedgerError(500, 'INVALID_CLOCK', '서버 시간을 확인할 수 없습니다.');
  return now;
}

function rowToUser(row: UserRow | undefined): UserRecord | undefined {
  return row ? { id: row.id, email: row.email, name: row.name, tag: row.tag, passwordHash: row.password_hash, createdAt: row.created_at } : undefined;
}

/** Single-instance sandbox ledger. Only journals cause application balance changes. */
export class LedgerStore {
  readonly db: DatabaseSync;
  private closed = false;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      if (path !== ':memory:') chmodSync(path, 0o600);
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      this.atomic(() => {
        this.db.exec(schema);
        this.db.prepare("INSERT OR IGNORE INTO ledger_accounts(id, user_id, kind, balance_won) VALUES (?, NULL, 'sandbox_control', 0)").run(CONTROL_ACCOUNT);
        this.db.prepare('INSERT OR IGNORE INTO ledger_schema_migrations(version, applied_at) VALUES (1, ?)').run(serverNow());
      });
    } catch (error) {
      this.db.close(); this.closed = true;
      throw error;
    }
  }

  private atomic<T>(work: () => T, readOnly = false): T {
    let begun = false;
    try {
      this.db.exec(readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE');
      begun = true;
      const value = work();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      if (begun) { try { this.db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ } }
      if (error instanceof Error && /database (?:is locked|is busy)|SQLITE_BUSY/.test(error.message)) {
        throw new LedgerError(503, 'DATABASE_BUSY', '다른 요청을 처리하고 있습니다. 같은 요청 번호로 다시 시도해 주세요.');
      }
      throw error;
    }
  }

  createUser(input: { id: string; email: string; name: string; tag: string; passwordHash: string; createdAt: number }): UserRecord {
    if (typeof input.id !== 'string' || !input.id.trim() || input.id.length > 128
      || typeof input.email !== 'string' || typeof input.name !== 'string' || typeof input.tag !== 'string'
      || typeof input.passwordHash !== 'string' || !input.passwordHash || input.passwordHash.length > 1024
      || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0 || input.createdAt > 8.64e15) {
      throw new LedgerError(400, 'INVALID_INPUT', '회원 정보를 확인해 주세요.');
    }
    const email = normalizeEmail(input.email), name = input.name.trim(), tag = normalizeTag(input.tag);
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || name.length < 1 || name.length > 100
      || !/^[a-z0-9][a-z0-9._]{1,18}[a-z0-9]$/.test(tag) || tag.includes('..') || /^\d+$/.test(tag)) {
      throw new LedgerError(400, 'INVALID_INPUT', '이메일, 이름 또는 태그를 확인해 주세요.');
    }
    return this.atomic(() => {
      if (this.getUserById(input.id)) throw new LedgerError(409, 'ID_TAKEN', '이미 있는 회원 번호입니다.');
      if (this.getUserByEmail(email)) throw new LedgerError(409, 'EMAIL_TAKEN', '이미 가입한 이메일입니다.');
      if (this.getUserByTag(tag)) throw new LedgerError(409, 'TAG_TAKEN', '이미 사용하는 태그입니다.');
      this.db.prepare('INSERT INTO users(id, email, name, tag, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(input.id, email, name, tag, input.passwordHash, input.createdAt);
      this.db.prepare("INSERT INTO ledger_accounts(id, user_id, kind, balance_won) VALUES (?, ?, 'user_spend', 0)")
        .run(userAccountId(input.id), input.id);
      return { id: input.id, email, name, tag, passwordHash: input.passwordHash, createdAt: input.createdAt };
    });
  }

  getUserById(id: string): UserRecord | undefined {
    return typeof id === 'string' ? rowToUser(this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow | undefined) : undefined;
  }

  getUserByEmail(email: string): UserRecord | undefined {
    return typeof email === 'string' ? rowToUser(this.db.prepare('SELECT * FROM users WHERE email = ?').get(normalizeEmail(email)) as unknown as UserRow | undefined) : undefined;
  }

  getUserByTag(tag: string): UserRecord | undefined {
    return typeof tag === 'string' ? rowToUser(this.db.prepare('SELECT * FROM users WHERE tag = ?').get(normalizeTag(tag)) as unknown as UserRow | undefined) : undefined;
  }

  private requireUser(id: string): UserRecord {
    const user = this.getUserById(id);
    if (!user) throw new LedgerError(404, 'USER_NOT_FOUND', '회원을 찾을 수 없습니다.');
    return user;
  }

  private balance(userId: string): number {
    const account = this.db.prepare("SELECT balance_won FROM ledger_accounts WHERE user_id = ? AND kind = 'user_spend'").get(userId) as { balance_won: number } | undefined;
    if (!account || !Number.isSafeInteger(account.balance_won) || account.balance_won < 0) throw new LedgerError(500, 'INVALID_LEDGER', '계정의 원장을 확인할 수 없습니다.');
    return account.balance_won;
  }

  private limits(user: UserRecord, balanceWon: number, now: number): AccountSnapshot['limits'] {
    const shifted = new Date(now + KST_OFFSET_MS);
    const year = shifted.getUTCFullYear(), month = shifted.getUTCMonth(), day = shifted.getUTCDate();
    const monthStart = Date.UTC(year, month, 1) - KST_OFFSET_MS;
    const monthEnd = Date.UTC(year, month + 1, 1) - KST_OFFSET_MS;
    const dayStart = Date.UTC(year, month, day) - KST_OFFSET_MS;
    const dayEnd = dayStart + DAY_MS;
    const sums = this.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN created_at >= ? AND created_at < ? THEN amount_won ELSE 0 END), 0) AS today,
      COALESCE(SUM(amount_won), 0) AS month
      FROM journals WHERE kind = 'member_transfer' AND sender_id = ? AND created_at >= ? AND created_at < ?`)
      .get(dayStart, dayEnd, user.id, monthStart, monthEnd) as { today: number; month: number };
    const share = now < user.createdAt + 30 * DAY_MS ? 2 : 1;
    const perTransfer = 1_000_000 / share, daily = 2_000_000 / share, monthly = 5_000_000 / share;
    return { perTransfer, daily, monthly, sentToday: sums.today, sentMonth: sums.month,
      available: Math.max(0, Math.min(balanceWon, perTransfer, daily - sums.today, monthly - sums.month)) };
  }

  private record(journal: JournalRow, userId: string): TransferRecord {
    const funded = journal.kind === 'sandbox_credit';
    const sent = journal.sender_id === userId;
    return { id: journal.id, direction: funded ? 'funded' : sent ? 'sent' : 'received', amountWon: journal.amount_won,
      counterpartyName: sent ? journal.recipient_name : journal.sender_name,
      counterpartyTag: sent ? journal.recipient_tag : journal.sender_tag, createdAt: journal.created_at };
  }

  snapshot(userId: string): AccountSnapshot {
    return this.atomic(() => {
      const user = this.requireUser(userId);
      const balanceWon = this.balance(userId);
      const rows = this.db.prepare('SELECT * FROM journals WHERE sender_id = ? OR recipient_id = ? ORDER BY created_at DESC, rowid DESC')
        .all(userId, userId) as unknown as JournalRow[];
      return { user: profile(user), balanceWon, transactions: rows.map((row) => this.record(row, userId)), limits: this.limits(user, balanceWon, serverNow()) };
    }, true);
  }

  private replay(ownerId: string, key: string, payload: string): TransferResult | undefined {
    const row = this.db.prepare('SELECT * FROM journals WHERE request_owner_id = ? AND idempotency_key = ?')
      .get(ownerId, key) as unknown as JournalRow | undefined;
    if (!row) return undefined;
    if (row.request_payload !== payload) throw new LedgerError(409, 'IDEMPOTENCY_CONFLICT', '같은 요청 번호에 다른 내용이 있습니다.');
    return { transfer: this.record(row, ownerId), balanceWon: row.balance_after_won };
  }

  transfer(input: { senderId: string; recipientTag: string; amountWon: number; idempotencyKey: string }): TransferResult {
    amount(input.amountWon, 1_000); requestKey(input.idempotencyKey);
    return this.atomic(() => {
      const sender = this.requireUser(input.senderId);
      const recipient = this.getUserByTag(input.recipientTag);
      if (!recipient) throw new LedgerError(404, 'RECIPIENT_NOT_FOUND', '받는 회원을 찾을 수 없습니다.');
      if (recipient.id === sender.id) throw new LedgerError(400, 'SELF_TRANSFER', '자신에게는 보낼 수 없습니다.');
      const payload = JSON.stringify({ kind: 'member_transfer', recipientId: recipient.id, amountWon: input.amountWon });
      const replay = this.replay(sender.id, input.idempotencyKey, payload);
      if (replay) return replay;
      const balanceWon = this.balance(sender.id), recipientBalance = this.balance(recipient.id), now = serverNow();
      const limits = this.limits(sender, balanceWon, now);
      if (input.amountWon > balanceWon) throw new LedgerError(409, 'INSUFFICIENT_FUNDS', '보낼 수 있는 잔액이 부족합니다.');
      if (input.amountWon > limits.perTransfer || input.amountWon + limits.sentToday > limits.daily || input.amountWon + limits.sentMonth > limits.monthly) {
        throw new LedgerError(409, 'LIMIT_EXCEEDED', '한 번 또는 이번 기간에 보낼 수 있는 한도를 초과했습니다.');
      }
      if (!Number.isSafeInteger(recipientBalance + input.amountWon)) throw new LedgerError(409, 'RECIPIENT_BALANCE_LIMIT', '받는 회원의 잔액 한도를 초과합니다.');
      const id = randomUUID();
      this.db.prepare(`INSERT INTO journals(id, kind, from_account_id, to_account_id, amount_won, sender_id, recipient_id,
        sender_name, sender_tag, recipient_name, recipient_tag, request_owner_id, idempotency_key, request_payload, balance_after_won, created_at)
        VALUES (?, 'member_transfer', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, userAccountId(sender.id), userAccountId(recipient.id), input.amountWon, sender.id, recipient.id,
          maskName(sender.name), sender.tag, maskName(recipient.name), recipient.tag, sender.id, input.idempotencyKey, payload, balanceWon - input.amountWon, now);
      const row = this.db.prepare('SELECT * FROM journals WHERE id = ?').get(id) as unknown as JournalRow;
      return { transfer: this.record(row, sender.id), balanceWon: row.balance_after_won };
    });
  }

  /** Operator CLI and tests only; HTTP routes must never expose this control-account credit. */
  creditSandbox(input: { userId: string; amountWon: number; idempotencyKey: string }): TransferResult {
    amount(input.amountWon, 1); requestKey(input.idempotencyKey);
    return this.atomic(() => {
      const user = this.requireUser(input.userId);
      const payload = JSON.stringify({ kind: 'sandbox_credit', recipientId: user.id, amountWon: input.amountWon });
      const replay = this.replay(user.id, input.idempotencyKey, payload);
      if (replay) return replay;
      const balanceWon = this.balance(user.id) + input.amountWon;
      if (!Number.isSafeInteger(balanceWon)) throw new LedgerError(409, 'RECIPIENT_BALANCE_LIMIT', '충전 후 잔액이 처리 범위를 초과합니다.');
      const id = randomUUID(), now = serverNow();
      this.db.prepare(`INSERT INTO journals(id, kind, from_account_id, to_account_id, amount_won, sender_id, recipient_id,
        sender_name, sender_tag, recipient_name, recipient_tag, request_owner_id, idempotency_key, request_payload, balance_after_won, created_at)
        VALUES (?, 'sandbox_credit', ?, ?, ?, NULL, ?, '테스트 충전', 'sandbox', ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, CONTROL_ACCOUNT, userAccountId(user.id), input.amountWon, user.id, maskName(user.name), user.tag,
          user.id, input.idempotencyKey, payload, balanceWon, now);
      const row = this.db.prepare('SELECT * FROM journals WHERE id = ?').get(id) as unknown as JournalRow;
      return { transfer: this.record(row, user.id), balanceWon: row.balance_after_won };
    });
  }

  close(): void {
    if (!this.closed) { this.db.close(); this.closed = true; }
  }
}
