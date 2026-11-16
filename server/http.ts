import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { AuthService } from './auth';
import { LedgerError, LedgerStore } from './ledger';

export interface ServerOptions {
  allowedOrigins: string[];
  secureCookies?: boolean;
  deliverRecovery?: (email: string, token: string) => Promise<void>;
  staticDir?: string;
}

const COOKIE = 'aqua_session';
const MAX_BODY = 16_384;
const SESSION_SECONDS = 7 * 24 * 60 * 60;

function tokenOf(req: IncomingMessage): string | undefined {
  const token = req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return token && /^[a-zA-Z0-9_-]{32,128}$/.test(token) ? token : undefined;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new LedgerError(415, 'CONTENT_TYPE', 'JSON 형식으로 요청해 주세요.');
  }
  if (Number(req.headers['content-length']) > MAX_BODY) throw new LedgerError(413, 'BODY_TOO_LARGE', '요청이 너무 커요.');
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY) throw new LedgerError(413, 'BODY_TOO_LARGE', '요청이 너무 커요.');
    chunks.push(Buffer.from(chunk));
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value as Record<string, unknown>;
  } catch { throw new LedgerError(400, 'INVALID_JSON', '요청 내용을 확인해 주세요.'); }
}

function stringField(body: Record<string, unknown>, field: string): string {
  if (typeof body[field] !== 'string') throw new LedgerError(400, 'INVALID_INPUT', '입력한 내용을 확인해 주세요.');
  return body[field];
}

