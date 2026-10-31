import { describe, expect, it } from 'vitest';
import {
  COMPANY_FILE,
  LEGACY_COMPANY_FILE,
  readCompanyFile,
  writeCompanyFile,
} from './companyFolder';
import { FakeDir, asDir } from './testing/fakeDir';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (d: FakeDir) => new TextDecoder().decode(d.files.get(COMPANY_FILE)!.data);

describe('company folder (DF-1 to DF-3)', () => {
  it('creates, reads back and saves with a matching stamp', async () => {
    const dir = new FakeDir();
    const s1 = await writeCompanyFile(asDir(dir), bytes('v1'), null);
    const read = await readCompanyFile(asDir(dir));
    expect(new TextDecoder().decode(read.bytes)).toBe('v1');
    expect(read.stamp).toEqual(s1);

    const s2 = await writeCompanyFile(asDir(dir), bytes('v2'), s1);
    expect(text(dir)).toBe('v2');
    expect(s2).not.toEqual(s1);
  });

  it('refuses to create a company over an existing one', async () => {
    const dir = new FakeDir();
    await writeCompanyFile(asDir(dir), bytes('first'), null);
    await expect(writeCompanyFile(asDir(dir), bytes('second'), null)).rejects.toMatchObject({
      name: 'CompanyExistsError',
    });
    expect(text(dir)).toBe('first');
  });

  it('refuses to overwrite a file that changed on disk since it was opened (DF-3)', async () => {
    const dir = new FakeDir();
    const stamp = await writeCompanyFile(asDir(dir), bytes('mine'), null);
    dir.touchExternally(COMPANY_FILE, bytes('theirs'));
    await expect(writeCompanyFile(asDir(dir), bytes('mine v2'), stamp)).rejects.toMatchObject({
      name: 'FileChangedOnDiskError',
    });
    expect(text(dir)).toBe('theirs');
  });

  it('refuses to save when the file was deleted from disk', async () => {
    const dir = new FakeDir();
    const stamp = await writeCompanyFile(asDir(dir), bytes('mine'), null);
    dir.files.delete(COMPANY_FILE);
    await expect(writeCompanyFile(asDir(dir), bytes('mine v2'), stamp)).rejects.toMatchObject({
      name: 'FileChangedOnDiskError',
    });
  });

  it('keeps the old file when a write fails part-way', async () => {
    const dir = new FakeDir();
    const stamp = await writeCompanyFile(asDir(dir), bytes('good'), null);
    dir.failNextWrite = true;
    await expect(writeCompanyFile(asDir(dir), bytes('new'), stamp)).rejects.toThrow(/disk full/);
    expect(text(dir)).toBe('good');
    // ...and the stamp is still valid, so the next save works
    await writeCompanyFile(asDir(dir), bytes('new'), stamp);
    expect(text(dir)).toBe('new');
  });

  it('says a folder without company.kmb is not a company folder', async () => {
    await expect(readCompanyFile(asDir(new FakeDir()))).rejects.toMatchObject({
      name: 'NotACompanyFileError',
    });
  });

  describe('folders saved before the rename from EasyBooks (company.ebk)', () => {
    async function oldFolder(content = 'old books') {
      const dir = new FakeDir();
      await dir.getFileHandle(LEGACY_COMPANY_FILE, { create: true });
      dir.touchExternally(LEGACY_COMPANY_FILE, bytes(content));
      return dir;
    }
    const names = (d: FakeDir) => [...d.files.keys()].sort();

    it('opens company.ebk as it is', async () => {
      const dir = await oldFolder();
      const read = await readCompanyFile(asDir(dir));
      expect(new TextDecoder().decode(read.bytes)).toBe('old books');
      expect(names(dir)).toEqual([LEGACY_COMPANY_FILE]);
    });

    it('the first save writes company.kmb, then removes company.ebk', async () => {
      const dir = await oldFolder();
      const { stamp } = await readCompanyFile(asDir(dir));
      const saved = await writeCompanyFile(asDir(dir), bytes('new books'), stamp);
      expect(names(dir)).toEqual([COMPANY_FILE]);
      expect(text(dir)).toBe('new books');
      const again = await readCompanyFile(asDir(dir));
      expect(again.stamp).toEqual(saved);
    });

    it('still refuses when company.ebk changed on disk (DF-3)', async () => {
      const dir = await oldFolder();
      const { stamp } = await readCompanyFile(asDir(dir));
      dir.touchExternally(LEGACY_COMPANY_FILE, bytes('theirs'));
      await expect(writeCompanyFile(asDir(dir), bytes('mine'), stamp)).rejects.toMatchObject({
        name: 'FileChangedOnDiskError',
      });
      expect(names(dir)).toEqual([LEGACY_COMPANY_FILE]);
    });

    it('a failed first save leaves company.ebk alone and no company.kmb', async () => {
      const dir = await oldFolder();
      const { stamp } = await readCompanyFile(asDir(dir));
      dir.failNextWrite = true;
      await expect(writeCompanyFile(asDir(dir), bytes('new'), stamp)).rejects.toThrow(/disk full/);
      expect(names(dir)).toEqual([LEGACY_COMPANY_FILE]);
      expect(dir.text(LEGACY_COMPANY_FILE)).toBe('old books');
    });

    it('an empty company.kmb left by an unfinished first save loses to company.ebk', async () => {
      const dir = await oldFolder();
      await dir.getFileHandle(COMPANY_FILE, { create: true });
      const read = await readCompanyFile(asDir(dir));
      expect(new TextDecoder().decode(read.bytes)).toBe('old books');
      await writeCompanyFile(asDir(dir), bytes('new books'), read.stamp);
      expect(names(dir)).toEqual([COMPANY_FILE]);
      expect(text(dir)).toBe('new books');
    });

    it('with both files, company.kmb is the books and the next save removes company.ebk', async () => {
      const dir = await oldFolder('stale');
      const stamp = await writeCompanyFile(asDir(dir), bytes('current'), null).catch(() => null);
      expect(stamp).toBeNull(); // a new company can't go where company.ebk is
      await dir.getFileHandle(COMPANY_FILE, { create: true });
      dir.touchExternally(COMPANY_FILE, bytes('current'));
      const read = await readCompanyFile(asDir(dir));
      expect(new TextDecoder().decode(read.bytes)).toBe('current');
      await writeCompanyFile(asDir(dir), bytes('current v2'), read.stamp);
      expect(names(dir)).toEqual([COMPANY_FILE]);
    });
  });
});
