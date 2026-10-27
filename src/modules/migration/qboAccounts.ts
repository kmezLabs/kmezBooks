// QuickBooks Online account types and detail types → this app's (MG-1, MG-4).
// QuickBooks has more detail types than this app; anything not listed falls
// back to the general one for its type, and the owner can change it in the
// dry run before importing.

import type { AccountType } from '../../shared/accounts';

export interface MappedType {
  type: AccountType;
  detailType: string;
}

/** Lower-case letters and digits only: "Owner's Equity" → "ownersequity". */
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const BY_TYPE: Record<string, MappedType> = {
  bank: { type: 'asset', detailType: 'bank' },
  accountsreceivablear: { type: 'asset', detailType: 'accounts_receivable' },
  accountsreceivable: { type: 'asset', detailType: 'accounts_receivable' },
  othercurrentassets: { type: 'asset', detailType: 'other_current_asset' },
  othercurrentasset: { type: 'asset', detailType: 'other_current_asset' },
  fixedassets: { type: 'asset', detailType: 'fixed_asset' },
  fixedasset: { type: 'asset', detailType: 'fixed_asset' },
  otherassets: { type: 'asset', detailType: 'other_asset' },
  otherasset: { type: 'asset', detailType: 'other_asset' },
  creditcard: { type: 'liability', detailType: 'credit_card' },
  accountspayableap: { type: 'liability', detailType: 'accounts_payable' },
  accountspayable: { type: 'liability', detailType: 'accounts_payable' },
  othercurrentliabilities: { type: 'liability', detailType: 'other_current_liability' },
  othercurrentliability: { type: 'liability', detailType: 'other_current_liability' },
  longtermliabilities: { type: 'liability', detailType: 'long_term_liability' },
  longtermliability: { type: 'liability', detailType: 'long_term_liability' },
  equity: { type: 'equity', detailType: 'other_equity' },
  income: { type: 'income', detailType: 'other_income' },
  otherincome: { type: 'income', detailType: 'other_income' },
  costofgoodssold: { type: 'expense', detailType: 'cost_of_goods_sold' },
  expenses: { type: 'expense', detailType: 'other_expense' },
  expense: { type: 'expense', detailType: 'other_expense' },
  otherexpense: { type: 'expense', detailType: 'other_expense' },
};

/** Detail types with a counterpart here, by the account type they belong to. */
const BY_DETAIL: Record<AccountType, Record<string, string>> = {
  asset: {
    checking: 'bank',
    savings: 'bank',
    moneymarket: 'bank',
    trustaccounts: 'bank',
    rentsheldintrust: 'bank',
    cashonhand: 'cash_on_hand',
    undepositedfunds: 'undeposited_funds',
    prepaidexpenses: 'prepaid_expenses',
    loanstoothers: 'loans_to_others',
    loanstoofficers: 'loans_to_others',
    loanstostockholders: 'loans_to_others',
    employeecashadvances: 'loans_to_others',
    accumulateddepreciation: 'accumulated_depreciation',
    accumulatedamortization: 'accumulated_depreciation',
  },
  liability: {
    payrolltaxpayable: 'payroll_liabilities',
    payrollclearing: 'payroll_liabilities',
    salestaxpayable: 'sales_tax_payable',
    lineofcredit: 'line_of_credit',
    notespayable: 'loan_payable',
    loanpayable: 'loan_payable',
    shareholdernotespayable: 'loan_payable',
  },
  equity: {
    retainedearnings: 'retained_earnings',
    openingbalanceequity: 'opening_balance_equity',
    commonstock: 'common_stock',
    partnersequity: 'partner_equity',
    ownerspaycontributions: 'owner_contributions',
    partnercontributions: 'owner_contributions',
    ownersdraw: 'owner_draws',
    partnerdistributions: 'owner_draws',
  },
  income: {
    salesofproductincome: 'sales',
    servicefeeincome: 'service_income',
    discountsrefundsgiven: 'discounts_given',
    interestearned: 'interest_income',
  },
  expense: {
    suppliesmaterialscogs: 'cost_of_goods_sold',
    costoflaborcos: 'cost_of_goods_sold',
    otherscostsofservicecos: 'cost_of_goods_sold',
    shippingfreightdeliverycos: 'cost_of_goods_sold',
    equipmentrentalcos: 'cost_of_goods_sold',
    advertisingpromotional: 'advertising',
    bankcharges: 'bank_charges',
    auto: 'auto',
    insurance: 'insurance',
    interestpaid: 'interest_paid',
    legalprofessionalfees: 'legal_professional',
    officegeneraladministrativeexpenses: 'office_expenses',
    rentorleaseofbuildings: 'rent_lease',
    equipmentrental: 'rent_lease',
    repairmaintenance: 'repairs_maintenance',
    taxespaid: 'taxes_licenses',
    travel: 'travel',
    travelmeals: 'meals',
    entertainmentmeals: 'meals',
    utilities: 'utilities',
    duessubscriptions: 'dues_subscriptions',
    payrollexpenses: 'payroll_expenses',
    depreciation: 'depreciation',
    amortization: 'depreciation',
  },
};

/** QuickBooks's type and detail type (as in its Account List) → ours, or null for an unknown type. */
export function mapQboType(qboType: string, qboDetail: string): MappedType | null {
  const base = BY_TYPE[key(qboType)];
  if (!base) return null;
  // Cost of goods sold stays COGS whatever its detail, so the P&L groups it
  if (base.detailType === 'cost_of_goods_sold') return base;
  const detail = BY_DETAIL[base.type][key(qboDetail)];
  return detail ? { type: base.type, detailType: detail } : base;
}

/** Where a balance sheet heading puts an account, for accounts missing from the Account List. */
export function typeFromStatementPath(path: string[]): AccountType | null {
  const top = path.map((p) => p.toLowerCase());
  if (top.some((p) => p === 'equity')) return 'equity';
  if (top.some((p) => p === 'liabilities')) return 'liability';
  if (top.some((p) => p === 'assets')) return 'asset';
  return null;
}

/** QuickBooks marks accounts deleted after they were used: "Old Bank (deleted)". */
export function isDeletedName(name: string): boolean {
  return /\(deleted\)$/i.test(name.trim());
}
