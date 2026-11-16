import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { LedgerStore } from './ledger';

const [email, amount, key, ...extra] = process.argv.slice(2);
if (process.env.NODE_ENV === 'production') throw new Error('Test credit is disabled in production.');
if (!email || !amount || !key || extra.length || !/^\d+$/.test(amount) || !Number.isSafeInteger(Number(amount))) {
  throw new Error('Usage: npm run server:credit -- <email> <integer test won> <idempotency key>');
}
const path = resolve(process.env.AQUA_DB_PATH ?? 'data/aqua.sqlite');
if (!existsSync(path)) throw new Error('Start the API and create an account first.');
process.umask(0o077);
const store = new LedgerStore(path);
try {
  const user = store.getUserByEmail(email.trim().toLowerCase());
  if (!user) throw new Error('Create this test account in the server app first.');
  const result = store.creditSandbox({ userId: user.id, amountWon: Number(amount), idempotencyKey: key });
  console.log(JSON.stringify({ mode: 'sandbox', transactionId: result.transfer.id, balanceWon: result.balanceWon }));
} finally { store.close(); }
