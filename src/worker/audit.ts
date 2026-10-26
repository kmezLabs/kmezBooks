// Audit log (US-5). Every table gets AFTER INSERT/UPDATE/DELETE triggers that
// write the row before and after into audit_event, stamped with the user from
// the session row. The triggers are generated from the live schema after each
// migration, so a new table or column is audited without anyone remembering to.

import type { Database } from './sqlite';

const PREFIX = 'audit__';

/**
 * Tables without generated audit triggers: the log itself, the session row,
 * SQLite's own, M1 spike data, and the ledger. Journal entries and lines get
 * compact hand-written triggers instead (migration 0008: one "post" and one
 * "void" event per entry), because full row copies made a 17-year company
 * several times larger than its ledger (M4 benchmark).
 */
export function isAudited(table: string): boolean {
  return (
    table !== 'audit_event' &&
    table !== 'session' &&
    table !== 'journal_entry' &&
    table !== 'journal_line' &&
    !table.startsWith('sqlite_') &&
    !table.startsWith('spike_')
  );
}

interface Column {
  name: string;
  type: string;
  pk: number;
}

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;

function tables(db: Database): string[] {
  return db
    .selectArrays(`SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name`)
    .map((r) => String(r[0]))
    .filter(isAudited);
}

function columns(db: Database, table: string): Column[] {
  return db
    .selectObjects('SELECT name, type, pk FROM pragma_table_info(?) ORDER BY cid', [table])
    .map((r) => ({ name: String(r.name), type: String(r.type).toUpperCase(), pk: Number(r.pk) }));
}

function rowJson(row: 'NEW' | 'OLD', cols: Column[]): string {
  // JSON can't hold BLOBs, so those are logged as hex
  const value = (c: Column) =>
    c.type === 'BLOB' ? `hex(${row}.${quote(c.name)})` : `${row}.${quote(c.name)}`;
  return `json_object(${cols.map((c) => `${literal(c.name)}, ${value(c)}`).join(', ')})`;
}

function rowId(row: 'NEW' | 'OLD', cols: Column[]): string {
  const keys = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
  if (keys.length === 0) return `CAST(${row}.rowid AS TEXT)`;
  return keys.map((c) => `CAST(${row}.${quote(c.name)} AS TEXT)`).join(` || '|' || `);
}

function triggersFor(table: string, cols: Column[]): Map<string, string> {
  const head = `INSERT INTO audit_event (company_id, user_id, action, entity, entity_id, before, after) VALUES ((SELECT id FROM company), (SELECT user_id FROM session WHERE id = 1)`;
  const t = quote(table);
  const name = (op: string) => `${PREFIX}${table}_${op}`;
  return new Map([
    [
      name('insert'),
      `CREATE TRIGGER ${quote(name('insert'))} AFTER INSERT ON ${t} BEGIN ${head}, 'insert', ${literal(table)}, ${rowId('NEW', cols)}, NULL, ${rowJson('NEW', cols)}); END`,
    ],
    [
      name('update'),
      // Skip updates that change nothing
      `CREATE TRIGGER ${quote(name('update'))} AFTER UPDATE ON ${t} WHEN ${rowJson('OLD', cols)} IS NOT ${rowJson('NEW', cols)} BEGIN ${head}, 'update', ${literal(table)}, ${rowId('NEW', cols)}, ${rowJson('OLD', cols)}, ${rowJson('NEW', cols)}); END`,
    ],
    [
      name('delete'),
      `CREATE TRIGGER ${quote(name('delete'))} AFTER DELETE ON ${t} BEGIN ${head}, 'delete', ${literal(table)}, ${rowId('OLD', cols)}, ${rowJson('OLD', cols)}, NULL); END`,
    ],
  ]);
}

function existingTriggers(db: Database): Map<string, string> {
  return new Map(
    db
      .selectArrays(
        `SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND substr(name, 1, ${PREFIX.length}) = ?`,
        [PREFIX],
      )
      .map((r) => [String(r[0]), String(r[1])]),
  );
}

/** Remove all generated audit triggers, so migrations can alter tables freely. */
export function dropAuditTriggers(db: Database): void {
  for (const name of existingTriggers(db).keys()) db.exec(`DROP TRIGGER ${quote(name)}`);
}

/** Bring the generated triggers in line with the current schema. Returns how many changed. */
export function rebuildAuditTriggers(db: Database): number {
  const wanted = new Map<string, string>();
  for (const table of tables(db)) {
    for (const [name, sql] of triggersFor(table, columns(db, table))) wanted.set(name, sql);
  }
  const existing = existingTriggers(db);
  let changed = 0;
  for (const [name, sql] of existing) {
    if (wanted.get(name) !== sql) {
      db.exec(`DROP TRIGGER ${quote(name)}`);
      changed++;
    }
  }
  for (const [name, sql] of wanted) {
    if (existing.get(name) !== sql) {
      db.exec(sql);
      changed++;
    }
  }
  return changed;
}

export type AppAuditAction =
  'create_company' | 'unlock' | 'lock' | 'restore' | 'schema_upgrade' | 'passphrase_change';

/** Record an event that isn't a row change, such as an unlock or a restore. */
export function recordEvent(db: Database, action: AppAuditAction, note?: string): void {
  db.exec({
    sql: `INSERT INTO audit_event (company_id, user_id, action, note)
          VALUES ((SELECT id FROM company), (SELECT user_id FROM session WHERE id = 1), ?, ?)`,
    bind: [action, note ?? null],
  });
}
