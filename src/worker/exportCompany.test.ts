import { strFromU8, unzipSync } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';
import { newLedgerDb, post } from '../../db/tests/ledgerTestDb';
import { voidEntry } from '../ledger/postEntry';
import { exportArchive, journalCsv, safeName, toCsv } from './exportCompany';
import type { Database } from './sqlite';

let db: Database;
beforeEach(async () => {
  db = await newLedgerDb();
});

const meta = { company: 'Acme LLC', exportedAt: '2026-10-28T12:00:00.000Z', schema: 14 };

describe('full export (Portability, M8)', () => {
  it('writes CSV that spreadsheets read back: quotes, commas, line breaks, blanks', () => {
    expect(
      toCsv(
        ['a', 'b', 'c'],
        [
          ['x, y', 'say "hi"', null],
          [1, 'two\nlines', ' pad'],
        ],
      ),
    ).toBe('a,b,c\r\n"x, y","say ""hi""",\r\n1,"two\nlines"," pad"\r\n');
  });

  it('lists every journal line with its account and dollars, void entries marked', () => {
    post(db, '2026-01-05', 'Utilities', 'Checking', 45_10, { name: 'City Power', ref: '1042' });
    const v = post(db, '2026-01-06', 'Meals', 'Checking', 12_00, { memo: 'Lunch, team' });
    voidEntry(db, v, 'Duplicate');
    const lines = journalCsv(db).trimEnd().split('\r\n');
    expect(lines[0]).toBe(
      'Entry,Date,Ref,Payee,Memo,Status,Source,Line,Account number,Account,Account type,Debit,Credit,Line memo,Line payee',
    );
    expect(lines.slice(1)).toEqual([
      '1,2026-01-05,1042,City Power,,posted,journal,1,,Utilities,expense,45.10,,,',
      '1,2026-01-05,1042,City Power,,posted,journal,2,,Checking,asset,,45.10,,',
      '2,2026-01-06,,,"Lunch, team",void,journal,1,,Meals,expense,12.00,,,',
      '2,2026-01-06,,,"Lunch, team",void,journal,2,,Checking,asset,,12.00,,',
    ]);
  });

  it('puts every table, the journal, the attachments and a README in one zip', () => {
    post(db, '2026-01-05', 'Utilities', 'Checking', 45_10, { name: 'City Power' });
    const zip = unzipSync(
      exportArchive(
        db,
        [
          {
            path: 'attachments/journal_entry 1/receipt.pdf',
            bytes: new Uint8Array([37, 80, 68, 70]),
          },
        ],
        ['lost.png (journal_entry 9): missing'],
        meta,
      ),
    );
    const tables = db
      .selectValues(
        `SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      .map(String);
    for (const t of tables) expect(Object.keys(zip), t).toContain(`tables/${t}.csv`);
    expect(zip['attachments/journal_entry 1/receipt.pdf']).toEqual(
      new Uint8Array([37, 80, 68, 70]),
    );

    const json = JSON.parse(strFromU8(zip['company.json']!)) as {
      company: string;
      tables: Record<string, Record<string, unknown>[]>;
    };
    expect(json.company).toBe('Acme LLC');
    for (const t of tables) {
      expect(json.tables[t]!.length, t).toBe(Number(db.selectValue(`SELECT count(*) FROM "${t}"`)));
    }
    expect(json.tables.journal_line![0]).toMatchObject({ debit: 45_10, credit: 0 });

    const accounts = strFromU8(zip['tables/account.csv']!).split('\r\n');
    expect(accounts[0]).toMatch(/^id,company_id,number,name,/);
    expect(strFromU8(zip['journal.csv']!)).toContain('City Power');
    const readme = strFromU8(zip['README.txt']!);
    expect(readme).toContain('NOT ENCRYPTED');
    expect(readme).toContain('lost.png (journal_entry 9): missing');
  });

  it('makes file names safe on every system', () => {
    expect(safeName('Acme: "Books" 2026/27?')).toBe('Acme_ _Books_ 2026_27_');
    expect(safeName('  ')).toBe('file');
  });
});
