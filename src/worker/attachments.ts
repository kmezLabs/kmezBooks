// Attachments (GL-4, EX-2): receipts and documents linked to an entry. Each is
// encrypted with the company's data key and written once as
// attachments/<id>.eba in the company folder, with a copy in the backup folder.
// The database records name, type, size and hash. Files are never rewritten or
// deleted, so restoring an older database backup still finds them.

import type { OpenCompany } from './company';
import { AppError, AttachmentMissingError } from './errors';
import type { Database } from './sqlite';

export const ATTACHMENT_DIR = 'attachments';
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface AttachmentRow {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  addedAt: string;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function writeOnce(
  dir: FileSystemDirectoryHandle,
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
) {
  const folder = await dir.getDirectoryHandle(ATTACHMENT_DIR, { create: true });
  const handle = await folder.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes);
    await writable.close();
  } catch (e) {
    await writable.abort().catch(() => {});
    throw e;
  }
}

export function listAttachments(db: Database, entity: string, entityId: string): AttachmentRow[] {
  return db
    .selectObjects(
      `SELECT id, file_name, mime_type, size, added_at FROM attachment
       WHERE entity = ? AND entity_id = ? ORDER BY added_at, id`,
      [entity, entityId],
    )
    .map((r) => ({
      id: String(r.id),
      fileName: String(r.file_name),
      mimeType: String(r.mime_type),
      size: Number(r.size),
      addedAt: String(r.added_at),
    }));
}

/** Encrypt and store a file, then record it. The caller saves the database. */
export async function addAttachment(
  company: OpenCompany,
  backupDir: FileSystemDirectoryHandle | null,
  entity: string,
  entityId: string,
  file: File,
): Promise<AttachmentRow> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new AppError(`${file.name} is larger than 25 MB.`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const id = crypto.randomUUID();
  const encrypted = await company.encryptBlob(bytes);
  await writeOnce(company.dir, `${id}.eba`, encrypted);
  // A copy beside the backups, so a lost company folder doesn't take its receipts along
  if (backupDir) await writeOnce(backupDir, `${id}.eba`, encrypted).catch(() => {});
  const row: AttachmentRow = {
    id,
    fileName: file.name || 'attachment',
    mimeType: file.type || 'application/octet-stream',
    size: bytes.byteLength,
    addedAt: new Date().toISOString(),
  };
  company.db.exec({
    sql: `INSERT INTO attachment (id, company_id, entity, entity_id, file_name, mime_type, size, sha256, added_at)
          VALUES (?, (SELECT id FROM company), ?, ?, ?, ?, ?, ?, ?)`,
    bind: [
      id,
      entity,
      entityId,
      row.fileName,
      row.mimeType,
      row.size,
      await sha256Hex(bytes),
      row.addedAt,
    ],
  });
  return row;
}

/** Read and decrypt an attachment, checking it is the file that was recorded. */
export async function openAttachment(
  company: OpenCompany,
  id: string,
): Promise<{ fileName: string; mimeType: string; bytes: Uint8Array<ArrayBuffer> }> {
  const row = company.db.selectObjects(
    'SELECT file_name, mime_type, sha256 FROM attachment WHERE id = ?',
    [id],
  )[0];
  if (!row) throw new AttachmentMissingError('That attachment no longer exists.');
  let encrypted: Uint8Array<ArrayBuffer>;
  try {
    const folder = await company.dir.getDirectoryHandle(ATTACHMENT_DIR);
    const file = await (await folder.getFileHandle(`${id}.eba`)).getFile();
    encrypted = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new AttachmentMissingError(
      `The file for ${String(row.file_name)} is missing from the company's attachments folder. A copy may be in the backup folder's attachments folder.`,
    );
  }
  const bytes = await company.decryptBlob(encrypted);
  if ((await sha256Hex(bytes)) !== String(row.sha256)) {
    throw new AttachmentMissingError(
      `The file for ${String(row.file_name)} doesn't match what was attached.`,
    );
  }
  return { fileName: String(row.file_name), mimeType: String(row.mime_type), bytes };
}

/** Unlink an attachment. The encrypted file stays in the folder. */
export function removeAttachment(db: Database, id: string): void {
  db.exec({ sql: 'DELETE FROM attachment WHERE id = ?', bind: [id] });
}
