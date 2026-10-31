// Recently opened company folders (DF-1), and each company's chosen backup
// folder (DF-9). The browser keeps only these folder handles, never any books.
// Handles can only be stored in IndexedDB; clearing site data just empties
// these lists.

import { del, get, set } from 'idb-keyval';

export interface RecentFolder {
  name: string;
  handle: FileSystemDirectoryHandle;
  lastOpened: number;
}

const KEY = 'recent-company-folders';
const MAX = 10;

export async function listRecentFolders(): Promise<RecentFolder[]> {
  try {
    return ((await get<RecentFolder[]>(KEY)) ?? []).sort((a, b) => b.lastOpened - a.lastOpened);
  } catch {
    return [];
  }
}

async function without(handle: FileSystemDirectoryHandle): Promise<RecentFolder[]> {
  const keep: RecentFolder[] = [];
  for (const f of await listRecentFolders()) {
    if (!(await f.handle.isSameEntry(handle))) keep.push(f);
  }
  return keep;
}

export async function rememberFolder(name: string, handle: FileSystemDirectoryHandle) {
  try {
    const others = await without(handle);
    await set(KEY, [{ name, handle, lastOpened: Date.now() }, ...others].slice(0, MAX));
  } catch {
    // The recent list is a convenience; opening by folder still works
  }
}

export async function forgetFolder(handle: FileSystemDirectoryHandle) {
  try {
    await set(KEY, await without(handle));
  } catch {
    // ignore
  }
}

const backupKey = (companyId: string) => `backup-folder:${companyId}`;

export async function getBackupFolder(
  companyId: string,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return (await get<FileSystemDirectoryHandle>(backupKey(companyId))) ?? null;
  } catch {
    return null;
  }
}

export async function setBackupFolder(companyId: string, handle: FileSystemDirectoryHandle | null) {
  if (handle) await set(backupKey(companyId), handle);
  else await del(backupKey(companyId));
}

/** Do we already have read/write access, without prompting? */
export async function hasReadWrite(handle: FileSystemHandle): Promise<boolean> {
  return (await handle.queryPermission({ mode: 'readwrite' })) === 'granted';
}

/**
 * Make sure we may read and write. Must run from a click handler: Chrome only
 * shows the permission prompt in response to a user gesture.
 */
export async function ensureReadWrite(handle: FileSystemHandle): Promise<boolean> {
  if (await hasReadWrite(handle)) return true;
  return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
}

export function folderPickerSupported(): boolean {
  return typeof window.showDirectoryPicker === 'function';
}

const cancelled = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

/** Ask for a folder. Returns undefined if the owner cancels. */
export async function pickFolder(
  id = 'company-folder',
): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    return await window.showDirectoryPicker!({ id, mode: 'readwrite', startIn: 'documents' });
  } catch (e) {
    if (cancelled(e)) return undefined;
    throw e;
  }
}

/** Ask for a backup file (.kmb, or .ebk from before the rename). Returns undefined if the owner cancels. */
export async function pickBackupFile(): Promise<FileSystemFileHandle | undefined> {
  try {
    const [file] = await window.showOpenFilePicker!({
      id: 'backup-file',
      types: [
        {
          description: 'kmezBooks company file',
          accept: { 'application/octet-stream': ['.kmb', '.ebk'] },
        },
      ],
    });
    return file;
  } catch (e) {
    if (cancelled(e)) return undefined;
    throw e;
  }
}
