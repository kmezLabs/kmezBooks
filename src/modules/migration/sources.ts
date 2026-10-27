// Reading the owner's folder of QuickBooks exports (MG-2: one run accepts many
// files). The folder is only read; nothing is written to it.

import type { SourceFile } from './analysis';

const MAX_DEPTH = 3;
const MAX_FILES = 1000;

/** Every .xlsx file in `dir` and its subfolders, with its path inside `dir`. */
export async function readExportFolder(
  dir: FileSystemDirectoryHandle,
  prefix = '',
  depth = 0,
  out: SourceFile[] = [],
): Promise<SourceFile[]> {
  for await (const [name, handle] of dir.entries()) {
    if (out.length >= MAX_FILES) break;
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') {
      if (depth < MAX_DEPTH && !name.startsWith('.')) {
        await readExportFolder(handle as FileSystemDirectoryHandle, path, depth + 1, out);
      }
    } else if (/\.xlsx$/i.test(name) && !name.startsWith('~$')) {
      const file = await (handle as FileSystemFileHandle).getFile();
      out.push({ path, bytes: new Uint8Array(await file.arrayBuffer()) });
    }
  }
  return out;
}

/** Files the owner picked one by one instead of a folder. */
export async function readPickedFiles(files: File[]): Promise<SourceFile[]> {
  return Promise.all(
    files
      .filter((f) => /\.xlsx$/i.test(f.name))
      .map(async (f) => ({ path: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
  );
}
