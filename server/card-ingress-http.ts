import { createHmac, timingSafeEqual } from 'node:crypto';
import Fastify, { LogController, type FastifyInstance, type FastifyLoggerOptions, type FastifyRequest } from 'fastify';
import type { SandboxCardEvent } from '../shared/api';
import { parseSandboxCardEvent } from './card-command';
import type { CardInboxStore } from './card-inbox';
import { LedgerError } from './errors';
import { createReadinessProbe, livenessSchema } from './readiness';

const PATH = '/webhooks/sandbox/cards';
const MAX_BODY = 16_384;
const MAX_CLOCK = 8.64e15 - 9 * 60 * 60 * 1_000;
const MAX_SKEW_MS = 300_000;
const MISSING_KEY = Buffer.alloc(32);

export class CardIngressConfigurationError extends Error {}

export interface CardIngressOptions {
  /** Explicitly configured sandbox keys. These are not any issuer's signing keys. */
  keys: Record<string, string>;
  now?: () => number;
  logger?: boolean | FastifyLoggerOptions;
}

function signingKeys(input: unknown): Map<string, Buffer> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CardIngressConfigurationError('Set one or two sandbox webhook signing keys.');
  const entries = Object.entries(input);
  if (entries.length < 1 || entries.length > 2) throw new CardIngressConfigurationError('Set one or two sandbox webhook signing keys.');
  const keys = new Map<string, Buffer>();
  for (const [id, secret] of entries) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id) || typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
      throw new CardIngressConfigurationError('Webhook key IDs must be 1-32 safe characters and secrets must be canonical base64url-encoded 32-byte values.');
    }
    const bytes = Buffer.from(secret, 'base64url');
    if (bytes.length !== 32 || bytes.toString('base64url') !== secret) throw new CardIngressConfigurationError('Webhook secrets must be canonical base64url-encoded 32-byte values.');
    keys.set(id, bytes);
  }
  return keys;
}

function unauthenticated(): never {
  throw new LedgerError(401, 'UNAUTHENTICATED_WEBHOOK', '웹훅 서명을 확인할 수 없습니다.');
}

/** Node can join repeated headers; inspect the wire names as well as its normalized view. */
function oneHeader(request: FastifyRequest, name: string): string {
  let count = 0;
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    if (request.raw.rawHeaders[index].toLowerCase() === name) count++;
  }
  const value = request.headers[name];
  if (count !== 1 || typeof value !== 'string') return unauthenticated();
  return value;
}

function authenticate(request: FastifyRequest, body: Buffer, keys: Map<string, Buffer>, now: number): void {
  const keyId = oneHeader(request, 'x-aqua-key-id');
  const timestamp = oneHeader(request, 'x-aqua-timestamp');
  const signature = oneHeader(request, 'x-aqua-signature');
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(keyId) || !/^(?:0|[1-9]\d{0,12})$/.test(timestamp) || !/^v1=[0-9a-f]{64}$/.test(signature)) unauthenticated();
  const sentAt = Number(timestamp) * 1_000;
  if (!Number.isSafeInteger(sentAt) || Math.abs(now - sentAt) > MAX_SKEW_MS) unauthenticated();
  const key = keys.get(keyId);
  const expected = createHmac('sha256', key ?? MISSING_KEY)
    .update(`sandbox.cards.v1.${keyId}.${timestamp}.`, 'utf8').update(body).digest();
  const matches = timingSafeEqual(expected, Buffer.from(signature.slice(3), 'hex'));
  if (!key || !matches) unauthenticated();
}

