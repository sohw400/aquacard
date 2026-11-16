import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { MemberProfile } from '../shared/api';
import { LedgerError, type LedgerStore } from './ledger';

interface SignupInput { email: string; name: string; tag: string; password: string }
interface LoginInput { email: string; password: string }
export interface AuthOptions {
  now?: () => number;
  deliverRecovery?: (email: string, token: string) => Promise<void>;
}

const MINUTE = 60_000;
const SESSION_TTL = 7 * 24 * 60 * MINUTE;
const RECOVERY_TTL = 15 * MINUTE;
const SCRYPT = { N: 65_536, r: 8, p: 2, maxmem: 128 * 1024 * 1024 } as const;
const KEY_BYTES = 64;
const DUMMY_HASH = `scrypt$1$65536$8$2$${'00'.repeat(16)}$${'00'.repeat(KEY_BYTES)}`;
const RESERVED_TAGS = new Set([
  'aqua', 'aquacard', 'admin', 'administrator', 'support', 'help', 'security',
  'system', 'api', 'root', 'official', 'staff', 'team', 'billing', 'payments',
  'compliance', 'null', 'undefined', 'me', 'login', 'signup', 'account', 'accounts',
  'wallet', 'wallets', 'reserve', 'rewards', 'settings',
]);

interface RateRule { scope: string; value: string; limit: number; duration: number }
interface RateRow { attempts: number; expires_at: number }
interface RecoveryRow { user_id: string; expires_at: number; used_at: number | null }
type AuthResult = { user: MemberProfile; token: string };

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const profile = (user: MemberProfile): MemberProfile => ({ id: user.id, email: user.email, name: user.name, tag: user.tag, createdAt: user.createdAt });
const invalidCredentials = () => new LedgerError(401, 'INVALID_CREDENTIALS', '이메일 또는 비밀번호를 확인해 주세요.');
const invalidRecovery = () => new LedgerError(400, 'INVALID_RECOVERY', '복구 정보가 유효하지 않거나 만료되었습니다. 다시 요청해 주세요.');
const invalidSignup = () => new LedgerError(409, 'ACCOUNT_UNAVAILABLE', '입력한 이메일 또는 태그로 가입할 수 없습니다.');
const validToken = (token: unknown): token is string => typeof token === 'string' && /^[a-f0-9]{64}$/.test(token);

function emailInput(value: unknown): string {
  if (typeof value !== 'string' || value.length > 254) throw new LedgerError(400, 'INVALID_EMAIL', '이메일 형식을 확인해 주세요.');
  const email = value.trim().toLowerCase();
  const [local] = email.split('@');
  if (!local || local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')
    || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(email)) {
    throw new LedgerError(400, 'INVALID_EMAIL', '이메일 형식을 확인해 주세요.');
  }
  return email;
}

function tagInput(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64) throw new LedgerError(400, 'INVALID_TAG', '태그는 영문, 숫자, 점, 밑줄 3자부터 20자로 입력해 주세요.');
  const tag = value.trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9._]{1,18}[a-z0-9]$/.test(tag) || tag.includes('..') || /^\d+$/.test(tag) || RESERVED_TAGS.has(tag.replace(/[._]/g, ''))) {
    throw new LedgerError(400, 'INVALID_TAG', '사용할 수 없는 태그입니다. 다른 태그를 입력해 주세요.');
  }
  return tag;
}

function nameInput(value: unknown): string {
  if (typeof value !== 'string' || value.length > 160 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) throw new LedgerError(400, 'INVALID_NAME', '이름은 2자부터 40자로 입력해 주세요.');
  const name = value.trim().normalize('NFC').replace(/\s+/gu, ' ');
  if (Array.from(name).length < 2 || Array.from(name).length > 40 || !/[\p{L}\p{N}]/u.test(name)) {
    throw new LedgerError(400, 'INVALID_NAME', '이름은 2자부터 40자로 입력해 주세요.');
  }
  return name;
}

function passwordInput(value: unknown): string {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128 || /[\p{Cc}\p{Cs}]/u.test(value)) {
    throw new LedgerError(400, 'INVALID_PASSWORD', '비밀번호는 12자부터 128자로 입력해 주세요.');
  }
  const classes = [/[a-z]/.test(value), /[A-Z]/.test(value), /[0-9]/.test(value), /[^\p{L}\p{N}\s]/u.test(value)];
  if (classes.filter(Boolean).length < 3) throw new LedgerError(400, 'INVALID_PASSWORD', '비밀번호에 소문자, 대문자, 숫자, 기호 중 3종류 이상을 사용해 주세요.');
  return value;
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, KEY_BYTES, SCRYPT, (error, result) => error ? reject(error) : resolve(result)));
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$1$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password: string, record: string | undefined): Promise<boolean> {
  const parts = typeof record === 'string' ? record.split('$') : [];
  const valid = parts.length === 7 && parts[0] === 'scrypt' && parts[1] === '1'
    && parts[2] === String(SCRYPT.N) && parts[3] === String(SCRYPT.r) && parts[4] === String(SCRYPT.p)
    && /^[a-f0-9]{32}$/.test(parts[5]) && /^[a-f0-9]{128}$/.test(parts[6]);
  const selected = valid ? parts : DUMMY_HASH.split('$');
  const actual = await derive(password, Buffer.from(selected[5], 'hex'));
  const equal = timingSafeEqual(actual, Buffer.from(selected[6], 'hex'));
  return valid && equal;
}

