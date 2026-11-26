import { BankSettlementFormatError, parseBankStatement, parseSettlementAdvice } from './bank-settlement-format';
import { BankSettlementScopeError, matchBankSettlement, verifyBankSettlementScope } from './bank-settlement-match';
import { checkIssuerStatementLedger } from './check-issuer-statement-ledger';
import { IssuerStatementFormatError, parseIssuerStatement, statementDayWindow } from './issuer-statement-format';
import { SettlementDayOpenError } from './issuer-statement-ledger';
import { readSettlementInput, SettlementInputError } from './settlement-input-file';

function incomplete(code: string) {
  console.error(JSON.stringify({ status: 'incomplete', code }));
  process.exitCode = 2;
}

async function run(args: string[]) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node dist-server/reconcile-bank-settlement.js ISSUER_STATEMENT SETTLEMENT_ADVICE BANK_STATEMENT');
    console.log('Compare closed TEST_KRW issuer events, settlement batches and bank postings. Exit 0 for a match, 1 for differences or 2 for an incomplete check.');
    return;
  }
  if (args.length !== 3 || args.some(arg => !arg || arg === '-')) return incomplete('SETTLEMENT_FILES_REQUIRED');

  try {
    const issuer = await readSettlementInput(args[0], parseIssuerStatement);
    const advice = await readSettlementInput(args[1], parseSettlementAdvice);
    const bank = await readSettlementInput(args[2], parseBankStatement);
    verifyBankSettlementScope(issuer.value, advice.value, bank.value);
    const window = statementDayWindow(bank.value.settlementDate);
    if (!window) return incomplete('INVALID_SETTLEMENT_DATE');
    const issuerStatement = await checkIssuerStatementLedger(issuer.value, window.endMs);
    const bankSettlement = issuerStatement.ok ? matchBankSettlement(issuer.value, advice.value, bank.value) : null;
    const ok = bankSettlement?.ok ?? false;
    console.log(JSON.stringify({
      scope: 'bank_settlement', stage: issuerStatement.ok ? 'bank_settlement' : 'issuer_statement', ok,
      accountRef: advice.value.accountRef, businessDate: issuer.value.businessDate, settlementDate: bank.value.settlementDate,
      sourceSha256: { issuerStatement: issuer.sha256, settlementAdvice: advice.sha256, bankStatement: bank.sha256 },
      issuerStatement, bankSettlement,
    }));
    process.exitCode = ok ? 0 : 1;
  } catch (error) {
    if (error instanceof BankSettlementFormatError || error instanceof IssuerStatementFormatError
        || error instanceof BankSettlementScopeError || error instanceof SettlementInputError
        || error instanceof SettlementDayOpenError) return incomplete(error.code);
    // Database errors can include connection and customer details.
    incomplete('SETTLEMENT_CHECK_UNAVAILABLE');
  }
}

await run(process.argv.slice(2));
