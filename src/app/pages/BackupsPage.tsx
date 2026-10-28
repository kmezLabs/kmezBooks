// Backups: list, back up now, where they go, test and restore (DF-9, DF-10;
// the restore drill is M8).
// Export: all data as an unencrypted .zip, or a decrypted SQLite copy
// (Portability, M8).

import { useEffect, useState } from 'react';
import { formatMoney } from '../../shared/money';
import type { BackupCheck } from '../../worker/backupDrill';
import type { BackupFile } from '../../worker/backups';
import type { BackupPreview } from '../../worker/company';
import type { SessionStatus } from '../../worker/companySession';
import { db } from '../../shared/workerClient';
import { download } from '../export/exportReport';
import { ensureReadWrite, getBackupFolder, pickFolder, setBackupFolder } from '../recentFolders';
import { Dialog, ErrorText, TextField, formatBytes, formatDateTime, useAction } from '../ui';

const LABELS: Record<string, string> = {
  'before-restore': 'before a restore',
  'before-upgrade': 'before an app upgrade',
};
const describeLabel = (label: string | null) =>
  label ? (LABELS[label.replace(/-v\d+$|-\d+$/, '')] ?? label) : '';

/**
 * The restore drill (M8): open a backup in memory and check it could replace
 * the company, without restoring it.
 */
function TestDialog(props: { backup: BackupFile; onClose: () => void }) {
  const [passphrase, setPassphrase] = useState('');
  const [check, setCheck] = useState<BackupCheck | null>(null);
  const { busy, error, run } = useAction();

  return (
    <Dialog title="Test this backup" onClose={busy ? undefined : props.onClose}>
      <p>
        Backup from <strong>{formatDateTime(props.backup.at)}</strong>. EasyBooks opens it in
        memory, checks it, and compares it with your books as they were then. Nothing is restored or
        changed.
      </p>
      {!check ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => setCheck(await db.testBackup(props.backup.name, passphrase)));
          }}
        >
          <TextField
            label="Passphrase of that backup"
            type="password"
            value={passphrase}
            onChange={setPassphrase}
            autoFocus
            hint="The passphrase the company had when the backup was made."
          />
          <div className="buttons">
            <button type="submit" disabled={busy || !passphrase}>
              {busy ? 'Testing…' : 'Test backup'}
            </button>
            <button type="button" className="secondary" onClick={props.onClose}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <CheckResult check={check} onClose={props.onClose} />
      )}
      <ErrorText>{error}</ErrorText>
    </Dialog>
  );
}

