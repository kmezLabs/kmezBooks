import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PBKDF2_ITERATIONS,
  changePassphrase,
  createCompanyKey,
  decryptBlob,
  decryptDatabase,
  encryptBlob,
  encryptDatabase,
  readHeader,
  unlockCompanyKey,
  verifyPassphrase,
} from './kmbFormat';

// Low iteration count keeps tests fast; the count is stored in the header,
// so the code path is the same as with the production default.
const FAST = 1_000;
const plaintext = new TextEncoder().encode('SQLite format 3\0 pretend database bytes');

describe('kmb format (DF-1, Security NFR)', () => {
  it('defaults to 600,000 PBKDF2 iterations', () => {
    expect(PBKDF2_ITERATIONS).toBe(600_000);
  });

  it('round-trips a database through encrypt, header read, unlock and decrypt', async () => {
    const key = await createCompanyKey('correct horse', FAST);
    const file = await encryptDatabase(key, plaintext);

    const header = readHeader(file);
    expect(header.iterations).toBe(FAST);
    const reopened = await unlockCompanyKey(header, 'correct horse');
    expect(await decryptDatabase(reopened, file)).toEqual(plaintext);
  });

  it('does not contain the plaintext', async () => {
    const key = await createCompanyKey('pw', FAST);
    const file = await encryptDatabase(key, plaintext);
    expect(Buffer.from(file).includes(Buffer.from('SQLite format 3'))).toBe(false);
  });

  it('uses a fresh IV on every save', async () => {
    const key = await createCompanyKey('pw', FAST);
    const a = readHeader(await encryptDatabase(key, plaintext));
    const b = readHeader(await encryptDatabase(key, plaintext));
    expect(a.iv).not.toEqual(b.iv);
  });

  it('rejects a wrong passphrase with WrongPassphraseError', async () => {
    const key = await createCompanyKey('right', FAST);
    const file = await encryptDatabase(key, plaintext);
    await expect(unlockCompanyKey(readHeader(file), 'wrong')).rejects.toMatchObject({
      name: 'WrongPassphraseError',
    });
  });

  it('treats NFC and NFD forms of the same passphrase as equal', async () => {
    const key = await createCompanyKey('café', FAST);
    const file = await encryptDatabase(key, plaintext);
    const reopened = await unlockCompanyKey(readHeader(file), 'café');
    expect(await decryptDatabase(reopened, file)).toEqual(plaintext);
  });

  it('reports a damaged body as DamagedFileError', async () => {
    const key = await createCompanyKey('pw', FAST);
    const file = await encryptDatabase(key, plaintext);
    file[file.length - 1]! ^= 0xff;
    await expect(decryptDatabase(key, file)).rejects.toMatchObject({ name: 'DamagedFileError' });
  });

  it('detects tampering with the header, because the header is authenticated', async () => {
    const key = await createCompanyKey('pw', FAST);
    const file = await encryptDatabase(key, plaintext);
    // Flip a salt byte: the header still parses, but the GCM tag no longer matches
    file[13]! ^= 0x01;
    await expect(decryptDatabase(key, file)).rejects.toMatchObject({ name: 'DamagedFileError' });
  });

  it('rejects files that are not company files', () => {
    expect(() => readHeader(new TextEncoder().encode('hello'))).toThrow(
      expect.objectContaining({ name: 'NotACompanyFileError' }),
    );
    const sqlite = new Uint8Array(200);
    sqlite.set(new TextEncoder().encode('SQLite format 3'));
    expect(() => readHeader(sqlite)).toThrow(
      expect.objectContaining({ name: 'NotACompanyFileError' }),
    );
  });

  it('rejects an unknown format version', async () => {
    const key = await createCompanyKey('pw', FAST);
    const file = await encryptDatabase(key, plaintext);
    new DataView(file.buffer).setUint16(4, 99);
    expect(() => readHeader(file)).toThrow(/format 99/);
  });

  it('changes the passphrase without changing the data key (US-1)', async () => {
    const key = await createCompanyKey('old', FAST);
    const before = await encryptDatabase(key, plaintext);
    const rekeyed = await changePassphrase(key, 'old', 'new', FAST);
    const after = await encryptDatabase(rekeyed, plaintext);

    await expect(unlockCompanyKey(readHeader(after), 'old')).rejects.toMatchObject({
      name: 'WrongPassphraseError',
    });
    const unlocked = await unlockCompanyKey(readHeader(after), 'new');
    expect(await decryptDatabase(unlocked, after)).toEqual(plaintext);
    // Same data key: the new key also opens a file saved before the change,
    // which is what lets attachments and old backups stay as they are
    expect(await decryptDatabase(unlocked, before)).toEqual(plaintext);
    // ...and the old backup still opens with the passphrase current when it was made
    const old = await unlockCompanyKey(readHeader(before), 'old');
    expect(await decryptDatabase(old, before)).toEqual(plaintext);
  });

  it('refuses a passphrase change when the old passphrase is wrong', async () => {
    const key = await createCompanyKey('old', FAST);
    await expect(changePassphrase(key, 'nope', 'new', FAST)).rejects.toMatchObject({
      name: 'WrongPassphraseError',
    });
  });
});

