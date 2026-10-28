// Payees (GL-11): one list of the names on transactions, unique ignoring
// case, as QuickBooks keeps it. A payee can be a customer (AR-1), a vendor
// (AP-1), both, or just a name. postEntry() turns an entry's name into its
// payee, adding a new one on first use, so every module keeps passing names.
// Renaming a payee renames it on every entry and line; merging moves one
// payee's entries to another. The schema lets a posted entry's name change
// only with its payee, and audits each change (migration 0014).

import { LedgerRuleError } from '../worker/errors';
import type { Database } from '../worker/sqlite';
import { inSavepoint } from './tx';

export type PayeeKind = 'all' | 'customers' | 'vendors' | 'other';

export interface PayeeInput {
  name: string;
  isCustomer: boolean;
  isVendor: boolean;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  /** Billing address for a customer, address for a vendor */
  address: string | null;
  shippingAddress: string | null;
  accountNumber: string | null;
  termsDays: number | null;
  /** The category a vendor's expenses usually go to (AP-1) */
  defaultAccountId: string | null;
  is1099: boolean;
  notes: string | null;
  active: boolean;
}

export interface Payee extends PayeeInput {
  id: string;
  /** Posted entries and lines that name it */
  uses: number;
  lastUsed: string | null;
}

export const blankPayee = (name = ''): PayeeInput => ({
  name,
  isCustomer: false,
  isVendor: false,
  contactName: null,
  email: null,
  phone: null,
  address: null,
  shippingAddress: null,
  accountNumber: null,
  termsDays: null,
  defaultAccountId: null,
  is1099: false,
  notes: null,
  active: true,
});

const text = (v: unknown) => (v === null || v === undefined ? null : String(v));

const payee = (r: Record<string, unknown>): Payee => ({
  id: String(r.id),
  name: String(r.name),
  isCustomer: r.is_customer === 1,
  isVendor: r.is_vendor === 1,
  contactName: text(r.contact_name),
  email: text(r.email),
  phone: text(r.phone),
  address: text(r.address),
  shippingAddress: text(r.shipping_address),
  accountNumber: text(r.account_number),
  termsDays: r.terms_days === null ? null : Number(r.terms_days),
  defaultAccountId: text(r.default_account_id),
  is1099: r.is_1099 === 1,
  notes: text(r.notes),
  active: r.active === 1,
  uses: Number(r.uses ?? 0),
  lastUsed: text(r.last_used),
});

const SELECT = `
  SELECT p.*, coalesce(u.uses, 0) AS uses, u.last_used
  FROM payee p
  LEFT JOIN (
    SELECT payee_id, count(*) AS uses, max(date) AS last_used FROM (
      SELECT e.payee_id, e.date FROM journal_entry e WHERE e.status = 'posted' AND e.payee_id IS NOT NULL
      UNION ALL
      SELECT l.payee_id, e.date FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
      WHERE e.status = 'posted' AND l.payee_id IS NOT NULL
    ) GROUP BY payee_id
  ) u ON u.payee_id = p.id`;

export function listPayees(
  db: Database,
  opts: { kind?: PayeeKind; search?: string; includeInactive?: boolean } = {},
): Payee[] {
  const where: string[] = [];
  const bind: (string | number)[] = [];
  if (!opts.includeInactive) where.push('p.active = 1');
  if (opts.kind === 'customers') where.push('p.is_customer = 1');
  if (opts.kind === 'vendors') where.push('p.is_vendor = 1');
  if (opts.kind === 'other') where.push('p.is_customer = 0 AND p.is_vendor = 0');
  const search = opts.search?.trim();
  if (search) {
    where.push(
      `(p.name LIKE ? ESCAPE '\\' OR p.contact_name LIKE ? ESCAPE '\\' OR p.email LIKE ? ESCAPE '\\')`,
    );
    const like = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    bind.push(like, like, like);
  }
  return db
    .selectObjects(
      `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.name COLLATE NOCASE`,
      bind.length ? bind : undefined,
    )
    .map(payee);
}

