import Fastify, { LogController, type FastifyInstance, type FastifyLoggerOptions, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import { extname, resolve } from 'node:path';
import type { MemberProfile } from '../shared/api';
import { AuthService } from './auth';
import { LedgerError, LedgerStore } from './ledger';

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
const cardPaymentSchema = {
  $id: 'AquaCardPayment', type: 'object', additionalProperties: false,
  required: ['id', 'merchantName', 'status', 'authorizedWon', 'heldWon', 'capturedWon', 'releasedWon', 'refundedWon', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string' }, merchantName: { type: 'string' },
    status: { type: 'string', enum: ['authorized', 'partially_captured', 'captured', 'cancelled', 'partially_refunded', 'refunded'] },
    ...Object.fromEntries(['authorizedWon', 'heldWon', 'capturedWon', 'releasedWon', 'refundedWon', 'createdAt', 'updatedAt'].map((key) => [key, { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }])),
  },
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
        info: { title: 'Aqua sandbox API', version: '0.3.0', description: '테스트 계정, 인증, 원장, 회원 송금과 카드 결제 내역 API. 실제 자금 이동은 제공하지 않습니다.' },
        components: { securitySchemes: { aquaSession: { type: 'apiKey', in: 'cookie', name: COOKIE } } },
      },
    });
    api.addSchema(errorSchema); api.addSchema(profileSchema); api.addSchema(recordSchema); api.addSchema(cardPaymentSchema);

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
      const result = await auth.signup(request.body, request.ip);
      sessionCookie(reply, result.token); return reply.code(201).send({ user: result.user });
    });
    api.post<{ Body: { email: string; password: string } }>('/api/auth/login', { schema: {
      tags: ['authentication'], summary: '로그인', body: objectBody({ email: text, password: { type: 'string', maxLength: 128, writeOnly: true } }), response: { 200: userSchema, ...errorResponses },
    } }, async (request, reply) => {
      const result = await auth.login(request.body, request.ip);
      await auth.logout(tokenOf(request)); sessionCookie(reply, result.token); return { user: result.user };
    });
    api.post('/api/auth/logout', { schema: { tags: ['authentication'], summary: '로그아웃', body: objectBody({}), response: { 200: okaySchema, ...errorResponses } } }, async (request, reply) => {
      const user = await auth.authenticate(tokenOf(request));
      if (user) accountMatches(request, user);
      await auth.logout(tokenOf(request)); sessionCookie(reply, '', true); return { ok: true };
    });
    api.post<{ Body: { email: string } }>('/api/auth/recovery/request', { schema: { tags: ['authentication'], summary: '복구 안내 요청', body: objectBody({ email: text }), response: { 202: okaySchema, ...errorResponses } } }, async (request, reply) => {
      if (!options.deliverRecovery) throw new LedgerError(503, 'RECOVERY_UNAVAILABLE', '계정 복구를 준비하고 있어요. 잠시 뒤 다시 시도해 주세요.');
      await auth.requestRecovery(request.body.email, request.ip); return reply.code(202).send({ ok: true });
    });
    api.post<{ Body: { token: string; password: string } }>('/api/auth/recovery/confirm', { schema: { tags: ['authentication'], summary: '비밀번호 재설정', body: objectBody({ token: { type: 'string', writeOnly: true }, password: { type: 'string', minLength: 12, maxLength: 128, writeOnly: true } }), response: { 200: okaySchema, ...errorResponses } } }, async (request, reply) => {
      if (!options.deliverRecovery) throw new LedgerError(503, 'RECOVERY_UNAVAILABLE', '계정 복구를 준비하고 있어요. 잠시 뒤 다시 시도해 주세요.');
      await auth.resetPassword(request.body.token, request.body.password, request.ip); sessionCookie(reply, '', true); return { ok: true };
    });
    api.get('/api/account', { preValidation: signedIn, schema: { tags: ['ledger'], summary: '내 잔액과 거래 내역', security: secured,
      response: { 200: { type: 'object', additionalProperties: false, required: ['user', 'balanceWon', 'heldBalanceWon', 'totalBalanceWon', 'cardPayments', 'transactions', 'limits'], properties: { user: { $ref: 'AquaMember#' }, balanceWon: { type: 'integer', minimum: 0 }, heldBalanceWon: { type: 'integer', minimum: 0 }, totalBalanceWon: { type: 'integer', minimum: 0 }, cardPayments: { type: 'array', items: { $ref: 'AquaCardPayment#' } }, transactions: { type: 'array', items: { $ref: 'AquaTransfer#' } }, limits: { type: 'object', additionalProperties: false, required: ['perTransfer', 'daily', 'monthly', 'sentToday', 'sentMonth', 'available'], properties: Object.fromEntries(['perTransfer', 'daily', 'monthly', 'sentToday', 'sentMonth', 'available'].map((key) => [key, { type: 'integer', minimum: 0 }])) } } }, ...errorResponses },
    } }, async (request) => store.snapshot(request.aquaUser!.id));
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
