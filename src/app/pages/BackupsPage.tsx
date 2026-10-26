// Backups: list, back up now, where they go, and restore (DF-9, DF-10).

import { useEffect, useState } from 'react';
import type { BackupFile } from '../../worker/backups';
import type { BackupPreview } from '../../worker/company';
import type { SessionStatus } from '../../worker/companySession';
import { db } from '../../shared/workerClient';
import { ensureReadWrite, getBackupFolder, pickFolder, setBackupFolder } from '../recentFolders';
import { Dialog, ErrorText, TextField, formatBytes, formatDateTime, useAction } from '../ui';

const LABELS: Record<string, string> = {
  'before-restore': 'before a restore',
  'before-upgrade': 'before an app upgrade',
};
const describeLabel = (label: string | null) =>
  label ? (LABELS[label.replace(/-v\d+$|-\d+$/, '')] ?? label) : '';

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
            the folder <strong>{folder.name}</strong>
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
    </section>
  );
}