function CheckResult({ check, onClose }: { check: BackupCheck; onClose: () => void }) {
  const item = (good: boolean, text: string) => (
    <li className={good ? 'check-ok' : 'check-bad'}>
      <span aria-hidden="true">{good ? '✓' : '✗'}</span> {text}
    </li>
  );
  return (
    <>
      <p className={check.ok ? 'notice' : 'warning'}>
        {check.ok
          ? 'This backup could replace the company: it opens, is sound, and matches your books as they were.'
          : 'This backup has problems; see below.'}
      </p>
      <ul className="plain drill">
        {item(true, 'Opens with this passphrase')}
        {item(
          check.integrity === 'ok',
          check.integrity === 'ok' ? 'The database is sound' : `Damaged: ${check.integrity}`,
        )}
        {item(
          !check.upgradeError,
          check.upgradeError
            ? `Can't be brought up to this version of EasyBooks: ${check.upgradeError}`
            : 'Opens in this version of EasyBooks',
        )}
        {item(
          check.sameCompany,
          check.sameCompany ? `Of ${check.legalName}` : `Of another company: ${check.legalName}`,
        )}
        {item(
          check.differences.length === 0,
          check.differences.length === 0
            ? `Every account balance matches your books as of ${formatDateTime(check.asOf)} (${check.entries.toLocaleString('en-US')} ${check.entries === 1 ? 'entry' : 'entries'})`
            : `${check.differences.length} account balance${check.differences.length === 1 ? '' : 's'} differ from your books as of ${formatDateTime(check.asOf)}`,
        )}
        {item(
          check.missingAttachments.length === 0,
          check.attachments === 0
            ? 'No attachments'
            : check.missingAttachments.length === 0
              ? `All ${check.attachments} attachments are in the company or backup folder`
              : `${check.missingAttachments.length} of ${check.attachments} attachments are missing: ${check.missingAttachments.join(', ')}`,
        )}
      </ul>
      {check.differences.length > 0 && (
        <>
          <table className="list">
            <thead>
              <tr>
                <th>Account</th>
                <th className="num">In the backup</th>
                <th className="num">Your books then</th>
              </tr>
            </thead>
            <tbody>
              {check.differences.map((d) => (
                <tr key={d.account}>
                  <td>{d.account}</td>
                  <td className="num">{formatMoney(d.backup)}</td>
                  <td className="num">{formatMoney(d.live)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">
            Debits minus credits. Entries changed in place or deleted since the backup show here
            (the company allows changing posted transactions); the audit log has the{' '}
            {check.changesSince.toLocaleString('en-US')} changes made since.
          </p>
        </>
      )}
      {check.differences.length === 0 && check.changesSince > 0 && (
        <p className="muted small">
          {check.changesSince.toLocaleString('en-US')} changes have been made since this backup.
        </p>
      )}
      <div className="buttons">
        <button onClick={onClose}>Done</button>
      </div>
    </>
  );
}

function RestoreDialog(props: { backup: BackupFile; onClose: () => void }) {
  const [passphrase, setPassphrase] = useState('');
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const { busy, error, run } = useAction();

  return (
    <Dialog title="Restore this backup" onClose={busy ? undefined : props.onClose}>
      <p>
        Backup from <strong>{formatDateTime(props.backup.at)}</strong>. The company goes back to how
        it was then; everything since is replaced. The current version is backed up first, so this
        can be undone.
      </p>
      {!preview ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => setPreview(await db.previewBackup(props.backup.name, passphrase)));
          }}
        >
          <TextField
            label="Passphrase of that backup"
            type="password"
            value={passphrase}
            onChange={setPassphrase}
            autoFocus
            hint="The passphrase the company had when the backup was made. After the restore it is the company's passphrase again."
          />
          <div className="buttons">
            <button type="submit" disabled={busy || !passphrase}>
              Check backup
            </button>
            <button type="button" className="secondary" onClick={props.onClose}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <p>
            <strong>{preview.legalName}</strong>, last activity{' '}
            {formatDateTime(preview.latestActivity)}.
          </p>
          <div className="buttons">
            <button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await db.restoreBackup(props.backup.name, passphrase);
                  props.onClose();
                })
              }
            >
              {busy ? 'Restoring…' : 'Restore'}
            </button>
            <button className="secondary" disabled={busy} onClick={props.onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
      <ErrorText>{error}</ErrorText>
    </Dialog>
  );
}

