import { describe, expect, it } from 'vitest';
import { COMPANY_FILE, readCompanyFile, writeCompanyFile } from './companyFolder';
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

  it('says a folder without company.ebk is not a company folder', async () => {
    await expect(readCompanyFile(asDir(new FakeDir()))).rejects.toMatchObject({
      name: 'NotACompanyFileError',
    });
  });
});
