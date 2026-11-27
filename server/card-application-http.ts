import type { FastifyInstance, FastifyRequest } from 'fastify';
import { CardApplicationStore, type ApplicationForm } from './card-applications';
import { LedgerError } from './errors';

const form = { type: 'string', enum: ['virtual','physical'] };
const uuid = { type: 'string', format: 'uuid' };
const version = { type: 'integer', minimum: 1, maximum: 6 };
const instant = { type: 'integer', minimum: 0 };
const object = (properties: Record<string,unknown>) => ({
  type: 'object', additionalProperties: false, required: Object.keys(properties), properties,
});
const application = object({
  id: uuid, form, status: { type: 'string', enum: ['submitted','approved','declined','issued','dispatched','delivered','active'] },
  version, reason: { type:['null','string'], enum:[null,'ELIGIBILITY','DETAILS_REQUIRED'] }, createdAt: instant, updatedAt: instant,
});
const headers = { 'x-aqua-account': { type:'string', minLength:1, maxLength:128 } };
const writeHeaders = {...headers, 'idempotency-key': { type:'string', pattern:'^[A-Za-z0-9_-]{8,128}$' }};
const metadata = {security:[{aquaSession:[]}], tags:['issuer sandbox']};

export function registerCardApplicationRoutes(api: FastifyInstance, store: CardApplicationStore, writable: boolean,
  identify: (request: FastifyRequest)=>Promise<void>, limit: (userId:string)=>Promise<void>) {
  const write = (allowed: string[]) => async (request: FastifyRequest) => {
    await identify(request);
    if (!writable) throw new LedgerError(403,'SANDBOX_DISABLED','테스트 카드 신청을 사용할 수 없어요.');
    // Reject unsupported identity or provider fields before validation can strip them.
    const payload = request.body;
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).some(field=>!allowed.includes(field))) throw new LedgerError(400,'INVALID_CARD_APPLICATION','카드 신청 내용을 확인해 주세요.');
    await limit(request.aquaUser!.id);
  };
  api.get('/api/card-application', {
    preValidation: identify, schema:{...metadata,summary:'내 카드 신청 및 활성화 가능 여부',headers:{type:'object',required:Object.keys(headers),properties:headers},
      response:{200:object({ application:{anyOf:[application,{type:'null'}]},canApply:{type:'boolean'},canActivate:{type:'boolean'} })} },
  }, async request => {
    const snapshot = await store.snapshot(request.aquaUser!.id);
    return {...snapshot,canApply:writable && snapshot.canApply,canActivate:writable && snapshot.canActivate};
  });
  api.post<{Body:{form:ApplicationForm}}>('/api/card-application', {
    preValidation:write(['form']), schema:{...metadata,summary:'테스트 카드 신청',headers:{type:'object',required:Object.keys(writeHeaders),properties:writeHeaders},
      body:object({form}),response:{201:application}},
  }, async (request,reply) => reply.code(201).send(await store.submit({
    userId:request.aquaUser!.id,form:request.body.form,idempotencyKey:request.headers['idempotency-key'] as string,
  })));
  api.post<{Body:{applicationId:string; expectedVersion:number}}>('/api/card-application/activate', {
    preValidation:write(['applicationId','expectedVersion']), schema:{...metadata,summary:'내 테스트 카드 활성화',
      headers:{type:'object',required:Object.keys(writeHeaders),properties:writeHeaders},body:object({applicationId:uuid,expectedVersion:version}),response:{200:application}},
  }, request => store.activate({userId:request.aquaUser!.id,applicationId:request.body.applicationId,
    expectedVersion:request.body.expectedVersion,idempotencyKey:request.headers['idempotency-key'] as string}));
}
