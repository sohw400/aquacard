import { closeSync, constants, lstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { IssuerCardStatus } from './issuer-outbox';

type LocalCommand = { requestKey: string; cardRef: string; targetStatus: IssuerCardStatus; expiresAt: number };
type StoredCommand = LocalCommand & { applied: number };

function receipt(command: StoredCommand) {
  const { requestKey, cardRef } = command;
  return command.applied
    ? { requestKey, cardRef, status: 'succeeded' as const, cardStatus: command.targetStatus }
    : { requestKey, cardRef, status: 'rejected' as const, code: 'COMMAND_REJECTED' as const };
}

export class LocalStagingIssuerReceipts {
  private readonly db: DatabaseSync;

  constructor(directory: string) {
    if (process.env.NODE_ENV !== 'staging') throw new Error('Local issuer requires staging.');
    const dir = lstatSync(directory);
    if (!dir.isDirectory() || dir.uid !== process.getuid?.() || (dir.mode & 0o077) !== 0) {
      throw new Error('Local issuer requires a private receipt directory.');
    }
    const file = join(directory, 'receipts.sqlite');
    const existing = lstatSync(file, { throwIfNoEntry: false });
    if (existing && (!existing.isFile() || existing.uid !== dir.uid || (existing.mode & 0o077) !== 0)) {
      throw new Error('Invalid local issuer receipt file.');
    }
    if (!existing) closeSync(openSync(file, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600));
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS cards (card_ref TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (
        request_key TEXT PRIMARY KEY, card_ref TEXT NOT NULL, target_status TEXT NOT NULL,
        expires_at INTEGER NOT NULL, applied INTEGER NOT NULL CHECK (applied IN (0, 1))
      );
      CREATE TRIGGER IF NOT EXISTS apply_card_status AFTER INSERT ON operations WHEN NEW.applied = 1
      BEGIN
        INSERT INTO cards (card_ref, status) VALUES (NEW.card_ref, NEW.target_status)
        ON CONFLICT(card_ref) DO UPDATE SET status = excluded.status;
      END;
    `);
  }

  private read(key: string) {
    return this.db.prepare(`SELECT request_key AS requestKey, card_ref AS cardRef, target_status AS targetStatus,
      expires_at AS expiresAt, applied FROM operations WHERE request_key = ?`).get(key) as StoredCommand | undefined;
  }

  lookup(key: string) {
    const operation = this.read(key);
    return operation && receipt(operation);
  }

  apply(command: LocalCommand) {
    const { requestKey, cardRef, targetStatus, expiresAt } = command;
    // Only a newly inserted receipt changes the card, in the very same SQLite transaction.
    this.db.prepare(`INSERT INTO operations (request_key, card_ref, target_status, expires_at, applied)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(request_key) DO NOTHING`).run(requestKey, cardRef, targetStatus, expiresAt, Date.now() < expiresAt ? 1 : 0);
    const operation = this.read(requestKey);
    if (!operation) throw new Error('Local issuer receipt unavailable.');
    if (operation.cardRef !== cardRef || operation.targetStatus !== targetStatus || operation.expiresAt !== expiresAt) return;
    return receipt(operation);
  }

  close() { this.db.close(); }
}