/** Server credentials only. Returned session secrets belong in HttpOnly cookies, not JSON or logs. */
export class AuthService {
  private readonly now: () => number;
  private readonly deliverRecovery: AuthOptions['deliverRecovery'];

  constructor(private readonly store: LedgerStore, options: AuthOptions = {}) {
    this.now = options.now ?? Date.now;
    this.deliverRecovery = options.deliverRecovery;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id);
      CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS auth_recovery (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      ) STRICT;
      CREATE INDEX IF NOT EXISTS auth_recovery_user ON auth_recovery(user_id);
      CREATE INDEX IF NOT EXISTS auth_recovery_expiry ON auth_recovery(expires_at);
      CREATE TABLE IF NOT EXISTS auth_rate_limits (
        scope TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        attempts INTEGER NOT NULL CHECK (attempts > 0),
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (scope, key_hash)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS auth_rate_expiry ON auth_rate_limits(expires_at);
    `);
  }

  private cleanup(): void {
    const time = this.now();
    // Each request removes a bounded batch; expiry indexes avoid scanning live records.
    for (const table of ['auth_sessions', 'auth_recovery']) {
      this.store.db.prepare(`DELETE FROM ${table} WHERE token_hash IN (SELECT token_hash FROM ${table} WHERE expires_at <= ? LIMIT 256)`).run(time);
    }
    this.store.db.prepare('DELETE FROM auth_rate_limits WHERE (scope, key_hash) IN (SELECT scope, key_hash FROM auth_rate_limits WHERE expires_at <= ? LIMIT 256)').run(time);
  }

  private transaction<T>(run: () => T): T {
    this.store.db.exec('BEGIN IMMEDIATE');
    try { const result = run(); this.store.db.exec('COMMIT'); return result; }
    catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }

  private rateLimit(rules: RateRule[]): void {
    this.cleanup();
    const time = this.now();
    this.transaction(() => {
      const rows = rules.map((rule) => {
        const key = digest(`${rule.scope}\0${rule.value}`);
        const row = this.store.db.prepare('SELECT attempts, expires_at FROM auth_rate_limits WHERE scope = ? AND key_hash = ?').get(rule.scope, key) as unknown as RateRow | undefined;
        if (row && row.expires_at > time && row.attempts >= rule.limit) {
          // Blocked requests never extend the existing window.
          throw new LedgerError(429, 'RATE_LIMITED', '요청이 많습니다. 잠시 후 다시 시도해 주세요.');
        }
        return { rule, key, attempts: row && row.expires_at > time ? row.attempts + 1 : 1, expiresAt: row && row.expires_at > time ? row.expires_at : time + rule.duration };
      });
      const statement = this.store.db.prepare('INSERT INTO auth_rate_limits (scope, key_hash, attempts, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(scope, key_hash) DO UPDATE SET attempts = excluded.attempts, expires_at = excluded.expires_at');
      for (const row of rows) statement.run(row.rule.scope, row.key, row.attempts, row.expiresAt);
    });
  }

  private ip(rateKey: string): string {
    return typeof rateKey === 'string' && rateKey.trim().length > 0 && rateKey.length <= 256 ? rateKey.trim() : 'unknown';
  }

  private issueSession(userId: string, expectedHash: string): AuthResult {
    const token = randomBytes(32).toString('hex');
    return this.transaction(() => {
      // A reset can finish while scrypt is running. Check under the session-write lock.
      const current = this.store.getUserById(userId);
      if (!current || current.passwordHash !== expectedHash) throw invalidCredentials();
      const time = this.now();
      this.store.db.prepare('INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(digest(token), userId, time, time + SESSION_TTL);
      return { user: profile(current), token };
    });
  }

  async signup(input: SignupInput, rateKey: string): Promise<AuthResult> {
    this.rateLimit([{ scope: 'signup:ip', value: this.ip(rateKey), limit: 5, duration: 10 * MINUTE }]);
    if (!input || typeof input !== 'object') throw new LedgerError(400, 'INVALID_SIGNUP', '가입 정보를 확인해 주세요.');
    const email = emailInput(input.email);
    const name = nameInput(input.name);
    const tag = tagInput(input.tag);
    const password = passwordInput(input.password);
    this.rateLimit([{ scope: 'signup:account', value: email, limit: 3, duration: 10 * MINUTE }]);
    if (this.store.getUserByEmail(email) || this.store.getUserByTag(tag)) throw invalidSignup();
    const passwordHash = await hashPassword(password);
    const id = randomUUID();
    try { this.store.createUser({ id, email, name, tag, passwordHash, createdAt: this.now() }); }
    catch (error) { if (error instanceof LedgerError && error.status === 409) throw invalidSignup(); throw error; }
    return this.issueSession(id, passwordHash);
  }

  async login(input: LoginInput, rateKey: string): Promise<AuthResult> {
    let email: string | null = null;
    try { email = emailInput(input?.email); } catch { /* Keep malformed credentials generic. */ }
    this.rateLimit([
      { scope: 'login:ip', value: this.ip(rateKey), limit: 10, duration: MINUTE },
      { scope: 'login:account', value: email ?? 'invalid-email', limit: 5, duration: 5 * MINUTE },
    ]);
    const usablePassword = typeof input?.password === 'string' && input.password.length > 0 && input.password.length <= 128;
    const password = usablePassword ? input.password : 'Invalid-Login-Input-1!';
    const user = email ? this.store.getUserByEmail(email) : undefined;
    const verified = await verifyPassword(password, usablePassword ? user?.passwordHash : undefined);
    if (!user || !usablePassword || !verified) throw invalidCredentials();
    return this.issueSession(user.id, user.passwordHash);
  }

  authenticate(token: string | undefined): MemberProfile | null {
    this.cleanup();
    if (!validToken(token)) return null;
    const session = this.store.db.prepare('SELECT user_id, expires_at FROM auth_sessions WHERE token_hash = ?').get(digest(token)) as { user_id: string; expires_at: number } | undefined;
    if (!session || session.expires_at <= this.now()) return null;
    const user = this.store.getUserById(session.user_id);
    return user ? profile(user) : null;
  }

  logout(token: string | undefined): void {
    if (validToken(token)) this.store.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(digest(token));
  }

  async requestRecovery(rawEmail: string, rateKey: string): Promise<void> {
    const email = emailInput(rawEmail);
    this.rateLimit([
      { scope: 'recovery:ip', value: this.ip(rateKey), limit: 5, duration: 15 * MINUTE },
      { scope: 'recovery:account', value: email, limit: 3, duration: 15 * MINUTE },
    ]);
    if (!this.deliverRecovery) throw new LedgerError(503, 'RECOVERY_UNAVAILABLE', '비밀번호 복구를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.');
    const user = this.store.getUserByEmail(email);
    if (!user) return;
    const token = randomBytes(32).toString('hex');
    const tokenHash = digest(token);
    const time = this.now();
    this.transaction(() => {
      this.store.db.prepare('DELETE FROM auth_recovery WHERE user_id = ?').run(user.id);
      this.store.db.prepare('INSERT INTO auth_recovery (token_hash, user_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)').run(tokenHash, user.id, time, time + RECOVERY_TTL);
    });
    try { await this.deliverRecovery(user.email, token); }
    catch {
      this.store.db.prepare('DELETE FROM auth_recovery WHERE token_hash = ?').run(tokenHash);
      // Transport failures must not reveal whether the requested account exists.
    }
  }

  async resetPassword(token: string, rawPassword: string, rateKey: string): Promise<void> {
    this.rateLimit([
      { scope: 'reset:ip', value: this.ip(rateKey), limit: 5, duration: 15 * MINUTE },
      { scope: 'reset:token', value: validToken(token) ? digest(token) : 'invalid-token', limit: 5, duration: 15 * MINUTE },
    ]);
    const password = passwordInput(rawPassword);
    if (!validToken(token)) throw invalidRecovery();
    const tokenHash = digest(token);
    const existing = this.store.db.prepare('SELECT user_id, expires_at, used_at FROM auth_recovery WHERE token_hash = ?').get(tokenHash) as unknown as RecoveryRow | undefined;
    if (!existing || existing.used_at !== null || existing.expires_at <= this.now()) throw invalidRecovery();
    const passwordHash = await hashPassword(password);
    this.transaction(() => {
      const time = this.now();
      const current = this.store.db.prepare('SELECT user_id, expires_at, used_at FROM auth_recovery WHERE token_hash = ?').get(tokenHash) as unknown as RecoveryRow | undefined;
      if (!current || current.used_at !== null || current.expires_at <= time) throw invalidRecovery();
      const consumed = this.store.db.prepare('UPDATE auth_recovery SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').run(time, tokenHash, time);
      if (consumed.changes !== 1) throw invalidRecovery();
      const updated = this.store.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, current.user_id);
      if (updated.changes !== 1) throw invalidRecovery();
      this.store.db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(current.user_id);
      this.store.db.prepare('DELETE FROM auth_recovery WHERE user_id = ?').run(current.user_id);
    });
  }
}
