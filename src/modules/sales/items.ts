// Products and services (AR-2): what invoice lines usually charge, with a rate
// and the income account the money goes to. No inventory is tracked.

import type { Cents } from '../../shared/money';
import { LedgerRuleError } from '../../worker/errors';
import type { Database } from '../../worker/sqlite';

export interface ItemInput {
  name: string;
  description: string | null;
  /** Price per unit in cents, if it has one */
  rate: Cents | null;
  incomeAccountId: string;
  active: boolean;
}

export interface Item extends ItemInput {
  id: string;
}

const text = (v: unknown) => (v === null || v === undefined ? null : String(v));

const item = (r: Record<string, unknown>): Item => ({
  id: String(r.id),
  name: String(r.name),
  description: text(r.description),
  rate: r.rate === null ? null : Number(r.rate),
  incomeAccountId: String(r.income_account_id),
  active: r.active === 1,
});

export function listItems(db: Database, includeInactive = false): Item[] {
  return db
    .selectObjects(
      `SELECT * FROM item ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY name COLLATE NOCASE`,
    )
    .map(item);
}

function problems(db: Database, input: ItemInput, id: string | null): string[] {
  const out: string[] = [];
  const name = input.name.trim();
  if (!name) out.push('Give the product or service a name.');
  const clash = db.selectValue(
    `SELECT name FROM item WHERE name = ? COLLATE NOCASE AND id IS NOT ?`,
    [name, id],
  );
  if (clash !== undefined)
    out.push(`There is already a product or service named ${String(clash)}.`);
  if (input.rate !== null && !Number.isSafeInteger(input.rate)) out.push('Enter a valid rate.');
  const type = db.selectValue('SELECT type FROM account WHERE id = ?', [input.incomeAccountId]);
  if (type !== 'income') out.push('Choose the income account it goes to.');
  return out;
}

const fields = (input: ItemInput) => [
  input.name.trim(),
  input.description?.trim() || null,
  input.rate,
  input.incomeAccountId,
  input.active ? 1 : 0,
];

export function createItem(db: Database, input: ItemInput): string {
  const p = problems(db, input, null);
  if (p.length) throw new LedgerRuleError(p.join(' '));
  const id = crypto.randomUUID();
  db.exec({
    sql: `INSERT INTO item (id, company_id, name, description, rate, income_account_id, active)
          VALUES (?, (SELECT id FROM company), ?, ?, ?, ?, ?)`,
    bind: [id, ...fields(input)],
  });
  return id;
}

export function updateItem(db: Database, id: string, input: ItemInput): void {
  const p = problems(db, input, id);
  if (p.length) throw new LedgerRuleError(p.join(' '));
  db.exec({
    sql: `UPDATE item SET name = ?, description = ?, rate = ?, income_account_id = ?, active = ? WHERE id = ?`,
    bind: [...fields(input), id],
  });
}
