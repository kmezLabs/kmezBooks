import type { SessionStatus } from '../worker/companySession';
import { db } from '../shared/workerClient';
import { getBackupFolder, hasReadWrite, rememberFolder } from './recentFolders';

/** Bookkeeping after a company opens: recent list, and its chosen backup folder if still allowed. */
export async function afterOpen(handle: FileSystemDirectoryHandle, status: SessionStatus) {
  if (status.legalName) await rememberFolder(status.legalName, handle);
  if (!status.companyId || status.readOnly) return;
  const backupDir = await getBackupFolder(status.companyId);
  // No prompt here: if access lapsed, the Backups page asks for it again
  if (backupDir && (await hasReadWrite(backupDir))) await db.setBackupDir(backupDir);
}
