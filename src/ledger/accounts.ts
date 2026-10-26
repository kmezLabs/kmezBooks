// Chart of accounts (GL-1, GL-2, GL-7). The schema guards the rules; these
// functions add readable messages and the tree view.

import {
  ACCOUNT_TYPES,
  DEFAULT_CHART,
  detailType,
  validateAccount,
  type AccountInput,
  type AccountRow,
  type AccountType,
} from '../shared/accounts';
import { LedgerRuleError } from '../worker/errors';
import type { Database } from '../worker/sqlite';
import { inSavepoint } from './tx';

interface RawAccount {
  id: string;
  number: string | null;
  name: string;
  type: AccountType;
  detailType: string;
  parentId: string | null;
  active: boolean;
  description: string | null;
}

function rawAccounts(db: Database): RawAccount[] {
  return db
    .selectObjects(
      'SELECT id, number, name, type, detail_type, parent_id, active, description FROM account',
    )
    .map((r) => ({
      id: String(r.id),
      number: r.number === null ? null : String(r.number),
      name: String(r.name),
      type: r.type as AccountType,
      detailType: String(r.detail_type),
      parentId: r.parent_id === null ? null : String(r.parent_id),
      active: r.active === 1,
      description: r.description === null ? null : String(r.description),
    }));
}

/** id → "Parent:Child" for every account. */
export function accountFullNames(db: Database): Map<string, string> {
  const all = new Map(rawAccounts(db).map((a) => [a.id, a]));
  const names = new Map<string, string>();
  const full = (a: RawAccount): string => {
    const cached = names.get(a.id);
    if (cached) return cached;
    const parent = a.parentId ? all.get(a.parentId) : undefined;
    const name = parent ? `${full(parent)}:${a.name}` : a.name;
    names.set(a.id, name);
    return name;
  };
  all.forEach(full);
  return names;
}

/** All accounts as a tree (parents before their sub-accounts), by type then name, with posted balances. */
export function listAccounts(db: Database): AccountRow[] {
  const raw = rawAccounts(db);
  const stats = new Map(
    db
      .selectArrays(
        `SELECT l.account_id,
                coalesce(sum(CASE WHEN e.status = 'posted' THEN l.debit - l.credit END), 0),
                count(*)
         FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
         GROUP BY l.account_id`,
      )
      .map((r) => [String(r[0]), { balance: Number(r[1]), lines: Number(r[2]) }]),
  );
  const fullNames = accountFullNames(db);
  const children = new Map<string | null, RawAccount[]>();
  for (const a of raw) {
    const key = a.parentId && raw.some((p) => p.id === a.parentId) ? a.parentId : null;
    children.set(key, [...(children.get(key) ?? []), a]);
  }
  const byName = (x: RawAccount, y: RawAccount) =>
    (x.number ?? '').localeCompare(y.number ?? '', undefined, { numeric: true }) ||
    x.name.localeCompare(y.name, undefined, { sensitivity: 'base' });
  const out: AccountRow[] = [];
  const walk = (a: RawAccount, depth: number) => {
    const s = stats.get(a.id);
    out.push({
      ...a,
      fullName: fullNames.get(a.id) ?? a.name,
      depth,
      balance: s?.balance ?? 0,
      hasHistory: (s?.lines ?? 0) > 0,
    });
    for (const c of (children.get(a.id) ?? []).sort(byName)) walk(c, depth + 1);
  };
  for (const type of ACCOUNT_TYPES) {
    for (const a of (children.get(null) ?? []).filter((x) => x.type === type).sort(byName))
      walk(a, 0);
  }
  return out;
}

function friendly(e: unknown, input: AccountInput): never {
  const message = e instanceof Error ? e.message : String(e);
  if (/UNIQUE constraint failed: account\.company_id, account\.number/.test(message)) {
    throw new LedgerRuleError(`Account number ${input.number} is already in use.`);
  }
  if (/UNIQUE constraint failed: index 'account_name'|account_name/.test(message)) {
    throw new LedgerRuleError(
      `There is already an account called ${input.name.trim()} at this level.`,
    );
  }
  if (/account\.company_id, account\.detail_type/.test(message)) {
    throw new LedgerRuleError(
      `A company can have only one ${detailType(input.detailType)?.name ?? input.detailType} account.`,
    );
  }
  throw e;
}

function checked(input: AccountInput): AccountInput {
  const problems = validateAccount(input);
  if (problems.length) throw new LedgerRuleError(problems.join(' '));
  return {
    ...input,
    name: input.name.trim(),
    number: input.number?.trim() || null,
    description: input.description?.trim() || null,
    parentId: input.parentId || null,
  };
}

export function createAccount(db: Database, input: AccountInput): string {
  const a = checked(input);
  const id = crypto.randomUUID();
  try {
    inSavepoint(db, 'create_account', () =>
      db.exec({
        sql: `INSERT INTO account (id, company_id, number, name, type, detail_type, parent_id, description)
              VALUES (?, (SELECT id FROM company), ?, ?, ?, ?, ?, ?)`,
        bind: [
          id,
          a.number ?? null,
          a.name,
          a.type,
          a.detailType,
          a.parentId ?? null,
          a.description ?? null,
        ],
      }),
    );
  } catch (e) {
    friendly(e, a);
  }
  return id;
}

export function updateAccount(db: Database, id: string, input: AccountInput): void {
  const a = checked(input);
  try {
    inSavepoint(db, 'update_account', () =>
      db.exec({
        sql: `UPDATE account SET number = ?, name = ?, type = ?, detail_type = ?, parent_id = ?, description = ?
              WHERE id = ?`,
        bind: [
          a.number ?? null,
          a.name,
          a.type,
          a.detailType,
          a.parentId ?? null,
          a.description ?? null,
          id,
        ],
      }),
    );
  } catch (e) {
    friendly(e, a);
  }
}

/** Inactive accounts keep their history and take no new postings (GL-7). */
export function setAccountActive(db: Database, id: string, active: boolean): void {
  inSavepoint(db, 'account_active', () =>
    db.exec({ sql: 'UPDATE account SET active = ? WHERE id = ?', bind: [active ? 1 : 0, id] }),
  );
}

/** Only an account without transactions or sub-accounts can be deleted (GL-7). */
export function deleteAccount(db: Database, id: string): void {
  inSavepoint(db, 'delete_account', () =>
    db.exec({ sql: 'DELETE FROM account WHERE id = ?', bind: [id] }),
  );
}

/** Add the default US small-business chart (GL-2) to a company that has no accounts. */
export function seedDefaultChart(db: Database): number {
  if (Number(db.selectValue('SELECT count(*) FROM account')) > 0) {
    throw new LedgerRuleError('This company already has accounts.');
  }
  inSavepoint(db, 'seed_chart', () => {
    for (const c of DEFAULT_CHART) {
      const type = detailType(c.detailType)!.type;
      db.exec({
        sql: `INSERT INTO account (id, company_id, name, type, detail_type) VALUES (?, (SELECT id FROM company), ?, ?, ?)`,
        bind: [crypto.randomUUID(), c.name, type, c.detailType],
      });
    }
  });
  return DEFAULT_CHART.length;
}