describe('attachment files (GL-4, EX-2)', () => {
  it('round-trips with the data key, and survives a passphrase change', async () => {
    const key = await createCompanyKey('pw', FAST);
    const blob = await encryptBlob(key, plaintext);
    expect(Buffer.from(blob).includes(Buffer.from('SQLite'))).toBe(false);
    const rekeyed = await changePassphrase(key, 'pw', 'new pw', FAST);
    expect(await decryptBlob(rekeyed, blob)).toEqual(plaintext);
  });

  it("refuses tampering and another company's key", async () => {
    const key = await createCompanyKey('pw', FAST);
    const other = await createCompanyKey('pw', FAST);
    const blob = await encryptBlob(key, plaintext);
    await expect(decryptBlob(other, blob)).rejects.toMatchObject({ name: 'DamagedFileError' });
    blob[blob.length - 1]! ^= 1;
    await expect(decryptBlob(key, blob)).rejects.toMatchObject({ name: 'DamagedFileError' });
    await expect(decryptBlob(key, plaintext)).rejects.toMatchObject({
      name: 'NotACompanyFileError',
    });
  });

  it('verifies a passphrase without changing anything (PC-2)', async () => {
    const key = await createCompanyKey('right one', FAST);
    expect(await verifyPassphrase(key, 'right one')).toBe(true);
    expect(await verifyPassphrase(key, 'wrong')).toBe(false);
  });
});

describe('files from before the rename from EasyBooks', () => {
  // Made by the EasyBooks code (ebkFormat.ts at 9c95f21) with test bytes, not real books
  const fixture = (name: string) =>
    new Uint8Array(readFileSync(`src/worker/testing/fixtures/${name}`));
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  const magic = (b: Uint8Array) => text(b.subarray(0, 4));

  it('new company files and attachments start with KMB1 and KMA1', async () => {
    const key = await createCompanyKey('pw', FAST);
    expect(magic(await encryptDatabase(key, plaintext))).toBe('KMB1');
    expect(magic(await encryptBlob(key, plaintext))).toBe('KMA1');
  });

  it('an EBK1 company file and its EBA1 attachment still open', async () => {
    const file = fixture('legacy-company-EBK1.bin');
    expect(magic(file)).toBe('EBK1');
    const key = await unlockCompanyKey(readHeader(file), 'legacy passphrase');
    expect(text(await decryptDatabase(key, file))).toBe('old database bytes');
    const blob = fixture('legacy-attachment-EBA1.bin');
    expect(magic(blob)).toBe('EBA1');
    expect(text(await decryptBlob(key, blob))).toBe('old receipt bytes');
  });

  it('re-saving an old file writes the new marker, same key and passphrase', async () => {
    const file = fixture('legacy-company-EBK1.bin');
    const key = await unlockCompanyKey(readHeader(file), 'legacy passphrase');
    const saved = await encryptDatabase(key, await decryptDatabase(key, file));
    expect(magic(saved)).toBe('KMB1');
    const again = await unlockCompanyKey(readHeader(saved), 'legacy passphrase');
    expect(text(await decryptDatabase(again, saved))).toBe('old database bytes');
  });

  it('anything else is still not a company file', () => {
    const file = fixture('legacy-company-EBK1.bin');
    file.set([0x58, 0x58, 0x58, 0x31], 0);
    expect(() => readHeader(file)).toThrow(/not a kmezBooks company file/);
  });
});