export function getPayee(db: Database, id: string): Payee {
  const r = db.selectObjects(`${SELECT} WHERE p.id = ?`, [id])[0];
  if (!r) throw new LedgerRuleError('That payee no longer exists.');
  return payee(r);
}

/**
 * The category a payee's expenses usually go to (AP-1), for a name typed in
 * a form: an active account, or null.
 */
export function defaultCategoryFor(db: Database, name: string): string | null {
  const clean = name.trim().replace(/\s+/g, ' ');
  if (!clean) return null;
  const id = db.selectValue(
    `SELECT p.default_account_id FROM payee p JOIN account a ON a.id = p.default_account_id AND a.active = 1
     WHERE p.name = ? COLLATE NOCASE`,
    [clean],
  );
  return id === undefined || id === null ? null : String(id);
}

/** Active payee names, for the name fields' suggestions. */
export function payeeNames(db: Database): string[] {
  return db
    .selectValues(`SELECT name FROM payee WHERE active = 1 ORDER BY name COLLATE NOCASE`)
    .map(String);
}

/**
 * The payee for a name on an entry, added on first use. The name is matched
 * ignoring case and extra spaces, and comes back as the payee spells it.
 */
export function payeeFor(
  db: Database,
  name: string | null | undefined,
): { id: string; name: string } | null {
  const clean = name?.trim().replace(/\s+/g, ' ');
  if (!clean) return null;
  const found = db.selectObjects(`SELECT id, name FROM payee WHERE name = ? COLLATE NOCASE`, [
    clean,
  ])[0];
  if (found) return { id: String(found.id), name: String(found.name) };
  const id = crypto.randomUUID();
  db.exec({
    sql: `INSERT INTO payee (id, company_id, name) VALUES (?, (SELECT id FROM company), ?)`,
    bind: [id, clean],
  });
  return { id, name: clean };
}

function problems(db: Database, input: PayeeInput, id: string | null): string[] {
  const out: string[] = [];
  const name = input.name.trim();
  if (!name) out.push('Give the payee a name.');
  const clash = db.selectValue(
    `SELECT name FROM payee WHERE name = ? COLLATE NOCASE AND id IS NOT ?`,
    [name, id],
  );
  if (clash !== undefined) {
    out.push(
      `There is already a payee named ${String(clash)}. To bring the two together, merge them.`,
    );
  }
  if (
    input.termsDays !== null &&
    (!Number.isInteger(input.termsDays) || input.termsDays < 0 || input.termsDays > 365)
  ) {
    out.push('Terms are a number of days from 0 to 365.');
  }
  if (input.email && !/^[^\s@]+@[^\s@]+$/.test(input.email.trim()))
    out.push('Enter a valid email address.');
  return out;
}

const fields = (input: PayeeInput) => [
  input.name.trim().replace(/\s+/g, ' '),
  input.isCustomer ? 1 : 0,
  input.isVendor ? 1 : 0,
  input.contactName?.trim() || null,
  input.email?.trim() || null,
  input.phone?.trim() || null,
  input.address?.trim() || null,
  input.shippingAddress?.trim() || null,
  input.accountNumber?.trim() || null,
  input.termsDays,
  input.defaultAccountId || null,
  input.is1099 ? 1 : 0,
  input.notes?.trim() || null,
  input.active ? 1 : 0,
];

