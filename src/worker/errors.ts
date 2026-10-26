// Errors that cross the worker boundary. Comlink keeps `name` and `message`,
// so the UI matches on `name`, not on `instanceof`. Each class spells its name
// out as a string: class names are shortened in the production build.

export class AppError extends Error {
  override name = 'AppError';
}

/** The file isn't an EasyBooks company file, or uses a format this app can't read. */
export class NotACompanyFileError extends AppError {
  override name = 'NotACompanyFileError';
}

/** The data key couldn't be unwrapped: almost always a wrong passphrase (US-1). */
export class WrongPassphraseError extends AppError {
  override name = 'WrongPassphraseError';
}

/** The key unwrapped but the body failed authentication: the file is damaged (DF-10). */
export class DamagedFileError extends AppError {
  override name = 'DamagedFileError';
}

/** The file on disk changed since it was opened or last saved; refuse to overwrite (DF-3). */
export class FileChangedOnDiskError extends AppError {
  override name = 'FileChangedOnDiskError';
}

/** The folder already holds a company; refuse to create another over it (DF-1). */
export class CompanyExistsError extends AppError {
  override name = 'CompanyExistsError';
}

/** The company was written by a newer app version (DF-11). */
export class NewerSchemaError extends AppError {
  override name = 'NewerSchemaError';
}

export class NoCompanyOpenError extends AppError {
  override name = 'NoCompanyOpenError';
}

/** The company is open read-only, because another device holds it or the owner chose to (DF-4). */
export class ReadOnlyError extends AppError {
  override name = 'ReadOnlyError';
}

/** Another device has the company open (DF-4). */
export class CompanyLockedError extends AppError {
  override name = 'CompanyLockedError';
}

/** The same company is already open in another tab or window of this browser (DF-4). */
export class OpenInAnotherTabError extends AppError {
  override name = 'OpenInAnotherTabError';
}

/** A backup belongs to a different company than the one it would replace (DF-10). */
export class WrongCompanyError extends AppError {
  override name = 'WrongCompanyError';
}