const errorSchema = {
  type: 'object', additionalProperties: false, required: ['error'], properties: {
    error: { type: 'object', additionalProperties: false, required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' } } },
  },
};
const errorResponses = Object.fromEntries([400, 401, 404, 409, 413, 415, 503].map((status) => [status, errorSchema]));

/** Aqua's own test transport only. A 202 receipt is never a card approval. */
export function createCardIngress(store: CardInboxStore, options: CardIngressOptions): FastifyInstance {
  if (process.env.NODE_ENV === 'production') throw new CardIngressConfigurationError('Sandbox card ingress is disabled in production.');
  const keys = signingKeys(options.keys);
  const readyForTraffic = createReadinessProbe(store.database, 'ingress');
  const clock = options.now ?? Date.now;
  const logger = options.logger === false ? false : {
    level: 'info', ...(typeof options.logger === 'object' ? options.logger : {}),
    redact: { paths: ['req.headers', 'res.headers', 'req.body', 'body', 'err', 'error', 'secret', 'keys', 'signature', 'authorization'], remove: true },
    serializers: {
      req: (value: unknown) => ({ method: (value as { method?: string }).method }),
      res: (value: unknown) => ({ statusCode: (value as { statusCode?: number }).statusCode }),
    },
  };
  const app = Fastify({
    logger, logController: new LogController({ disableRequestLogging: true }), requestIdHeader: false,
    trustProxy: false, bodyLimit: MAX_BODY, requestTimeout: 15_000, connectionTimeout: 10_000,
    keepAliveTimeout: 5_000, exposeHeadRoutes: false,
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    if (request.routeOptions.url !== PATH && request.routeOptions.url !== '/health' && request.routeOptions.url !== '/live') {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '요청한 경로를 찾을 수 없습니다.' } });
    }
    if (request.routeOptions.url !== PATH) return;
    const contentType = request.headers['content-type'];
    if (typeof contentType !== 'string' || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(contentType.trim())
      || request.headers['content-encoding'] !== undefined) {
      throw new LedgerError(415, 'CONTENT_TYPE', '인코딩하지 않은 UTF-8 JSON 요청이 필요합니다.');
    }
  });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: MAX_BODY }, (request, body, done) => {
    try {
      const now = clock();
      if (!Number.isSafeInteger(now) || now < 0 || now > MAX_CLOCK) throw new LedgerError(503, 'INGRESS_UNAVAILABLE', '수신 서버 시간을 확인할 수 없습니다.');
      if (!Buffer.isBuffer(body)) throw new LedgerError(400, 'INVALID_CARD_EVENT', '카드 테스트 이벤트 형식을 확인해 주세요.');
      authenticate(request, body, keys, now);
      // Authentication covers the original bytes, before decoding or normalization.
      let decoded: unknown;
      try { decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body)) as unknown; }
      catch { throw new LedgerError(400, 'INVALID_CARD_EVENT', '카드 테스트 이벤트 형식을 확인해 주세요.'); }
      done(null, parseSandboxCardEvent(decoded));
    } catch (error) { done(error instanceof Error ? error : new Error('Invalid webhook request.')); }
  });

  app.addHook('onResponse', async (request, reply) => {
    request.log.info({ requestId: request.id, method: request.method, path: request.routeOptions.url ?? '/*', statusCode: reply.statusCode }, 'card ingress request completed');
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof LedgerError && [400, 401, 409, 413, 415].includes(error.status)) {
      return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    }
    const detail = error as { code?: string; statusCode?: number };
    if (detail.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || detail.statusCode === 413) return reply.code(413).send({ error: { code: 'BODY_TOO_LARGE', message: '요청이 너무 큽니다.' } });
    if (detail.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return reply.code(415).send({ error: { code: 'CONTENT_TYPE', message: 'UTF-8 JSON 요청이 필요합니다.' } });
    // Never include error.message, SQL, headers, body or signing material in logs.
    request.log.error({ event: 'card_ingress_unavailable' }, 'card ingress could not confirm receipt');
    reply.header('Retry-After', '5');
    return reply.code(503).send({ error: { code: 'INGRESS_UNAVAILABLE', message: '수신 결과를 확인하지 못했습니다. 같은 이벤트 번호와 내용으로 다시 보내 주세요.' } });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: '요청한 경로를 찾을 수 없습니다.' } }));

  app.get('/live', { schema: { response: { 200: livenessSchema } } }, async () => ({ status: 'ok' }));
  app.get('/health', { schema: { response: { 200: {
    type: 'object', additionalProperties: false, required: ['status', 'mode'], properties: { status: { type: 'string', enum: ['ok'] }, mode: { type: 'string', enum: ['sandbox'] } },
  }, 503: errorSchema } } }, async (_request, reply) => {
    if (!(await readyForTraffic())) return reply.code(503).header('Retry-After', '5')
      .send({ error: { code: 'INGRESS_UNAVAILABLE', message: '수신 서버를 준비하고 있습니다.' } });
    return { status: 'ok', mode: 'sandbox' };
  });
  app.post<{ Body: SandboxCardEvent }>(PATH, { schema: { response: { 202: {
    type: 'object', additionalProperties: false, required: ['id', 'eventId', 'status', 'receivedAt', 'duplicate'], properties: {
      id: { type: 'string' }, eventId: { type: 'string' }, status: { type: 'string', enum: ['pending', 'retry', 'applied', 'dead_letter'] },
      receivedAt: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, duplicate: { type: 'boolean' },
    },
  }, ...errorResponses } } }, async (request, reply) => reply.code(202).send(await store.enqueue(request.body)));
  return app;
}
