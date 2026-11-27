import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { LedgerError } from '../server/errors';
import { FundingStore } from '../server/funding-store';
import { verifyMigrations } from '../server/migrations';
import { verifyFundingRole } from '../server/permissions';
import { assertPrivateStagingPath, openLocalStagingOperator, LocalStagingError } from './staging-operator';
import {
  issueLocalDepositProof, validateLocalDepositProof, type LocalDepositBinding, type LocalDepositProof,
} from './staging-chain-proof';

const email = 'qa-member@example.test';

async function readProof(path: string, binding: LocalDepositBinding) {
  try {
    await assertPrivateStagingPath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return await validateLocalDepositProof(JSON.parse(await readFile(path, 'utf8')), binding);
  } catch {
    throw new LocalStagingError('Saved chain evidence failed verification. Restore the original receipt before retrying.');
  }
}

async function persistProof(dir: string, path: string, proof: LocalDepositProof) {
  const temporary = join(dir, randomUUID() + '.tmp');
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(proof) + '\n');
      await file.sync();
    } finally { await file.close(); }
    try { await link(temporary, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  } finally { await unlink(temporary); }
}

async function syncDirectory(dir: string) {
  const directory = await open(dir, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function run() {
  const id = process.argv[2]?.replace(/^aqua-test:ethereum:/, '');
  if (process.argv.length !== 3 || !id || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id)) {
    throw new LocalStagingError('Supply the accepted deposit UUID or its full aqua-test:ethereum: address.');
  }
  const operator = await openLocalStagingOperator();
  const credentials = join(operator.dir, 'member.json');
  await assertPrivateStagingPath(credentials);
  const member = JSON.parse(await readFile(credentials, 'utf8'));
  if (member.email !== email || typeof member.tag !== 'string' || !/^stageqa[0-9a-f]{10}$/.test(member.tag)) {
    throw new LocalStagingError('Use the credentials for the local staged QA member.');
  }
  const app = operator.database('DATABASE_URL');
  const funding = operator.database('FUNDING_DATABASE_URL');
  try {
    await verifyMigrations(app);
    await verifyFundingRole(funding);
    const user = await app.query<{ id: string }>('SELECT id FROM users WHERE email=$1 AND tag=$2', [email, member.tag]);
    const owner = user.rows[0]?.id;
    if (!owner) throw new LocalStagingError('Run the staging member fixture first.');
    // Session lock is held while the local chain runs, with no open DB transaction.
    // Closing this dedicated connection releases it on any process or connection failure.
    const connection = await funding.pool.connect();
    try {
      // The other invocation may still be compiling the token or mining its confirmations.
      await connection.query("SET lock_timeout='30s'; SET statement_timeout='35s'");
      await connection.query('SELECT pg_advisory_lock(hashtextextended($1,0))', ['staging-chain-deposit/' + id]);
      const op = (await new FundingStore(app).history(owner)).find(row => row.id === id);
      if (!op || op.direction !== 'deposit' || op.asset !== 'KRWS' || op.network !== 'ethereum'
        || op.destination !== 'aqua-test:ethereum:' + id || op.requiredConfirmations !== 12) {
        throw new LocalStagingError('Choose a KRWS Ethereum deposit in the QA member’s recent funding history.');
      }
      if (!['awaiting', 'observed', 'confirmed', 'credited'].includes(op.status)) {
        throw new LocalStagingError('First accept the deposit in the member app. Cancelled or reviewed requests cannot be credited here.');
      }
      // The app permits up to 8 fraction digits. The chain fixture represents exactly 6.
      if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(op.units)) {
        throw new LocalStagingError('MockKRWS supports six fraction digits. Create a new quote with an exact amount.');
      }
      const binding = { memberId: owner, intentId: id, destination: op.destination,
        units: op.units, requiredConfirmations: op.requiredConfirmations };
      const dir = join(operator.dir, 'chain-deposits');
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await assertPrivateStagingPath(dir, true);
      const path = join(dir, id + '.json');
      let proof = await readProof(path, binding);
      if (!proof) {
        if (op.status !== 'awaiting') {
          throw new LocalStagingError('Funding already advanced. Restore its original private chain receipt to retry.');
        }
        await persistProof(dir, path, await issueLocalDepositProof(binding));
        proof = await readProof(path, binding);
        if (!proof) throw new LocalStagingError('Could not reopen the published local chain receipt.');
      }
      // A prior run may have stopped after the hard link but before fsync. Persist both
      // directory entries before posting, including on a replay of previously saved evidence.
      await syncDirectory(dir);
      await syncDirectory(operator.dir);
      const store = new FundingStore(funding);
      const event = (action: string, fields: Record<string, unknown> = {}) => store.event({
        id, eventId: 'local-stage-' + id + '-' + action, action, ...fields,
      });
      const refs = { transferRef: `sim-tx:${proof.transactionHash.slice(2)}:${proof.logIndex}`,
        blockRef: `sim-block:${proof.blockHash.slice(2)}` };
      await event('observe', { ...refs, asset: op.asset, network: op.network, units: op.units, destination: op.destination });
      await event('confirm', { ...refs, confirmations: proof.confirmations });
      const posted = await event('convert');
      console.log(JSON.stringify({ id: posted.id, status: posted.status, amountWon: posted.grossWon,
        chainId: proof.chainId, transactionHash: proof.transactionHash, logIndex: proof.logIndex, confirmations: proof.confirmations }));
    } finally { connection.release(true); }
  } finally { await Promise.all([app.close(), funding.close()]); }
}

run().catch((error: unknown) => {
  console.error(error instanceof LocalStagingError ? error.message : error instanceof LedgerError ? error.code
    : 'Staging deposit unavailable. Check the local database, funding login and chain fixture, then retry the same intent.');
  process.exitCode = 1;
});