export function createPayee(db: Database, input: PayeeInput): string {
  const p = problems(db, input, null);
  if (p.length) throw new LedgerRuleError(p.join(' '));
  const id = crypto.randomUUID();
  db.exec({
    sql: `INSERT INTO payee (id, company_id, name, is_customer, is_vendor, contact_name, email, phone,
                             address, shipping_address, account_number, terms_days, default_account_id,
                             is_1099, notes, active)
          VALUES (?, (SELECT id FROM company), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bind: [id, ...fields(input)],
  });
  return id;
}

/** Entries, lines and bank rules that name a payee take its new name. */
function renameEverywhere(db: Database, id: string, oldName: string, newName: string) {
  db.exec({
    sql: `UPDATE journal_entry SET name = ? WHERE payee_id = ? AND name IS NOT ?`,
    bind: [newName, id, newName],
  });
  db.exec({
    sql: `UPDATE journal_line SET name = ? WHERE payee_id = ? AND name IS NOT ?`,
    bind: [newName, id, newName],
  });
  db.exec({
    sql: `UPDATE bank_rule SET payee = ? WHERE payee = ? COLLATE NOCASE`,
    bind: [newName, oldName],
  });
}

/** Save a payee's record; a new name is the payee's name on every transaction from now on. */
export function updatePayee(db: Database, id: string, input: PayeeInput): void {
  inSavepoint(db, 'payee_update', () => {
    const before = getPayee(db, id);
    const p = problems(db, input, id);
    if (p.length) throw new LedgerRuleError(p.join(' '));
    db.exec({
      sql: `UPDATE payee SET name = ?, is_customer = ?, is_vendor = ?, contact_name = ?, email = ?, phone = ?,
                             address = ?, shipping_address = ?, account_number = ?, terms_days = ?,
                             default_account_id = ?, is_1099 = ?, notes = ?, active = ?
            WHERE id = ?`,
      bind: [...fields(input), id],
    });
    const after = getPayee(db, id);
    // Also when only the capitals change; then names imported in other
    // capitals take the payee's too
    if (after.name !== before.name) renameEverywhere(db, id, before.name, after.name);
  });
}

/**
 * Merge one payee into another: its entries, lines and bank rules move to the
 * other, which also becomes a customer or vendor if this one was, and keeps
 * its own details, filling in what it lacks. Then this one is deleted.
 */
export function mergePayee(db: Database, fromId: string, intoId: string): void {
  if (fromId === intoId) throw new LedgerRuleError('Choose another payee to merge into.');
  inSavepoint(db, 'payee_merge', () => {
    const from = getPayee(db, fromId);
    const into = getPayee(db, intoId);
    db.exec({
      sql: `UPDATE payee SET
              is_customer = max(is_customer, ?), is_vendor = max(is_vendor, ?), is_1099 = max(is_1099, ?),
              contact_name = coalesce(contact_name, ?), email = coalesce(email, ?), phone = coalesce(phone, ?),
              address = coalesce(address, ?), shipping_address = coalesce(shipping_address, ?),
              account_number = coalesce(account_number, ?), terms_days = coalesce(terms_days, ?),
              default_account_id = coalesce(default_account_id, ?), notes = coalesce(notes, ?),
              active = 1
            WHERE id = ?`,
      bind: [
        from.isCustomer ? 1 : 0,
        from.isVendor ? 1 : 0,
        from.is1099 ? 1 : 0,
        from.contactName,
        from.email,
        from.phone,
        from.address,
        from.shippingAddress,
        from.accountNumber,
        from.termsDays,
        from.defaultAccountId,
        from.notes,
        intoId,
      ],
    });
    db.exec({
      sql: `UPDATE journal_entry SET payee_id = ?, name = ? WHERE payee_id = ?`,
      bind: [intoId, into.name, fromId],
    });
    db.exec({
      sql: `UPDATE journal_line SET payee_id = ?, name = ? WHERE payee_id = ?`,
      bind: [intoId, into.name, fromId],
    });
    db.exec({
      sql: `UPDATE bank_rule SET payee = ? WHERE payee = ? COLLATE NOCASE`,
      bind: [into.name, from.name],
    });
    db.exec({ sql: `DELETE FROM payee WHERE id = ?`, bind: [fromId] });
  });
}

/** Delete a payee no transaction names (the schema refuses others). */
export function deletePayee(db: Database, id: string): void {
  getPayee(db, id);
  db.exec({ sql: `DELETE FROM payee WHERE id = ?`, bind: [id] });
}
