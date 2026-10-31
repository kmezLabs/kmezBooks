// Reading and writing a company folder on the owner's disk (DF-1 to DF-3).
//
// Saves go through createWritable(): Chrome writes to a temporary file next to
// the original and swaps it in on close(), so a crash mid-save leaves the old
// file untouched. Before every write we check that the file on disk is still
// the one we opened or last saved, so we never clobber someone else's copy.
//
// Folders made before the rename from EasyBooks hold company.ebk. It is read
// as is; the first save writes company.kmb and only then removes company.ebk.

import { CompanyExistsError, FileChangedOnDiskError, NotACompanyFileError } from './errors';

export const COMPANY_FILE = 'company.kmb';
/** The company file's name before the app was renamed from EasyBooks; read, never written */
export const LEGACY_COMPANY_FILE = 'company.ebk';

/** What we last saw on disk; compared before each write (DF-3). */
export interface FileStamp {
  lastModified: number;
  size: number;
}

function stampOf(file: File): FileStamp {
  return { lastModified: file.lastModified, size: file.size };
}

async function fileIn(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemFileHandle | undefined> {
  try {
    return await dir.getFileHandle(name);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotFoundError') return undefined;
    throw e;
  }
}

/**
 * company.kmb, or company.ebk in a folder not yet saved since the rename. An
 * empty company.kmb beside company.ebk is a first save that never finished
 * (Chrome creates the file before writing it), so company.ebk is used.
 */
export async function existingCompanyFile(
  dir: FileSystemDirectoryHandle,
): Promise<FileSystemFileHandle | undefined> {
  const current = await fileIn(dir, COMPANY_FILE);
  const legacy = await fileIn(dir, LEGACY_COMPANY_FILE);
  if (current && legacy && (await current.getFile()).size === 0) return legacy;
  return current ?? legacy;
}

export async function readCompanyFile(
  dir: FileSystemDirectoryHandle,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; stamp: FileStamp }> {
  const handle = await existingCompanyFile(dir);
  if (!handle) {
    throw new NotACompanyFileError(
      `This folder has no ${COMPANY_FILE}, so it isn't a company folder.`,
    );
  }
  const file = await handle.getFile();
  return { bytes: new Uint8Array(await file.arrayBuffer()), stamp: stampOf(file) };
}

/**
 * Write the company file atomically.
 * `expected` is the stamp from the last open/save, or null for a brand-new company
 * (which must not overwrite an existing file). Returns the new stamp.
 */
export async function writeCompanyFile(
  dir: FileSystemDirectoryHandle,
  bytes: Uint8Array<ArrayBuffer>,
  expected: FileStamp | null,
): Promise<FileStamp> {
  const existing = await existingCompanyFile(dir);
  if (expected === null && existing) {
    throw new CompanyExistsError(`This folder already holds a company (${existing.name}).`);
  }
  if (expected !== null) {
    const onDisk = existing ? stampOf(await existing.getFile()) : null;
    if (!onDisk || onDisk.lastModified !== expected.lastModified || onDisk.size !== expected.size) {
      throw new FileChangedOnDiskError(
        'The company file changed on disk since you opened it, so it was not overwritten. Save your changes as a separate copy.',
      );
    }
  }
  const converting = existing?.name === LEGACY_COMPANY_FILE;
  const handle = await dir.getFileHandle(COMPANY_FILE, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes);
    await writable.close();
  } catch (e) {
    await writable.abort().catch(() => {});
    // Don't leave an empty company.kmb in front of the good company.ebk
    if (converting) await dir.removeEntry(COMPANY_FILE).catch(() => {});
    throw e;
  }
  const stamp = stampOf(await handle.getFile());
  // company.kmb now holds the books, so an old company.ebk beside it is stale.
  // If it can't be removed, company.kmb still wins and the next save tries again.
  await dir.removeEntry(LEGACY_COMPANY_FILE).catch(() => {});
  return stamp;
}
