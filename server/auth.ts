import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { AuthSessionRecord, EmailVerificationSnapshot, MemberProfile, SessionSecuritySnapshot } from '../shared/api';
import { LedgerError, type LedgerStore } from './ledger';
import type { AuthMailQueue } from './auth-mail';

interface SignupInput { email: string; name: string; tag: string; password: string }
interface LoginInput { email: string; password: string }
export interface AuthOptions {
  now?: () => number;
  mailQueue?: AuthMailQueue;
  /** Test-only synchronous transport. The executable API always uses the durable queue. */
  deliverRecovery?: (email: string, token: string) => Promise<void>;
}
/** Only the derived family label is retained. User agents are not trusted device identity. */
export interface SessionMetadata { userAgent?: string }

const MINUTE = 60_000;
const SESSION_TTL = 7 * 24 * 60 * MINUTE;
const RECOVERY_TTL = 15 * MINUTE;
const REAUTHENTICATION_TTL = 5 * MINUTE;
const SESSION_ACTIVITY_INTERVAL = 5 * MINUTE;
const MAX_SESSIONS = 20;
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
interface RateRow extends QueryResultRow { attempts: number; expires_at: string | number }
interface RecoveryRow extends QueryResultRow { user_id: string; expires_at: string | number; used_at: string | number | null }
interface UserRow extends QueryResultRow { id: string; email: string; name: string; tag: string; password_hash: string; created_at: string | number; email_verified_at: string | number | null }
interface SessionRow extends QueryResultRow {
  session_id: string; token_hash: string; user_id: string; device_label: string;
  created_at: string | number; expires_at: string | number; last_seen_at: string | number;
  reauthenticated_at: string | number | null;
}
type AuthResult = { user: MemberProfile; token: string };

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const invalidCredentials = () => new LedgerError(401, 'INVALID_CREDENTIALS', '이메일 또는 비밀번호를 확인해 주세요.');
const invalidRecovery = () => new LedgerError(400, 'INVALID_RECOVERY', '복구 정보가 유효하지 않거나 만료되었습니다. 다시 요청해 주세요.');
const invalidVerification = () => new LedgerError(400, 'INVALID_EMAIL_VERIFICATION', '이메일 확인 코드가 유효하지 않거나 만료되었습니다. 다시 요청해 주세요.');
const invalidSignup = () => new LedgerError(409, 'ACCOUNT_UNAVAILABLE', '입력한 이메일 또는 태그로 가입할 수 없습니다.');
const validToken = (token: unknown): token is string => typeof token === 'string' && /^[a-f0-9]{64}$/.test(token);
const authenticationRequired = () => new LedgerError(401, 'AUTH_REQUIRED', '다시 로그인해 주세요.');
const reauthenticationRequired = () => new LedgerError(403, 'REAUTHENTICATION_REQUIRED', '보안을 위해 비밀번호를 다시 입력해 주세요.');

function deviceLabel(metadata?: SessionMetadata): string {
  const agent = typeof metadata?.userAgent === 'string' ? metadata.userAgent.slice(0, 1024) : '';
  const device = /iPad/i.test(agent) ? 'iPad' : /iPhone/i.test(agent) ? 'iPhone'
    : /Android/i.test(agent) ? 'Android' : /Windows/i.test(agent) ? 'Windows'
    : /Macintosh|Mac OS X/i.test(agent) ? 'Mac' : /Linux/i.test(agent) ? 'Linux' : '알 수 없는 기기';
  const browser = /Edg(?:e|A|iOS)?\//i.test(agent) ? 'Edge' : /SamsungBrowser\//i.test(agent) ? 'Samsung Internet'
    : /Firefox\/|FxiOS\//i.test(agent) ? 'Firefox' : /Chrome\/|CriOS\//i.test(agent) ? 'Chrome'
    : /Safari\//i.test(agent) ? 'Safari' : '';
  return browser ? `${device} · ${browser}` : device;
}

