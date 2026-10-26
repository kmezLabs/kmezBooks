import { describe, expect, it } from 'vitest';
import * as errors from './errors';

describe('worker errors', () => {
  // The UI matches errors by name, and the production build shortens class
  // names, so every class must spell its own name out
  it.each(Object.entries(errors))('%s sets its own name', (exportName, ErrorClass) => {
    const e = new ErrorClass('message');
    expect(e.name).toBe(exportName);
    expect(e.message).toBe('message');
    expect(e).toBeInstanceOf(Error);
  });
});
