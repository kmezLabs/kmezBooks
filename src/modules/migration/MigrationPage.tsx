// QuickBooks Online migration screen (MG-1 to MG-6): choose the exports, see
// what was found, map the accounts, dry run with the tie-out, then import.

import * as Comlink from 'comlink';
import { useEffect, useState } from 'react';
import { formatDate } from '../../app/ledgerUi';
import { ErrorText, useAction } from '../../app/ui';
import {
  ACCOUNT_TYPES,
  TYPE_LABELS,
  detailTypesFor,
  type AccountRow,
  type AccountType,
} from '../../shared/accounts';
import { formatMoney } from '../../shared/money';
import { db } from '../../shared/workerClient';
import type { MigrationPlan, SessionStatus } from '../../worker/companySession';
import type { QboAccount } from './analysis';
import type { AccountChoices, AccountTarget, ImportResult, TieOutCheck } from './importer';

const cancelled = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

/** "1 customer", "16 vendors", "1,234 entries" */
const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

async function pickExportFolder(): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    return await window.showDirectoryPicker!({ id: 'qbo-exports', mode: 'read' });
  } catch (e) {
    if (cancelled(e)) return undefined;
    throw e;
  }
}

function Instructions() {
  return (
    <details>
      <summary>How to export from QuickBooks Online</summary>
      <ol>
        <li>
          Set the accounting method to Cash: gear icon → Account and settings → Advanced →
          Accounting → Accounting method. This only changes how reports are shown; switch it back
          afterwards if you like.
        </li>
        <li>
          Gear icon → Tools → Export data. On Reports, choose one year (January 1 to December 31)
          and export; on Lists, export customers and vendors. Repeat for every year, back to the
          first year in QuickBooks. Each export is a folder named like{' '}
          <code>Company 20250101-20251231</code>.
        </li>
        <li>
          Chart of accounts → Run report → Export to Excel, for the Account List with each
          account&rsquo;s type.
        </li>
        <li>Put everything in one folder (subfolders are fine) and choose that folder below.</li>
      </ol>
    </details>
  );
}

