// A company is open: header with the active company and save state (CO-2,
// DF-2), problems that need the owner (DF-3, DF-4, DF-9), and the pages.

import { useEffect, useState } from 'react';
import { BankingPage } from '../modules/banking/BankingPage';
import { ReconcilePage } from '../modules/banking/ReconcilePage';
import { RulesPage } from '../modules/banking/RulesPage';
import { BillsPage } from '../modules/bills/BillsPage';
import { ItemsPage } from '../modules/sales/ItemsPage';
import {
  RecurringInvoicesPage,
  draftFromInvoice,
  type RecurringInvoiceDraft,
} from '../modules/sales/RecurringInvoicesPage';
import { SalesDocsPage } from '../modules/sales/SalesDocsPage';
import { MigrationPage } from '../modules/migration/MigrationPage';
import type { Module } from '../shared/company';
import type { SessionStatus } from '../worker/companySession';
import { db } from '../shared/workerClient';
import { AccountsPage } from './pages/AccountsPage';
import { AuditLogPage } from './pages/AuditLogPage';
import { BackupsPage } from './pages/BackupsPage';
import { CloseBooksPage } from './pages/CloseBooksPage';
import { CompanyPage } from './pages/CompanyPage';
import { JournalPage } from './pages/JournalPage';
import { M1LabPage } from './pages/M1LabPage';
import { PayeesPage } from './pages/PayeesPage';
import { RecurringPage, type RecurringDraft } from './pages/RecurringPage';
import { RegisterPage } from './pages/RegisterPage';
import { ReportsPage } from './pages/ReportsPage';
import { ModulesPage } from './pages/ModulesPage';
import { SecurityPage } from './pages/SecurityPage';
import { ensureReadWrite, pickFolder, rememberFolder } from './recentFolders';
import { formatDate } from './ledgerUi';
import { ErrorText, formatDateTime, useAction } from './ui';

const PAGES = {
  register: 'Transactions',
  accountsRegister: 'Accounts register',
  journal: 'Journal entries',
  recurring: 'Recurring entries',
  accounts: 'Accounts',
  payees: 'Payees',
  reports: 'Reports',
  close: 'Close books',
  invoices: 'Invoices',
  estimates: 'Estimates',
  recurringInvoices: 'Recurring invoices',
  items: 'Products & services',
  bills: 'Bills',
  banking: 'Bank import',
  rules: 'Bank rules',
  reconcile: 'Reconcile',
  migration: 'QuickBooks import',
  company: 'Company',
  modules: 'Modules',
  backups: 'Backups',
  audit: 'Audit log',
  security: 'Passphrase and device',
  m1: 'Technical test (M1)',
} as const;
type Page = keyof typeof PAGES;

const NAV: { group: string; pages: Page[] }[] = [
  {
    group: 'Books',
    pages: [
      'register',
      'accountsRegister',
      'journal',
      'recurring',
      'accounts',
      'payees',
      'reports',
      'close',
    ],
  },
  { group: 'Sales', pages: ['invoices', 'estimates', 'recurringInvoices', 'items'] },
  { group: 'Purchases', pages: ['bills'] },
  { group: 'Banking', pages: ['banking', 'rules', 'reconcile'] },
  { group: 'Modules', pages: ['migration'] },
  { group: 'Company', pages: ['company', 'modules', 'backups', 'audit', 'security'] },
  { group: 'Development', pages: ['m1'] },
];

/** Pages that belong to a module, shown only while it's on for the company (CO-4). */
const MODULE_OF: Partial<Record<Page, Module>> = {
  invoices: 'sales',
  estimates: 'sales',
  recurringInvoices: 'sales',
  items: 'sales',
  bills: 'bills',
  banking: 'banking',
  rules: 'banking',
  reconcile: 'banking',
  migration: 'migration',
};

