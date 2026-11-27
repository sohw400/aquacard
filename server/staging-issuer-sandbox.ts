import { createHmac, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyRequest } from 'fastify';

const requestKey = /^aqua-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const cardRef = /^sandbox-card-[A-Za-z0-9_-]{1,100}$/;

/** This synthetic issuer rejects every command. It has no card state and can truthfully
 * report that a lost request never took effect, even after its task is replaced. */
export function createStagingIssuer(keyId: string, encodedKey: string) {
  if (process.env.NODE_ENV !== 'staging' || !/^[A-Za-z0-9_-]{1,32}$/.test(keyId) || !/^[A-Za-z0-9_-]{43}$/.test(encodedKey)) {
    throw new Error('The private staging issuer requires a sandbox signing key.');
  }
  const key = Buffer.from(encodedKey, 'base64url');
  if (key.toString('base64url') !== encodedKey) throw new Error('Invalid staging signing key.');
  const app = Fastify({ logger: false, bodyLimit: 2048, requestTimeout: 5000, connectionTimeout: 5000, exposeHeadRoutes: false });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  function signed(request: FastifyRequest, body: Buffer) {
    const timestamp = request.headers['x-aqua-timestamp'];
    const signature = request.headers['x-aqua-signature'];
    if (request.headers['x-aqua-key-id'] !== keyId || typeof timestamp !== 'string' || !/^\d{10}$/.test(timestamp)
      || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300
      || typeof signature !== 'string' || !/^v1=[0-9a-f]{64}$/.test(signature)) return false;
    const mac = createHmac('sha256', key).update(`sandbox.issuer.v1.${keyId}.${timestamp}.${request.method}.${request.url}.`).update(body).digest();
    return timingSafeEqual(mac, Buffer.from(signature.slice(3), 'hex'));
  }
  app.get<{ Params: { key: string } }>('/operations/:key', async (request, reply) => {
    if (!signed(request, Buffer.alloc(0))) return reply.code(401).send({});
    if (!requestKey.test(request.params.key)) return reply.code(400).send({});
    return reply.code(404).send({ requestKey: request.params.key, status: 'not_found', authoritative: true });
  });
  app.post<{ Params: { card: string } }>('/cards/:card/status', async (request, reply) => {
    if (!Buffer.isBuffer(request.body) || !signed(request, request.body)) return reply.code(401).send({});
    const id = request.headers['idempotency-key'];
    if (typeof id !== 'string' || !requestKey.test(id) || !cardRef.test(request.params.card)) return reply.code(400).send({});
    let body;
    try { body = JSON.parse(request.body.toString('utf8')); } catch { return reply.code(400).send({}); }
    if (body?.requestKey !== id || body.cardRef !== request.params.card || !['active', 'locked'].includes(body.targetStatus)
      || !Number.isSafeInteger(body.expiresAt)) return reply.code(400).send({});
    return reply.code(422).send({ requestKey: id, cardRef: body.cardRef, status: 'rejected', code: 'COMMAND_REJECTED' });
  });
  return app;
}
