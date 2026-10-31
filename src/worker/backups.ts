// Versioned encrypted backups (DF-9). A backup is a byte-for-byte copy of a
// saved company.kmb, so it opens with the passphrase that was current when it
// was made. Backups are found by listing the backup folder; their names carry
// the time, so nothing about them is stored in the database.

import { safeName } from './exportCompany';

export const BACKUP_DIR = 'backups';
export const KEEP_BACKUPS = 30;
export const BACKUP_EVERY_MS = 4 * 60 * 60_000;
export const WARN_AFTER_DAYS = 7;

export interface BackupFile {
  name: string;
  at: Date;
  size: number;
  label: string | null;
}

// company-2026-10-26T15-30-00Z.kmb or company-2026-10-26T15-30-00Z-before-upgrade.kmb;
// .ebk for backups made before the rename from EasyBooks, which are kept and restored alike
const NAME =
  /^company-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z(?:-([a-z0-9-]+))?\.(?:kmb|ebk)$/;

export function backupName(at: Date, label?: string): string {
  const stamp = at.toISOString().slice(0, 19).replaceAll(':', '-');
  return `company-${stamp}Z${label ? `-${label}` : ''}.kmb`;
}

export function parseBackupName(name: string): { at: Date; label: string | null } | null {
  const m = NAME.exec(name);
  if (!m) return null;
  const at = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
  return Number.isNaN(at.getTime()) ? null : { at, label: m[5] ?? null };
}

/** The first save of each day gets a backup, then one every few hours while work goes on. */
export function backupDue(latest: Date | null, now: Date): boolean {
  if (!latest) return true;
  return (
    latest.toDateString() !== now.toDateString() ||
    now.getTime() - latest.getTime() >= BACKUP_EVERY_MS
  );
}

export function backupOverdue(latest: Date | null, now: Date): boolean {
  return !latest || now.getTime() - latest.getTime() > WARN_AFTER_DAYS * 24 * 60 * 60_000;
}

export async function defaultBackupDir(
  companyDir: FileSystemDirectoryHandle,
): Promise<FileSystemDirectoryHandle> {
  return companyDir.getDirectoryHandle(BACKUP_DIR, { create: true });
}

/**
 * A company's own folder inside a backup folder the owner chose, so several
 * companies can share one (a synced folder, say) without listing, restoring
 * or pruning each other's backups. Named after the company, and found again
 * by its id if the company is renamed: "Acme LLC [1a2b3c4d]".
 */
export async function companyBackupDir(
  chosen: FileSystemDirectoryHandle,
  companyId: string,
  legalName: string,
): Promise<FileSystemDirectoryHandle> {
  const tag = `[${companyId.slice(0, 8)}]`;
  for await (const [name, handle] of chosen.entries()) {
    if (handle.kind === 'directory' && name.endsWith(tag)) {
      return handle as FileSystemDirectoryHandle;
    }
  }
  return chosen.getDirectoryHandle(`${safeName(legalName)} ${tag}`, { create: true });
}

/** Newest first. Files that aren't backups are ignored. */
export async function listBackups(dir: FileSystemDirectoryHandle): Promise<BackupFile[]> {
  const found: BackupFile[] = [];
  for await (const [name, handle] of dir.entries()) {
    const parsed = handle.kind === 'file' ? parseBackupName(name) : null;
    if (!parsed) continue;
    const file = await (handle as FileSystemFileHandle).getFile();
    found.push({ name, at: parsed.at, size: file.size, label: parsed.label });
  }
  return found.sort((a, b) => b.at.getTime() - a.at.getTime() || b.name.localeCompare(a.name));
}

/** Write a backup atomically, never over an existing one. Returns its name. */
export async function writeBackup(
  dir: FileSystemDirectoryHandle,
  bytes: Uint8Array<ArrayBuffer>,
  at: Date,
  label?: string,
): Promise<string> {
  let name = backupName(at, label);
  for (let n = 2; await exists(dir, name); n++)
    name = backupName(at, `${label ? `${label}-` : ''}${n}`);
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes);
    await writable.close();
  } catch (e) {
    await writable.abort().catch(() => {});
    await dir.removeEntry(name).catch(() => {});
    throw e;
  }
  return name;
}

/** Keep the newest `keep` backups; returns the names removed. */
export async function pruneBackups(
  dir: FileSystemDirectoryHandle,
  keep = KEEP_BACKUPS,
): Promise<string[]> {
  const old = (await listBackups(dir)).slice(Math.max(keep, 1));
  for (const b of old) await dir.removeEntry(b.name);
  return old.map((b) => b.name);
}

export async function readBackup(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const file = await (await dir.getFileHandle(name)).getFile();
  return new Uint8Array(await file.arrayBuffer());
}

async function exists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotFoundError') return false;
    throw e;
  }
}
