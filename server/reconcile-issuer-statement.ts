import { checkIssuerStatementLedger } from './check-issuer-statement-ledger';
import { IssuerStatementFormatError, parseIssuerStatement } from './issuer-statement-format';
import { readSettlementInput, SettlementInputError } from './settlement-input-file';

const usage = 'Usage: node dist-server/reconcile-issuer-statement.js FILE';

function incomplete(code: string) {
  console.error(JSON.stringify({ status: 'incomplete', code }));
  process.exitCode = 2;
}

async function run() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
    console.log('Compare a normalized TEST_KRW statement for one completed Korean business date. Exit 0 for a match, 1 for differences or 2 for an incomplete check.');
    return;
  }
  if (args.length !== 1 || !args[0] || args[0] === '-') return incomplete('STATEMENT_FILE_REQUIRED');

  let input;
  try { input = await readSettlementInput(args[0], parseIssuerStatement); }
  catch (error) {
    return incomplete(error instanceof IssuerStatementFormatError || error instanceof SettlementInputError
      ? error.code : 'INVALID_STATEMENT_FORMAT');
  }
  const { value: statement, sha256: statementSha256 } = input;

  try {
    const report = await checkIssuerStatementLedger(statement);
    console.log(JSON.stringify({ ...report, statementSha256 }));
    process.exitCode = report.ok ? 0 : 1;
  } catch {
    // Connection and SQL messages may include credentials, row data or identifiers.
    incomplete('SETTLEMENT_CHECK_UNAVAILABLE');
  }
}

await run();
