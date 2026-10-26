// A company is open: header with the active company and save state (CO-2,
// DF-2), problems that need the owner (DF-3, DF-4, DF-9), and the pages.

import { useState } from 'react';
import type { SessionStatus } from '../worker/companySession';
import { db } from '../shared/workerClient';
import { AccountsPage } from './pages/AccountsPage';
import { AuditLogPage } from './pages/AuditLogPage';
import { BackupsPage } from './pages/BackupsPage';
import { CloseBooksPage } from './pages/CloseBooksPage';
import { CompanyPage } from './pages/CompanyPage';
import { JournalPage } from './pages/JournalPage';
import { M1LabPage } from './pages/M1LabPage';
import { ModulesPage } from './pages/ModulesPage';
import { SecurityPage } from './pages/SecurityPage';
import { pickFolder, rememberFolder } from './recentFolders';
import { ErrorText, formatDateTime, formatTime, useAction } from './ui';

const PAGES = {
  journal: 'Journal entries',
  accounts: 'Accounts',
  close: 'Close books',
  company: 'Company',
  modules: 'Modules',
  backups: 'Backups',
  audit: 'Audit log',
  security: 'Passphrase and device',
  m1: 'Technical test (M1)',
} as const;
type Page = keyof typeof PAGES;

const NAV: { group: string; pages: Page[] }[] = [
  { group: 'Books', pages: ['journal', 'accounts', 'close'] },
  { group: 'Company', pages: ['company', 'modules', 'backups', 'audit', 'security'] },
  { group: 'Development', pages: ['m1'] },
];

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

  const saveCopy = () =>
    run(async () => {
      const dir = await pickFolder('company-copy');
      if (!dir) return;
      const s = await db.saveAs(dir);
      if (s.legalName) await rememberFolder(`${s.legalName} (copy)`, dir);
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
            {cannotSaveHere ? (
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
  const [page, setPage] = useState<Page>('journal');
  const [accountFilter, setAccountFilter] = useState<string | null>(null);
  const { busy, run } = useAction();

  const go = (p: Page) => {
    setPage(p);
    if (p !== 'journal') setAccountFilter(null);
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
          title="Save, close the company and forget the key"
          onClick={() => run(() => db.close())}
        >
          Lock
        </button>
      </header>
      <div className="body">
        <nav className="sidebar" aria-label="Pages">
          {NAV.map(({ group, pages }) => (
            <div key={group} className="nav-group">
              <div className="nav-heading">{group}</div>
              {pages.map((p) => (
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
              // Remount when the filter changes, so the list starts over
              key={accountFilter ?? 'all'}
              status={status}
              accountFilter={accountFilter}
              onClearAccountFilter={() => setAccountFilter(null)}
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
          {page === 'close' && <CloseBooksPage status={status} />}
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
