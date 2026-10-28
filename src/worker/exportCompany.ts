// Full export of a company (Portability, M8): everything in the database as
// CSV and JSON, a plain journal for spreadsheets, and the attachments, in one
// unencrypted .zip. Readable without EasyBooks, so the books are never locked
// in. The decrypted SQLite copy is the database file itself.

import { strToU8, zipSync, type Zippable } from 'fflate';
import { centsToDecimal } from '../shared/money';
import type { Database } from './sqlite';

export interface ExportFile {
  path: string;
  bytes: Uint8Array;
}

function tables(db: Database): string[] {
  return db
    .selectValues(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .map(String);
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s =
    v instanceof Uint8Array
      ? [...v].map((b) => b.toString(16).padStart(2, '0')).join('')
      : String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** Rows as CSV with a header row, CRLF line ends as spreadsheets expect. */
export function toCsv(columns: string[], rows: unknown[][]): string {
  return [columns, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/**
 * Every posted and void journal line with its entry, the account's full name
 * and amounts in dollars: the books in one sheet.
 */
export function journalCsv(db: Database): string {
  const rows = db.selectArrays(
    `WITH RECURSIVE path (id, full_name) AS (
       SELECT id, name FROM account WHERE parent_id IS NULL
       UNION ALL
       SELECT a.id, path.full_name || ':' || a.name FROM account a JOIN path ON a.parent_id = path.id
     )
     SELECT e.id, e.date, e.ref, e.name, e.memo, e.status, e.source_type,
            l.line_no, a.number, path.full_name, a.type, l.debit, l.credit, l.memo, l.name
     FROM journal_entry e
     JOIN journal_line l ON l.entry_id = e.id
     JOIN account a ON a.id = l.account_id
     JOIN path ON path.id = a.id
     WHERE e.status <> 'draft'
     ORDER BY e.date, e.id, l.line_no`,
  );
  return toCsv(
    [
      'Entry',
      'Date',
      'Ref',
      'Payee',
      'Memo',
      'Status',
      'Source',
      'Line',
      'Account number',
      'Account',
      'Account type',
      'Debit',
      'Credit',
      'Line memo',
      'Line payee',
    ],
    rows.map((r) => [
      ...r.slice(0, 11),
      Number(r[11]) ? centsToDecimal(Number(r[11])) : '',
      Number(r[12]) ? centsToDecimal(Number(r[12])) : '',
      r[13],
      r[14],
    ]),
  );
}

function readme(meta: { company: string; exportedAt: string; schema: number }, missing: string[]) {
  return [
    `EasyBooks export of ${meta.company}`,
    `Made ${meta.exportedAt}, company schema version ${meta.schema}.`,
    '',
    'THIS EXPORT IS NOT ENCRYPTED. Anyone with this file can read these books.',
    'Keep it somewhere safe, or delete it when you no longer need it.',
    '',
    'journal.csv     Every journal line, with its entry, the account and amounts in',
    '                dollars. Void entries are included, marked void in Status.',
    'company.json    Every table of the company database, as JSON.',
    'tables/*.csv    The same tables, one CSV file each.',
    'attachments/    The attached files, decrypted, in a folder per journal entry.',
    '',
    'In company.json and tables/, money is in whole cents: 12345 means $123.45.',
    'Debits and credits are separate columns; a line has one or the other.',
    ...(missing.length
      ? [
          '',
          'These attachments could not be read and are not included:',
          ...missing.map((m) => `  ${m}`),
        ]
      : []),
    '',
  ].join('\r\n');
}

/** The whole export as a .zip. */
export function exportArchive(
  db: Database,
  attachments: ExportFile[],
  missing: string[],
  meta: { company: string; exportedAt: string; schema: number },
): Uint8Array {
  const files: Zippable = {};
  const json: Record<string, Record<string, unknown>[]> = {};
  for (const table of tables(db)) {
    const columns = db
      .selectObjects(`SELECT name FROM pragma_table_info(?) ORDER BY cid`, [table])
      .map((r) => String(r.name));
    const rows = db.selectArrays(`SELECT * FROM "${table.replaceAll('"', '""')}"`);
    files[`tables/${table}.csv`] = strToU8(toCsv(columns, rows));
    json[table] = rows.map((r) =>
      Object.fromEntries(
        columns.map((c, i) => [
          c,
          r[i] instanceof Uint8Array
            ? [...(r[i] as Uint8Array)].map((b) => b.toString(16).padStart(2, '0')).join('')
            : r[i],
        ]),
      ),
    );
  }
  files['company.json'] = strToU8(JSON.stringify({ ...meta, tables: json }, null, 1));
  files['journal.csv'] = strToU8(journalCsv(db));
  files['README.txt'] = strToU8(readme(meta, missing));
  for (const a of attachments) files[a.path] = [a.bytes, { level: 0 }];
  return zipSync(files, { level: 6 });
}

/** A name safe on Windows, macOS and Linux. */
export function safeName(name: string): string {
  const clean = [...name]
    .map((ch) => (ch.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(ch) ? '_' : ch))
    .join('');
  return clean.trim() || 'file';
}
