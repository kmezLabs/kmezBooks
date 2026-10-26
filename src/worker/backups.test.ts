import { describe, expect, it } from 'vitest';
import {
  backupDue,
  backupName,
  backupOverdue,
  listBackups,
  parseBackupName,
  pruneBackups,
  readBackup,
  writeBackup,
} from './backups';
import { FakeDir, asDir } from './testing/fakeDir';

const bytes = (s: string) => new TextEncoder().encode(s);
const at = (iso: string) => new Date(iso);

describe('backup names', () => {
  it('round-trips the time and an optional label', () => {
    const t = at('2026-10-26T15:30:05Z');
    expect(backupName(t)).toBe('company-2026-10-26T15-30-05Z.ebk');
    expect(parseBackupName(backupName(t))).toEqual({ at: t, label: null });
    expect(parseBackupName(backupName(t, 'before-upgrade'))).toEqual({
      at: t,
      label: 'before-upgrade',
    });
  });

  it('ignores other files', () => {
    expect(parseBackupName('company.ebk')).toBeNull();
    expect(parseBackupName('notes.txt')).toBeNull();
    expect(parseBackupName('company-2026-13-45T99-99-99Z.ebk')).toBeNull();
  });
});

describe('backup schedule (DF-9)', () => {
  it('backs up the first save, the first save of a new day, and every 4 hours', () => {
    const latest = new Date(2026, 9, 26, 9, 0);
    expect(backupDue(null, latest)).toBe(true);
    expect(backupDue(latest, new Date(2026, 9, 26, 12, 59))).toBe(false);
    expect(backupDue(latest, new Date(2026, 9, 26, 13, 0))).toBe(true);
    expect(backupDue(new Date(2026, 9, 26, 23, 0), new Date(2026, 9, 27, 0, 5))).toBe(true);
  });

  it('warns when the newest backup is more than 7 days old', () => {
    const now = at('2026-10-26T12:00:00Z');
    expect(backupOverdue(null, now)).toBe(true);
    expect(backupOverdue(at('2026-10-20T12:00:00Z'), now)).toBe(false);
    expect(backupOverdue(at('2026-10-19T11:59:00Z'), now)).toBe(true);
  });
});

describe('backup files', () => {
  it('writes, lists newest first, and reads back', async () => {
    const dir = new FakeDir();
    await writeBackup(asDir(dir), bytes('old'), at('2026-10-01T10:00:00Z'));
    await writeBackup(asDir(dir), bytes('new'), at('2026-10-02T10:00:00Z'));
    dir.files.set('readme.txt', dir.files.get(backupName(at('2026-10-01T10:00:00Z')))!);
    const list = await listBackups(asDir(dir));
    expect(list.map((b) => b.name)).toEqual([
      'company-2026-10-02T10-00-00Z.ebk',
      'company-2026-10-01T10-00-00Z.ebk',
    ]);
    expect(list[0]!.size).toBe(3);
    expect(new TextDecoder().decode(await readBackup(asDir(dir), list[0]!.name))).toBe('new');
  });

  it('never overwrites a backup with the same time', async () => {
    const dir = new FakeDir();
    const t = at('2026-10-01T10:00:00Z');
    const a = await writeBackup(asDir(dir), bytes('a'), t);
    const b = await writeBackup(asDir(dir), bytes('b'), t);
    expect(a).not.toBe(b);
    expect(dir.text(a)).toBe('a');
    expect(dir.text(b)).toBe('b');
  });

  it('removes a half-written backup when the write fails', async () => {
    const dir = new FakeDir();
    dir.failNextWrite = true;
    await expect(writeBackup(asDir(dir), bytes('x'), at('2026-10-01T10:00:00Z'))).rejects.toThrow();
    expect(await listBackups(asDir(dir))).toEqual([]);
  });

  it('keeps only the newest backups, and never all of them', async () => {
    const dir = new FakeDir();
    for (let d = 1; d <= 5; d++) {
      await writeBackup(asDir(dir), bytes(String(d)), at(`2026-10-0${d}T10:00:00Z`));
    }
    expect(await pruneBackups(asDir(dir), 3)).toEqual([
      'company-2026-10-02T10-00-00Z.ebk',
      'company-2026-10-01T10-00-00Z.ebk',
    ]);
    expect((await listBackups(asDir(dir))).length).toBe(3);
    await pruneBackups(asDir(dir), 0);
    expect((await listBackups(asDir(dir))).length).toBe(1);
  });
});
