import { databaseFromEnvironment } from './database';
import { verifyMigrations } from './migrations';
import { LedgerStore } from './ledger';

const [email, amount, key, ...extra] = process.argv.slice(2);
if (process.env.NODE_ENV === 'production') throw new Error('Test credit is disabled in production.');
if (!email || !amount || !key || extra.length || !/^\d+$/.test(amount) || !Number.isSafeInteger(Number(amount))) {
  throw new Error('Usage: npm run server:credit -- <email> <integer test won> <idempotency key>');
}
const database = await databaseFromEnvironment();
try {
  await verifyMigrations(database);
  const store = new LedgerStore(database);
  const user = await store.getUserByEmail(email.trim().toLowerCase());
  if (!user) throw new Error('Create this test account in the server app first.');
  const result = await store.creditSandbox({ userId: user.id, amountWon: Number(amount), idempotencyKey: key });
  console.log(JSON.stringify({ mode: 'sandbox', transactionId: result.transfer.id, balanceWon: result.balanceWon }));
} finally { await database.close(); }
