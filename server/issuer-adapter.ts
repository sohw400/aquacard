import { createHmac } from 'node:crypto';
import type { IssuerOutboxClaim, IssuerOutboxOutcome } from './issuer-outbox';

const MAX_RESPONSE_BYTES = 8_192;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const REQUEST_KEY = new RegExp(`^aqua-${UUID}$`, 'i');
const REJECTIONS = new Set(['CARD_NOT_FOUND', 'CARD_CLOSED', 'COMMAND_REJECTED']);
const uncertain = (code: 'PROVIDER_UNAVAILABLE' | 'PROVIDER_PENDING' | 'PROVIDER_TIMEOUT' | 'PROVIDER_INVALID_RESPONSE' | 'IDEMPOTENCY_WINDOW_EXPIRED'): IssuerOutboxOutcome => ({ kind: 'uncertain', code });

export class IssuerAdapterConfigurationError extends Error {}
export class IssuerLeaseExpiredError extends Error {
  constructor() { super('The issuer command lease expired before dispatch.'); }
}

export interface SandboxIssuerOptions {
  baseUrl: string;
  keyId: string;
  signingKey: string;
  now?: () => number;
  /** Tests can shorten the timeout; the sandbox adapter never allows more than five seconds. */
  timeoutMs?: number;
}

export interface IssuerAdapter {
  execute(claim: IssuerOutboxClaim): Promise<IssuerOutboxOutcome>;
}

function sandboxOnly(): void {
  if (process.env.NODE_ENV === 'production') throw new IssuerAdapterConfigurationError('The sandbox issuer adapter is disabled in production.');
}

function configuredOrigin(value: string): string {
  // No DNS names, userinfo, redirects, event-controlled URL or hidden URL normalization.
  if (typeof value !== 'string' || !/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9]\d{0,4}\/?$/.test(value)) {
    throw new IssuerAdapterConfigurationError('Set a loopback HTTP origin with an explicit port for the sandbox issuer.');
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new IssuerAdapterConfigurationError('Invalid sandbox issuer origin.'); }
  if (Number(url.port || 80) > 65535) throw new IssuerAdapterConfigurationError('Invalid sandbox issuer port.');
  return url.origin;
}

function secretBytes(value: string): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new IssuerAdapterConfigurationError('Set a canonical base64url-encoded 32-byte sandbox signing key.');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== value) throw new IssuerAdapterConfigurationError('Set a canonical base64url-encoded 32-byte sandbox signing key.');
  return bytes;
}

function objectResponse(bytes: Uint8Array): Record<string, unknown> {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.values(value).some((item) => typeof item !== 'string' && typeof item !== 'boolean')) throw new Error('Invalid flat issuer response.');
  // JSON.parse otherwise discards duplicate fields. Count wire keys outside strings.
  const keys = new Set<string>();
  let inString = false; let escaped = false; let start = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (!inString) { if (character === '"') { inString = true; start = index; } continue; }
    if (escaped) { escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (character !== '"') continue;
    inString = false;
    let next = index + 1;
    while (/\s/.test(text[next] ?? '') && next < text.length) next++;
    if (text[next] !== ':') continue;
    const key = JSON.parse(text.slice(start, index + 1)) as string;
    if (keys.has(key)) throw new Error('Duplicate issuer response field.');
    keys.add(key);
  }
  if (keys.size !== Object.keys(value).length) throw new Error('Invalid issuer response fields.');
  return value as Record<string, unknown>;
}

const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

async function boundedBody(response: Response): Promise<Uint8Array> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) throw new Error('Issuer response too large.');
  if (!response.body) throw new Error('Issuer response body is required.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Issuer response too large.');
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally { reader.releaseLock(); }
}

