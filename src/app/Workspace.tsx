// A company is open: header with the active company and save state (CO-2,
// DF-2), problems that need the owner (DF-3, DF-4, DF-9), and the pages.

import { useEffect, useState } from 'react';
import { BankingPage } from '../modules/banking/BankingPage';
import { ReconcilePage } from '../modules/banking/ReconcilePage';
import { RulesPage } from '../modules/banking/RulesPage';
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
import { RegisterPage } from './pages/RegisterPage';
import { ReportsPage } from './pages/ReportsPage';
import { ModulesPage } from './pages/ModulesPage';
import { SecurityPage } from './pages/SecurityPage';
import { ensureReadWrite, pickFolder, rememberFolder } from './recentFolders';
import { ErrorText, formatDateTime, formatTime, useAction } from './ui';

const PAGES = {
  register: 'Transactions',
  journal: 'Journal entries',
  accounts: 'Accounts',
  reports: 'Reports',
  close: 'Close books',
  banking: 'Bank transactions',
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
  { group: 'Books', pages: ['register', 'journal', 'accounts', 'reports', 'close'] },
  { group: 'Banking', pages: ['banking', 'rules', 'reconcile'] },
  { group: 'Modules', pages: ['migration'] },
  { group: 'Company', pages: ['company', 'modules', 'backups', 'audit', 'security'] },
  { group: 'Development', pages: ['m1'] },
];

/** Pages that belong to a module, shown only while it's on for the company (CO-4). */
const MODULE_OF: Partial<Record<Page, Module>> = {
  banking: 'banking',
  rules: 'banking',
  reconcile: 'banking',
  migration: 'migration',
};

function SaveState({ status }: { status: SessionStatus }) {
  if (status.readOnly) return <span className="badge">Read-only</span>;
  if (status.saving) return <span className="save-state">Saving…</span>;
  if (status.error) return <span className="save-state error-text">Not saved</span>;
  if (status.dirty) return <span className="save-state">Unsaved changes</span>;
  return (
    <span className="save-state muted">
      {status.lastSavedAt ? `Saved ${formatTime(status.lastSavedAt)}` : 'All changes saved'}
    </span>
  );
}

/** Problems the owner has to act on, with the actions that fix them. */
function Problems({ status, onBackups }: { status: SessionStatus; onBackups: () => void }) {
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

export function Workspace({ status }: { status: SessionStatus }) {
  // Transactions is the home panel (GL-9)
  const [page, setPage] = useState<Page>('register');
  const [accountFilter, setAccountFilter] = useState<string | null>(null);
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
        <SaveState status={status} />
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
          <Problems status={status} onBackups={() => go('backups')} />
          {page === 'journal' && (
            <JournalPage
              // Remount when the filter or opened entry changes, so the page starts over
              key={`${accountFilter ?? 'all'}:${openEntry ?? ''}:${visit}`}
              status={status}
              accountFilter={accountFilter}
              onClearAccountFilter={() => setAccountFilter(null)}
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
              status={status}
              onOpenEntry={(id) => {
                setOpenEntry(id);
                setEntryFrom('register');
                setPage('journal');
              }}
            />
          </div>
          {page === 'close' && <CloseBooksPage status={status} />}
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
