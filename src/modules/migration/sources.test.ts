// Reading the owner's folder of QuickBooks exports (MG-2), on a fake folder.

import { describe, expect, it } from 'vitest';
import { FakeDir, asDir } from '../../worker/testing/fakeDir';
import { readExportFolder, readPickedFiles } from './sources';

async function put(dir: FakeDir, path: string, text = path) {
  const parts = path.split('/');
  let d = dir;
  for (const p of parts.slice(0, -1))
    d = (await d.getDirectoryHandle(p, { create: true })) as FakeDir;
  const w = await (await d.getFileHandle(parts.at(-1)!, { create: true })).createWritable();
  await w.write(text);
  await w.close();
}

describe('reading the exports folder (MG-2)', () => {
  it('reads every .xlsx in the folder and its subfolders, with its path', async () => {
    const dir = new FakeDir();
    await put(dir, 'Acme_Account List.xlsx');
    await put(dir, 'Acme 20250101-20251231/Journal.xlsx', 'journal bytes');
    await put(dir, 'Acme 20250101-20251231/General_ledger.XLSX');
    const files = await readExportFolder(asDir(dir));
    expect(files.map((f) => f.path).sort()).toEqual([
      'Acme 20250101-20251231/General_ledger.XLSX',
      'Acme 20250101-20251231/Journal.xlsx',
      'Acme_Account List.xlsx',
    ]);
    const journal = files.find((f) => f.path.endsWith('Journal.xlsx'))!;
    expect(new TextDecoder().decode(journal.bytes)).toBe('journal bytes');
  });

  it('skips other files, Excel lock files, hidden folders and folders nested too deep', async () => {
    const dir = new FakeDir();
    await put(dir, 'notes.txt');
    await put(dir, 'Journal.csv');
    await put(dir, '~$Journal.xlsx'); // Excel's lock file while the workbook is open
    await put(dir, '.git/Journal.xlsx');
    await put(dir, 'a/b/c/Three deep.xlsx');
    await put(dir, 'a/b/c/d/Four deep.xlsx');
    const files = await readExportFolder(asDir(dir));
    expect(files.map((f) => f.path)).toEqual(['a/b/c/Three deep.xlsx']);
  });

  it('reads picked files the same way, keeping only workbooks', async () => {
    const picked = [
      new File(['j'], 'Journal.xlsx'),
      new File(['n'], 'notes.txt'),
      new File(['t'], 'Trial_balance.Xlsx'),
    ];
    const files = await readPickedFiles(picked);
    expect(files.map((f) => f.path)).toEqual(['Journal.xlsx', 'Trial_balance.Xlsx']);
    expect(new TextDecoder().decode(files[0]!.bytes)).toBe('j');
  });
});