/** Sandbox providers deduplicate for 24 hours and reject first execution after the signed expiry. */
export function createSandboxIssuerAdapter(options: SandboxIssuerOptions): IssuerAdapter {
  sandboxOnly();
  const origin = configuredOrigin(options.baseUrl);
  if (typeof options.keyId !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(options.keyId)) throw new IssuerAdapterConfigurationError('Set a sandbox key ID of 1-32 safe characters.');
  const keyId = options.keyId;
  const key = secretBytes(options.signingKey);
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 5_000) throw new IssuerAdapterConfigurationError('Issuer request timeout must be between 10 and 5000 ms.');
  return {
    async execute(claim) {
      sandboxOnly();
      const clock = now();
      if (!Number.isSafeInteger(clock) || clock < 0 || !Number.isSafeInteger(claim.leaseUntil) || !Number.isSafeInteger(claim.expiresAt)
        || !/^sandbox-card-[A-Za-z0-9_-]{1,100}$/.test(claim.providerCardId) || !REQUEST_KEY.test(claim.requestKey)
        || !['active', 'locked'].includes(claim.targetStatus) || !['send', 'lookup'].includes(claim.phase)) {
        throw new IssuerAdapterConfigurationError('Invalid sandbox issuer dispatch input.');
      }
      if (clock >= claim.leaseUntil) throw new IssuerLeaseExpiredError();
      if (claim.phase === 'send' && clock >= claim.expiresAt) return uncertain('IDEMPOTENCY_WINDOW_EXPIRED');
      const method = claim.phase === 'send' ? 'POST' : 'GET';
      const path = claim.phase === 'send' ? `/cards/${claim.providerCardId}/status` : `/operations/${claim.requestKey}`;
      const body = claim.phase === 'send' ? JSON.stringify({ requestKey: claim.requestKey, cardRef: claim.providerCardId, targetStatus: claim.targetStatus, expiresAt: claim.expiresAt }) : '';
      const timestamp = String(Math.floor(clock / 1_000));
      const signature = createHmac('sha256', key).update(`sandbox.issuer.v1.${keyId}.${timestamp}.${method}.${path}.`, 'utf8').update(body, 'utf8').digest('hex');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref();
      let responseReceived = false;
      try {
        const response = await fetch(origin + path, {
          method, redirect: 'manual', signal: controller.signal,
          headers: {
            accept: 'application/json', 'x-aqua-key-id': keyId, 'x-aqua-timestamp': timestamp,
            'x-aqua-signature': `v1=${signature}`,
            ...(method === 'POST' ? { 'content-type': 'application/json', 'idempotency-key': claim.requestKey } : {}),
          },
          ...(method === 'POST' ? { body } : {}),
        });
        responseReceived = true;
        if (response.status >= 300 && response.status < 400) return uncertain('PROVIDER_INVALID_RESPONSE');
        if (![200, 202, 404, 422].includes(response.status)) return uncertain('PROVIDER_UNAVAILABLE');
        if (response.headers.get('content-encoding') !== null || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(response.headers.get('content-type') ?? '')) return uncertain('PROVIDER_INVALID_RESPONSE');
        const result = objectResponse(await boundedBody(response));
        if (result.requestKey !== claim.requestKey) return uncertain('PROVIDER_INVALID_RESPONSE');
        if (claim.phase === 'lookup' && response.status === 404 && exactKeys(result, ['requestKey', 'status', 'authoritative'])
          && result.status === 'not_found' && result.authoritative === true) return { kind: 'not_found' };
        if (result.cardRef !== claim.providerCardId) return uncertain('PROVIDER_INVALID_RESPONSE');
        if (response.status === 200 && result.status === 'succeeded' && exactKeys(result, ['requestKey', 'cardRef', 'status', 'cardStatus'])
          && result.cardStatus === claim.targetStatus) return { kind: 'succeeded' };
        if (response.status === (claim.phase === 'send' ? 422 : 200) && result.status === 'rejected'
          && exactKeys(result, ['requestKey', 'cardRef', 'status', 'code']) && typeof result.code === 'string' && REJECTIONS.has(result.code)) {
          return { kind: 'rejected', code: result.code as 'CARD_NOT_FOUND' | 'CARD_CLOSED' | 'COMMAND_REJECTED' };
        }
        if (response.status === 202 && result.status === 'pending' && exactKeys(result, ['requestKey', 'cardRef', 'status'])) return uncertain('PROVIDER_PENDING');
        return uncertain('PROVIDER_INVALID_RESPONSE');
      } catch {
        // A timeout, reset, or invalid reply cannot prove that the provider did not execute.
        return uncertain(controller.signal.aborted ? 'PROVIDER_TIMEOUT' : responseReceived ? 'PROVIDER_INVALID_RESPONSE' : 'PROVIDER_UNAVAILABLE');
      } finally {
        clearTimeout(timer);
        controller.abort(); // Release unread/oversized bodies without retaining a connection.
      }
    },
  };
}
