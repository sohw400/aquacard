import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { checkedSchema, type Database } from './database';

export type AuthMailPurpose = 'email-verification' | 'password-recovery';
export interface AuthMailMessage {
  purpose: AuthMailPurpose;
  userId: string;
  email: string;
  token: string;
  createdAt: number;
  expiresAt: number;
}
export interface AuthMailQueue { enqueue(client: PoolClient, message: AuthMailMessage): Promise<void> }
export interface AuthMailKeyring { activeKeyId: string; keys: ReadonlyMap<string, Buffer> }
export interface AuthMailEnvelope { keyId: string; iv: string; tag: string; ciphertext: string }
export interface AuthMailClaim extends AuthMailEnvelope {
  id: string; purpose: AuthMailPurpose; userId: string; tokenHash: string; createdAt: number; expiresAt: number;
  leaseToken: string; leaseUntil: number; version: number; attemptCount: number;
}
export type AuthMailErrorCode = 'DELIVERY_UNAVAILABLE' | 'DELIVERY_REJECTED' | 'PAYLOAD_UNAVAILABLE' | 'KEY_UNAVAILABLE';
export class AuthMailPayloadError extends Error {
  constructor(readonly reason: 'key_unavailable' | 'invalid_payload') { super('Authentication delivery payload is unavailable.'); }
}
export interface AuthMailCompletion {
  id: string; leaseToken: string; expectedVersion: number; outcome: 'sent' | 'retry' | 'failed'; errorCode: AuthMailErrorCode | null;
}
export interface AuthMailResult {
  id: string; status: 'sent' | 'retry' | 'failed'; version: number; attemptCount: number; errorCode: string | null;
}
export interface AuthMailStats {
  pending: string; inFlight: string; retry: string; sent: string; discarded: string; failed: string; due: string; oldestPendingAt: number | null;
}
const purpose = (value: unknown): value is AuthMailPurpose => value === 'email-verification' || value === 'password-recovery';
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const validKeyId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value);
const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
export function validAuthMailMessage(value: unknown): value is AuthMailMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const m = value as Partial<AuthMailMessage>;
  return Object.keys(m).length === 6 && purpose(m.purpose)
    && typeof m.userId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(m.userId)
    && typeof m.email === 'string' && m.email.length <= 254 && m.email === m.email.trim().toLowerCase()
    && /^[^\s\u0000-\u001f\u007f<>]+@[^\s\u0000-\u001f\u007f<>]+\.[^\s\u0000-\u001f\u007f<>]+$/.test(m.email)
    && typeof m.token === 'string' && /^[a-f0-9]{64}$/.test(m.token)
    && validTime(m.createdAt) && validTime(m.expiresAt) && m.expiresAt > m.createdAt && m.expiresAt <= m.createdAt + 900_000;
}
function validatedKeyring(keyring: AuthMailKeyring): AuthMailKeyring {
  if (!keyring || !validKeyId(keyring.activeKeyId) || !(keyring.keys instanceof Map)
    || keyring.keys.size < 1 || keyring.keys.size > 8 || !keyring.keys.has(keyring.activeKeyId)
    || [...keyring.keys].some(([id, key]) => !validKeyId(id) || !Buffer.isBuffer(key) || key.length !== 32)) {
    throw new Error('Auth mail encryption requires an active 32-byte key and a valid keyring.');
  }
  return { activeKeyId: keyring.activeKeyId, keys: new Map([...keyring.keys].map(([id, key]) => [id, Buffer.from(key)])) };
}
export function authMailKeyringFromEnvironment(environment: NodeJS.ProcessEnv = process.env): AuthMailKeyring | undefined {
  const json = environment.AQUA_AUTH_MAIL_KEYS;
  const activeKeyId = environment.AQUA_AUTH_MAIL_ACTIVE_KEY;
  if (!json && !activeKeyId) return undefined;
  if (!json || !activeKeyId || json.length > 4096) throw new Error('Configure both auth mail keyring and active key ID.');
  let input: unknown;
  try { input = JSON.parse(json); } catch { throw new Error('Auth mail keyring must be a JSON object of base64 keys.'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Auth mail keyring must be a JSON object of base64 keys.');
  const keys = new Map<string, Buffer>();
  for (const [id, encoded] of Object.entries(input)) {
    if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error('Auth mail keys must be canonical base64-encoded 32-byte values.');
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error('Auth mail keys must be canonical base64-encoded 32-byte values.');
    keys.set(id, key);
  }
  return validatedKeyring({ activeKeyId, keys });
}
function associatedData(schema: string, id: string, mailPurpose: AuthMailPurpose): Buffer {
  return Buffer.from(JSON.stringify(['aqua-auth-mail', 1, schema, id, mailPurpose]), 'utf8');
}

export class PostgresAuthMailQueue implements AuthMailQueue {
  private readonly keyring: AuthMailKeyring;
  private readonly schema: string;
  constructor(schema: string, keyring: AuthMailKeyring) {
    this.schema = checkedSchema(schema);
    this.keyring = validatedKeyring(keyring);
  }
  async enqueue(client: PoolClient, message: AuthMailMessage): Promise<void> {
    if (!validAuthMailMessage(message)) throw new Error('Invalid authentication delivery request.');
    const id = randomUUID();
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keyring.keys.get(this.keyring.activeKeyId)!, nonce);
    cipher.setAAD(associatedData(this.schema, id, message.purpose));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(message), 'utf8'), cipher.final()]);
    const input = { id, purpose: message.purpose, userId: message.userId, tokenHash: hash(message.token),
      createdAt: message.createdAt, expiresAt: message.expiresAt, keyId: this.keyring.activeKeyId,
      iv: nonce.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('hex') };
    await client.query('SELECT enqueue_auth_mail($1::jsonb)', [JSON.stringify(input)]);
  }
}
export function authMailQueueFromEnvironment(schema: string, environment: NodeJS.ProcessEnv = process.env): PostgresAuthMailQueue | undefined {
  const keyring = authMailKeyringFromEnvironment(environment);
  return keyring ? new PostgresAuthMailQueue(schema, keyring) : undefined;
}
export function decryptAuthMail(schema: string, claim: AuthMailClaim, keyring: AuthMailKeyring): AuthMailMessage {
  checkedSchema(schema);
  const keys = validatedKeyring(keyring);
  if (!claim || !validId(claim.id) || !purpose(claim.purpose) || !validKeyId(claim.keyId)
    || !/^[a-f0-9]{24}$/.test(claim.iv) || !/^[a-f0-9]{32}$/.test(claim.tag)
    || !/^[a-f0-9]{2,8192}$/.test(claim.ciphertext) || claim.ciphertext.length % 2 !== 0) throw new AuthMailPayloadError('invalid_payload');
  const key = keys.keys.get(claim.keyId);
  if (!key) throw new AuthMailPayloadError('key_unavailable');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(claim.iv, 'hex'));
    decipher.setAAD(associatedData(schema, claim.id, claim.purpose));
    decipher.setAuthTag(Buffer.from(claim.tag, 'hex'));
    const text = Buffer.concat([decipher.update(Buffer.from(claim.ciphertext, 'hex')), decipher.final()]).toString('utf8');
    const message: unknown = JSON.parse(text);
    if (!validAuthMailMessage(message) || message.purpose !== claim.purpose || message.userId !== claim.userId
      || message.createdAt !== claim.createdAt || message.expiresAt !== claim.expiresAt || hash(message.token) !== claim.tokenHash) throw new Error();
    return message;
  } catch { throw new AuthMailPayloadError('invalid_payload'); }
}
export class AuthMailOutbox {
  constructor(readonly database: Database, private readonly now: () => number = Date.now) {}
  private time() { const time = this.now(); if (!validTime(time)) throw new Error('Invalid auth mail clock.'); return time; }
  async claim(): Promise<AuthMailClaim | null> {
    return this.database.transaction(async (client) => (await client.query<{ result: AuthMailClaim | null }>('SELECT claim_auth_mail($1::bigint) AS result', [this.time()])).rows[0].result);
  }
  async finish(input: AuthMailCompletion): Promise<AuthMailResult> {
    return this.database.transaction(async (client) => (await client.query<{ result: AuthMailResult }>('SELECT finish_auth_mail($1::jsonb,$2::bigint) AS result', [JSON.stringify(input), this.time()])).rows[0].result);
  }
  async stats(): Promise<AuthMailStats> {
    return (await this.database.query<{ result: AuthMailStats }>('SELECT auth_mail_stats($1::bigint) AS result', [this.time()])).rows[0].result;
  }
}
