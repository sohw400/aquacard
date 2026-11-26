import { CustomerAccessStore } from './customer-access';
import type { Database } from './database';

/** Explicit disposable-fixture email proof and approval through the owner connection, never through signup. */
export async function approveTestCustomer(ownerDatabase: Database, userId: string) {
  if (process.env.NODE_ENV === 'production') throw new Error('Disposable customer fixtures are disabled in production.');
  await ownerDatabase.query('UPDATE users SET email_verified_at=created_at WHERE id=$1 AND email_verified_at IS NULL', [userId]);
  return new CustomerAccessStore(ownerDatabase).transition({
    userId,
    status: 'active',
    expectedVersion: 1,
    idempotencyKey: `fixture-approval:${userId}`,
    reason: 'Sandbox test approval for fixture only',
  });
}
