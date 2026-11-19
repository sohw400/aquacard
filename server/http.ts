import Fastify, { LogController, type FastifyInstance, type FastifyLoggerOptions, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import { extname, resolve } from 'node:path';
import type { IssuerCardStatus, MemberProfile } from '../shared/api';
import { AuthService } from './auth';
import { LedgerError, LedgerStore } from './ledger';
import { RewardsStore } from './rewards';
import { IssuerOutboxStore } from './issuer-outbox';

declare module 'fastify' {
  interface FastifyRequest { aquaUser: MemberProfile | null }
}

export interface ServerOptions {
  allowedOrigins: string[];
  secureCookies?: boolean;
  deliverRecovery?: (email: string, token: string) => Promise<void>;
  staticDir?: string;
  exposeOpenApi?: boolean;
  logger?: boolean | FastifyLoggerOptions;
  trustedProxies?: string[];
}

const COOKIE = 'aqua_session';
const MAX_BODY = 16_384;
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const errorSchema = {
  $id: 'AquaError', type: 'object', additionalProperties: false, required: ['error'],
  properties: { error: { type: 'object', additionalProperties: false, required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' } } } },
};
const profileSchema = {
  $id: 'AquaMember', type: 'object', additionalProperties: false, required: ['id', 'email', 'name', 'tag', 'createdAt'],
  properties: { id: { type: 'string' }, email: { type: 'string' }, name: { type: 'string' }, tag: { type: 'string' }, createdAt: { type: 'integer', minimum: 0 } },
};
const recordSchema = {
  $id: 'AquaTransfer', type: 'object', additionalProperties: false, required: ['id', 'direction', 'amountWon', 'counterpartyName', 'counterpartyTag', 'createdAt'],
  properties: { id: { type: 'string' }, direction: { type: 'string', enum: ['sent', 'received', 'funded'] }, amountWon: { type: 'integer', minimum: 1 }, counterpartyName: { type: 'string' }, counterpartyTag: { type: 'string' }, createdAt: { type: 'integer', minimum: 0 } },
};
const amount = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const customerAccessSchema = {
  $id: 'AquaCustomerAccess', type: 'object', additionalProperties: false,
  required: ['status', 'version', 'updatedAt', 'canTransact'],
  properties: {
    status: { type: 'string', enum: ['unverified', 'pending_review', 'active', 'restricted', 'frozen', 'closed'] },
    version: amount, updatedAt: amount, canTransact: { type: 'boolean' },
  },
};
const sessionSecuritySchema = {
  type: 'object', additionalProperties: false, required: ['sessions', 'reauthenticatedUntil'],
  properties: {
    reauthenticatedUntil: { anyOf: [amount, { type: 'null' }] },
    sessions: { type: 'array', maxItems: 20, items: {
      type: 'object', additionalProperties: false,
      required: ['id', 'deviceLabel', 'createdAt', 'lastSeenAt', 'expiresAt', 'current'],
      properties: {
        id: { type: 'string', format: 'uuid' }, deviceLabel: { type: 'string', maxLength: 80 },
        createdAt: amount, lastSeenAt: amount, expiresAt: amount, current: { type: 'boolean' },
      },
    } },
  },
};
const amountProperties = (names: string[]) => Object.fromEntries(names.map((key) => [key, amount]));
const fundingFields = ['authorizedWon', 'heldWon', 'capturedWon', 'releasedWon', 'refundedWon'];
const fundingSchema = { type: 'object', additionalProperties: false, required: fundingFields, properties: amountProperties(fundingFields) };
const cashbackSchema = {
  type: 'object', additionalProperties: false,
  required: ['policyVersion', 'month', 'rateBps', 'pendingWon', 'awardedWon', 'reversedWon', 'offsetWon', 'closedAt'],
  properties: { policyVersion: { type: 'string' }, month: { type: 'string' },
    ...amountProperties(['rateBps', 'pendingWon', 'awardedWon', 'reversedWon', 'offsetWon']),
    closedAt: { anyOf: [amount, { type: 'null' }] } },
};
const rewardsSchema = {
  $id: 'AquaRewards', type: 'object', additionalProperties: false,
  required: ['availableWon', 'heldWon', 'adjustmentDueWon', 'useFirst', 'preferenceVersion', 'programActive', 'policy', 'cashback', 'history'],
  properties: {
    ...amountProperties(['availableWon', 'heldWon', 'adjustmentDueWon', 'preferenceVersion']),
    useFirst: { type: 'boolean' }, programActive: { type: 'boolean' },
    policy: { type: 'object', additionalProperties: false, required: ['version', 'rateBps', 'monthlyCapWon'], properties: { version: { type: 'string' }, ...amountProperties(['rateBps', 'monthlyCapWon']) } },
    cashback: { type: 'object', additionalProperties: false, required: ['month', 'confirmedWon', 'pendingWon', 'reversedWon', 'remainingWon'], properties: { month: { type: 'string' }, ...amountProperties(['confirmedWon', 'pendingWon', 'reversedWon', 'remainingWon']) } },
    history: { type: 'array', maxItems: 50, items: { type: 'object', additionalProperties: false,
      required: ['id', 'kind', 'amountWon', 'paymentId', 'createdAt', 'availableDeltaWon', 'heldDeltaWon', 'adjustmentDeltaWon'], properties: {
        id: { type: 'string' }, kind: { type: 'string', enum: ['grant', 'cashback', 'card_authorize', 'card_capture', 'card_release', 'card_refund', 'cashback_reversal', 'adjustment_offset'] },
        paymentId: { anyOf: [{ type: 'string' }, { type: 'null' }] }, ...amountProperties(['amountWon', 'createdAt']),
        ...Object.fromEntries(['availableDeltaWon', 'heldDeltaWon', 'adjustmentDeltaWon'].map((key) => [key, { type: 'integer', minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }])),
      } } },
  },
};
const cardPaymentSchema = {
  $id: 'AquaCardPayment', type: 'object', additionalProperties: false,
  required: ['id', 'merchantName', 'status', 'authorizedWon', 'heldWon', 'capturedWon', 'releasedWon', 'refundedWon', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string' }, merchantName: { type: 'string' },
    status: { type: 'string', enum: ['authorized', 'partially_captured', 'captured', 'cancelled', 'partially_refunded', 'refunded'] },
    ...Object.fromEntries(['authorizedWon', 'heldWon', 'capturedWon', 'releasedWon', 'refundedWon', 'createdAt', 'updatedAt'].map((key) => [key, { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }])),
    funding: { type: 'object', additionalProperties: false, required: ['principal', 'rewards'], properties: { principal: fundingSchema, rewards: fundingSchema } },
    cashback: cashbackSchema,
  },
};
const issuerStatusSchema = { type: 'string', enum: ['active', 'locked'] };
const issuerCommandStatusSchema = { type: 'string', enum: ['pending', 'in_flight', 'retry', 'succeeded', 'failed', 'needs_review'] };
const uuidSchema = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' };
const issuerVersionSchema = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const issuerCardSchema = {
  $id: 'AquaIssuerCard', type: 'object', additionalProperties: false, required: ['mode', 'canRequestStatus', 'card'],
  properties: {
    mode: { type: 'string', enum: ['sandbox'] },
    canRequestStatus: { type: 'boolean' },
    card: { anyOf: [{ type: 'null' }, {
      type: 'object', additionalProperties: false, required: ['id', 'desiredStatus', 'confirmedStatus', 'version', 'updatedAt', 'command'],
      properties: {
        id: uuidSchema, desiredStatus: issuerStatusSchema, confirmedStatus: issuerStatusSchema, version: issuerVersionSchema, updatedAt: amount,
        command: { anyOf: [{ type: 'null' }, {
          type: 'object', additionalProperties: false, required: ['id', 'status', 'phase', 'attemptCount', 'errorCode', 'createdAt', 'updatedAt'],
          properties: {
            id: uuidSchema, status: issuerCommandStatusSchema, phase: { type: 'string', enum: ['send', 'lookup'] },
            ...amountProperties(['attemptCount', 'createdAt', 'updatedAt']),
            errorCode: { anyOf: [{ type: 'string', maxLength: 64 }, { type: 'null' }] },
          },
        }] },
      },
    }] },
  },
};
const issuerReceiptSchema = {
  type: 'object', additionalProperties: false, required: ['id', 'cardId', 'status', 'cardVersion', 'duplicate'],
  properties: { id: uuidSchema, cardId: uuidSchema, status: { type: 'string', enum: ['pending'] }, cardVersion: issuerVersionSchema, duplicate: { type: 'boolean' } },
};
const okaySchema = { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean', enum: [true] } } };
const userSchema = { type: 'object', additionalProperties: false, required: ['user'], properties: { user: { $ref: 'AquaMember#' } } };
const errorResponses = Object.fromEntries([400, 401, 403, 404, 405, 409, 413, 415, 429, 500, 503].map((status) => [status, { $ref: 'AquaError#' }]));
const objectBody = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, required, properties });
const text = { type: 'string' };
const secured = [{ aquaSession: [] }];
const apiPath = (request: FastifyRequest) => {
  const path = new URL(request.raw.url ?? request.url, 'http://aqua.invalid').pathname;
  return path === '/api' || path.startsWith('/api/');
};

function tokenOf(request: FastifyRequest): string | undefined {
  const token = request.cookies[COOKIE];
  return typeof token === 'string' && /^[a-zA-Z0-9_-]{32,128}$/.test(token) ? token : undefined;
}

/** Plugins and routes are registered synchronously; callers await ready/listen and close their own database. */
export function createApiServer(store: LedgerStore, options: ServerOptions): FastifyInstance {
  const auth = new AuthService(store, { deliverRecovery: options.deliverRecovery });
  const rewards = new RewardsStore(store.database);
  const issuer = new IssuerOutboxStore(store.database);
  const sandboxIssuerWritesEnabled = process.env.NODE_ENV !== 'production';
  const allowedOrigins = new Set(options.allowedOrigins);
  const logger = options.logger === false ? false : {
    level: 'info',
    ...(typeof options.logger === 'object' ? options.logger : {}),
    redact: { paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]', 'req.body', 'body', 'password', 'token', 'cookie', 'authorization'], remove: true },
    serializers: {
      req: (value: unknown) => ({ method: (value as { method?: string }).method }),
      res: (value: unknown) => ({ statusCode: (value as { statusCode?: number }).statusCode }),
    },
  };
  const app = Fastify({
    logger, logController: new LogController({ disableRequestLogging: true }), trustProxy: options.trustedProxies ?? false,
    bodyLimit: MAX_BODY, requestTimeout: 15_000, connectionTimeout: 10_000,
    keepAliveTimeout: 5_000, exposeHeadRoutes: false,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: true, useDefaults: false } },
  });
  app.decorateRequest('aquaUser', null);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer').header('X-Frame-Options', 'DENY');
    if (options.secureCookies) reply.header('Strict-Transport-Security', 'max-age=31536000');
    if (!apiPath(request)) return;
    if (request.headers['sec-fetch-site'] === 'cross-site') throw new LedgerError(403, 'ORIGIN_REJECTED', '이 요청은 허용되지 않아요.');
    if (!['GET', 'POST'].includes(request.method)) throw new LedgerError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
    if (request.method === 'POST') {
      if (typeof request.headers.origin !== 'string' || !allowedOrigins.has(request.headers.origin)) throw new LedgerError(403, 'ORIGIN_REJECTED', '이 요청은 허용되지 않아요.');
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new LedgerError(415, 'CONTENT_TYPE', 'JSON 형식으로 요청해 주세요.');
    }
  });
  app.addHook('preValidation', async (request) => {
    if (apiPath(request) && request.method === 'POST' && (request.body === null || typeof request.body !== 'object' || Array.isArray(request.body))) {
      throw new LedgerError(400, 'INVALID_JSON', '요청 내용을 확인해 주세요.');
    }
  });
  app.addHook('onResponse', async (request, reply) => {
    // The registered route template never contains a query, email, cookie or request body.
    request.log.info({ requestId: request.id, method: request.method, path: request.routeOptions.url ?? (apiPath(request) ? '/api/*' : '/*'), statusCode: reply.statusCode, durationMs: Math.round(reply.elapsedTime * 100) / 100 }, 'request completed');
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof LedgerError) {
      if (error.status === 429) reply.header('Retry-After', '60');
      return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    }
    const detail = error as { code?: string; validation?: unknown; statusCode?: number };
    if (detail.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send({ error: { code: 'BODY_TOO_LARGE', message: '요청이 너무 커요.' } });
    if (detail.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return reply.code(415).send({ error: { code: 'CONTENT_TYPE', message: 'JSON 형식으로 요청해 주세요.' } });
    if (['FST_ERR_CTP_INVALID_JSON_BODY', 'FST_ERR_CTP_EMPTY_JSON_BODY'].includes(detail.code ?? '')) return reply.code(400).send({ error: { code: 'INVALID_JSON', message: '요청 내용을 확인해 주세요.' } });
    if (detail.validation || detail.code === 'FST_ERR_VALIDATION') return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '입력한 내용을 확인해 주세요.' } });
    if (detail.code === 'FST_ERR_BAD_URL') return reply.code(400).send({ error: { code: 'INVALID_PATH', message: '주소를 확인해 주세요.' } });
    if (Number.isInteger(detail.statusCode) && detail.statusCode! >= 400 && detail.statusCode! < 500) {
      const status = detail.statusCode!;
      return reply.code(status).send({ error: {
        code: status === 404 ? 'NOT_FOUND' : status === 403 ? 'FORBIDDEN' : status === 408 ? 'REQUEST_TIMEOUT' : 'INVALID_REQUEST',
        message: status === 404 ? '요청한 페이지를 찾지 못했어요.' : '요청을 처리할 수 없어요. 입력한 내용을 확인해 주세요.',
      } });
    }
    // Do not pass errors/SQL/headers to Pino: they may contain credential or database details.
    request.log.error({ event: 'request_failed', errorType: error instanceof Error ? error.name : 'UnknownError' }, 'request failed');
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: '처리 결과를 확인하지 못했어요. 같은 요청으로 다시 확인해 주세요.' } });
  });

  app.register(async function apiPlugin(api) {
    await api.register(cookie);
    await api.register(swagger, {
      openapi: {
        openapi: '3.0.3',
        info: { title: 'Aqua sandbox API', version: '0.6.0', description: '계정, 거래 자격, 세션 보안, 원장, 송금, 카드 결제, 결제 전용 리워드와 테스트 발급사 상태 동기화 API. 실제 고객확인, 자금 이동이나 카드 발급은 제공하지 않습니다.' },
        components: { securitySchemes: { aquaSession: { type: 'apiKey', in: 'cookie', name: COOKIE } } },
      },
    });
    api.addSchema(errorSchema); api.addSchema(profileSchema); api.addSchema(recordSchema); api.addSchema(cardPaymentSchema); api.addSchema(rewardsSchema); api.addSchema(issuerCardSchema); api.addSchema(customerAccessSchema);

    const sessionCookie = (reply: FastifyReply, token: string, clear = false) => {
      reply.setCookie(COOKIE, token, { path: '/api', httpOnly: true, sameSite: 'strict', secure: options.secureCookies ?? false, maxAge: clear ? 0 : SESSION_SECONDS });
    };
    const signedIn = async (request: FastifyRequest) => {
      const user = await auth.authenticate(tokenOf(request));
      if (!user) throw new LedgerError(401, 'UNAUTHENTICATED', '다시 로그인해 주세요.');
      request.aquaUser = user;
    };
    const accountMatches = (request: FastifyRequest, user: MemberProfile) => {
      if (request.headers['x-aqua-account'] !== user.id) throw new LedgerError(409, 'SESSION_CHANGED', '로그인한 계정이 바뀌었어요. 계정을 다시 확인해 주세요.');
    };

    api.get('/api/health', { schema: {
      tags: ['operations'], summary: '데이터베이스 준비 상태',
      response: { 200: { type: 'object', additionalProperties: false, required: ['status', 'mode'], properties: { status: { type: 'string', enum: ['ok'] }, mode: { type: 'string', enum: ['sandbox'] } } }, 503: { $ref: 'AquaError#' } },
    } }, async (_request, reply) => {
      try { await store.database.query('SELECT 1'); return { status: 'ok', mode: 'sandbox' }; }
      catch { return reply.code(503).send({ error: { code: 'DATABASE_UNAVAILABLE', message: '데이터베이스 연결을 준비하고 있어요. 잠시 후 다시 확인해 주세요.' } }); }
    });
    api.get('/api/session', { schema: { tags: ['authentication'], summary: '현재 세션 확인', response: { 200: { type: 'object', additionalProperties: false, required: ['user'], properties: { user: { anyOf: [{ $ref: 'AquaMember#' }, { type: 'null' }] } } }, ...errorResponses } } }, async (request) => ({ user: await auth.authenticate(tokenOf(request)) }));

    api.post<{ Body: { email: string; name: string; tag: string; password: string } }>('/api/auth/signup', { schema: {
      tags: ['authentication'], summary: '테스트 계정 생성', body: objectBody({ email: { type: 'string', maxLength: 254 }, name: { type: 'string', maxLength: 160 }, tag: { type: 'string', maxLength: 64 }, password: { type: 'string', minLength: 12, maxLength: 128, writeOnly: true } }), response: { 201: userSchema, ...errorResponses },
    } }, async (request, reply) => {
      const result = await auth.signup(request.body, request.ip, { userAgent: request.headers['user-agent'] });
      sessionCookie(reply, result.token); return reply.code(201).send({ user: result.user });
    });
    api.post<{ Body: { email: string; password: string } }>('/api/auth/login', { schema: {
      tags: ['authentication'], summary: '로그인', body: objectBody({ email: text, password: { type: 'string', maxLength: 128, writeOnly: true } }), response: { 200: userSchema, ...errorResponses },
    } }, async (request, reply) => {
      const result = await auth.login(request.body, request.ip, { userAgent: request.headers['user-agent'] });
      await auth.logout(tokenOf(request)); sessionCookie(reply, result.token); return { user: result.user };
    });
    api.post('/api/auth/logout', { schema: { tags: ['authentication'], summary: '로그아웃', body: objectBody({}), response: { 200: okaySchema, ...errorResponses } } }, async (request, reply) => {
      const user = await auth.authenticate(tokenOf(request));
      if (user) accountMatches(request, user);
      await auth.logout(tokenOf(request)); sessionCookie(reply, '', true); return { ok: true };
    });
    const securityAccount = async (request: FastifyRequest) => {
      await signedIn(request);
      accountMatches(request, request.aquaUser!);
    };
    const securityHeaders = { type: 'object', required: ['x-aqua-account'], properties: { 'x-aqua-account': { type: 'string', minLength: 1, maxLength: 128 } } };
    api.get('/api/auth/sessions', { preValidation: securityAccount, schema: {
      tags: ['authentication'], summary: '내 로그인 기기와 최근 인증 상태', security: secured, headers: securityHeaders,
      response: { 200: sessionSecuritySchema, ...errorResponses },
    } }, async (request) => auth.listSessions(tokenOf(request), request.aquaUser!.id));
    api.post<{ Body: { password: string } }>('/api/auth/reauthenticate', { preValidation: securityAccount, schema: {
      tags: ['authentication'], summary: '현재 세션의 비밀번호 재확인', security: secured, headers: securityHeaders,
      body: objectBody({ password: { type: 'string', minLength: 1, maxLength: 128, writeOnly: true } }),
      response: { 200: objectBody({ reauthenticatedUntil: amount }), ...errorResponses },
    } }, async (request) => auth.reauthenticate(tokenOf(request), request.aquaUser!.id, request.body.password, request.ip));
    api.post<{ Body: { sessionId: string } }>('/api/auth/sessions/revoke', { preValidation: securityAccount, schema: {
      tags: ['authentication'], summary: '선택한 로그인 기기 해제', security: secured, headers: securityHeaders,
      body: objectBody({ sessionId: { type: 'string', format: 'uuid' } }),
      response: { 200: objectBody({ revokedCurrent: { type: 'boolean' } }), ...errorResponses },
    } }, async (request, reply) => {
      const result = await auth.revokeSession(tokenOf(request), request.aquaUser!.id, request.body.sessionId);
      if (result.revokedCurrent) sessionCookie(reply, '', true);
      return result;
    });
    api.post('/api/auth/sessions/revoke-others', { preValidation: securityAccount, schema: {
      tags: ['authentication'], summary: '현재 기기를 제외한 로그인 해제', security: secured, headers: securityHeaders,
      body: objectBody({}), response: { 200: objectBody({ revokedCount: amount }), ...errorResponses },
    } }, async (request) => auth.revokeOtherSessions(tokenOf(request), request.aquaUser!.id));
    api.post<{ Body: { email: string } }>('/api/auth/recovery/request', { schema: { tags: ['authentication'], summary: '복구 안내 요청', body: objectBody({ email: text }), response: { 202: okaySchema, ...errorResponses } } }, async (request, reply) => {
      if (!options.deliverRecovery) throw new LedgerError(503, 'RECOVERY_UNAVAILABLE', '계정 복구를 준비하고 있어요. 잠시 뒤 다시 시도해 주세요.');
      await auth.requestRecovery(request.body.email, request.ip); return reply.code(202).send({ ok: true });
    });
    api.post<{ Body: { token: string; password: string } }>('/api/auth/recovery/confirm', { schema: { tags: ['authentication'], summary: '비밀번호 재설정', body: objectBody({ token: { type: 'string', writeOnly: true }, password: { type: 'string', minLength: 12, maxLength: 128, writeOnly: true } }), response: { 200: okaySchema, ...errorResponses } } }, async (request, reply) => {
      if (!options.deliverRecovery) throw new LedgerError(503, 'RECOVERY_UNAVAILABLE', '계정 복구를 준비하고 있어요. 잠시 뒤 다시 시도해 주세요.');
      await auth.resetPassword(request.body.token, request.body.password, request.ip); sessionCookie(reply, '', true); return { ok: true };
    });
    api.get('/api/account', { preValidation: signedIn, schema: { tags: ['ledger'], summary: '내 잔액과 거래 내역', security: secured,
      response: { 200: { type: 'object', additionalProperties: false, required: ['user', 'access', 'balanceWon', 'heldBalanceWon', 'totalBalanceWon', 'rewards', 'cardPayments', 'transactions', 'limits'], properties: { user: { $ref: 'AquaMember#' }, access: { $ref: 'AquaCustomerAccess#' }, balanceWon: { type: 'integer', minimum: 0 }, heldBalanceWon: { type: 'integer', minimum: 0 }, totalBalanceWon: { type: 'integer', minimum: 0 }, rewards: { $ref: 'AquaRewards#' }, cardPayments: { type: 'array', items: { $ref: 'AquaCardPayment#' } }, transactions: { type: 'array', items: { $ref: 'AquaTransfer#' } }, limits: { type: 'object', additionalProperties: false, required: ['perTransfer', 'daily', 'monthly', 'sentToday', 'sentMonth', 'available'], properties: Object.fromEntries(['perTransfer', 'daily', 'monthly', 'sentToday', 'sentMonth', 'available'].map((key) => [key, { type: 'integer', minimum: 0 }])) } } }, ...errorResponses },
    } }, async (request) => store.snapshot(request.aquaUser!.id));
    api.post<{ Body: { useFirst: boolean; expectedVersion: number } }>('/api/rewards/preference', {
      preValidation: async (request) => { await signedIn(request); accountMatches(request, request.aquaUser!); await auth.enforceRewardPreference(request.aquaUser!.id); },
      schema: {
        tags: ['rewards'], summary: '다음 카드 승인부터 적용할 리워드 우선 사용 설정', security: secured,
        headers: { type: 'object', required: ['idempotency-key', 'x-aqua-account'], properties: { 'idempotency-key': { type: 'string', minLength: 8, maxLength: 128, pattern: '^[a-zA-Z0-9_-]+$' }, 'x-aqua-account': { type: 'string', minLength: 1 } } },
        body: objectBody({ useFirst: { type: 'boolean' }, expectedVersion: amount }),
        response: { 200: { type: 'object', additionalProperties: false, required: ['useFirst', 'version'], properties: { useFirst: { type: 'boolean' }, version: amount } }, ...errorResponses },
      },
    }, async (request) => rewards.setPreference({ userId: request.aquaUser!.id, useFirst: request.body.useFirst, expectedVersion: request.body.expectedVersion, idempotencyKey: request.headers['idempotency-key'] as string }));
    api.get('/api/issuer-card', { preValidation: async (request) => {
      await signedIn(request); accountMatches(request, request.aquaUser!);
    }, schema: {
      tags: ['issuer sandbox'], summary: '내 테스트 발급사 카드의 요청 상태와 확인 상태', security: secured,
      headers: { type: 'object', required: ['x-aqua-account'], properties: { 'x-aqua-account': { type: 'string', minLength: 1, maxLength: 128 } } },
      response: { 200: { $ref: 'AquaIssuerCard#' }, ...errorResponses },
    } }, async (request) => ({ ...await issuer.snapshot(request.aquaUser!.id), canRequestStatus: sandboxIssuerWritesEnabled }));
    api.post<{ Body: { cardId: string; targetStatus: IssuerCardStatus; expectedVersion: number } }>('/api/issuer-card/status', {
      preValidation: async (request) => {
        await signedIn(request); accountMatches(request, request.aquaUser!);
        if (!sandboxIssuerWritesEnabled) throw new LedgerError(403, 'SANDBOX_DISABLED', '운영 환경에서는 테스트 발급사 명령을 실행할 수 없어요.');
        // Validate before Ajv's shared removeAdditional setting can strip caller-selected identities or endpoints.
        const allowed = new Set(['cardId', 'targetStatus', 'expectedVersion']);
        if (Object.keys(request.body).some((key) => !allowed.has(key))) throw new LedgerError(400, 'INVALID_INPUT', '요청 내용을 확인해 주세요.');
        const key = request.headers['idempotency-key'];
        if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(key)) throw new LedgerError(400, 'IDEMPOTENCY_KEY_REQUIRED', '요청 식별자를 확인해 주세요.');
        await auth.enforceIssuerCardCommand(request.aquaUser!.id);
      },
      schema: {
        tags: ['issuer sandbox'], summary: '테스트 발급사 카드 잠금·해제 요청 접수',
        description: '202는 요청이 저장됐다는 뜻입니다. 발급사 확인 전에는 confirmedStatus가 바뀌지 않습니다. 현재 테스트 원장 승인 경로의 결제 차단 기능과는 별개입니다.', security: secured,
        headers: { type: 'object', required: ['idempotency-key', 'x-aqua-account'], properties: { 'idempotency-key': { type: 'string', minLength: 8, maxLength: 128, pattern: '^[a-zA-Z0-9_-]+$' }, 'x-aqua-account': { type: 'string', minLength: 1 } } },
        body: objectBody({ cardId: uuidSchema, targetStatus: issuerStatusSchema, expectedVersion: issuerVersionSchema }),
        response: { 202: issuerReceiptSchema, ...errorResponses },
      },
    }, async (request, reply) => reply.code(202).send(await issuer.requestStatus({
      userId: request.aquaUser!.id, cardId: request.body.cardId, targetStatus: request.body.targetStatus,
      expectedVersion: request.body.expectedVersion, idempotencyKey: request.headers['idempotency-key'] as string,
    })));
    api.get<{ Querystring: { tag: string } }>('/api/members', { preValidation: signedIn, schema: { tags: ['members'], summary: '태그로 회원 찾기', security: secured, querystring: objectBody({ tag: { type: 'string', minLength: 3, maxLength: 21 } }), response: { 200: { type: 'object', additionalProperties: false, required: ['member'], properties: { member: { type: 'object', additionalProperties: false, required: ['id', 'tag', 'name'], properties: { id: text, tag: text, name: text } } } }, ...errorResponses } } }, async (request) => {
      await auth.enforceMemberLookup(request.aquaUser!.id);
      const tag = request.query.tag.trim().replace(/^@/, '').toLowerCase();
      if (!/^[a-z0-9._]{3,20}$/.test(tag)) throw new LedgerError(400, 'INVALID_TAG', '받는 사람의 태그를 확인해 주세요.');
      const member = await store.getUserByTag(tag);
      if (!member) throw new LedgerError(404, 'MEMBER_NOT_FOUND', '일치하는 회원을 찾지 못했어요.');
      const letters = Array.from(member.name);
      const name = letters.length <= 2 ? `${letters[0]}*` : `${letters[0]}${'*'.repeat(letters.length - 2)}${letters.at(-1)}`;
      return { member: { id: member.id, tag: member.tag, name } };
    });
    api.post<{ Body: { recipientTag: string; amountWon: number } }>('/api/transfers', {
      preValidation: async (request) => {
        await signedIn(request); accountMatches(request, request.aquaUser!);
        const key = request.headers['idempotency-key'];
        if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(key)) throw new LedgerError(400, 'IDEMPOTENCY_KEY_REQUIRED', '거래 식별자를 확인해 주세요.');
      },
      schema: { tags: ['ledger'], summary: '회원 간 테스트 잔액 송금', security: secured,
        headers: { type: 'object', required: ['idempotency-key', 'x-aqua-account'], properties: { 'idempotency-key': { type: 'string', minLength: 8, maxLength: 128, pattern: '^[a-zA-Z0-9_-]+$' }, 'x-aqua-account': { type: 'string', minLength: 1 } } },
        body: objectBody({ recipientTag: { type: 'string', minLength: 3, maxLength: 21 }, amountWon: { type: 'integer', minimum: 1000, maximum: Number.MAX_SAFE_INTEGER } }),
        response: { 200: { type: 'object', additionalProperties: false, required: ['transfer', 'balanceWon'], properties: { transfer: { $ref: 'AquaTransfer#' }, balanceWon: { type: 'integer', minimum: 0 } } }, ...errorResponses },
      },
    }, async (request) => store.transfer({ senderId: request.aquaUser!.id, recipientTag: request.body.recipientTag, amountWon: request.body.amountWon, idempotencyKey: request.headers['idempotency-key'] as string }));

    if (options.exposeOpenApi ?? process.env.NODE_ENV !== 'production') {
      api.get('/api/openapi.json', { schema: { hide: true } }, async () => api.swagger());
    }
    if (options.staticDir) {
      await api.register(fastifyStatic, { root: resolve(options.staticDir), wildcard: true, index: false, dotfiles: 'deny', cacheControl: false, allowedPath: (_path, _root, request) => !apiPath(request) });
      // The static wildcard rejects directory roots before the SPA not-found fallback runs.
      api.route({ method: ['GET', 'HEAD'], url: '/', schema: { hide: true }, handler: (_request, reply) => reply.sendFile('index.html') });
    }
    api.setNotFoundHandler(async (request, reply) => {
      const path = new URL(request.raw.url ?? request.url, 'http://aqua.invalid').pathname;
      if (!apiPath(request) && options.staticDir && ['GET', 'HEAD'].includes(request.method) && !extname(path)) return reply.sendFile('index.html');
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: apiPath(request) ? '요청한 기능을 찾지 못했어요.' : '요청한 페이지를 찾지 못했어요.' } });
    });
  });
  return app;
}
