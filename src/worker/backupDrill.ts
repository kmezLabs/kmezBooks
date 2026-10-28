// Restore drill (M8, DF-10): open a backup in memory, never in place, and
// check it could stand in for the live company. The database must be sound,
// upgrade to this app's schema, have its attachments, and balance account by
// account with the live books as they stood when the backup was made: an
// entry counts if it was posted by then and not yet voided. Entries changed
// in place or deleted since (GL-6 off) show as differences, with the number
// of changes since the backup, so the owner can see why.

import type { Cents } from '../shared/money';
import { applySchema } from './schema';
import type { Database } from './sqlite';

export interface BalanceDifference {
  account: string;
  backup: Cents;
  live: Cents;
}

export interface BackupCheck {
  legalName: string;
  /** The backup's last recorded activity: the moment it shows the books at */
  asOf: string | null;
  schemaVersion: number;
  /** "ok", or what SQLite's integrity check found */
  integrity: string;
  /** Why upgrading it to this app's schema failed, if it did */
  upgradeError: string | null;
  sameCompany: boolean;
  /** Posted entries in the backup, and in the live books as of asOf */
  entries: number;
  liveEntries: number;
  differences: BalanceDifference[];
  /** Audit events in the live company after asOf */
  changesSince: number;
  attachments: number;
  missingAttachments: string[];
  ok: boolean;
}

const hasTable = (db: Database, name: string) =>
  Number(
    db.selectValue(`SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = ?`, [name]),
  ) > 0;

function balances(db: Database, where: string, bind?: Record<string, string>): Map<string, number> {
  return new Map(
    db
      .selectArrays(
        `SELECT l.account_id, sum(l.debit - l.credit) FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id
         WHERE ${where} GROUP BY l.account_id`,
        bind,
      )
      .map((r) => [String(r[0]), Number(r[1])]),
  );
}

function accountNames(db: Database): Map<string, string> {
  const rows = db.selectObjects('SELECT id, name, parent_id FROM account');
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const full = (id: string): string => {
    const r = byId.get(id);
    if (!r) return id;
    return r.parent_id === null ? String(r.name) : `${full(String(r.parent_id))}:${String(r.name)}`;
  };
  return new Map([...byId.keys()].map((id) => [id, full(id)]));
}

/**
 * Compare a backup, loaded in memory, with the live company. The backup's
 * database is upgraded in memory as part of the check, so it can't be used
 * afterwards; `attachmentFound` says whether an attachment's file exists.
 */
export async function checkBackup(
  backup: Database,
  live: Database,
  attachmentFound: (id: string) => Promise<boolean>,
): Promise<BackupCheck> {
  const integrity = String(backup.selectValue('PRAGMA integrity_check'));
  const company = backup.selectObjects('SELECT id, legal_name FROM company')[0];
  const sameCompany = String(company?.id) === String(live.selectValue('SELECT id FROM company'));
  const schemaVersion = Number(backup.selectValue('PRAGMA user_version'));
  const asOf = hasTable(backup, 'audit_event')
    ? ((backup.selectValue('SELECT max(at) FROM audit_event') as string | null) ?? null)
    : null;

  const inBackup = balances(backup, `e.status = 'posted'`);
  const inLive = asOf
    ? balances(
        live,
        `e.posted_at <= :at AND (e.status = 'posted' OR (e.status = 'void' AND e.voided_at > :at))`,
        { ':at': asOf },
      )
    : new Map<string, number>();
  const names = accountNames(live);
  const backupNames = accountNames(backup);
  const differences: BalanceDifference[] = [];
  for (const id of new Set([...inBackup.keys(), ...inLive.keys()])) {
    const b = inBackup.get(id) ?? 0;
    const l = inLive.get(id) ?? 0;
    if (b !== l) {
      differences.push({ account: names.get(id) ?? backupNames.get(id) ?? id, backup: b, live: l });
    }
  }
  differences.sort((x, y) => x.account.localeCompare(y.account));

  const entries = Number(
    backup.selectValue(`SELECT count(*) FROM journal_entry WHERE status = 'posted'`),
  );
  const liveEntries = asOf
    ? Number(
        live.selectValue(
          `SELECT count(*) FROM journal_entry e
           WHERE e.posted_at <= ? AND (e.status = 'posted' OR (e.status = 'void' AND e.voided_at > ?))`,
          [asOf, asOf],
        ),
      )
    : 0;
  const changesSince = asOf
    ? Number(live.selectValue('SELECT count(*) FROM audit_event WHERE at > ?', [asOf]))
    : 0;

  const attachmentRows = hasTable(backup, 'attachment')
    ? backup.selectObjects('SELECT id, file_name FROM attachment ORDER BY added_at')
    : [];
  const missingAttachments: string[] = [];
  for (const a of attachmentRows) {
    if (!(await attachmentFound(String(a.id)))) missingAttachments.push(String(a.file_name));
  }

  // Last: bring it to this app's schema, as opening it after a restore would
  let upgradeError: string | null = null;
  try {
    applySchema(backup);
  } catch (e) {
    upgradeError = e instanceof Error ? e.message : String(e);
  }

  return {
    legalName: String(company?.legal_name ?? ''),
    asOf,
    schemaVersion,
    integrity,
    upgradeError,
    sameCompany,
    entries,
    liveEntries,
    differences,
    changesSince,
    attachments: attachmentRows.length,
    missingAttachments,
    ok:
      integrity === 'ok' &&
      !upgradeError &&
      sameCompany &&
      differences.length === 0 &&
      missingAttachments.length === 0,
  };
}
