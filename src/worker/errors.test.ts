import { describe, expect, it } from 'vitest';
import * as errors from './errors';

describe('worker errors', () => {
  // The UI matches errors by name, and the production build shortens class
  // names, so every class must spell its own name out
  const classes = Object.entries(errors).filter(
    (entry): entry is [string, typeof errors.AppError] =>
      typeof entry[1] === 'function' && entry[1].prototype instanceof Error,
  );
  it.each(classes)('%s sets its own name', (exportName, ErrorClass) => {
    const e = new ErrorClass('message');
    expect(e.name).toBe(exportName);
    expect(e.message).toBe('message');
    expect(e).toBeInstanceOf(Error);
  });

  it('turns a withdrawn folder permission into a readable error', () => {
    const denied = new DOMException(
      'The request is not allowed by the user agent or the platform in the current context.',
      'NotAllowedError',
    );
    expect(errors.fromFolderAccess(denied, 'Acme LLC')).toMatchObject({
      name: 'FolderAccessError',
      message: expect.stringContaining('“Acme LLC”'),
    });
    const other = new DOMException('not found', 'NotFoundError');
    expect(errors.fromFolderAccess(other, 'Acme LLC')).toBe(other);
  });

  it('turns schema rule errors into readable ones', () => {
    const rule = errors.fromRule(
      new Error(
        'SQLITE_CONSTRAINT_TRIGGER: sqlite3 result code 1811: GL-3: debits and credits must be equal',
      ),
    );
    expect(rule).toMatchObject({
      name: 'LedgerRuleError',
      message: 'Debits and credits must be equal.',
    });
    expect(errors.fromRule(new Error('… PC-1: this date is in a closed period'))).toMatchObject({
      name: 'ClosedPeriodError',
    });
    const other = new Error('disk I/O error');
    expect(errors.fromRule(other)).toBe(other);
  });
});
