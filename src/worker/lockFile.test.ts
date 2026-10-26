import { describe, expect, it } from 'vitest';
import {
  LOCK_FILE,
  STALE_AFTER_MS,
  checkLock,
  releaseLock,
  writeLock,
  type LockInfo,
} from './lockFile';
import { FakeDir, asDir } from './testing/fakeDir';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const lock = (sessionId: string, heartbeatAt = NOW): LockInfo => ({
  sessionId,
  device: 'Office PC',
  user: 'Owner',
  openedAt: new Date(heartbeatAt).toISOString(),
  heartbeatAt: new Date(heartbeatAt).toISOString(),
});

describe('company lock file (DF-4)', () => {
  it('is free when there is no lock file', async () => {
    expect(await checkLock(asDir(new FakeDir()), 'me', NOW)).toEqual({ kind: 'free' });
  });

  it('recognises our own lock', async () => {
    const dir = new FakeDir();
    await writeLock(asDir(dir), lock('me'));
    expect(await checkLock(asDir(dir), 'me', NOW)).toEqual({ kind: 'ours' });
  });

  it('reports a fresh lock held by someone else', async () => {
    const dir = new FakeDir();
    await writeLock(asDir(dir), lock('them', NOW - 10_000));
    expect(await checkLock(asDir(dir), 'me', NOW)).toMatchObject({
      kind: 'held',
      stale: false,
      lock: { device: 'Office PC' },
    });
  });

  it('reports a lock as stale once its heartbeat stops', async () => {
    const dir = new FakeDir();
    await writeLock(asDir(dir), lock('them', NOW - STALE_AFTER_MS - 1));
    expect(await checkLock(asDir(dir), 'me', NOW)).toMatchObject({ kind: 'held', stale: true });
  });

  it('treats an unreadable lock file as stale', async () => {
    const dir = new FakeDir();
    await writeLock(asDir(dir), lock('x'));
    dir.touchExternally(LOCK_FILE, new TextEncoder().encode('{not json'));
    expect(await checkLock(asDir(dir), 'me', NOW)).toMatchObject({ kind: 'held', stale: true });
  });

  it('releases only its own lock', async () => {
    const dir = new FakeDir();
    await writeLock(asDir(dir), lock('them'));
    await releaseLock(asDir(dir), 'me');
    expect(dir.files.has(LOCK_FILE)).toBe(true);
    await releaseLock(asDir(dir), 'them');
    expect(dir.files.has(LOCK_FILE)).toBe(false);
  });
});
