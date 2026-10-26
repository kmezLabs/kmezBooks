// Errors that cross the worker boundary. Comlink keeps `name` and `message`,
// so the UI matches on `name`, not on `instanceof`.

export class AppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The file isn't an EasyBooks company file, or uses a format this app can't read. */
export class NotACompanyFileError extends AppError {}

/** The data key couldn't be unwrapped: almost always a wrong passphrase (US-1). */
export class WrongPassphraseError extends AppError {}

/** The key unwrapped but the body failed authentication: the file is damaged (DF-10). */
export class DamagedFileError extends AppError {}

/** The file on disk changed since it was opened or last saved; refuse to overwrite (DF-3). */
export class FileChangedOnDiskError extends AppError {}

/** The folder already holds a company; refuse to create another over it (DF-1). */
export class CompanyExistsError extends AppError {}

/** The company was written by a newer app version (DF-11). */
export class NewerSchemaError extends AppError {}

export class NoCompanyOpenError extends AppError {}
