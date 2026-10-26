import { fromRule } from '../worker/errors';
import type { Database } from '../worker/sqlite';

/**
 * Run `fn` in a savepoint: its own transaction at top level, or a nested part
 * of a caller's transaction (a document and its entry save together or not at
 * all). Trigger errors come back as readable ledger errors.
 */
export function inSavepoint<T>(db: Database, name: string, fn: () => T): T {
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (e) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw fromRule(e);
  }
}
