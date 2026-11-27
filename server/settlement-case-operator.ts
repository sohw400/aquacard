import { createHash } from 'node:crypto';
import { BankSettlementFormatError, parseBankStatement, parseSettlementAdvice } from './bank-settlement-format';
import { BankSettlementScopeError, matchBankSettlement, verifyBankSettlementScope } from './bank-settlement-match';
import type { Database } from './database';
import { cardServiceDatabase } from './card-service-database';
import { checkIssuerStatementLedger } from './check-issuer-statement-ledger';
import { isStatementReference, IssuerStatementFormatError, parseIssuerStatement, statementDayWindow } from './issuer-statement-format';
import { SettlementDayOpenError } from './issuer-statement-ledger';
import { verifyMigrations } from './migrations';
import { verifySettlementCaseRole } from './permissions';
import { readSettlementInput, SettlementInputError } from './settlement-input-file';
import { readSettlementReference } from './settlement-reference';

const usage = [
  'open-issuer COMMAND_UUID EVENT_REFERENCE ISSUER_FILE',
  'open-bank COMMAND_UUID BATCH_REFERENCE ISSUER_FILE ADVICE_FILE BANK_FILE',
  'claim|release|approve COMMAND_UUID CASE_UUID EXPECTED_VERSION',
  'evidence COMMAND_UUID CASE_UUID EXPECTED_VERSION RESOLUTION EVIDENCE_SHA256',
  'return COMMAND_UUID CASE_UUID EXPECTED_VERSION EVIDENCE_SHA256',
  'read CASE_UUID', 'list STATE [AFTER_CASE_UUID]',
];
const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const states = ['open', 'assigned', 'evidenced', 'approved'];
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const knownDatabaseErrors = new Set(['SETTLEMENT_CASE_ALREADY_RECORDED','SETTLEMENT_COMMAND_CONFLICT','SETTLEMENT_CASE_INVALID',
  'SETTLEMENT_CASE_NOT_FOUND','SETTLEMENT_CASE_STALE','SETTLEMENT_CASE_STATE_CONFLICT','SETTLEMENT_CASE_ASSIGNEE_REQUIRED',
  'SETTLEMENT_CASE_INDEPENDENT_REVIEW_REQUIRED','SETTLEMENT_DAY_OPEN']);

class CaseInputError extends Error {}

interface Request { sql: string; args: unknown[] }

type FileHashes = { issuerStatement: string; settlementAdvice?: string; bankStatement?: string };
interface OriginalCase { source: { scope: string; referenceSha256: string; sourceSha256: FileHashes } }

async function openCase(args: string[], db: Database): Promise<Request> {
  const [op, commandId, ref, issuerPath, advicePath, bankPath] = args;
  const isBank = op === 'open-bank';
  if (args.length !== (isBank ? 6 : 4) || !uuid.test(commandId)
    || !(isBank ? isStatementReference(ref) : readSettlementReference('event', ref))) throw new CaseInputError('SETTLEMENT_CASE_INVALID');
  const issuer = await readSettlementInput(issuerPath, parseIssuerStatement);
  const base = { businessDate: issuer.value.businessDate, referenceSha256: digest(ref) };
  const advice = isBank ? await readSettlementInput(advicePath, parseSettlementAdvice) : null;
  const bank = isBank ? await readSettlementInput(bankPath, parseBankStatement) : null;
  const scope = isBank ? 'bank_settlement' : 'issuer_statement';
  const sourceSha256: FileHashes = { issuerStatement: issuer.sha256 };
  if (advice && bank) {
    verifyBankSettlementScope(issuer.value, advice.value, bank.value);
    sourceSha256.settlementAdvice = advice.sha256;
    sourceSha256.bankStatement = bank.sha256;
  }
  // An acknowledgement can be lost after commit. With exactly the same input bytes
  // replay the stored attestation even if later postings have resolved the finding.
  const prior = (await db.query<{ saved: OriginalCase | null }>('SELECT read_settlement_case($1::uuid) AS saved', [commandId])).rows[0].saved;
  let source;
  if (prior) {
    const recorded = prior.source;
    if (recorded.scope !== scope || recorded.referenceSha256 !== base.referenceSha256
      || recorded.sourceSha256.issuerStatement !== sourceSha256.issuerStatement
      || recorded.sourceSha256.settlementAdvice !== sourceSha256.settlementAdvice
      || recorded.sourceSha256.bankStatement !== sourceSha256.bankStatement) throw new CaseInputError('SETTLEMENT_COMMAND_CONFLICT');
    source = recorded;
  } else if (advice && bank) {
    const window = statementDayWindow(bank.value.settlementDate);
    if (!window) throw new CaseInputError('INVALID_SETTLEMENT_DATE');
    const upstream = await checkIssuerStatementLedger(issuer.value, window.endMs);
    if (!upstream.ok) throw new CaseInputError('SETTLEMENT_CASE_ISSUER_DIFFERENCE');
    const finding = matchBankSettlement(issuer.value, advice.value, bank.value, ref).findings[0];
    if (!finding) throw new CaseInputError('SETTLEMENT_CASE_FINDING_ABSENT');
    source = { ...base, scope: 'bank_settlement', settlementDate: bank.value.settlementDate, accountSha256: digest(bank.value.accountRef),
      findingSha256: digest(JSON.stringify(finding)), codes: finding.codes,
      sourceSha256 };
  } else {
    const result = await checkIssuerStatementLedger(issuer.value, undefined, ref);
    const finding = result.findings[0];
    if (!finding) throw new CaseInputError('SETTLEMENT_CASE_FINDING_ABSENT');
    source = { ...base, scope: 'issuer_statement', settlementDate: null, accountSha256: null, findingSha256: digest(JSON.stringify(finding)),
      codes: finding.codes, sourceSha256 };
  }
  return { sql: 'SELECT open_settlement_case($1::jsonb) AS result', args: [JSON.stringify({ commandId, source })] };
}

