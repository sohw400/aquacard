import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Database } from './database';
import { grantSettlementCaseRole, grantSettlementRole, verifySettlementCaseRole } from './permissions';
import { createTestDatabase } from './test-support';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

test('fresh report findings produce immutable human case evidence with independent approval, confirmed login and safe concurrent replay', async t => {
  const f = await createTestDatabase();
  const dir = await mkdtemp(join(tmpdir(), 'case-inputs-'));
  const roles: { name: string; db: Database; url: string }[] = [];
  t.after(async () => {
    try {
      await Promise.all(roles.map(role => role.db.close()));
      for (const role of roles) {
        await f.database.query(`DROP OWNED BY "${role.name}"`);
        await f.database.query(`DROP ROLE "${role.name}"`);
      }
    } finally { await f.cleanup(); await rm(dir, { recursive: true, force: true }); }
  });
  for (const purpose of ['maker','reviewer','settlement']) {
    const name = 'cash_' + purpose + '_' + randomBytes(7).toString('hex');
    const password = randomBytes(24).toString('hex');
    await f.database.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${password}'`);
    const uri = new URL(f.connectionString); uri.username = name; uri.password = password;
    const db = new Database({ connectionString: uri.href, schema: f.schema });
    roles.push({ name, db, url: uri.href });
    if (purpose === 'settlement') await grantSettlementRole(f.database, name);
    else { await grantSettlementCaseRole(f.database, name); await verifySettlementCaseRole(db); }
  }
  const [maker, reviewer, settlement] = roles;
  for (const q of ['SELECT * FROM settlement_cases','SELECT * FROM settlement_case_events','SELECT * FROM journal_entries',
    'SELECT * FROM users','SELECT * FROM issuer_statement_postings(0,0)','DELETE FROM journals','UPDATE settlement_cases SET version=1']) {
    await assert.rejects(maker.db.query(q), /permission denied/);
  }
  await assert.rejects(settlement.db.query('SELECT list_settlement_cases($1,NULL)', ['open']), /permission denied/);
  await assert.rejects(settlement.db.query('SELECT open_settlement_case(NULL)'), /permission denied/);

  const issuer = join(dir, 'issuer.json'), advice = join(dir, 'advice.json'), bank = join(dir, 'bank.json');
  const businessDate = '2025-05-12', settlementDate = '2025-05-13', currency = 'TEST_KRW';
  const reference = 'unposted-z';
  const events = Array.from({ length: 101 }, (_, n) => ({ eventId: 'unposted-' + n, paymentId: 'p', kind: 'capture', amountWon: '1' }));
  events.push({ eventId: reference, paymentId: 'p', kind: 'capture', amountWon: '1' });
  const input = { version: 1, currency, businessDate, controls: { rowCount: 102, capturedWon: '102', refundedWon: '0' }, rows: events };
  const document = JSON.stringify(input);
  await writeFile(issuer, document);
  const mode = { version: 1, currency, accountRef: 'private-settlement', settlementDate };
  await writeFile(advice,JSON.stringify({ ...mode, businessDate, batches: [] }));
  await writeFile(bank,JSON.stringify({ ...mode, controls: { rowCount: 1, debitedWon: '100', creditedWon: '0' }, rows: [
    { postingId: 'private-posting', batchId: 'bank-only', direction: 'debit', amountWon: '100' },
  ] }));
  function cli(args: string[], actor = maker, readerUrl = settlement.url) {
    const result = spawnSync(process.execPath, ['--import','tsx','server/settlement-case-operator.ts',...args], {
      env: { ...process.env, NODE_ENV:'test', DATABASE_SCHEMA:f.schema, SETTLEMENT_CASE_DATABASE_URL:actor.url, SETTLEMENT_DATABASE_URL:readerUrl },
      encoding:'utf8', timeout:20_000,
    });
    assert.ifError(result.error);
    assert.doesNotMatch(result.stdout + result.stderr, /unposted-z|private-posting|private-settlement|postgresql:|case-inputs-/);
    return result;
  }
  const request = randomUUID();
  const opened = cli(['open-issuer',request,reference,issuer]);
  assert.equal(opened.status,0,opened.stderr);
  const { caseId } = JSON.parse(opened.stdout);
  const initial = JSON.parse(cli(['read',caseId]).stdout);
  assert.equal(initial.source.referenceSha256, digest(reference));
  assert.equal(initial.source.sourceSha256.issuerStatement, digest(document));
  assert.deepEqual(initial.source.codes,['MISSING_IN_LEDGER']);
  const openCmd = { commandId: request, source: initial.source };
  const exec = async (who: typeof maker, fn: 'open_settlement_case'|'transition_settlement_case', cmd: Record<string,unknown>) =>
    (await who.db.query(`SELECT ${fn}($1::jsonb) AS result`,[JSON.stringify(cmd)])).rows[0].result;
  await assert.rejects(exec(reviewer,'open_settlement_case',openCmd),/SETTLEMENT_COMMAND_CONFLICT/);
  await assert.rejects(exec(maker,'open_settlement_case',{...openCmd,commandId:randomUUID()}),/SETTLEMENT_CASE_ALREADY_RECORDED/);
  await assert.rejects(exec(maker,'open_settlement_case',{commandId:randomUUID(),source:{...initial.source,comment:'unsafe'}}),/SETTLEMENT_CASE_INVALID/);
  const change = (action:string,expectedVersion:number,extra:Record<string,unknown>={}) => ({ commandId:randomUUID(),caseId,expectedVersion,action,...extra });
  const claim = change('claim',1);
  const concurrent = await Promise.all([exec(maker,'transition_settlement_case',claim),exec(maker,'transition_settlement_case',claim)]);
  assert.deepEqual(concurrent[0],concurrent[1]);
  await assert.rejects(exec(maker,'transition_settlement_case',{...claim,action:'release'}),/SETTLEMENT_COMMAND_CONFLICT/);
  await assert.rejects(exec(maker,'transition_settlement_case',change('release',1)),/SETTLEMENT_CASE_STALE/);
  await assert.rejects(exec(maker,'transition_settlement_case',change('approve',2,{actor:reviewer.name})),/SETTLEMENT_CASE_INVALID/);
  const evidence = (v:number) => change('evidence',v,{resolution:'source_corrected',evidenceSha256:digest('protected-case-evidence')});
  await assert.rejects(exec(reviewer,'transition_settlement_case',evidence(2)),/SETTLEMENT_CASE_ASSIGNEE_REQUIRED/);
  await exec(maker,'transition_settlement_case',evidence(2));
  await assert.rejects(exec(maker,'transition_settlement_case',change('approve',3)),/SETTLEMENT_CASE_INDEPENDENT_REVIEW_REQUIRED/);
  await exec(reviewer,'transition_settlement_case',change('return',3,{evidenceSha256:digest('review-return')}));
  await exec(maker,'transition_settlement_case',evidence(4));
  const approved = cli(['approve',randomUUID(),caseId,'5'],reviewer);
  assert.equal(approved.status,0,approved.stderr);
  const done = JSON.parse(cli(['read',caseId],reviewer).stdout);
  assert.deepEqual(done.history.map((row:{action:string})=>row.action), ['open','claim','evidence','return','evidence','approve']);
  assert.equal(done.history[5].actor,reviewer.name);
  assert.equal(done.state,'approved');
  assert.equal((await exec(maker,'open_settlement_case',openCmd)).version,1);
  const lostReceipt = cli(['open-issuer',request,reference,issuer],maker,'');
  assert.equal(lostReceipt.status,0,lostReceipt.stderr);
  assert.deepEqual(JSON.parse(lostReceipt.stdout),JSON.parse(opened.stdout));
  const reused = cli(['open-issuer',request,'unposted-13',issuer]);
  assert.equal(JSON.parse(reused.stderr).code,'SETTLEMENT_COMMAND_CONFLICT');
  await assert.rejects(exec(reviewer,'transition_settlement_case',change('approve',6)),/SETTLEMENT_CASE_STATE_CONFLICT/);
  assert.equal(JSON.parse(cli(['list','approved']).stdout)[0].caseId,caseId);
  await assert.rejects(f.database.query('DELETE FROM settlement_case_events'),/SETTLEMENT_AUDIT_IMMUTABLE/);
  await assert.rejects(f.database.query('TRUNCATE settlement_case_events'),/SETTLEMENT_AUDIT_IMMUTABLE/);
  const upstream = cli(['open-bank',randomUUID(),'bank-only',issuer,advice,bank]);
  assert.equal(JSON.parse(upstream.stderr).code,'SETTLEMENT_CASE_ISSUER_DIFFERENCE');
  await writeFile(issuer,JSON.stringify({...input,controls:{rowCount:0,capturedWon:'0',refundedWon:'0'},rows:[]}));
  const absent = cli(['open-issuer',randomUUID(),reference,issuer]);
  assert.equal(JSON.parse(absent.stderr).code,'SETTLEMENT_CASE_FINDING_ABSENT');
  const bankOpen = cli(['open-bank',randomUUID(),'bank-only',issuer,advice,bank]);
  assert.equal(bankOpen.status,0,bankOpen.stderr);
  const verified = JSON.parse(cli(['read',JSON.parse(bankOpen.stdout).caseId]).stdout);
  assert.deepEqual(verified.source.codes,['UNEXPECTED_BANK_BATCH']);
  assert.equal(verified.source.accountSha256,digest(mode.accountRef));
  assert.equal((await f.database.query('SELECT count(*)::int AS n FROM journals')).rows[0].n,0);
});
