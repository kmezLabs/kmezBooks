import { describe, expect, it } from 'vitest';
import { BACKUP_DIR } from './backups';
import { CompanySession } from './companySession';
import { FakeDir, asDir } from './testing/fakeDir';
import { ACME } from './testing/fixtures';

const backupsIn = (dir: FakeDir) => [...dir.files.keys()].filter((n) => n.endsWith('.ebk')).length;

function newSession() {
  let t = new Date(2026, 9, 28, 9, 0, 0);
  const session = new CompanySession({
    iterations: 1_000,
    heartbeatMs: 0,
    saveDelayMs: 10_000,
    now: () => t,
  });
  return { session, later: () => (t = new Date(t.getTime() + 60_000)) };
}

describe('backup folders (DF-9)', () => {
  it('gives each company its own folder inside a shared backup folder', async () => {
    const shared = new FakeDir('Synced backups');
    const { session, later } = newSession();

    const acme = new FakeDir('Acme');
    await session.create(asDir(acme), ACME, 'pw', 'PC');
    await session.setBackupDir(asDir(shared));
    later();
    await session.backupNow();
    await session.close();

    const other = new FakeDir('Other');
    await session.create(asDir(other), { ...ACME, legalName: 'Other Co' }, 'pw', 'PC');
    await session.setBackupDir(asDir(shared));
    later();
    await session.backupNow();
    expect(await session.listBackups()).toHaveLength(1);

    const folders = [...shared.dirs.keys()].sort();
    expect(folders).toEqual([
      expect.stringMatching(/^Acme LLC \[/),
      expect.stringMatching(/^Other Co \[/),
    ]);
    expect(backupsIn(shared)).toBe(0);
    expect(folders.map((f) => backupsIn(shared.dirs.get(f)!))).toEqual([1, 1]);

    // Renamed, the company keeps its folder, found by its id
    session.updateDetails({ legalName: 'Other Renamed Co' });
    later();
    await session.backupNow();
    expect([...shared.dirs.keys()]).toHaveLength(2);
    expect(await session.listBackups()).toHaveLength(2);
  });

  it('doesn’t carry one company’s backup folder over to the next one opened', async () => {
    const chosen = new FakeDir('Chosen');
    const { session, later } = newSession();
    const acme = new FakeDir('Acme');
    await session.create(asDir(acme), ACME, 'pw', 'PC');
    await session.setBackupDir(asDir(chosen));
    await session.close();

    const other = new FakeDir('Other');
    await session.create(asDir(other), { ...ACME, legalName: 'Other Co' }, 'pw', 'PC');
    later();
    await session.backupNow();
    // Into its own company folder, not the first company's chosen one
    expect([...chosen.dirs.keys()]).toEqual([expect.stringMatching(/^Acme LLC \[/)]);
    expect(backupsIn(chosen.dirs.values().next().value!)).toBe(1); // Acme's own, from closing it
    expect(backupsIn(other.dirs.get(BACKUP_DIR)!)).toBe(2);
  });
});
