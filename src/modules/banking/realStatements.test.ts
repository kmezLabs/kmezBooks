// Banking against real files on this computer. Opt-in, and the data never
// enters the repository:
//   QBO_DIR="C:/KM/QBO/Some Company" npx vitest run src/modules/banking/realStatements.test.ts --silent=false
// Imports the company's QuickBooks exports (if the folder has them), then every
// .qbo/.ofx/.qfx statement under the folder, and reports what the review queue
// and a reconciliation make of them.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { newCompanyDb } from '../../../db/tests/testDb';
import { formatMoney } from '../../shared/money';
import { analyze } from '../migration/analysis';
import { proposeChoices, runImport } from '../migration/importer';
import { bankAccounts } from './bankAccounts';
import {
  cancelReconciliation,
  finishReconciliation,
  reconcileState,
  setAllCleared,
  startReconciliation,
} from './reconcile';
import { acceptSuggestions, listQueue, match } from './review';
import { importStatements, readStatements, type PendingStatement } from './statements';

function files(root: string, ext: RegExp, dir = root): { path: string; bytes: Uint8Array }[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(root, ext, path);
    if (!ext.test(name)) return [];
    return [{ path: relative(root, path).replaceAll('\\', '/'), bytes: readFileSync(path) }];
  });
}

it.runIf(process.env.QBO_DIR)(
  'imports, reviews and reconciles the statements in QBO_DIR',
  async () => {
    const root = process.env.QBO_DIR!;
    const db = await newCompanyDb();

    const exports = files(root, /\.xlsx$/i);
    if (exports.length) {
      const analysis = analyze(exports);
      const migrated = runImport(db, analysis, proposeChoices(db, analysis.summary.accounts), {
        commit: true,
      });
      expect(migrated.errors).toEqual([]);
      console.log(
        `QuickBooks history: ${JSON.stringify(migrated.counts)} entries, periods ${analysis.summary.periods.join(', ')}`,
      );
    }

    const statementFiles = files(root, /\.(qbo|ofx|qfx)$/i).map((f) => ({
      name: f.path,
      bytes: f.bytes,
    }));
    const { pending, problems } = readStatements(statementFiles);
    expect(problems).toEqual([]);
    for (const p of pending) {
      const s = p.statement;
      console.log(
        `${p.file}: ${p.label}, ${s.startDate} – ${s.endDate}, ${s.transactions.length} transactions, ` +
          `balance ${s.balance === null ? '?' : formatMoney(s.balance)} on ${s.balanceDate}, ` +
          `${s.transactions.filter((t) => !t.fitid).length} without a bank id`,
      );
    }

    // The ledger account for each statement: the bank or card account with the most history
    const target = (p: PendingStatement) => {
      const detail = p.statement.kind === 'card' ? 'credit_card' : 'bank';
      const row = db.selectObjects(
        `SELECT a.id, a.name, (SELECT count(*) FROM journal_line l WHERE l.account_id = a.id) AS n
         FROM account a WHERE a.detail_type = ? ORDER BY n DESC LIMIT 1`,
        [detail],
      )[0];
      if (!row) throw new Error(`No ${detail} account for ${p.label}`);
      return String(row.id);
    };
    const choices = Object.fromEntries(pending.map((p) => [p.key, target(p)]));
    const result = importStatements(db, pending, choices);
    console.log(JSON.stringify(result.statements.map(({ accountId: _, ...s }) => s)));
    console.log(
      `auto: ${result.autoMatched} transfers matched, ${result.autoPosted} posted by rules`,
    );

    // Importing the same files again adds nothing (BK-6)
    const again = importStatements(db, readStatements(statementFiles).pending, choices);
    expect(again.statements.every((s) => s.added === 0)).toBe(true);

    for (const account of bankAccounts(db).filter((a) => a.waiting > 0)) {
      const queue = listQueue(db, account.id);
      const kinds = {
        alreadyInBooksFromQuickBooks: queue.filter((t) =>
          t.matches.some((m) => m.sourceType === 'qbo_migration'),
        ).length,
        otherMatches: queue.filter(
          (t) => t.matches.length && !t.matches.some((m) => m.sourceType === 'qbo_migration'),
        ).length,
        transfers: queue.filter((t) => t.transfer).length,
        suggested: queue.filter((t) => !t.matches.length && t.suggestion).length,
        nothing: queue.filter((t) => !t.matches.length && !t.transfer && !t.suggestion).length,
      };
      console.log(`${account.name}: ${queue.length} waiting ${JSON.stringify(kinds)}`);
      for (const t of queue) {
        const m = t.matches[0];
        console.log(
          `  ${t.date} ${formatMoney(t.amount).padStart(12)} ${(t.payee ?? '').slice(0, 34).padEnd(34)} ` +
            (m
              ? `→ match ${m.date} ${m.name ?? m.memo ?? ''} (${m.accounts})`
              : t.possibleDuplicate
                ? 'flagged'
                : ''),
        );
      }
    }

    // Review as the owner would: match what's already in the books, then
    // accept the suggestions (from rules or from earlier matches)
    for (const account of bankAccounts(db)) {
      const queue = listQueue(db, account.id);
      let matched = 0;
      for (const t of queue) {
        if (t.matches.length) {
          match(db, t.id, t.matches[0]!.entryId);
          matched++;
        }
      }
      const after = listQueue(db, account.id);
      for (const t of after) {
        if (t.suggestion) {
          console.log(
            `  suggests for ${t.date} ${(t.payee ?? '').slice(0, 30).padEnd(30)} ${formatMoney(t.amount).padStart(12)}: ${t.suggestion.payee ?? ''} (${t.suggestion.source})`,
          );
        }
      }
      const posted = acceptSuggestions(
        db,
        after.map((t) => t.id),
      ).length;
      const left = listQueue(db, account.id);
      console.log(
        `${account.name}: matched ${matched}, added ${posted} as suggested, ${left.length} left for the owner: ` +
          left.map((t) => `${t.date} ${formatMoney(t.amount)} ${t.payee ?? ''}`).join('; '),
      );
    }

    // Reconcile each statement in date order at its suggested date and balance
    for (const p of [...pending].sort((a, b) =>
      (a.statement.endDate ?? '').localeCompare(b.statement.endDate ?? ''),
    )) {
      const accountId = choices[p.key]!;
      const s = p.statement;
      if (s.balance === null || !s.balanceDate || !s.endDate) continue;
      // The bank's balance is the statement's ending balance, even when dated at download
      const statementDate = s.balanceDate > s.endDate ? s.endDate : s.balanceDate;
      const endingBalance = s.balance;
      const id = startReconciliation(db, accountId, statementDate, endingBalance);
      setAllCleared(db, id, true);
      const state = reconcileState(db, accountId);
      const waiting = db.selectValue(
        `SELECT coalesce(sum(amount), 0) FROM bank_txn WHERE account_id = ? AND status = 'new' AND date <= ?`,
        [accountId, statementDate],
      );
      console.log(
        `Reconcile ${p.label} statement of ${statementDate} at ${formatMoney(endingBalance)}: ` +
          `${state.clearedCount} items cleared, difference ${formatMoney(state.difference)}, ` +
          `still waiting for review ${formatMoney(Number(waiting))}`,
      );
      // Whatever the books lack is exactly what is still waiting for review
      expect(state.difference).toBe(Number(waiting));
      if (state.difference === 0) finishReconciliation(db, id);
      else cancelReconciliation(db, id);
    }
  },
  600_000,
);
