// The UI's handle on the SQLite worker. All database and file access goes
// through here (CLAUDE.md rule 6).

import * as Comlink from 'comlink';
import type { WorkerApi } from '../worker/db.worker';

export const db = Comlink.wrap<WorkerApi>(
  new Worker(new URL('../worker/db.worker.ts', import.meta.url), { type: 'module' }),
);

/** Errors from the worker arrive as plain Errors; `name` identifies the kind (src/worker/errors.ts). */
export function errorName(e: unknown): string {
  return e instanceof Error ? e.name : 'Error';
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
