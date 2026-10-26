// Encrypted company file format (.ebk), DF-1 and the Security NFR.
// Layout and reasoning: docs/IMPLEMENTATION-PLAN.md, "Company folder and file format".
//
//   header (plain; also the AES-GCM additional authenticated data)
//     magic "EBK1"        4
//     format version      u16
//     header length       u16
//     KDF id              u8   (1 = PBKDF2-HMAC-SHA256)
//     KDF iterations      u32
//     salt                16
//     wrapped data key    40   (AES-KW of a 256-bit AES-GCM key)
//     IV                  12   (fresh on every save)
//   body
//     AES-256-GCM ciphertext of the SQLite database
//
// A random data key encrypts the database (and, later, attachments). The
// passphrase only wraps that key, so changing the passphrase rewrites the
// header, never the attachments. Integers are big-endian.

import { DamagedFileError, NotACompanyFileError, WrongPassphraseError } from './errors';

export const PBKDF2_ITERATIONS = 600_000;

const MAGIC = [0x45, 0x42, 0x4b, 0x31]; // "EBK1"
const FORMAT_VERSION = 1;
const KDF_PBKDF2_SHA256 = 1;
const SALT_BYTES = 16;
const WRAPPED_KEY_BYTES = 40;
const IV_BYTES = 12;
const HEADER_BYTES = 4 + 2 + 2 + 1 + 4 + SALT_BYTES + WRAPPED_KEY_BYTES + IV_BYTES;
const MAX_ITERATIONS = 10_000_000;

export interface EbkHeader {
  iterations: number;
  salt: Uint8Array<ArrayBuffer>;
  wrappedKey: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
}

/** An unlocked company's key material. `dataKey` is non-extractable. */
export interface CompanyKey {
  dataKey: CryptoKey;
  iterations: number;
  salt: Uint8Array<ArrayBuffer>;
  wrappedKey: Uint8Array<ArrayBuffer>;
}

const subtle = globalThis.crypto.subtle;

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

async function deriveWrappingKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  // NFC so the same passphrase typed on different devices gives the same key
  const material = await subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase.normalize('NFC')),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

async function unwrapDataKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
  wrappedKey: Uint8Array<ArrayBuffer>,
  extractable: boolean,
): Promise<CryptoKey> {
  const kek = await deriveWrappingKey(passphrase, salt, iterations);
  try {
    return await subtle.unwrapKey('raw', wrappedKey, kek, 'AES-KW', 'AES-GCM', extractable, [
      'encrypt',
      'decrypt',
    ]);
  } catch {
    // AES-KW has a built-in integrity check, so a wrong passphrase fails here
    throw new WrongPassphraseError('Wrong passphrase.');
  }
}

/** Key material for a new company file. */
export async function createCompanyKey(
  passphrase: string,
  iterations = PBKDF2_ITERATIONS,
): Promise<CompanyKey> {
  const salt = randomBytes(SALT_BYTES);
  const kek = await deriveWrappingKey(passphrase, salt, iterations);
  const extractable = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  const wrappedKey = new Uint8Array(await subtle.wrapKey('raw', extractable, kek, 'AES-KW'));
  // Keep only a non-extractable copy in memory
  const dataKey = await subtle.unwrapKey('raw', wrappedKey, kek, 'AES-KW', 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
  return { dataKey, iterations, salt, wrappedKey };
}

/** Unlock with the passphrase stored in a file's header. Throws WrongPassphraseError. */
export async function unlockCompanyKey(header: EbkHeader, passphrase: string): Promise<CompanyKey> {
  const dataKey = await unwrapDataKey(
    passphrase,
    header.salt,
    header.iterations,
    header.wrappedKey,
    false,
  );
  return {
    dataKey,
    iterations: header.iterations,
    salt: header.salt,
    wrappedKey: header.wrappedKey,
  };
}

/** Re-wrap the same data key under a new passphrase (US-1). The data key never changes. */
export async function changePassphrase(
  key: CompanyKey,
  oldPassphrase: string,
  newPassphrase: string,
  iterations = PBKDF2_ITERATIONS,
): Promise<CompanyKey> {
  const extractable = await unwrapDataKey(
    oldPassphrase,
    key.salt,
    key.iterations,
    key.wrappedKey,
    true,
  );
  const salt = randomBytes(SALT_BYTES);
  const kek = await deriveWrappingKey(newPassphrase, salt, iterations);
  const wrappedKey = new Uint8Array(await subtle.wrapKey('raw', extractable, kek, 'AES-KW'));
  return { dataKey: key.dataKey, iterations, salt, wrappedKey };
}

function writeHeader(h: EbkHeader): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(HEADER_BYTES);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  view.setUint16(4, FORMAT_VERSION);
  view.setUint16(6, HEADER_BYTES);
  view.setUint8(8, KDF_PBKDF2_SHA256);
  view.setUint32(9, h.iterations);
  let at = 13;
  out.set(h.salt, at);
  at += SALT_BYTES;
  out.set(h.wrappedKey, at);
  at += WRAPPED_KEY_BYTES;
  out.set(h.iv, at);
  return out;
}

