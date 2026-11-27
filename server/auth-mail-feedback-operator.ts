import { parseAuthMailFeedback, recordAuthMailFeedback } from './auth-mail-feedback';
import { cardServiceDatabase } from './card-service-database';
import { verifyMigrations } from './migrations';
import { verifyAuthMailFeedbackRole } from './permissions';
import { readSettlementInput, SettlementInputError } from './settlement-input-file';

async function run() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: server:mail:feedback -- <synthetic SES event JSON file>');
    return;
  }
  if (args.length !== 1 || !args[0] || args[0] === '-') throw new Error('MAIL_FEEDBACK_FILE_REQUIRED');
  if (process.env.NODE_ENV === 'production' || process.env.AQUA_AUTH_MAIL_FEEDBACK_MODE !== 'sandbox') throw new Error('MAIL_FEEDBACK_DISABLED');
  const input = await readSettlementInput(args[0], parseAuthMailFeedback);
  const db = await cardServiceDatabase('mailFeedback');
  try {
    await verifyMigrations(db);
    await verifyAuthMailFeedbackRole(db);
    console.log(JSON.stringify(await recordAuthMailFeedback(db,input.value)));
  } finally { await db.close(); }
}
run().catch((error: unknown) => {
  const known = ['MAIL_FEEDBACK_FILE_REQUIRED','MAIL_FEEDBACK_DISABLED','INVALID_MAIL_FEEDBACK','MAIL_FEEDBACK_UNMATCHED','MAIL_FEEDBACK_CONFLICT','MAIL_FEEDBACK_UNAVAILABLE'];
  if (error instanceof SettlementInputError) {
    console.error(error.code === 'INVALID_STATEMENT_FORMAT' ? 'INVALID_MAIL_FEEDBACK' : 'MAIL_FEEDBACK_FILE_UNAVAILABLE');
  } else {
    console.error(error instanceof Error && known.includes(error.message) ? error.message : 'MAIL_FEEDBACK_UNAVAILABLE');
  }
  process.exitCode = 1;
});