/** One trusted server owns the ledger. There is no endpoint to set balances or credit test money. */
export function createApiServer(store: LedgerStore, options: ServerOptions) {
  const auth = new AuthService(store, { deliverRecovery: options.deliverRecovery });
  const allowedOrigins = new Set(options.allowedOrigins);
  const lookups = new Map<string, { count: number; until: number }>();
  const setSession = (res: ServerResponse, token: string, clear = false) => {
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_SECONDS}${options.secureCookies ? '; Secure' : ''}`);
  };

  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    if (options.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const url = new URL(req.url ?? '/', 'http://aqua.invalid');
      const path = url.pathname;
      const method = req.method ?? 'GET';
      if (!path.startsWith('/api/')) {
        if (options.staticDir && (method === 'GET' || method === 'HEAD')) return await serveStatic(res, url, options.staticDir, method === 'HEAD');
        throw new LedgerError(404, 'NOT_FOUND', '요청한 페이지를 찾지 못했어요.');
      }
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new LedgerError(403, 'ORIGIN_REJECTED', '이 요청은 허용되지 않아요.');
      if (method === 'GET' && path === '/api/health') return json(res, 200, { status: 'ok', mode: 'sandbox' });
      const sessionToken = tokenOf(req);
      if (method === 'GET' && path === '/api/session') return json(res, 200, { user: auth.authenticate(sessionToken) });
      // No CORS or GET mutations. Browser cookies may only authorize JSON POSTs from our exact origin.
      if (method !== 'GET') {
        if (method !== 'POST') throw new LedgerError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청이에요.');
        if (!req.headers.origin || !allowedOrigins.has(req.headers.origin)) throw new LedgerError(403, 'ORIGIN_REJECTED', '이 요청은 허용되지 않아요.');
      }
      const body = method === 'POST' ? await bodyOf(req) : {};
      const rateKey = req.socket.remoteAddress ?? 'unknown';
      if (method === 'POST' && path === '/api/auth/signup') {
        const result = await auth.signup({ email: stringField(body, 'email'), name: stringField(body, 'name'), tag: stringField(body, 'tag'), password: stringField(body, 'password') }, rateKey);
        setSession(res, result.token);
        return json(res, 201, { user: result.user });
      }
      if (method === 'POST' && path === '/api/auth/login') {
        const result = await auth.login({ email: stringField(body, 'email'), password: stringField(body, 'password') }, rateKey);
        if (sessionToken) auth.logout(sessionToken);
        setSession(res, result.token);
        return json(res, 200, { user: result.user });
      }
      if (method === 'POST' && path === '/api/auth/logout') {
        const current = auth.authenticate(sessionToken);
        if (current && req.headers['x-aqua-account'] !== current.id) {
          throw new LedgerError(409, 'SESSION_CHANGED', '로그인한 계정이 바뀌었어요. 계정을 다시 확인해 주세요.');
        }
        auth.logout(sessionToken);
        setSession(res, '', true);
        return json(res, 200, { ok: true });
      }
      if (method === 'POST' && (path === '/api/auth/recovery/request' || path === '/api/auth/recovery/confirm')) {
        if (!options.deliverRecovery) throw new LedgerError(503, 'RECOVERY_UNAVAILABLE', '계정 복구를 준비하고 있어요. 잠시 뒤 다시 시도해 주세요.');
        if (path.endsWith('/request')) {
          await auth.requestRecovery(stringField(body, 'email'), rateKey);
          return json(res, 202, { ok: true });
        }
        await auth.resetPassword(stringField(body, 'token'), stringField(body, 'password'), rateKey);
        setSession(res, '', true);
        return json(res, 200, { ok: true });
      }
      const user = auth.authenticate(sessionToken);
      if (!user) throw new LedgerError(401, 'UNAUTHENTICATED', '다시 로그인해 주세요.');
      if (method === 'GET' && path === '/api/account') return json(res, 200, store.snapshot(user.id));
      if (method === 'GET' && path === '/api/members') {
        const now = Date.now();
        for (const [key, value] of lookups) if (value.until <= now) lookups.delete(key);
        const entry = lookups.get(user.id) ?? { count: 0, until: now + 60_000 };
        if (++entry.count > 30 || lookups.size > 10_000) throw new LedgerError(429, 'RATE_LIMITED', '잠시 뒤 다시 찾아 주세요.');
        lookups.set(user.id, entry);
        const tag = (url.searchParams.get('tag') ?? '').trim().replace(/^@/, '').toLowerCase();
        if (!/^[a-z0-9._]{3,20}$/.test(tag)) throw new LedgerError(400, 'INVALID_TAG', '받는 사람의 태그를 확인해 주세요.');
        const member = store.getUserByTag(tag);
        if (!member) throw new LedgerError(404, 'MEMBER_NOT_FOUND', '일치하는 회원을 찾지 못했어요.');
        const letters = Array.from(member.name);
        const name = letters.length <= 2 ? `${letters[0]}*` : `${letters[0]}${'*'.repeat(letters.length - 2)}${letters.at(-1)}`;
        return json(res, 200, { member: { id: member.id, tag: member.tag, name } });
      }
      if (method === 'POST' && path === '/api/transfers') {
        // Tabs share cookies. An old screen must never debit the account another tab just signed into.
        const expectedAccount = req.headers['x-aqua-account'];
        if (typeof expectedAccount !== 'string' || expectedAccount !== user.id) {
          throw new LedgerError(409, 'SESSION_CHANGED', '로그인한 계정이 바뀌었어요. 계정을 다시 확인해 주세요.');
        }
        const key = req.headers['idempotency-key'];
        if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(key)) throw new LedgerError(400, 'IDEMPOTENCY_KEY_REQUIRED', '거래 식별자를 확인해 주세요.');
        if (typeof body.amountWon !== 'number' || !Number.isSafeInteger(body.amountWon)) throw new LedgerError(400, 'INVALID_AMOUNT', '금액은 원 단위로 입력해 주세요.');
        return json(res, 200, store.transfer({ senderId: user.id, recipientTag: stringField(body, 'recipientTag'), amountWon: body.amountWon, idempotencyKey: key }));
      }
      throw new LedgerError(404, 'NOT_FOUND', '요청한 기능을 찾지 못했어요.');
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      if (error instanceof LedgerError) {
        if (error.status === 429) res.setHeader('Retry-After', '60');
        json(res, error.status, { error: { code: error.code, message: error.message } });
      } else {
        // Do not log request bodies, cookies, recovery tokens, or database contents.
        console.error('API request failed:', error instanceof Error ? error.name : 'UnknownError');
        json(res, 500, { error: { code: 'INTERNAL_ERROR', message: '처리 결과를 확인하지 못했어요. 같은 요청으로 다시 확인해 주세요.' } });
      }
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}

async function serveStatic(res: ServerResponse, url: URL, directory: string, head: boolean) {
  const root = resolve(directory);
  let decoded: string;
  try { decoded = decodeURIComponent(url.pathname); } catch { throw new LedgerError(400, 'INVALID_PATH', '주소를 확인해 주세요.'); }
  let target = resolve(root, `.${decoded}`);
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new LedgerError(404, 'NOT_FOUND', '페이지를 찾지 못했어요.');
  try { if (!(await stat(target)).isFile()) target = resolve(root, 'index.html'); }
  catch { if (extname(target)) throw new LedgerError(404, 'NOT_FOUND', '파일을 찾지 못했어요.'); target = resolve(root, 'index.html'); }
  const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2' };
  const data = await readFile(target);
  res.writeHead(200, { 'Content-Type': types[extname(target)] ?? 'application/octet-stream', 'Content-Length': data.length });
  res.end(head ? undefined : data);
}