/** Parse and validate the plain header. Throws NotACompanyFileError. */
export function readHeader(file: Uint8Array): EbkHeader {
  if (file.byteLength < HEADER_BYTES || MAGIC.some((b, i) => file[i] !== b)) {
    throw new NotACompanyFileError('This is not an EasyBooks company file.');
  }
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const version = view.getUint16(4);
  const headerLength = view.getUint16(6);
  const kdf = view.getUint8(8);
  const iterations = view.getUint32(9);
  if (version !== FORMAT_VERSION || headerLength !== HEADER_BYTES) {
    throw new NotACompanyFileError(
      `Company file format ${version} isn't supported by this version of the app.`,
    );
  }
  if (kdf !== KDF_PBKDF2_SHA256 || iterations < 1 || iterations > MAX_ITERATIONS) {
    throw new NotACompanyFileError('The company file header is invalid.');
  }
  let at = 13;
  const salt = file.slice(at, (at += SALT_BYTES));
  const wrappedKey = file.slice(at, (at += WRAPPED_KEY_BYTES));
  const iv = file.slice(at, at + IV_BYTES);
  return { iterations, salt, wrappedKey, iv };
}

/** Encrypt a serialized SQLite database into a complete .ebk file. */
export async function encryptDatabase(
  key: CompanyKey,
  plaintext: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const header = writeHeader({
    iterations: key.iterations,
    salt: key.salt,
    wrappedKey: key.wrappedKey,
    iv: randomBytes(IV_BYTES),
  });
  const iv = header.slice(HEADER_BYTES - IV_BYTES);
  const body = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header }, key.dataKey, plaintext),
  );
  const file = new Uint8Array(header.byteLength + body.byteLength);
  file.set(header, 0);
  file.set(body, header.byteLength);
  return file;
}

/** Decrypt a complete .ebk file. Throws NotACompanyFileError or DamagedFileError. */
export async function decryptDatabase(
  key: CompanyKey,
  file: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const { iv } = readHeader(file);
  const header = file.subarray(0, HEADER_BYTES);
  const body = file.subarray(HEADER_BYTES);
  try {
    return new Uint8Array(
      await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: header }, key.dataKey, body),
    );
  } catch {
    throw new DamagedFileError(
      'The company file is damaged and cannot be read. Restore it from a backup.',
    );
  }
}

/** True if `passphrase` unlocks this key — for re-confirming it, as the closed-period override does (PC-2). */
export async function verifyPassphrase(key: CompanyKey, passphrase: string): Promise<boolean> {
  try {
    await unwrapDataKey(passphrase, key.salt, key.iterations, key.wrappedKey, false);
    return true;
  } catch {
    return false;
  }
}

// ---- attachment files (.eba) --------------------------------------------
//
//   magic "EBA1" 4 | format version u16 | IV 12 | AES-256-GCM ciphertext
//
// Encrypted with the company's data key (no passphrase material in the file),
// so a passphrase change never touches attachments. The header is the AAD.

const BLOB_MAGIC = [0x45, 0x42, 0x41, 0x31]; // "EBA1"
const BLOB_HEADER_BYTES = 4 + 2 + IV_BYTES;

export async function encryptBlob(
  key: CompanyKey,
  plaintext: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const header = new Uint8Array(BLOB_HEADER_BYTES);
  header.set(BLOB_MAGIC, 0);
  new DataView(header.buffer).setUint16(4, FORMAT_VERSION);
  const iv = randomBytes(IV_BYTES);
  header.set(iv, 6);
  const body = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header }, key.dataKey, plaintext),
  );
  const out = new Uint8Array(header.byteLength + body.byteLength);
  out.set(header, 0);
  out.set(body, header.byteLength);
  return out;
}

export async function decryptBlob(
  key: CompanyKey,
  file: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (
    file.byteLength < BLOB_HEADER_BYTES ||
    BLOB_MAGIC.some((b, i) => file[i] !== b) ||
    view.getUint16(4) !== FORMAT_VERSION
  ) {
    throw new NotACompanyFileError('This is not an EasyBooks attachment file.');
  }
  const header = file.subarray(0, BLOB_HEADER_BYTES);
  try {
    return new Uint8Array(
      await subtle.decrypt(
        { name: 'AES-GCM', iv: file.slice(6, BLOB_HEADER_BYTES), additionalData: header },
        key.dataKey,
        file.subarray(BLOB_HEADER_BYTES),
      ),
    );
  } catch {
    throw new DamagedFileError('The attachment file is damaged or belongs to another company.');
  }
}
