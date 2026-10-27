// Categorization rules (BK-5): when a transaction's payee or description
// contains some text, and optionally its amount is in a range, money goes in
// or out, or it's in a given account, suggest a category, payee and memo.
// The first active rule by priority wins. A rule set to post automatically
// posts matching transactions on import.

import type { Cents } from '../../shared/money';
import { inSavepoint } from '../../ledger/tx';
import { LedgerRuleError } from '../../worker/errors';
import type { Database } from '../../worker/sqlite';

export type Direction = 'any' | 'in' | 'out';

export interface RuleInput {
  name: string;
  active: boolean;
  /** Only transactions in this bank or card account; null for any */
  accountId: string | null;
  direction: Direction;
  /** Matched against the payee and the description (memo), ignoring case */
  textContains: string | null;
  /** Amount range, as a positive amount whichever way the money goes */
  amountMin: Cents | null;
  amountMax: Cents | null;
  categoryId: string;
  payee: string | null;
  memo: string | null;
  autoPost: boolean;
}

export interface RuleRow extends RuleInput {
  id: string;
  priority: number;
}

const row = (r: Record<string, unknown>): RuleRow => ({
  id: String(r.id),
  priority: Number(r.priority),
  name: String(r.name),
  active: r.active === 1,
  accountId: r.account_id === null ? null : String(r.account_id),
  direction: r.direction as Direction,
  textContains: r.text_contains === null ? null : String(r.text_contains),
  amountMin: r.amount_min === null ? null : Number(r.amount_min),
  amountMax: r.amount_max === null ? null : Number(r.amount_max),
  categoryId: String(r.category_id),
  payee: r.payee === null ? null : String(r.payee),
  memo: r.memo === null ? null : String(r.memo),
  autoPost: r.auto_post === 1,
});

export function listRules(db: Database): RuleRow[] {
  return db.selectObjects('SELECT * FROM bank_rule ORDER BY priority, created_at').map(row);
}

/** Does the rule apply to this transaction? */
export function ruleMatches(
  rule: RuleInput,
  t: { accountId: string; amount: Cents; payee: string | null; memo: string | null },
): boolean {
  if (rule.accountId && rule.accountId !== t.accountId) return false;
  if (rule.direction === 'in' && t.amount < 0) return false;
  if (rule.direction === 'out' && t.amount > 0) return false;
  const size = Math.abs(t.amount);
  if (rule.amountMin !== null && size < rule.amountMin) return false;
  if (rule.amountMax !== null && size > rule.amountMax) return false;
  if (rule.textContains) {
    const needle = rule.textContains.trim().toLowerCase();
    const haystack = `${t.payee ?? ''}\n${t.memo ?? ''}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

/** The first active rule, in priority order, that applies. */
export function firstRule(
  rules: RuleRow[],
  t: { accountId: string; amount: Cents; payee: string | null; memo: string | null },
): RuleRow | null {
  return rules.find((r) => r.active && ruleMatches(r, t)) ?? null;
}

const blank = (s: string | null | undefined) => (s?.trim() ? s.trim() : null);

function checked(db: Database, input: RuleInput): RuleInput {
  const r: RuleInput = {
    ...input,
    name: input.name.trim(),
    accountId: input.accountId || null,
    textContains: blank(input.textContains),
    payee: blank(input.payee),
    memo: blank(input.memo),
  };
  const problems: string[] = [];
  if (!r.name) problems.push('Give the rule a name.');
  if (!r.textContains && r.amountMin === null && r.amountMax === null) {
    problems.push('Say what the rule looks for: text in the payee or description, or an amount.');
  }
  for (const a of [r.amountMin, r.amountMax]) {
    if (a !== null && (!Number.isSafeInteger(a) || a < 0))
      problems.push('Amounts must be zero or more.');
  }
  if (r.amountMin !== null && r.amountMax !== null && r.amountMin > r.amountMax) {
    problems.push('The smallest amount is larger than the largest.');
  }
  if (!r.categoryId) problems.push('Choose the category to use.');
  else if (r.categoryId === r.accountId)
    problems.push('The category can’t be the account the rule is for.');
  else if (db.selectValue('SELECT active FROM account WHERE id = ?', [r.categoryId]) !== 1) {
    problems.push('The category is inactive.');
  }
  if (problems.length) throw new LedgerRuleError(problems.join(' '));
  return r;
}

const binds = (r: RuleInput) => [
  r.name,
  r.active ? 1 : 0,
  r.accountId,
  r.direction,
  r.textContains,
  r.amountMin,
  r.amountMax,
  r.categoryId,
  r.payee,
  r.memo,
  r.autoPost ? 1 : 0,
];

/** Add a rule after the existing ones. Returns its id. */
export function createRule(db: Database, input: RuleInput): string {
  const r = checked(db, input);
  const id = crypto.randomUUID();
  inSavepoint(db, 'bank_rule_create', () =>
    db.exec({
      sql: `INSERT INTO bank_rule (id, company_id, priority, name, active, account_id, direction, text_contains,
                                   amount_min, amount_max, category_id, payee, memo, auto_post)
            VALUES (?, (SELECT id FROM company), (SELECT coalesce(max(priority), 0) + 1 FROM bank_rule),
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      bind: [id, ...binds(r)],
    }),
  );
  return id;
}

export function updateRule(db: Database, id: string, input: RuleInput): void {
  const r = checked(db, input);
  inSavepoint(db, 'bank_rule_update', () => {
    db.exec({
      sql: `UPDATE bank_rule SET name = ?, active = ?, account_id = ?, direction = ?, text_contains = ?,
                                 amount_min = ?, amount_max = ?, category_id = ?, payee = ?, memo = ?, auto_post = ?
            WHERE id = ?`,
      bind: [...binds(r), id],
    });
    if (db.changes() !== 1) throw new LedgerRuleError('That rule no longer exists.');
  });
}

export function deleteRule(db: Database, id: string): void {
  inSavepoint(db, 'bank_rule_delete', () =>
    db.exec({ sql: 'DELETE FROM bank_rule WHERE id = ?', bind: [id] }),
  );
}

/** Move a rule up (earlier, wins first) or down in the order. */
export function moveRule(db: Database, id: string, direction: 'up' | 'down'): void {
  inSavepoint(db, 'bank_rule_move', () => {
    const rules = listRules(db);
    const i = rules.findIndex((r) => r.id === id);
    const j = direction === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= rules.length) return;
    [rules[i], rules[j]] = [rules[j]!, rules[i]!];
    rules.forEach((r, n) =>
      db.exec({
        sql: 'UPDATE bank_rule SET priority = ? WHERE id = ? AND priority IS NOT ?',
        bind: [n + 1, r.id, n + 1],
      }),
    );
  });
}
