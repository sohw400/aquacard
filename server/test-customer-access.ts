import { CustomerAccessStore } from './customer-access';
import type { Database } from './database';

/** Explicit test fixture approval through the owner connection, never through signup or a runtime role. */
export async function approveTestCustomer(ownerDatabase: Database, userId: string) {
  return new CustomerAccessStore(ownerDatabase).transition({
    userId,
    status: 'active',
    expectedVersion: 1,
    idempotencyKey: `fixture-approval:${userId}`,
    reason: 'Sandbox test approval for fixture only',
  });
}