function caseRequest(args: string[]): Request {
  const [action, first, caseId, version] = args;
  if (action === 'read' && args.length === 2 && uuid.test(first)) {
    return { sql: 'SELECT read_settlement_case($1::uuid) AS result', args: [first] };
  }
  if (action === 'list' && states.includes(first) && (args.length === 2 || (args.length === 3 && uuid.test(caseId)))) {
    return { sql: 'SELECT list_settlement_cases($1::text,$2::uuid) AS result', args: [first, caseId ?? null] };
  }
  if (!['claim','release','evidence','return','approve'].includes(action) || !uuid.test(first) || !uuid.test(caseId)
    || !/^[1-9][0-9]{0,8}$/.test(version) || args.length !== (action === 'evidence' ? 6 : action === 'return' ? 5 : 4)) {
    throw new CaseInputError('SETTLEMENT_CASE_INVALID');
  }
  const command = { commandId: first, caseId, expectedVersion: Number(version), action,
    resolution: action === 'evidence' ? args[4] : undefined,
    evidenceSha256: action === 'evidence' ? args[5] : action === 'return' ? args[4] : undefined };
  return { sql: 'SELECT transition_settlement_case($1::jsonb) AS result', args: [JSON.stringify(command)] };
}

async function run(args: string[]) {
  if (args.length === 1 && args[0] === '--help') { console.log(usage.join('\n')); return; }
  try {
    const opening = args[0] === 'open-issuer' || args[0] === 'open-bank';
    const transition = opening ? null : caseRequest(args);
    const db = await cardServiceDatabase('settlementCase');
    let result: unknown;
    try {
      await verifyMigrations(db);
      await verifySettlementCaseRole(db);
      const request = transition ?? await openCase(args, db);
      result = (await db.query(request.sql, request.args)).rows[0].result;
      if (result === null) throw new CaseInputError('SETTLEMENT_CASE_NOT_FOUND');
    } finally { await db.close(); }
    console.log(JSON.stringify(result));
  } catch (error) {
    let code = 'SETTLEMENT_CASE_UNAVAILABLE';
    if (error instanceof BankSettlementFormatError || error instanceof BankSettlementScopeError || error instanceof IssuerStatementFormatError
      || error instanceof SettlementInputError || error instanceof SettlementDayOpenError) code = error.code;
    else if (error instanceof CaseInputError || (error instanceof Error && knownDatabaseErrors.has(error.message))) code = error.message;
    console.error(JSON.stringify({ status: 'incomplete', code }));
    process.exitCode = 2;
  }
}

await run(process.argv.slice(2));
