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
} from './ebkFormat';

// Low iteration count keeps tests fast; the count is stored in the header,
// so the code path is the same as with the production default.
const FAST = 1_000;
const plaintext = new TextEncoder().encode('SQLite format 3\0 pretend database bytes');

describe('ebk format (DF-1, Security NFR)', () => {
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
