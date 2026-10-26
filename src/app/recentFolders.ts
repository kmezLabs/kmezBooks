// Recently opened company folders (DF-1). The browser keeps only these folder
// handles, never any books. Handles live in IndexedDB because they can't be
// stored anywhere else; clearing site data just empties this list.

import { get, set } from 'idb-keyval';

export interface RecentFolder {
  name: string;
  handle: FileSystemDirectoryHandle;
  lastOpened: number;
}

const KEY = 'recent-company-folders';
const MAX = 10;

export async function listRecentFolders(): Promise<RecentFolder[]> {
  return ((await get<RecentFolder[]>(KEY)) ?? []).sort((a, b) => b.lastOpened - a.lastOpened);
}

export async function rememberFolder(name: string, handle: FileSystemDirectoryHandle) {
  const others: RecentFolder[] = [];
  for (const f of await listRecentFolders()) {
    if (!(await f.handle.isSameEntry(handle))) others.push(f);
  }
  await set(KEY, [{ name, handle, lastOpened: Date.now() }, ...others].slice(0, MAX));
}

export async function forgetFolder(handle: FileSystemDirectoryHandle) {
  const keep: RecentFolder[] = [];
  for (const f of await listRecentFolders()) {
    if (!(await f.handle.isSameEntry(handle))) keep.push(f);
  }
  await set(KEY, keep);
}

/**
 * Make sure we may read and write the folder. Must run from a click handler:
 * Chrome only shows the permission prompt in response to a user gesture.
 */
export async function ensureReadWrite(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const mode = { mode: 'readwrite' } as const;
  if ((await handle.queryPermission(mode)) === 'granted') return true;
  return (await handle.requestPermission(mode)) === 'granted';
}

export function folderPickerSupported(): boolean {
  return typeof window.showDirectoryPicker === 'function';
}

/** Ask the owner for a folder. Returns undefined if they cancel. */
export async function pickFolder(): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    return await window.showDirectoryPicker!({
      id: 'company-folder',
      mode: 'readwrite',
      startIn: 'documents',
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return undefined;
    throw e;
  }
}
