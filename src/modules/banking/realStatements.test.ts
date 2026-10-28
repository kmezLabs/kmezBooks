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
import { seedDefaultChart } from '../../ledger/accounts';
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
import { acceptSuggestions, listQueue, match, matchCandidates } from './review';
import { importStatements, previewStatements, readStatements } from './statements';

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
    if (!exports.length) seedDefaultChart(db);
    if (exports.length) {
      const analysis = analyze(exports);
      const migrated = runImport(db, analysis, proposeChoices(db, analysis.summary.accounts), {
        commit: true,
      });
      const history = migrated.committed;
      // As the import screen offers (MG-8): close the books through the last imported day
      const lastDay = analysis.summary.periods.at(-1)?.to;
      if (history && lastDay)
        db.exec({ sql: 'UPDATE company SET closing_date = ?', bind: [lastDay] });
      if (!migrated.committed) {
        // Still try the statements, against the standard chart
        console.log(
          `QuickBooks history not imported: ${[...analysis.summary.errors, ...migrated.errors].join(' ')}`,
        );
        seedDefaultChart(db);
      }
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

    // The ledger account for each statement, as the import dialog proposes it
    const previews = previewStatements(db, pending);
    const choices: Record<string, string> = {};
    for (const p of previews) {
      const name = db.selectValue('SELECT name FROM account WHERE id = ?', [p.accountId]);
      console.log(
        `${p.file} (${p.label}) → ${p.accountId ? `${String(name)}${p.guessed ? ' (guessed)' : ''}` : 'owner chooses'}`,
      );
      if (p.accountId) choices[p.key] = p.accountId;
    }
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
      for (const t of queue.slice(0, 12)) {
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
      // As the screen does: the suggestions are read again after each match
      for (const t of queue) {
        const [m] = matchCandidates(db, t);
        if (m) {
          match(db, t.id, m.entryId);
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
        `${account.name}: matched ${matched}, added ${posted} as suggested, ${left.length} left for the owner`,
      );
    }

    // Reconcile each account at the statement the reconcile screen suggests
    for (const account of bankAccounts(db).filter((a) => a.lastImportAt)) {
      const suggested = reconcileState(db, account.id).suggested;
      if (!suggested) continue;
      if (suggested.endingBalance === null) {
        console.log(
          `Reconcile ${account.name}: statement of ${suggested.statementDate}, balance not trusted (dated at download), owner enters it`,
        );
        continue;
      }
      const id = startReconciliation(
        db,
        account.id,
        suggested.statementDate,
        suggested.endingBalance,
      );
      setAllCleared(db, id, true);
      const state = reconcileState(db, account.id);
      const closing = String(
        db.selectValue('SELECT coalesce(closing_date, ?) FROM company', ['0000-00-00']),
      );
      const sum = (where: string) =>
        db.selectObjects(
          `SELECT count(*) AS n, coalesce(sum(amount), 0) AS total FROM bank_txn
           WHERE account_id = ? AND status = 'new' AND date <= ? AND ${where}`,
          [account.id, suggested.statementDate, closing],
        )[0]!;
      const after = sum('date > ?');
      const inHistory = sum('date <= ?');
      const waiting = Number(after.total);
      console.log(
        `  ${Number(inHistory.n)} unmatched in the closed history (${formatMoney(Number(inHistory.total))}), ` +
          `${Number(after.n)} waiting after it (${formatMoney(waiting)})`,
      );
      console.log(
        `Reconcile ${account.name} statement of ${suggested.statementDate} at ${formatMoney(suggested.endingBalance)}: ` +
          `${state.clearedCount} items cleared, difference ${formatMoney(state.difference)}, still waiting for review ${formatMoney(waiting)}`,
      );
      // With the history in the books, whatever they lack is exactly what is
      // still waiting for review; without it, the opening balance is missing too
      // Real books needn't agree with the bank (QuickBooks may never have been
      // reconciled), so this reports rather than asserts
      const books = Number(
        db.selectValue(
          `SELECT coalesce(sum(l.debit - l.credit), 0) FROM journal_line l
           JOIN journal_entry e ON e.id = l.entry_id AND e.status = 'posted'
           WHERE l.account_id = ? AND e.date <= ?`,
          [account.id, suggested.statementDate],
        ),
      );
      console.log(
        `  books ${formatMoney(books)} vs bank ${formatMoney(suggested.endingBalance)} on ${suggested.statementDate}: ` +
          `${state.difference === waiting ? 'ties out apart from what waits for review' : `off by ${formatMoney(state.difference - waiting)} beyond what waits for review`}`,
      );
      if (state.difference === 0) finishReconciliation(db, id);
      else cancelReconciliation(db, id);
    }
  },
  600_000,
);