export function BackupsPage({ status }: { status: SessionStatus }) {
  const [backups, setBackups] = useState<BackupFile[]>([]);
  const [folder, setFolder] = useState<FileSystemDirectoryHandle | null>(null);
  const [folderInUse, setFolderInUse] = useState(true);
  const [restoring, setRestoring] = useState<BackupFile | null>(null);
  const [testing, setTesting] = useState<BackupFile | null>(null);
  const { busy, error, run } = useAction();
  const companyId = status.companyId!;

  useEffect(() => {
    void (async () => {
      setBackups(await db.listBackups());
      const chosen = await getBackupFolder(companyId);
      setFolder(chosen);
      setFolderInUse(
        !chosen || (await chosen.queryPermission({ mode: 'readwrite' })) === 'granted',
      );
    })();
  }, [companyId, status.latestBackupAt, status.lastSavedAt]);

  const refresh = async () => setBackups(await db.listBackups());

  const chooseFolder = () =>
    run(async () => {
      const dir = await pickFolder('backup-folder');
      if (!dir) return;
      await setBackupFolder(companyId, dir);
      await db.setBackupDir(dir);
      setFolder(dir);
      setFolderInUse(true);
      await refresh();
    });

  const grantAccess = () =>
    run(async () => {
      if (folder && (await ensureReadWrite(folder))) {
        await db.setBackupDir(folder);
        setFolderInUse(true);
        await refresh();
      }
    });

  const useDefault = () =>
    run(async () => {
      await setBackupFolder(companyId, null);
      await db.setBackupDir(null);
      setFolder(null);
      setFolderInUse(true);
      await refresh();
    });

  return (
    <section>
      <h2>Backups</h2>
      <p className="muted">
        A backup is an encrypted copy of the company file, made on the first save of each day and
        then every 4 hours while you work. The newest 30 are kept. Each opens with the passphrase
        the company had when it was made.
      </p>
      <p>
        Backups go to{' '}
        {folder ? (
          <>
            the folder <strong>{folder.name}</strong>, in a folder of their own for this company
            {!folderInUse &&
              ' (EasyBooks needs permission again, so they currently go to the company folder)'}
          </>
        ) : (
          <>
            the <code>backups</code> folder inside the company folder
          </>
        )}
        . For a copy off this computer, choose a folder that is synced to cloud storage or on
        another drive.
      </p>
      <div className="buttons">
        <button
          disabled={busy || status.readOnly}
          onClick={() =>
            run(async () => {
              await db.backupNow();
              await refresh();
            })
          }
        >
          Back up now
        </button>
        <button className="secondary" disabled={busy || status.readOnly} onClick={chooseFolder}>
          Choose backup folder…
        </button>
        {folder && !folderInUse && (
          <button className="secondary" disabled={busy} onClick={grantAccess}>
            Allow access to {folder.name}
          </button>
        )}
        {folder && (
          <button className="secondary" disabled={busy || status.readOnly} onClick={useDefault}>
            Use the company folder again
          </button>
        )}
      </div>
      <ErrorText>{error}</ErrorText>
      {backups.length === 0 ? (
        <p className="muted">No backups in this folder yet.</p>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Made</th>
              <th>Size</th>
              <th>Note</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {backups.map((b) => (
              <tr key={b.name}>
                <td title={b.name}>{formatDateTime(b.at)}</td>
                <td>{formatBytes(b.size)}</td>
                <td className="muted">{describeLabel(b.label)}</td>
                <td>
                  <button
                    className="link"
                    title="Check this backup could replace the company, without restoring it"
                    onClick={() => setTesting(b)}
                  >
                    Test…
                  </button>{' '}
                  <button
                    className="link"
                    disabled={status.readOnly}
                    onClick={() => setRestoring(b)}
                  >
                    Restore…
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {restoring && (
        <RestoreDialog
          backup={restoring}
          onClose={() => {
            setRestoring(null);
            void refresh();
          }}
        />
      )}
      {testing && <TestDialog backup={testing} onClose={() => setTesting(null)} />}
      <ExportSection />
    </section>
  );
}

function ExportSection() {
  const { busy, error, run } = useAction();
  return (
    <>
      <h3>Export</h3>
      <p className="muted">
        Take everything out of EasyBooks, to keep or to open in other software. Unlike backups,{' '}
        <strong>exports are not encrypted</strong>: anyone with the file can read these books.
      </p>
      <div className="buttons">
        <button
          className="secondary"
          disabled={busy}
          title="Every table as CSV and JSON, a journal with dollar amounts, and the attachments"
          onClick={() =>
            void run(async () => {
              const { fileName, bytes } = await db.exportData();
              download(fileName, bytes as Uint8Array<ArrayBuffer>, 'application/zip');
            })
          }
        >
          {busy ? 'Exporting…' : 'Export all data (.zip)'}
        </button>
        <button
          className="secondary"
          disabled={busy}
          title="The company database, decrypted, for any SQLite tool"
          onClick={() =>
            void run(async () => {
              if (
                !confirm(
                  'Save a decrypted copy of the company database? Anyone with the file can read all of these books.',
                )
              )
                return;
              const { fileName, bytes } = await db.sqliteCopy();
              download(fileName, bytes as Uint8Array<ArrayBuffer>, 'application/vnd.sqlite3');
            })
          }
        >
          Decrypted database copy (.sqlite)
        </button>
      </div>
      <ErrorText>{error}</ErrorText>
    </>
  );
}
