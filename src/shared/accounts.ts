// Account types, detail types and the default chart of accounts (GL-1, GL-2).
// Shared by the UI (pickers, labels) and the worker (validation, seeding).

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const TYPE_LABELS: Record<AccountType, string> = {
  asset: 'Assets',
  liability: 'Liabilities',
  equity: 'Equity',
  income: 'Income',
  expense: 'Expenses',
};

/** Assets and expenses grow with debits; the rest with credits. */
export function isDebitNormal(type: AccountType): boolean {
  return type === 'asset' || type === 'expense';
}

export interface DetailType {
  code: string;
  type: AccountType;
  name: string;
}

const d = (type: AccountType, code: string, name: string): DetailType => ({ code, type, name });

export const DETAIL_TYPES: readonly DetailType[] = [
  d('asset', 'bank', 'Bank'),
  d('asset', 'cash_on_hand', 'Cash on hand'),
  d('asset', 'undeposited_funds', 'Undeposited funds'),
  d('asset', 'accounts_receivable', 'Accounts receivable (migrated history only)'),
  d('asset', 'other_current_asset', 'Other current asset'),
  d('asset', 'prepaid_expenses', 'Prepaid expenses'),
  d('asset', 'loans_to_others', 'Loans to others'),
  d('asset', 'fixed_asset', 'Fixed asset'),
  d('asset', 'accumulated_depreciation', 'Accumulated depreciation'),
  d('asset', 'other_asset', 'Other asset'),
  d('liability', 'credit_card', 'Credit card'),
  d('liability', 'accounts_payable', 'Accounts payable (migrated history only)'),
  d('liability', 'other_current_liability', 'Other current liability'),
  d('liability', 'line_of_credit', 'Line of credit'),
  d('liability', 'payroll_liabilities', 'Payroll liabilities'),
  d('liability', 'sales_tax_payable', 'Sales tax payable'),
  d('liability', 'loan_payable', 'Loan payable'),
  d('liability', 'long_term_liability', 'Long-term liability'),
  d('equity', 'owner_contributions', "Owner's investment"),
  d('equity', 'owner_draws', "Owner's draw"),
  d('equity', 'partner_equity', "Partner's equity"),
  d('equity', 'common_stock', 'Common stock'),
  d('equity', 'retained_earnings', 'Retained earnings'),
  d('equity', 'opening_balance_equity', 'Opening balance equity'),
  d('equity', 'other_equity', 'Other equity'),
  d('income', 'sales', 'Sales of products'),
  d('income', 'service_income', 'Service income'),
  d('income', 'discounts_given', 'Discounts and refunds given'),
  d('income', 'interest_income', 'Interest earned'),
  d('income', 'other_income', 'Other income'),
  d('income', 'uncategorized_income', 'Uncategorized income'),
  d('expense', 'cost_of_goods_sold', 'Cost of goods sold'),
  d('expense', 'advertising', 'Advertising and marketing'),
  d('expense', 'bank_charges', 'Bank charges and fees'),
  d('expense', 'auto', 'Car and truck'),
  d('expense', 'contract_labor', 'Contract labor'),
  d('expense', 'depreciation', 'Depreciation'),
  d('expense', 'dues_subscriptions', 'Dues and subscriptions'),
  d('expense', 'insurance', 'Insurance'),
  d('expense', 'interest_paid', 'Interest paid'),
  d('expense', 'legal_professional', 'Legal and professional fees'),
  d('expense', 'meals', 'Meals'),
  d('expense', 'office_expenses', 'Office supplies and software'),
  d('expense', 'payroll_expenses', 'Payroll expenses'),
  d('expense', 'rent_lease', 'Rent or lease'),
  d('expense', 'repairs_maintenance', 'Repairs and maintenance'),
  d('expense', 'taxes_licenses', 'Taxes and licenses'),
  d('expense', 'travel', 'Travel'),
  d('expense', 'utilities', 'Utilities'),
  d('expense', 'other_expense', 'Other expense'),
  d('expense', 'uncategorized_expense', 'Uncategorized expense'),
];

/** Detail types that can exist only once per company. */
export const SINGLE_DETAIL_TYPES = [
  'retained_earnings',
  'opening_balance_equity',
  'undeposited_funds',
];

/** Detail types the cash-basis ledger refuses new postings to (GL-8). */
export const ACCRUAL_DETAIL_TYPES = ['accounts_receivable', 'accounts_payable'];

