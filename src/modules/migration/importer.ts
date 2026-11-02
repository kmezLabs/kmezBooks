// Importing analysed QuickBooks history into the open company (MG-1 to MG-6).
//
// A run happens in one savepoint: accounts, customers and vendors, an opening
// entry for balances before the first period, every transaction through
// postEntry(), then the tie-out against QuickBooks's own reports. A dry run
// (MG-4) does all of it, so the schema checks every entry, and then rolls
// back. A real run commits only when there are no errors and the tie-out
// matches, unless the owner accepts the differences; otherwise it too rolls
// back and the company is as it was (MG-6).

import { accountFullNames, createAccount, setAccountActive } from '../../ledger/accounts';
import { trialBalance } from '../../ledger/balances';
import { postEntry, type EntryLineInput } from '../../ledger/postEntry';
import {
  detailType as detailTypeInfo,
  isDebitNormal,
  type AccountType,
} from '../../shared/accounts';
import { fromRule } from '../../worker/errors';
import type { Database } from '../../worker/sqlite';
import { resolveStatementName, type Analysis, type QboAccount } from './analysis';

export type AccountTarget =
  | { kind: 'new'; type: AccountType | null; detailType: string | null }
  | { kind: 'existing'; accountId: string };

/** QuickBooks account full name → what it becomes here. */
export type AccountChoices = Record<string, AccountTarget>;

export interface TieOutRow {
  account: string;
  /** Debit minus credit, except Net Income (profit positive) */
  qbo: number;
  ours: number;
}

export interface TieOutCheck {
  report: 'Trial Balance' | 'Balance Sheet';
  asOf: string;
  /** QuickBooks ran it for "All Dates": income and expenses since the start (MG-11) */
  allDates: boolean;
  file: string;
  /** Accounts compared */
  checked: number;
  differences: TieOutRow[];
}

export interface TieOut {
  ok: boolean;
  checks: TieOutCheck[];
}

export interface ImportCounts {
  accountsCreated: number;
  customers: number;
  vendors: number;
  entries: number;
}

export interface ImportResult {
  committed: boolean;
  errors: string[];
  counts: ImportCounts;
  tieOut: TieOut | null;
}

export interface ImportOptions {
  commit: boolean;
  /** Commit even though the tie-out shows differences */
  acceptDifferences?: boolean;
  onProgress?: (done: number, total: number) => void;
}

const MAX_ERRORS = 50;

/**
 * The default for each QuickBooks account: an existing account with the same
 * full name, the existing one-per-company account of the same kind (Retained
 * Earnings…), or a new account of QuickBooks's type.
 */
export function proposeChoices(db: Database, accounts: QboAccount[]): AccountChoices {
  const existing = new Map<string, string>();
  for (const [id, name] of accountFullNames(db)) existing.set(name.toLowerCase(), id);
  const special = new Map(
    db
      .selectArrays(
        `SELECT detail_type, id FROM account
         WHERE detail_type IN ('retained_earnings', 'opening_balance_equity', 'undeposited_funds')`,
      )
      .map((r) => [String(r[0]), String(r[1])]),
  );
  const out: AccountChoices = {};
  for (const a of accounts) {
    const same = existing.get(a.name.toLowerCase()) ?? (a.detailType && special.get(a.detailType));
    out[a.name] = same
      ? { kind: 'existing', accountId: same }
      : { kind: 'new', type: a.type, detailType: a.detailType };
  }
  return out;
}