function epoch(value: unknown): number {
  const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 0 || number > 8_640_000_000_000_000) throw new LedgerError(500, 'AUTH_STATE_INVALID', '인증 정보를 처리할 수 없습니다.');
  return number;
}
const rowProfile = (user: UserRow): MemberProfile => ({ id: user.id, email: user.email, name: user.name, tag: user.tag, createdAt: epoch(user.created_at), emailVerifiedAt: user.email_verified_at === null ? null : epoch(user.email_verified_at) });

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
  private readonly mailQueue: AuthOptions['mailQueue'];

  constructor(private readonly store: LedgerStore, options: AuthOptions = {}) {
    this.now = options.now ?? Date.now;
    this.deliverRecovery = options.deliverRecovery;
    this.mailQueue = options.mailQueue;
    if (options.deliverRecovery && process.env.NODE_ENV === 'production') throw new Error('Production authentication requires the durable mail queue.');
  }

  private time(): number { return epoch(this.now()); }

  private async cleanup(): Promise<void> {
    const time = this.time();
    // Bounded batches skip rows owned by active login/reset/rate transactions.
    for (const table of ['auth_sessions', 'auth_recovery']) {
      await this.store.database.query(`DELETE FROM ${table} WHERE token_hash IN (
        SELECT token_hash FROM ${table} WHERE expires_at <= $1
        ORDER BY expires_at, token_hash LIMIT 256 FOR UPDATE SKIP LOCKED
      )`, [time]);
    }
    // Keep a consumed verification receipt for same-owner retry after a lost response.
    await this.store.database.query('SELECT cleanup_auth_email_verification($1::bigint)', [time]);
    await this.store.database.query(`DELETE FROM auth_rate_limits WHERE (scope, key_hash) IN (
      SELECT scope, key_hash FROM auth_rate_limits WHERE expires_at <= $1
      ORDER BY expires_at, scope, key_hash LIMIT 256 FOR UPDATE SKIP LOCKED
    )`, [time]);
  }

  private async rateLimit(rules: RateRule[]): Promise<void> {
    await this.cleanup();
    const ordered = rules.map((rule) => ({ ...rule, key: digest(`${rule.scope}\0${rule.value}`) }))
      .sort((left, right) => {
        const a = `${left.scope}\0${left.key}`; const b = `${right.scope}\0${right.key}`;
        return a < b ? -1 : a > b ? 1 : 0;
      });
    await this.store.database.transaction(async (client) => {
      for (const rule of ordered) {
        const time = this.time();
        // UPSERT also locks an existing row, including simultaneous first requests.
        const { rows } = await client.query<RateRow>(`INSERT INTO auth_rate_limits (scope, key_hash, attempts, expires_at)
          VALUES ($1, $2, 0, $3)
          ON CONFLICT (scope, key_hash) DO UPDATE SET attempts = auth_rate_limits.attempts
          RETURNING attempts, expires_at`, [rule.scope, rule.key, epoch(time + rule.duration)]);
        const row = rows[0];
        const active = epoch(row.expires_at) > time;
        if (active && row.attempts >= rule.limit) {
          // The transaction rolls back; blocked requests never extend the window.
          throw new LedgerError(429, 'RATE_LIMITED', '요청이 많습니다. 잠시 후 다시 시도해 주세요.');
        }
        await client.query('UPDATE auth_rate_limits SET attempts = $3, expires_at = $4 WHERE scope = $1 AND key_hash = $2',
          [rule.scope, rule.key, active ? row.attempts + 1 : 1, active ? epoch(row.expires_at) : epoch(time + rule.duration)]);
      }
    });
  }

  private ip(rateKey: string): string {
    return typeof rateKey === 'string' && rateKey.trim().length > 0 && rateKey.length <= 256 ? rateKey.trim() : 'unknown';
  }

  private async issueSession(userId: string, expectedHash: string, metadata?: SessionMetadata, transactionClient?: PoolClient): Promise<AuthResult> {
    const token = randomBytes(32).toString('hex');
    const issue = async (client: PoolClient): Promise<AuthResult> => {
      // Every credential writer locks users first, then its token/session rows.
      const { rows } = await client.query<UserRow>('SELECT id, email, name, tag, password_hash, created_at, email_verified_at FROM users WHERE id = $1 FOR UPDATE', [userId]);
      const current = rows[0];
      if (!current || current.password_hash !== expectedHash) throw invalidCredentials();
      const time = this.time();
      // A finite list also bounds the account-management response. Issuance and revocation
      // share the user lock, so sessions created before revoke-others cannot escape it.
      await client.query('DELETE FROM auth_sessions WHERE user_id = $1 AND expires_at <= $2', [userId, time]);
      await client.query(`DELETE FROM auth_sessions WHERE token_hash IN (
        SELECT token_hash FROM auth_sessions WHERE user_id = $1
        ORDER BY created_at DESC, session_id DESC OFFSET $2
      )`, [userId, MAX_SESSIONS - 1]);
      await client.query(`INSERT INTO auth_sessions
        (token_hash, user_id, created_at, expires_at, device_label, last_seen_at, reauthenticated_at)
        VALUES ($1, $2, $3, $4, $5, $3, $3)`,
      [digest(token), userId, time, epoch(time + SESSION_TTL), deviceLabel(metadata)]);
      return { user: rowProfile(current), token };
    };
    return transactionClient ? issue(transactionClient) : this.store.database.transaction(issue);
  }

  async signup(input: SignupInput, rateKey: string, metadata?: SessionMetadata): Promise<AuthResult> {
    await this.rateLimit([{ scope: 'signup:ip', value: this.ip(rateKey), limit: 5, duration: 10 * MINUTE }]);
    if (!input || typeof input !== 'object') throw new LedgerError(400, 'INVALID_SIGNUP', '가입 정보를 확인해 주세요.');
    const email = emailInput(input.email);
    const name = nameInput(input.name);
    const tag = tagInput(input.tag);
    const password = passwordInput(input.password);
    await this.rateLimit([{ scope: 'signup:account', value: email, limit: 3, duration: 10 * MINUTE }]);
    if (await this.store.getUserByEmail(email) || await this.store.getUserByTag(tag)) throw invalidSignup();
    const passwordHash = await hashPassword(password);
    const id = randomUUID();
    try {
      return await this.store.database.transaction(async (client) => {
        await this.store.createUser({ id, email, name, tag, passwordHash, createdAt: this.time() }, client);
        return this.issueSession(id, passwordHash, metadata, client);
      });
    } catch (error) {
      if (error instanceof LedgerError && error.status === 409) throw invalidSignup();
      throw error;
    }
  }

  async login(input: LoginInput, rateKey: string, metadata?: SessionMetadata): Promise<AuthResult> {
    let email: string | null = null;
    try { email = emailInput(input?.email); } catch { /* Keep malformed credentials generic. */ }
    await this.rateLimit([
      { scope: 'login:ip', value: this.ip(rateKey), limit: 10, duration: MINUTE },
      { scope: 'login:account', value: email ?? 'invalid-email', limit: 5, duration: 5 * MINUTE },
    ]);
    const usablePassword = typeof input?.password === 'string' && input.password.length > 0 && input.password.length <= 128;
    const password = usablePassword ? input.password : 'Invalid-Login-Input-1!';
    const user = email ? await this.store.getUserByEmail(email) : undefined;
    const verified = await verifyPassword(password, usablePassword ? user?.passwordHash : undefined);
    if (!user || !usablePassword || !verified) throw invalidCredentials();
    return this.issueSession(user.id, user.passwordHash, metadata);
  }

  async authenticate(token: string | undefined): Promise<MemberProfile | null> {
    await this.cleanup();
    if (!validToken(token)) return null;
    const { rows } = await this.store.database.query<UserRow>(`SELECT u.id, u.email, u.name, u.tag, u.password_hash, u.created_at, u.email_verified_at
      FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > $2`, [digest(token), this.time()]);
    if (rows[0]) {
      const time = this.time();
      await this.store.database.query(`UPDATE auth_sessions SET last_seen_at = $2
        WHERE token_hash = $1 AND expires_at > $2 AND created_at <= $2 AND last_seen_at <= $3`,
      [digest(token), time, time - SESSION_ACTIVITY_INTERVAL]);
    }
    return rows[0] ? rowProfile(rows[0]) : null;
  }

  async logout(token: string | undefined): Promise<void> {
    if (!validToken(token)) return;
    const tokenHash = digest(token);
    const { rows } = await this.store.database.query<{ user_id: string }>('SELECT user_id FROM auth_sessions WHERE token_hash = $1', [tokenHash]);
    if (!rows[0]) return;
    await this.store.database.transaction(async (client) => {
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [rows[0].user_id]);
      await client.query('DELETE FROM auth_sessions WHERE token_hash = $1 AND user_id = $2', [tokenHash, rows[0].user_id]);
    });
  }

  /** Every security mutation rechecks the caller after taking the shared user lock. */
  private async lockedSession(client: PoolClient, token: string | undefined, userId: string): Promise<SessionRow> {
    if (!validToken(token) || typeof userId !== 'string') throw authenticationRequired();
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const { rows } = await client.query<SessionRow>(`SELECT * FROM auth_sessions
      WHERE token_hash = $1 AND user_id = $2 FOR UPDATE`, [digest(token), userId]);
    const row = rows[0];
    if (!row || epoch(row.created_at) > this.time() || epoch(row.expires_at) <= this.time()) throw authenticationRequired();
    return row;
  }

  private reauthenticatedUntil(session: SessionRow): number | null {
    if (session.reauthenticated_at === null) return null;
    const verified = epoch(session.reauthenticated_at);
    const until = Math.min(epoch(verified + REAUTHENTICATION_TTL), epoch(session.expires_at));
    return verified <= this.time() && until > this.time() ? until : null;
  }

  async listSessions(token: string | undefined, userId: string): Promise<SessionSecuritySnapshot> {
    return this.store.database.transaction(async (client) => {
      const current = await this.lockedSession(client, token, userId);
      const { rows } = await client.query<SessionRow>(`SELECT * FROM auth_sessions
        WHERE user_id = $1 AND expires_at > $2
        ORDER BY (session_id = $3) DESC, last_seen_at DESC, session_id LIMIT $4`,
      [userId, this.time(), current.session_id, MAX_SESSIONS]);
      const sessions: AuthSessionRecord[] = rows.map((row) => ({
        id: row.session_id, deviceLabel: row.device_label,
        createdAt: epoch(row.created_at), lastSeenAt: epoch(row.last_seen_at), expiresAt: epoch(row.expires_at),
        current: row.session_id === current.session_id,
      }));
      return { sessions, reauthenticatedUntil: this.reauthenticatedUntil(current) };
    });
  }

  async reauthenticate(token: string | undefined, userId: string, rawPassword: string, rateKey: string): Promise<{ reauthenticatedUntil: number }> {
    await this.rateLimit([
      { scope: 'reauth:ip', value: this.ip(rateKey), limit: 10, duration: 5 * MINUTE },
      { scope: 'reauth:account', value: userId, limit: 5, duration: 5 * MINUTE },
    ]);
    if (!validToken(token)) throw authenticationRequired();
    const { rows } = await this.store.database.query<UserRow>(`SELECT u.id, u.email, u.name, u.tag, u.password_hash, u.created_at, u.email_verified_at
      FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.user_id = $2 AND s.expires_at > $3`, [digest(token), userId, this.time()]);
    const expected = rows[0];
    if (!expected) throw authenticationRequired();
    const usable = typeof rawPassword === 'string' && rawPassword.length > 0 && rawPassword.length <= 128;
    const verified = await verifyPassword(usable ? rawPassword : 'Invalid-Reauthentication-1!', usable ? expected.password_hash : undefined);
    if (!verified) throw new LedgerError(401, 'INVALID_PASSWORD', '비밀번호를 확인해 주세요.');
    return this.store.database.transaction(async (client) => {
      const session = await this.lockedSession(client, token, userId);
      const current = await client.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [userId]);
      // A reset/password replacement while scrypt was running cannot bless an old credential.
      if (current.rows[0]?.password_hash !== expected.password_hash) throw authenticationRequired();
      const time = this.time();
      if (time < epoch(session.created_at) || time >= epoch(session.expires_at)) throw authenticationRequired();
      await client.query('UPDATE auth_sessions SET reauthenticated_at = $2 WHERE token_hash = $1', [digest(token), time]);
      return { reauthenticatedUntil: Math.min(epoch(time + REAUTHENTICATION_TTL), epoch(session.expires_at)) };
    });
  }

  /** Session management helper. Financial integration must first reconcile user/recipient lock ordering. */
  async requireRecentAuthentication(token: string | undefined, userId: string, transactionClient?: PoolClient): Promise<void> {
    const check = async (client: PoolClient) => {
      const session = await this.lockedSession(client, token, userId);
      if (this.reauthenticatedUntil(session) === null) throw reauthenticationRequired();
    };
    if (transactionClient) await check(transactionClient);
    else await this.store.database.transaction(check);
  }

  async revokeSession(token: string | undefined, userId: string, sessionId: string): Promise<{ revokedCurrent: boolean }> {
    if (typeof sessionId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(sessionId)) {
      throw new LedgerError(400, 'INVALID_SESSION', '로그인 정보를 확인해 주세요.');
    }
    await this.rateLimit([{ scope: 'sessions:manage', value: userId, limit: 30, duration: MINUTE }]);
    return this.store.database.transaction(async (client) => {
      const current = await this.lockedSession(client, token, userId);
      if (this.reauthenticatedUntil(current) === null) throw reauthenticationRequired();
      const result = await client.query('DELETE FROM auth_sessions WHERE session_id = $1 AND user_id = $2 AND expires_at > $3',
        [sessionId, userId, this.time()]);
      if (result.rowCount !== 1) throw new LedgerError(404, 'SESSION_NOT_FOUND', '로그인 정보를 찾지 못했어요. 목록을 새로 확인해 주세요.');
      return { revokedCurrent: current.session_id === sessionId.toLowerCase() };
    });
  }

  async revokeOtherSessions(token: string | undefined, userId: string): Promise<{ revokedCount: number }> {
    await this.rateLimit([{ scope: 'sessions:manage', value: userId, limit: 30, duration: MINUTE }]);
    return this.store.database.transaction(async (client) => {
      const current = await this.lockedSession(client, token, userId);
      if (this.reauthenticatedUntil(current) === null) throw reauthenticationRequired();
      const result = await client.query('DELETE FROM auth_sessions WHERE user_id = $1 AND session_id <> $2 AND expires_at > $3',
        [userId, current.session_id, this.time()]);
      return { revokedCount: result.rowCount ?? 0 };
    });
  }

  async enforceMemberLookup(userId: string): Promise<void> {
    await this.rateLimit([{ scope: 'lookup:member', value: userId, limit: 30, duration: MINUTE }]);
  }

  async enforceRewardPreference(userId: string): Promise<void> {
    await this.rateLimit([{ scope: 'rewards:preference', value: userId, limit: 20, duration: MINUTE }]);
  }

  async enforceIssuerCardCommand(userId: string): Promise<void> {
    await this.rateLimit([{ scope: 'issuer:card-status', value: userId, limit: 20, duration: MINUTE }]);
  }

  async emailVerificationSnapshot(token: string | undefined, userId: string): Promise<EmailVerificationSnapshot> {
    return this.store.database.transaction(async (client) => {
      await this.lockedSession(client, token, userId);
      const { rows } = await client.query<{ email: string; email_verified_at: string | null }>(
        'SELECT email, email_verified_at FROM users WHERE id = $1', [userId]);
      if (!rows[0]) throw authenticationRequired();
      return { email: rows[0].email, verifiedAt: rows[0].email_verified_at === null ? null : epoch(rows[0].email_verified_at),
        canRequest: Boolean(this.mailQueue) && rows[0].email_verified_at === null };
    });
  }

  async requestEmailVerification(token: string | undefined, userId: string, rateKey: string): Promise<void> {
    await this.rateLimit([
      { scope: 'email:request:ip', value: this.ip(rateKey), limit: 10, duration: 15 * MINUTE },
      { scope: 'email:request:account', value: userId, limit: 3, duration: 15 * MINUTE },
    ]);
    try {
      await this.store.database.transaction(async (client) => {
        await this.lockedSession(client, token, userId);
        const { rows } = await client.query<{ email: string; email_verified_at: string | null }>(
          'SELECT email, email_verified_at FROM users WHERE id=$1', [userId]);
        const user = rows[0];
        if (!user) throw authenticationRequired();
        if (user.email_verified_at !== null) return;
        if (!this.mailQueue) throw new LedgerError(503, 'EMAIL_VERIFICATION_UNAVAILABLE', '이메일 확인 안내를 보낼 수 없습니다. 잠시 후 다시 시도해 주세요.');
        const code = randomBytes(32).toString('hex');
        const time = this.time(), expiresAt = epoch(time + RECOVERY_TTL);
        await client.query('DELETE FROM auth_email_verification WHERE user_id=$1', [userId]);
        await client.query(`INSERT INTO auth_email_verification(token_hash,user_id,email,created_at,expires_at,used_at)
          VALUES($1,$2,$3,$4,$5,NULL)`, [digest(code), userId, user.email, time, expiresAt]);
        await this.mailQueue.enqueue(client, { purpose: 'email-verification', userId, email: user.email, token: code, createdAt: time, expiresAt });
      });
    } catch (error) {
      if (error instanceof LedgerError) throw error;
      throw new LedgerError(503, 'EMAIL_VERIFICATION_UNAVAILABLE', '이메일 확인 안내를 접수하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    }
  }

  async confirmEmailVerification(token: string | undefined, userId: string, code: string, rateKey: string): Promise<void> {
    await this.rateLimit([
      { scope: 'email:confirm:ip', value: this.ip(rateKey), limit: 10, duration: 15 * MINUTE },
      { scope: 'email:confirm:account', value: userId, limit: 5, duration: 15 * MINUTE },
    ]);
    if (!validToken(code)) throw invalidVerification();
    try {
      await this.store.database.transaction(async (client) => {
        await this.lockedSession(client, token, userId);
        await client.query('SELECT confirm_auth_email_verification($1::text,$2::text,$3::bigint)', [userId, code, this.time()]);
      });
    } catch (error) {
      if (error instanceof LedgerError) throw error;
      const pg = error as { message?: string; code?: string } | null;
      if (pg?.message === 'INVALID_EMAIL_VERIFICATION') throw invalidVerification();
      if (['55P03', '40P01', '40001'].includes(pg?.code ?? '')) throw new LedgerError(503, 'DATABASE_BUSY', '다른 요청을 처리하고 있습니다. 같은 코드로 다시 확인해 주세요.');
      throw error;
    }
  }

  async requestRecovery(rawEmail: string, rateKey: string): Promise<void> {
    const email = emailInput(rawEmail);
    await this.rateLimit([
      { scope: 'recovery:ip', value: this.ip(rateKey), limit: 5, duration: 15 * MINUTE },
      { scope: 'recovery:account', value: email, limit: 3, duration: 15 * MINUTE },
    ]);
    if (!this.mailQueue && !this.deliverRecovery) throw new LedgerError(503, 'RECOVERY_UNAVAILABLE', '비밀번호 복구를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.');
    const user = await this.store.getUserByEmail(email);
    if (!user) return;
    const token = randomBytes(32).toString('hex');
    const tokenHash = digest(token);
    let issued: boolean;
    try { issued = await this.store.database.transaction(async (client) => {
      const owner = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [user.id]);
      if (owner.rowCount !== 1) return false;
      const time = this.time();
      await client.query('DELETE FROM auth_recovery WHERE user_id = $1', [user.id]);
      await client.query('INSERT INTO auth_recovery (token_hash, user_id, created_at, expires_at, used_at) VALUES ($1, $2, $3, $4, NULL)',
        [tokenHash, user.id, time, epoch(time + RECOVERY_TTL)]);
      if (this.mailQueue) await this.mailQueue.enqueue(client, { purpose: 'password-recovery', userId: user.id, email: user.email,
        token, createdAt: time, expiresAt: epoch(time + RECOVERY_TTL) });
      return true;
    }); } catch (error) {
      if (!this.mailQueue) throw error;
      // An enqueue failure must not distinguish a known address from an unknown one.
      // The challenge replacement rolls back with the queue write; never log either secret.
      console.error(JSON.stringify({ event: 'auth_mail_enqueue_failed', purpose: 'password-recovery' }));
      return;
    }
    if (!issued || this.mailQueue) return;
    try { await this.deliverRecovery!(user.email, token); }
    catch {
      await this.store.database.query('DELETE FROM auth_recovery WHERE token_hash = $1', [tokenHash]);
      // Transport failures must not reveal whether the requested account exists.
    }
  }

  async resetPassword(token: string, rawPassword: string, rateKey: string): Promise<void> {
    await this.rateLimit([
      { scope: 'reset:ip', value: this.ip(rateKey), limit: 5, duration: 15 * MINUTE },
      { scope: 'reset:token', value: validToken(token) ? digest(token) : 'invalid-token', limit: 5, duration: 15 * MINUTE },
    ]);
    const password = passwordInput(rawPassword);
    if (!validToken(token)) throw invalidRecovery();
    const tokenHash = digest(token);
    const { rows } = await this.store.database.query<RecoveryRow>('SELECT user_id, expires_at, used_at FROM auth_recovery WHERE token_hash = $1', [tokenHash]);
    const existing = rows[0];
    if (!existing || existing.used_at !== null || epoch(existing.expires_at) <= this.time()) throw invalidRecovery();
    const passwordHash = await hashPassword(password);
    await this.store.database.transaction(async (client) => {
      // User-first ordering also serializes recovery replacement and login issuance.
      const owner = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [existing.user_id]);
      if (owner.rowCount !== 1) throw invalidRecovery();
      const { rows: locked } = await client.query<RecoveryRow>('SELECT user_id, expires_at, used_at FROM auth_recovery WHERE token_hash = $1 AND user_id = $2 FOR UPDATE', [tokenHash, existing.user_id]);
      const current = locked[0];
      const time = this.time();
      if (!current || current.used_at !== null || epoch(current.expires_at) <= time) throw invalidRecovery();
      const consumed = await client.query('UPDATE auth_recovery SET used_at = $1 WHERE token_hash = $2 AND used_at IS NULL AND expires_at > $1', [time, tokenHash]);
      if (consumed.rowCount !== 1) throw invalidRecovery();
      const updated = await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, current.user_id]);
      if (updated.rowCount !== 1) throw invalidRecovery();
      await client.query('DELETE FROM auth_sessions WHERE user_id = $1', [current.user_id]);
      await client.query('DELETE FROM auth_recovery WHERE user_id = $1', [current.user_id]);
      await client.query('DELETE FROM auth_email_verification WHERE user_id = $1', [current.user_id]);
    });
  }
}
