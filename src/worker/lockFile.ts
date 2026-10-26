// One editor per company (DF-4). While a company is open for editing, the app
// keeps company.lock in its folder with a heartbeat. Another device that finds
// a fresh lock opens the company read-only; a lock whose heartbeat has stopped
// (a crash, a closed laptop) is stale and the owner may clear it.
//
// The lock file is plain JSON, not encrypted: it holds only a device name,
// the user's name and times.

export const LOCK_FILE = 'company.lock';
export const HEARTBEAT_MS = 30_000;
export const STALE_AFTER_MS = 2 * 60_000;

export interface LockInfo {
  sessionId: string;
  device: string;
  user: string;
  openedAt: string;
  heartbeatAt: string;
}

export type LockState =
  { kind: 'free' } | { kind: 'ours' } | { kind: 'held'; lock: LockInfo; stale: boolean };

export async function readLock(dir: FileSystemDirectoryHandle): Promise<LockInfo | null> {
  let text: string;
  try {
    text = await (await (await dir.getFileHandle(LOCK_FILE)).getFile()).text();
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotFoundError') return null;
    throw e;
  }
  try {
    const lock = JSON.parse(text) as Partial<LockInfo>;
    if (typeof lock.sessionId === 'string' && typeof lock.heartbeatAt === 'string') {
      return {
        sessionId: lock.sessionId,
        device: String(lock.device ?? 'another device'),
        user: String(lock.user ?? 'someone'),
        openedAt: String(lock.openedAt ?? lock.heartbeatAt),
        heartbeatAt: lock.heartbeatAt,
      };
    }
  } catch {
    // fall through: an unreadable lock is treated as stale
  }
  return {
    sessionId: 'unknown',
    device: 'another device',
    user: 'someone',
    openedAt: new Date(0).toISOString(),
    heartbeatAt: new Date(0).toISOString(),
  };
}

export function isStale(lock: LockInfo, now: number): boolean {
  const beat = Date.parse(lock.heartbeatAt);
  return Number.isNaN(beat) || now - beat > STALE_AFTER_MS;
}

export async function checkLock(
  dir: FileSystemDirectoryHandle,
  sessionId: string,
  now: number,
): Promise<LockState> {
  const lock = await readLock(dir);
  if (!lock) return { kind: 'free' };
  if (lock.sessionId === sessionId) return { kind: 'ours' };
  return { kind: 'held', lock, stale: isStale(lock, now) };
}

export async function writeLock(dir: FileSystemDirectoryHandle, lock: LockInfo): Promise<void> {
  const handle = await dir.getFileHandle(LOCK_FILE, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(lock, null, 2));
  await writable.close();
}

/** Remove the lock, but only if it is still ours. */
export async function releaseLock(
  dir: FileSystemDirectoryHandle,
  sessionId: string,
): Promise<void> {
  const lock = await readLock(dir);
  if (lock?.sessionId !== sessionId) return;
  try {
    await dir.removeEntry(LOCK_FILE);
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'NotFoundError')) throw e;
  }
}