/** Problems with the owner's choices that would stop the import. */
export function checkChoices(db: Database, analysis: Analysis, choices: AccountChoices): string[] {
  const problems: string[] = [];
  const types = new Map(
    db.selectArrays('SELECT id, type FROM account').map((r) => [String(r[0]), String(r[1])]),
  );
  for (const a of analysis.summary.accounts) {
    const c = choices[a.name];
    if (!c) {
      problems.push(`Account ${a.name}: choose what it becomes.`);
    } else if (c.kind === 'existing') {
      if (!types.has(c.accountId))
        problems.push(`Account ${a.name}: that account no longer exists.`);
    } else {
      const info = c.detailType ? detailTypeInfo(c.detailType) : undefined;
      if (!c.type) problems.push(`Account ${a.name}: choose a type.`);
      else if (!info || info.type !== c.type) {
        problems.push(`Account ${a.name}: choose a detail type that fits its type.`);
      }
      const parent = a.parent ? choices[a.parent] : undefined;
      const parentType =
        parent?.kind === 'new' ? parent.type : parent ? types.get(parent.accountId) : undefined;
      if (parent && c.type && parentType && parentType !== c.type) {
        problems.push(`Account ${a.name}: a sub-account must have the same type as ${a.parent}.`);
      }
    }
  }
  return problems;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Run the import; see the top of this file. */
export function runImport(
  db: Database,
  analysis: Analysis,
  choices: AccountChoices,
  opts: ImportOptions,
): ImportResult {
  const counts: ImportCounts = { accountsCreated: 0, customers: 0, vendors: 0, entries: 0 };
  const blocking = [...analysis.summary.errors, ...checkChoices(db, analysis, choices)];
  if (blocking.length) return { committed: false, errors: blocking, counts, tieOut: null };

  const errors: string[] = [];
  const fail = (text: string) => {
    if (errors.length < MAX_ERRORS) errors.push(text);
    else if (errors.length === MAX_ERRORS) errors.push('…and more.');
  };
  const runId = crypto.randomUUID();
  let tieOut: TieOut | null = null;
  let committed = false;

  db.exec('SAVEPOINT qbo_import');
  try {
    db.exec({
      sql: `INSERT INTO qbo_import_run (id, company_id) VALUES (?, (SELECT id FROM company))`,
      bind: [runId],
    });

    // ---- accounts, parents first ----
    const ids = new Map<string, string>();
    const typeOf = new Map(
      db
        .selectArrays('SELECT id, type FROM account')
        .map((r) => [String(r[0]), r[1] as AccountType]),
    );
    const ordered = [...analysis.summary.accounts].sort(
      (a, b) => a.name.split(':').length - b.name.split(':').length || a.name.localeCompare(b.name),
    );
    for (const a of ordered) {
      const c = choices[a.name]!;
      if (c.kind === 'existing') {
        ids.set(a.name, c.accountId);
        continue;
      }
      try {
        const id = createAccount(db, {
          name: a.leaf,
          number: a.number,
          type: c.type!,
          detailType: c.detailType!,
          parentId: a.parent ? (ids.get(a.parent) ?? null) : null,
          description: a.description,
        });
        ids.set(a.name, id);
        typeOf.set(id, c.type!);
        counts.accountsCreated++;
      } catch (e) {
        fail(`Account ${a.name}: ${message(e)}`);
      }
    }

    // ---- customers and vendors (MG-1), into the payee list (GL-11) ----
    // One name is one payee: a vendor with a customer's name is both
    for (const [list, flag] of [
      [analysis.customers, 'is_customer'],
      [analysis.vendors, 'is_vendor'],
    ] as const) {
      for (const c of list) {
        db.exec({
          sql: `INSERT INTO payee (id, company_id, name, ${flag}, contact_name, email, phone, address,
                                   shipping_address, account_number)
                VALUES (?, (SELECT id FROM company), ?, 1, ?, ?, ?, ?, ?, ?)
                ON CONFLICT DO UPDATE SET ${flag} = 1,
                  contact_name = coalesce(contact_name, excluded.contact_name),
                  email = coalesce(email, excluded.email), phone = coalesce(phone, excluded.phone),
                  address = coalesce(address, excluded.address),
                  shipping_address = coalesce(shipping_address, excluded.shipping_address),
                  account_number = coalesce(account_number, excluded.account_number)
                WHERE ${flag} = 0`,
          bind: [
            crypto.randomUUID(),
            c.name.trim().replace(/\s+/g, ' '),
            c.contactName,
            c.email,
            c.phone,
            c.address,
            c.shippingAddress,
            c.accountNumber,
          ],
        });
        if (db.changes()) counts[flag === 'is_customer' ? 'customers' : 'vendors']++;
      }
    }

    // ---- entries ----
    const record = db.prepare(
      `INSERT INTO qbo_entry (entry_id, company_id, run_id, txn_type, source)
       VALUES (?, (SELECT id FROM company), ?, ?, ?)`,
    );
    try {
      const post = (
        source: string,
        type: string,
        entry: { date: string; ref: string | null; name: string | null; memo: string | null },
        lines: EntryLineInput[],
      ) => {
        try {
          const id = postEntry(db, {
            ...entry,
            sourceType: 'qbo_migration',
            sourceId: runId,
            lines,
          });
          record.bind([id, runId, type, source]).stepReset();
          counts.entries++;
        } catch (e) {
          fail(`${source}: ${message(e)}`);
        }
      };

      if (analysis.opening && !errors.length) {
        const net = new Map<string, number>();
        for (const [name, value] of analysis.opening.balances) {
          const id = ids.get(name)!;
          const signed =
            analysis.opening.kind === 'net' || isDebitNormal(typeOf.get(id)!) ? value : -value;
          net.set(id, (net.get(id) ?? 0) + signed);
        }
        const lines = [...net]
          .filter(([, v]) => v !== 0)
          .map(([accountId, v]) => ({
            accountId,
            debit: v > 0 ? v : 0,
            credit: v < 0 ? -v : 0,
          }));
        if (lines.length) {
          post(
            'Balances before the first period',
            'Opening balances',
            {
              date: analysis.opening.date,
              ref: null,
              name: null,
              memo: 'Balances brought forward from QuickBooks Online',
            },
            lines,
          );
        }
      }

      const total = analysis.transactions.length;
      if (!errors.length) {
        analysis.transactions.forEach((t, i) => {
          const memo = t.lines[0]?.memo ?? null;
          post(
            t.source,
            t.type,
            { date: t.date, ref: t.num, name: t.name, memo },
            t.lines.map((l) => ({
              accountId: ids.get(l.account)!,
              debit: l.debit,
              credit: l.credit,
              memo: l.memo === memo ? null : l.memo,
              name: l.name === t.name ? null : l.name,
            })),
          );
          if (i % 500 === 499) opts.onProgress?.(i + 1, total);
        });
        opts.onProgress?.(total, total);
      }
    } finally {
      record.finalize();
    }

    // Accounts QuickBooks shows as deleted keep their history and take no new postings
    for (const a of analysis.summary.accounts) {
      if (a.deleted && choices[a.name]?.kind === 'new' && ids.has(a.name)) {
        setAccountActive(db, ids.get(a.name)!, false);
      }
    }

    if (!errors.length) tieOut = computeTieOut(db, analysis, ids);
    const ok = !errors.length && !!tieOut && (tieOut.ok || !!opts.acceptDifferences);
    if (opts.commit && ok) {
      db.exec({
        sql: `UPDATE qbo_import_run SET status = 'done', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), summary = ? WHERE id = ?`,
        bind: [
          JSON.stringify({
            company: analysis.summary.company,
            files: analysis.summary.files.filter((f) => f.kind).map((f) => f.path),
            periods: analysis.summary.periods.map((p) => `${p.from}..${p.to}`),
            ...counts,
            tieOut: tieOut!.ok ? 'matched' : 'differences accepted',
          }),
          runId,
        ],
      });
      db.exec('RELEASE qbo_import');
      committed = true;
    }
  } catch (e) {
    throw fromRule(e);
  } finally {
    if (!committed) {
      db.exec('ROLLBACK TO qbo_import');
      db.exec('RELEASE qbo_import');
    }
  }
  return { committed, errors, counts, tieOut };
}

/**
 * Compare our books with QuickBooks's own cash-basis reports (MG-5): every
 * trial balance account by account, and the latest balance sheet line by line
 * with its net income.
 */
export function computeTieOut(db: Database, analysis: Analysis, ids: Map<string, string>): TieOut {
  const names = accountFullNames(db);
  const types = new Map(
    db.selectArrays('SELECT id, type FROM account').map((r) => [String(r[0]), r[1] as AccountType]),
  );
  const RE = 'retained earnings (no account)';
  const ours = (asOf: string, since?: string) => {
    const out = new Map<string, number>();
    for (const r of trialBalance(db, asOf, since).rows)
      out.set(r.accountId ?? RE, r.debit - r.credit);
    return out;
  };
  const label = (key: string) => names.get(key) ?? key;
  const compare = (qbo: Map<string, number>, mine: Map<string, number>, keys: Set<string>) => {
    const differences: TieOutRow[] = [];
    for (const k of keys) {
      const q = qbo.get(k) ?? 0;
      const o = mine.get(k) ?? 0;
      if (q !== o) differences.push({ account: label(k), qbo: q, ours: o });
    }
    return differences.sort((a, b) => a.account.localeCompare(b.account));
  };

  const checks: TieOutCheck[] = [];
  for (const tb of [...analysis.trialBalances].sort((a, b) => a.asOf.localeCompare(b.asOf))) {
    const qbo = new Map<string, number>();
    for (const [name, v] of tb.balances) {
      const k = ids.get(name) ?? name;
      qbo.set(k, (qbo.get(k) ?? 0) + v);
    }
    const mine = ours(tb.asOf, tb.since);
    const keys = new Set([...qbo.keys(), ...mine.keys()]);
    checks.push({
      report: 'Trial Balance',
      asOf: tb.asOf,
      allDates: !!tb.since,
      file: tb.file,
      checked: keys.size,
      differences: compare(qbo, mine, keys),
    });
  }

  const bs = analysis.balanceSheet;
  if (bs) {
    const known = new Set(ids.keys());
    const qbo = new Map<string, number>();
    const NET_INCOME = 'Net Income';
    for (const line of bs.lines) {
      const name = resolveStatementName(line, known);
      if (name) {
        const k = ids.get(name)!;
        // Assets show debit-positive; liabilities and equity credit-positive
        const net = types.get(k) === 'asset' ? line.cents : -line.cents;
        qbo.set(k, (qbo.get(k) ?? 0) + net);
      } else if (line.label.toLowerCase() === 'net income') {
        qbo.set(NET_INCOME, (qbo.get(NET_INCOME) ?? 0) + line.cents);
      } else {
        qbo.set(line.label, (qbo.get(line.label) ?? 0) + line.cents);
      }
    }
    const mine = new Map<string, number>();
    let netIncome = 0;
    for (const [k, v] of ours(bs.asOf, bs.since)) {
      const type = types.get(k);
      if (type === 'income' || type === 'expense') netIncome -= v;
      else mine.set(k, v);
    }
    if (netIncome !== 0 || qbo.has(NET_INCOME)) mine.set(NET_INCOME, netIncome);
    const keys = new Set([...qbo.keys(), ...mine.keys()]);
    checks.push({
      report: 'Balance Sheet',
      asOf: bs.asOf,
      allDates: !!bs.since,
      file: bs.file,
      checked: keys.size,
      differences: compare(qbo, mine, keys),
    });
  }
  return { ok: checks.every((c) => c.differences.length === 0), checks };
}
