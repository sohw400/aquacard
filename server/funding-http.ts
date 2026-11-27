import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { FundingInput } from '../shared/funding';
import { LedgerError } from './errors';
import { FundingStore } from './funding-store';

const text = { type: 'string' };
const number = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const fields = {
  id:text, direction:text, asset:text, network:text, status:text, destination:text, priceWon:number, grossWon:number,
  feeWon:number, networkFeeWon:number, netWon:number, units:text, requiredConfirmations:number, createdAt:number, updatedAt:number, expiresAt:number,
};
const result = { type:'object', additionalProperties:false, required:Object.keys(fields), properties:fields };
const scoped = { 'x-aqua-account': { type:'string', minLength:1, maxLength:128 } };
const keyHeader = { 'idempotency-key': { type:'string', pattern:'^[A-Za-z0-9_-]{8,128}$' } };
const meta = { tags:['ledger'], security:[{ aquaSession:[] }] };
const quote = { type:'object', additionalProperties:false, required:['action','direction','asset','network','quantity'], properties:{
  action:{ const:'quote' }, direction:{ enum:['deposit','withdrawal'] }, asset:{enum:['KRWS','USDC','USDT','BTC','ETH']},
  network:{enum:['polygon','ethereum','bitcoin']}, quantity:{type:'string',maxLength:19}, destination:{type:'string',maxLength:80},
} };
const command = { type:'object', additionalProperties:false, required:['action','id'], properties:{
  action:{ enum:['accept_deposit','accept_withdrawal','cancel'] }, id:{type:'string',format:'uuid'},
} };
export function registerFundingRoutes(api: FastifyInstance, funding: FundingStore, account: (request: FastifyRequest)=>Promise<void>,
  recent: (request: FastifyRequest)=>Promise<boolean>) {
  api.get('/api/funding', { preValidation:account, schema:{...meta, summary:'내 테스트 코인 입출금', headers:{type:'object',required:['x-aqua-account'],properties:scoped},
    response:{200:{type:'array',items:result}}} }, async request => funding.history(request.aquaUser!.id));
  api.post<{Body: FundingInput}>('/api/funding', { preValidation:async request => {
    await account(request);
    if (process.env.NODE_ENV==='production') throw new LedgerError(403,'SANDBOX_DISABLED','운영 환경에서는 체험용 입출금을 접수하지 않아요.');
    const body=request.body;
    const allowed=body?.action==='quote' ? Object.keys(quote.properties) : Object.keys(command.properties);
    if (!body || Object.keys(body).some(key=>!allowed.includes(key))) throw new LedgerError(400,'INVALID_FUNDING_INPUT','요청 항목을 확인해 주세요.');
  }, schema:{...meta, summary:'테스트 입출금 견적·확인·취소',
    headers:{type:'object',required:['x-aqua-account','idempotency-key'],properties:{...scoped,...keyHeader}},
    body:{type:'object',additionalProperties:false,properties:{...quote.properties,...command.properties,action:{enum:['quote','accept_deposit','accept_withdrawal','cancel']}},
      oneOf:[{required:quote.required,properties:{action:quote.properties.action}},{required:command.required,properties:{action:command.properties.action}}]}, response:{200:result}} }, async request => {
    if (request.body.action==='accept_withdrawal' && !(await recent(request))) {
      throw new LedgerError(403,'REAUTHENTICATION_REQUIRED','보안을 위해 비밀번호를 다시 입력해 주세요.');
    }
    return funding.intent(request.aquaUser!.id,request.headers['idempotency-key'] as string,request.body);
  });
}
