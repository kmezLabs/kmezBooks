// Company details and modules as the UI and the worker both see them (CO-1,
// CO-4). Pure functions only: safe to import from UI code. The database's
// CHECK constraints are the backstop for this validation.

export const MODULES = ['sales', 'bills', 'expenses', 'banking', 'migration'] as const;
export type Module = (typeof MODULES)[number];

export interface CompanyDetails {
  legalName: string;
  ein: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  fiscalYearStartMonth: number;
  /** On invoices and estimates (AR-8) */
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  /** Printed at the foot of every invoice: how to pay, a thank-you */
  invoiceFooter?: string | null;
}

export interface NewCompany extends CompanyDetails {
  ownerName: string;
  /** Start with the default chart of accounts (GL-2); default true. */
  standardChart?: boolean;
  /** A test company (CO-7): "– Test" after its name, and the Development pages; default false. */
  test?: boolean;
}

const blankToNull = (s: string | null | undefined) => {
  const t = s?.trim();
  return t ? t : null;
};

/** Trim, upper-case codes, and turn blanks into nulls. */
export function normalizeDetails<T extends Partial<CompanyDetails>>(d: T): T {
  const out = { ...d };
  for (const key of [
    'ein',
    'addressLine1',
    'addressLine2',
    'city',
    'postalCode',
    'email',
    'phone',
    'website',
    'invoiceFooter',
  ] as const) {
    if (key in out) out[key] = blankToNull(out[key]);
  }
  if ('state' in out) out.state = blankToNull(out.state)?.toUpperCase() ?? null;
  if ('legalName' in out) out.legalName = (out.legalName ?? '').trim();
  return out;
}

/** Human-readable problems; empty when the details are valid. */
export function validateDetails(d: Partial<CompanyDetails>): string[] {
  const problems: string[] = [];
  if ('legalName' in d && !d.legalName?.trim()) problems.push('Enter the legal name.');
  if (d.ein && !/^\d{2}-\d{7}$/.test(d.ein)) problems.push('EIN must look like 12-3456789.');
  if (d.state && !/^[A-Z]{2}$/.test(d.state))
    problems.push('State must be a two-letter code, such as IL.');
  if (d.email && !/^[^\s@]+@[^\s@]+$/.test(d.email)) problems.push('Enter a valid email address.');
  if (d.postalCode && !/^\d{5}(-\d{4})?$/.test(d.postalCode)) {
    problems.push('ZIP code must look like 62701 or 62701-1234.');
  }
  if (
    'fiscalYearStartMonth' in d &&
    !(
      Number.isInteger(d.fiscalYearStartMonth) &&
      d.fiscalYearStartMonth! >= 1 &&
      d.fiscalYearStartMonth! <= 12
    )
  ) {
    problems.push('Fiscal year must start in a month from 1 to 12.');
  }
  return problems;
}