function Problems({ errors, warnings }: { errors: string[]; warnings: string[] }) {
  return (
    <>
      {errors.length > 0 && (
        <div className="error" role="alert">
          <strong>Fix these before importing:</strong>
          <ul>
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="warning">
          <strong>Good to know:</strong>
          <ul>
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function Summary({ plan, status }: { plan: MigrationPlan; status: SessionStatus }) {
  const s = plan.summary;
  return (
    <>
      <h3>What was found</h3>
      {s.company && s.company !== status.legalName && (
        <p className="warning">
          These exports are from <strong>{s.company}</strong>, and this company is{' '}
          <strong>{status.legalName}</strong>. Check that you are importing into the right company.
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>Period</th>
            <th>Transactions from</th>
            <th className="num">Transactions</th>
            <th>Trial balance</th>
            <th>Balance sheet</th>
          </tr>
        </thead>
        <tbody>
          {s.periods.map((p) => (
            <tr key={p.from}>
              <td>
                {formatDate(p.from)} – {formatDate(p.to)}
              </td>
              <td>
                {p.source === 'journal'
                  ? p.cashChecked
                    ? 'Journal, checked against the cash-basis General Ledger'
                    : 'Journal (not checked)'
                  : p.source === 'generalLedger'
                    ? 'Cash-basis General Ledger'
                    : '—'}
              </td>
              <td className="num">{p.transactions.toLocaleString('en-US')}</td>
              <td>{p.trialBalance ? 'Yes' : 'Missing'}</td>
              <td>{p.balanceSheet ? 'Yes' : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        {count(s.transactions, 'transaction')}, {count(s.accounts.length, 'account')},{' '}
        {count(s.customers, 'customer')} and {count(s.vendors, 'vendor')}.
        {s.opening &&
          ` Balances before the first period (${s.opening.accounts} accounts) come in as one opening entry dated ${formatDate(s.opening.date)}.`}
      </p>
      <details>
        <summary>Files ({s.files.length})</summary>
        <table>
          <thead>
            <tr>
              <th>File</th>
              <th>Report</th>
              <th>Period</th>
              <th>Basis</th>
            </tr>
          </thead>
          <tbody>
            {s.files.map((f) => (
              <tr key={f.path} className={f.kind ? undefined : 'inactive'}>
                <td>{f.path}</td>
                <td>{f.label}</td>
                <td>{f.period}</td>
                <td>{f.basis === 'cash' ? 'Cash' : f.basis === 'accrual' ? 'Accrual' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      <Problems errors={s.errors} warnings={s.warnings} />
    </>
  );
}

function TargetPicker(props: {
  account: QboAccount;
  target: AccountTarget;
  existing: AccountRow[];
  disabled: boolean;
  onChange: (t: AccountTarget) => void;
}) {
  const { target, account } = props;
  const newType = target.kind === 'new' ? target.type : null;
  return (
    <div className="target">
      <select
        value={target.kind === 'new' ? 'new' : target.accountId}
        disabled={props.disabled}
        onChange={(e) =>
          props.onChange(
            e.target.value === 'new'
              ? { kind: 'new', type: account.type, detailType: account.detailType }
              : { kind: 'existing', accountId: e.target.value },
          )
        }
      >
        <option value="new">New account</option>
        {props.existing.length > 0 && (
          <optgroup label="Existing account">
            {props.existing.map((a) => (
              <option key={a.id} value={a.id}>
                {a.fullName}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {target.kind === 'new' && (
        <>
          <select
            value={newType ?? ''}
            disabled={props.disabled}
            className={newType ? undefined : 'invalid'}
            onChange={(e) => {
              const type = e.target.value as AccountType;
              props.onChange({ kind: 'new', type, detailType: detailTypesFor(type)[0]!.code });
            }}
          >
            <option value="">Choose a type…</option>
            {ACCOUNT_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </select>
          {newType && (
            <select
              value={target.detailType ?? ''}
              disabled={props.disabled}
              onChange={(e) =>
                props.onChange({ kind: 'new', type: newType, detailType: e.target.value })
              }
            >
              {detailTypesFor(newType).map((d) => (
                <option key={d.code} value={d.code}>
                  {d.name}
                </option>
              ))}
            </select>
          )}
        </>
      )}
    </div>
  );
}

function AccountMapping(props: {
  plan: MigrationPlan;
  choices: AccountChoices;
  existing: AccountRow[];
  disabled: boolean;
  onChange: (name: string, t: AccountTarget) => void;
}) {
  const [onlyUsed, setOnlyUsed] = useState(false);
  const accounts = props.plan.summary.accounts.filter((a) => !onlyUsed || a.lines > 0);
  return (
    <>
      <h3>Accounts</h3>
      <p className="muted">
        Each QuickBooks account becomes a new account with the same name, unless you point it at an
        account this company already has. Types and detail types can also be changed later on the
        Accounts page, except the type of an account with transactions.
      </p>
      <label className="check inline">
        <input type="checkbox" checked={onlyUsed} onChange={(e) => setOnlyUsed(e.target.checked)} />
        Only accounts with transactions
      </label>
      <table className="mapping">
        <thead>
          <tr>
            <th>QuickBooks account</th>
            <th>QuickBooks type</th>
            <th className="num">Lines</th>
            <th>Becomes</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => (
            <tr key={a.name} className={a.deleted ? 'inactive' : undefined}>
              <td>
                {a.name}
                {!a.inList && <span className="badge small">not in Account List</span>}
              </td>
              <td>
                {a.qboType ?? '—'}
                {a.qboDetailType && <div className="muted">{a.qboDetailType}</div>}
              </td>
              <td className="num">{a.lines.toLocaleString('en-US')}</td>
              <td>
                <TargetPicker
                  account={a}
                  target={props.choices[a.name]!}
                  existing={props.existing}
                  disabled={props.disabled}
                  onChange={(t) => props.onChange(a.name, t)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function TieOutResult({ check }: { check: TieOutCheck }) {
  const title = `${check.report} as of ${formatDate(check.asOf)}`;
  if (check.differences.length === 0) {
    return (
      <p className="notice">
        ✓ {title}: all {check.checked} lines match QuickBooks.
      </p>
    );
  }
  return (
    <div className="warning">
      <strong>
        {title}: {check.differences.length} of {check.checked} lines differ
      </strong>{' '}
      <span className="muted">({check.file})</span>
      <table>
        <thead>
          <tr>
            <th>Account</th>
            <th className="num">QuickBooks</th>
            <th className="num">kmezBooks</th>
            <th className="num">Difference</th>
          </tr>
        </thead>
        <tbody>
          {check.differences.map((d) => (
            <tr key={d.account}>
              <td>{d.account}</td>
              <td className="num">{formatMoney(d.qbo)}</td>
              <td className="num">{formatMoney(d.ours)}</td>
              <td className="num">{formatMoney(d.ours - d.qbo)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">Amounts are debits minus credits; Net Income is shown as profit.</p>
    </div>
  );
}

function RunResult({ result }: { result: ImportResult }) {
  return (
    <>
      <Problems errors={result.errors} warnings={[]} />
      {result.tieOut && (
        <>
          <h3>Tie-out</h3>
          {result.tieOut.checks.length === 0 && (
            <p className="warning">No trial balance or balance sheet to compare with.</p>
          )}
          {result.tieOut.checks.map((c) => (
            <TieOutResult key={`${c.report}${c.asOf}`} check={c} />
          ))}
        </>
      )}
    </>
  );
}

export function MigrationPage({ status }: { status: SessionStatus }) {
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [choices, setChoices] = useState<AccountChoices>({});
  const [existing, setExisting] = useState<AccountRow[]>([]);
  const [dryRun, setDryRun] = useState<ImportResult | null>(null);
  const [imported, setImported] = useState<ImportResult | null>(null);
  const [accept, setAccept] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [closingSet, setClosingSet] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  useEffect(() => {
    void db.accounts().then(setExisting);
  }, [status.companyId, imported]);
  // Forget the exports when leaving the page
  useEffect(() => () => void db.migrationDiscard(), []);

  const analyse = (source: FileSystemDirectoryHandle | File[]) =>
    run(async () => {
      setPlan(null);
      setDryRun(null);
      setImported(null);
      const p = await db.migrationAnalyze(source);
      setPlan(p);
      setChoices(p.choices);
      setAccept(false);
    });

  const chooseFolder = () =>
    run(async () => {
      const dir = await pickExportFolder();
      if (dir) await analyse(dir);
    });

  const onProgress = Comlink.proxy((done: number, total: number) =>
    setProgress(`Posting ${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}…`),
  );

  const go = (commit: boolean) =>
    run(async () => {
      setProgress(commit ? 'Importing…' : 'Dry run…');
      try {
        const result = await db.migrationRun(
          choices,
          { commit, acceptDifferences: commit && accept },
          onProgress,
        );
        if (commit && result.committed) {
          setImported(result);
          setPlan(null);
        } else {
          setDryRun(result);
        }
      } finally {
        setProgress(null);
      }
    });

  const change = (name: string, t: AccountTarget) => {
    setChoices((c) => ({ ...c, [name]: t }));
    setDryRun(null);
  };

  const lastDay = plan?.summary.periods.at(-1)?.to ?? null;
  const dryRunClean = !!dryRun && dryRun.errors.length === 0 && !!dryRun.tieOut;
  const canImport = dryRunClean && (dryRun.tieOut!.ok || accept) && !status.readOnly && !busy;
  const blocked = !!plan && (plan.summary.errors.length > 0 || plan.companyHasTransactions);

  if (imported) {
    const end =
      imported.tieOut?.checks
        .map((c) => c.asOf)
        .sort()
        .at(-1) ?? null;
    return (
      <section>
        <h2>QuickBooks import</h2>
        <p className="notice">
          Imported {count(imported.counts.entries, 'entry', 'entries')},{' '}
          {count(imported.counts.accountsCreated, 'new account')},{' '}
          {count(imported.counts.customers, 'customer')} and{' '}
          {count(imported.counts.vendors, 'vendor')}. The company is saved as usual.
        </p>
        <RunResult result={imported} />
        <h3>Next</h3>
        <p>
          Compare a few reports with QuickBooks (Reports → Profit and Loss, Balance Sheet). Keep the
          QuickBooks subscription until all four companies have been imported and checked.
        </p>
        {end && (
          <>
            <p className="muted">
              Closing the books through the last imported day stops anyone changing migrated history
              by accident (MG-8). It can be changed on Close books.
            </p>
            {closingSet ? (
              <p className="notice">Books closed through {formatDate(closingSet)}.</p>
            ) : (
              <div className="buttons">
                <button
                  disabled={busy || status.readOnly}
                  onClick={() =>
                    run(async () => {
                      await db.setClosingDate(end);
                      setClosingSet(end);
                    })
                  }
                >
                  Close the books through {formatDate(end)}
                </button>
              </div>
            )}
          </>
        )}
        <ErrorText>{error}</ErrorText>
      </section>
    );
  }

  return (
    <section>
      <h2>QuickBooks import</h2>
      <p className="muted">
        Brings this company&rsquo;s history over from QuickBooks Online: the chart of accounts,
        customers, vendors and every transaction, from QuickBooks&rsquo;s cash-basis exports. A dry
        run posts everything, compares the result with QuickBooks&rsquo;s own trial balances and
        balance sheet, and then undoes it. The import itself is all or nothing.
      </p>
      <p className="muted">
        Import into a new, empty company: create it with &ldquo;Start with the standard chart&rdquo;
        unticked, so the chart comes from QuickBooks.
      </p>
      <Instructions />
      <div className="buttons">
        <button disabled={busy || status.readOnly} onClick={chooseFolder}>
          {plan ? 'Choose another folder…' : 'Choose the exports folder…'}
        </button>
        <label className="file-add">
          or pick the files
          <input
            type="file"
            multiple
            accept=".xlsx"
            disabled={busy || status.readOnly}
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              if (files.length) void analyse(files);
            }}
          />
        </label>
      </div>
      {progress && <p className="loading">{progress}</p>}
      <ErrorText>{error}</ErrorText>

      {plan && (
        <>
          {plan.companyHasTransactions && (
            <p className="error">
              This company already has transactions, so history can&rsquo;t be imported into it
              (MG-6). Create a new company and import there.
            </p>
          )}
          <Summary plan={plan} status={status} />
          {plan.summary.accounts.length > 0 && (
            <AccountMapping
              plan={plan}
              choices={choices}
              existing={existing}
              disabled={busy}
              onChange={change}
            />
          )}
          <h3>Dry run and import</h3>
          <p className="muted">
            The dry run takes about as long as the import: roughly a minute for 100,000
            transactions.
          </p>
          <div className="buttons">
            <button disabled={busy || blocked || status.readOnly} onClick={() => go(false)}>
              Dry run
            </button>
            <button disabled={!canImport || blocked} onClick={() => go(true)}>
              Import{lastDay ? ` through ${formatDate(lastDay)}` : ''}
            </button>
          </div>
          {dryRun && <RunResult result={dryRun} />}
          {dryRunClean && !dryRun.tieOut!.ok && (
            <label className="check">
              <input
                type="checkbox"
                checked={accept}
                onChange={(e) => setAccept(e.target.checked)}
              />
              <span>
                Import anyway. I&rsquo;ll look into the differences above.
                <span className="hint">
                  Better: fix the cause (a missing year, an account mapped to the wrong place) and
                  dry run again.
                </span>
              </span>
            </label>
          )}
          {dryRunClean && dryRun.tieOut!.ok && (
            <p className="notice">The dry run ties out. Import when you&rsquo;re ready.</p>
          )}
        </>
      )}
      {plan === null && !busy && existing.length > 0 && (
        <p className="muted">
          This company has {existing.length} accounts; QuickBooks accounts with the same name will
          be matched to them.
        </p>
      )}
    </section>
  );
}