/** Problems the owner has to act on, with the actions that fix them. */
function Problems({
  status,
  onBackups,
  onPage,
}: {
  status: SessionStatus;
  onBackups: () => void;
  onPage: (p: Page) => void;
}) {
  const { busy, error, run } = useAction();
  const err = status.error;
  const cannotSaveHere =
    err?.name === 'FileChangedOnDiskError' || err?.name === 'CompanyLockedError';
  const accessLost = err?.name === 'FolderAccessError';

  const saveCopy = () =>
    run(async () => {
      const dir = await pickFolder('company-copy');
      if (!dir) return;
      const s = await db.saveAs(dir);
      if (s.legalName) await rememberFolder(`${s.legalName} (copy)`, dir);
    });
  // Chrome only asks for permission in response to a click, so this runs from one
  const allowAndSave = () =>
    run(async () => {
      if (!(await ensureReadWrite(await db.folder())))
        throw new Error('Nothing was saved: Chrome did not allow access to the folder.');
      await db.folderAccessRegained();
    });
  const discard = () =>
    run(async () => {
      if (confirm('Close without saving? Changes since the last save will be lost.'))
        await db.discard();
    });

  return (
    <>
      {err && (
        <div className="banner error-banner" role="alert">
          <p>{err.message}</p>
          <div className="buttons">
            {accessLost ? (
              <>
                <button disabled={busy} onClick={allowAndSave}>
                  Allow access and save
                </button>
                <button className="secondary" disabled={busy} onClick={saveCopy}>
                  Save a copy in another folder…
                </button>
              </>
            ) : cannotSaveHere ? (
              <>
                <button disabled={busy} onClick={saveCopy}>
                  Save a copy in another folder…
                </button>
                <button className="secondary" disabled={busy} onClick={discard}>
                  Close without saving
                </button>
              </>
            ) : (
              <button disabled={busy} onClick={() => run(() => db.save())}>
                Try saving again
              </button>
            )}
          </div>
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      {status.readOnly && !err && (
        <div className="banner">
          This company is open read-only: another device has it open, or you chose read-only.
          Changes can't be made here.
        </div>
      )}
      {(status.recurring || status.recurringInvoices) && (
        <RecurringNotice status={status} onPage={onPage} />
      )}
      {status.backupOverdue && (
        <div className="banner warn-banner">
          {status.latestBackupAt
            ? `The newest backup is from ${formatDateTime(status.latestBackupAt)}, more than 7 days ago.`
            : 'This company has no backup yet.'}{' '}
          <button className="link" onClick={onBackups}>
            Go to Backups
          </button>
        </div>
      )}
    </>
  );
}

/** "Rent (Feb 1, Mar 1); Insurance (Mar 1)": dates grouped by name. */
function byName(done: { name: string; date: string }[]): string {
  const map = new Map<string, string[]>();
  for (const d of done) map.set(d.name, [...(map.get(d.name) ?? []), formatDate(d.date)]);
  return [...map].map(([name, dates]) => `${name} (${dates.join(', ')})`).join('; ');
}

/**
 * What the recurring entries (GL-5) and recurring invoices (AR-9) did when
 * the company opened: posted or made automatically, with this to say so, and
 * any that are waiting and why.
 */
function RecurringNotice({ status, onPage }: { status: SessionStatus; onPage: (p: Page) => void }) {
  const r = status.recurring ?? { posted: [], waiting: [] };
  const inv = status.recurringInvoices ?? { created: [], waiting: [] };
  const waiting = r.waiting.length + inv.waiting.length > 0;
  return (
    <div className={`banner ${waiting ? 'warn-banner' : 'notice-banner'}`} role="status">
      {r.posted.length > 0 && (
        <p>
          Posted {r.posted.length} recurring {r.posted.length === 1 ? 'entry' : 'entries'}:{' '}
          {byName(r.posted)}.
        </p>
      )}
      {r.waiting.map((w) => (
        <p key={w.recurringId}>
          {w.name} for {formatDate(w.date)} is waiting: {w.reason}.
        </p>
      ))}
      {inv.created.length > 0 && (
        <p>
          Made {inv.created.length} {inv.created.length === 1 ? 'invoice' : 'invoices'}, as drafts
          to check and send: {byName(inv.created)}.
        </p>
      )}
      {inv.waiting.map((w) => (
        <p key={w.recurringId}>
          The {w.name} invoice for {formatDate(w.date)} is waiting: {w.reason}.
        </p>
      ))}
      <div className="buttons">
        {(r.posted.length > 0 || r.waiting.length > 0) && (
          <button className="link" onClick={() => onPage('recurring')}>
            Recurring entries
          </button>
        )}
        {inv.created.length > 0 && (
          <button className="link" onClick={() => onPage('invoices')}>
            Invoices
          </button>
        )}
        {inv.waiting.length > 0 && (
          <button className="link" onClick={() => onPage('recurringInvoices')}>
            Recurring invoices
          </button>
        )}
        <button className="link" onClick={() => void db.dismissRecurring()}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

export function Workspace({ status }: { status: SessionStatus }) {
  // Transactions is the home panel (GL-9)
  const [page, setPage] = useState<Page>('register');
  const [accountFilter, setAccountFilter] = useState<string | null>(null);
  // A recurring entry being started from a journal entry (GL-5)
  const [recurringDraft, setRecurringDraft] = useState<RecurringDraft | null>(null);
  // A recurring invoice being started from an invoice (AR-9)
  const [invoiceDraft, setInvoiceDraft] = useState<RecurringInvoiceDraft | null>(null);
  // The register narrowed to one payee, from the Payees page (GL-11)
  const [payeeFilter, setPayeeFilter] = useState<{ id: string; name: string } | null>(null);
  // An entry opened from a report or the register, so its Back button returns there
  const [openEntry, setOpenEntry] = useState<number | null>(null);
  const [entryFrom, setEntryFrom] = useState<Page>('reports');
  // Reports stay mounted once visited, so drilling to an entry and back keeps the report
  const [reportsVisited, setReportsVisited] = useState(false);
  // Counts sidebar clicks, so clicking the current page's item returns to its list
  const [visit, setVisit] = useState(0);
  const [modules, setModules] = useState<Record<Module, boolean> | null>(null);
  const { busy, run } = useAction();

  // Re-read on every page change, so switching a module on the Modules page shows up
  useEffect(() => {
    void db.modules().then(setModules);
  }, [status.companyId, page]);

  const shown = (p: Page) => {
    const m = MODULE_OF[p];
    return !m || !!modules?.[m];
  };

  const go = (p: Page) => {
    setPage(p);
    setVisit((v) => v + 1);
    setOpenEntry(null);
    if (p !== 'journal') setAccountFilter(null);
    if (p === 'reports') setReportsVisited(true);
  };

  return (
    <div className="workspace">
      <header className="topbar">
        <div className="company-name" title="Active company">
          {status.legalName}
        </div>
        <button
          className="secondary"
          disabled={busy || status.saving}
          title="Save, close the company, forget the key and go back to the start screen"
          onClick={() => run(() => db.close())}
        >
          Close company
        </button>
      </header>
      <div className="body">
        <nav className="sidebar" aria-label="Pages">
          {NAV.filter(({ pages }) => pages.some(shown)).map(({ group, pages }) => (
            <div key={group} className="nav-group">
              <div className="nav-heading">{group}</div>
              {pages.filter(shown).map((p) => (
                <button
                  key={p}
                  className={p === page ? 'tab active' : 'tab'}
                  aria-current={p === page ? 'page' : undefined}
                  onClick={() => go(p)}
                >
                  {PAGES[p]}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <main>
          <Problems status={status} onBackups={() => go('backups')} onPage={go} />
          {page === 'journal' && (
            <JournalPage
              // Remount when the filter or opened entry changes, so the page starts over
              key={`${accountFilter ?? 'all'}:${openEntry ?? ''}:${visit}`}
              status={status}
              accountFilter={accountFilter}
              onClearAccountFilter={() => setAccountFilter(null)}
              onMakeRecurring={
                status.readOnly
                  ? undefined
                  : (draft) => {
                      setRecurringDraft(draft);
                      setPage('recurring');
                    }
              }
              initialEntryId={openEntry}
              backLabel={
                openEntry
                  ? `← Back to ${entryFrom === 'reports' ? 'report' : PAGES[entryFrom].toLowerCase()}`
                  : undefined
              }
              onBackToReport={
                openEntry
                  ? () => {
                      setOpenEntry(null);
                      setPage(entryFrom);
                    }
                  : undefined
              }
            />
          )}
          {page === 'accounts' && (
            <AccountsPage
              status={status}
              onShowEntries={(id) => {
                setAccountFilter(id);
                setPage('journal');
              }}
            />
          )}
          {reportsVisited && (
            <div hidden={page !== 'reports'}>
              <ReportsPage
                status={status}
                onOpenEntry={(id) => {
                  setOpenEntry(id);
                  setEntryFrom('reports');
                  setPage('journal');
                }}
              />
            </div>
          )}
          {/* Kept mounted, so its filters survive opening an entry and coming back */}
          <div hidden={page !== 'register'}>
            <RegisterPage
              // A payee filter starts the register over, at that payee's latest
              key={payeeFilter?.id ?? 'all'}
              status={status}
              payee={payeeFilter}
              onClearPayee={() => setPayeeFilter(null)}
              onOpenEntry={(id) => {
                setOpenEntry(id);
                setEntryFrom('register');
                setPage('journal');
              }}
            />
          </div>
          {page === 'accountsRegister' && (
            <RegisterPage
              key={visit}
              status={status}
              single
              onOpenEntry={(id) => {
                setOpenEntry(id);
                setEntryFrom(page);
                setPage('journal');
              }}
            />
          )}
          {page === 'recurring' && (
            <RecurringPage
              key={visit}
              status={status}
              draft={recurringDraft}
              onDraftUsed={() => setRecurringDraft(null)}
            />
          )}
          {page === 'payees' && (
            <PayeesPage
              status={status}
              onShowTransactions={(p) => {
                setPayeeFilter(p);
                setPage('register');
              }}
            />
          )}
          {page === 'close' && <CloseBooksPage status={status} />}
          {page === 'invoices' && (
            <SalesDocsPage
              key={visit}
              status={status}
              kind="invoice"
              onMakeRecurring={(d) => {
                setInvoiceDraft(draftFromInvoice(d));
                setPage('recurringInvoices');
              }}
            />
          )}
          {page === 'estimates' && <SalesDocsPage key={visit} status={status} kind="estimate" />}
          {page === 'recurringInvoices' && (
            <RecurringInvoicesPage
              key={visit}
              status={status}
              draft={invoiceDraft}
              onDraftUsed={() => setInvoiceDraft(null)}
              onOpenInvoices={() => go('invoices')}
            />
          )}
          {page === 'items' && <ItemsPage status={status} />}
          {page === 'bills' && <BillsPage key={visit} status={status} />}
          {page === 'banking' && <BankingPage status={status} />}
          {page === 'rules' && <RulesPage status={status} />}
          {page === 'reconcile' && <ReconcilePage status={status} />}
          {page === 'migration' && <MigrationPage status={status} />}
          {page === 'company' && <CompanyPage status={status} />}
          {page === 'modules' && <ModulesPage status={status} />}
          {page === 'backups' && <BackupsPage status={status} />}
          {page === 'audit' && <AuditLogPage status={status} />}
          {page === 'security' && <SecurityPage status={status} />}
          {page === 'm1' && <M1LabPage status={status} />}
        </main>
      </div>
    </div>
  );
}