export function detailTypesFor(type: AccountType): DetailType[] {
  return DETAIL_TYPES.filter((t) => t.type === type);
}

export function detailType(code: string): DetailType | undefined {
  return DETAIL_TYPES.find((t) => t.code === code);
}

export interface ChartAccount {
  name: string;
  detailType: string;
}

/**
 * The default chart for a US small business on a cash basis (GL-2). No A/R or
 * A/P: on a cash basis invoices and bills don't post until paid.
 */
export const DEFAULT_CHART: readonly ChartAccount[] = [
  { name: 'Checking', detailType: 'bank' },
  { name: 'Savings', detailType: 'bank' },
  { name: 'Petty Cash', detailType: 'cash_on_hand' },
  { name: 'Undeposited Funds', detailType: 'undeposited_funds' },
  { name: 'Prepaid Expenses', detailType: 'prepaid_expenses' },
  { name: 'Furniture and Equipment', detailType: 'fixed_asset' },
  { name: 'Vehicles', detailType: 'fixed_asset' },
  { name: 'Accumulated Depreciation', detailType: 'accumulated_depreciation' },
  { name: 'Credit Card', detailType: 'credit_card' },
  { name: 'Line of Credit', detailType: 'line_of_credit' },
  { name: 'Loan Payable', detailType: 'loan_payable' },
  { name: "Owner's Investment", detailType: 'owner_contributions' },
  { name: "Owner's Draw", detailType: 'owner_draws' },
  { name: 'Opening Balance Equity', detailType: 'opening_balance_equity' },
  { name: 'Retained Earnings', detailType: 'retained_earnings' },
  { name: 'Sales', detailType: 'sales' },
  { name: 'Services', detailType: 'service_income' },
  { name: 'Discounts Given', detailType: 'discounts_given' },
  { name: 'Interest Income', detailType: 'interest_income' },
  { name: 'Other Income', detailType: 'other_income' },
  { name: 'Uncategorized Income', detailType: 'uncategorized_income' },
  { name: 'Cost of Goods Sold', detailType: 'cost_of_goods_sold' },
  { name: 'Advertising and Marketing', detailType: 'advertising' },
  { name: 'Bank Fees', detailType: 'bank_charges' },
  { name: 'Car and Truck', detailType: 'auto' },
  { name: 'Contract Labor', detailType: 'contract_labor' },
  { name: 'Depreciation', detailType: 'depreciation' },
  { name: 'Dues and Subscriptions', detailType: 'dues_subscriptions' },
  { name: 'Insurance', detailType: 'insurance' },
  { name: 'Interest Paid', detailType: 'interest_paid' },
  { name: 'Legal and Professional Fees', detailType: 'legal_professional' },
  { name: 'Meals', detailType: 'meals' },
  { name: 'Office Supplies and Software', detailType: 'office_expenses' },
  { name: 'Rent or Lease', detailType: 'rent_lease' },
  { name: 'Repairs and Maintenance', detailType: 'repairs_maintenance' },
  { name: 'Taxes and Licenses', detailType: 'taxes_licenses' },
  { name: 'Travel', detailType: 'travel' },
  { name: 'Utilities', detailType: 'utilities' },
  { name: 'Other Expenses', detailType: 'other_expense' },
  { name: 'Uncategorized Expense', detailType: 'uncategorized_expense' },
];

/** An account as the worker returns it to the UI. */
export interface AccountRow {
  id: string;
  number: string | null;
  name: string;
  /** "Parent:Child" with every ancestor, as QuickBooks shows it. */
  fullName: string;
  type: AccountType;
  detailType: string;
  parentId: string | null;
  depth: number;
  active: boolean;
  description: string | null;
  /** Posted debits minus credits, in cents. */
  balance: number;
  hasHistory: boolean;
}

export interface AccountInput {
  name: string;
  number?: string | null;
  type: AccountType;
  detailType: string;
  parentId?: string | null;
  description?: string | null;
}

export function validateAccount(a: AccountInput): string[] {
  const problems: string[] = [];
  if (!a.name?.trim()) problems.push('Enter a name.');
  if (a.name?.includes(':'))
    problems.push('Names cannot contain ":", which separates sub-accounts.');
  if (!ACCOUNT_TYPES.includes(a.type)) problems.push('Choose a type.');
  const dt = detailType(a.detailType);
  if (!dt || dt.type !== a.type) problems.push('Choose a detail type that fits the account type.');
  return problems;
}
