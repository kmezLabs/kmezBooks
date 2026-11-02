// Which sections of the user guide the ? on each page shows (CO-9). The ids
// are the guide's heading ids; helpTopics.test.ts fails if a heading here is
// renamed or removed in docs/USER-GUIDE.md.

import type { Page } from './Workspace';

export const HELP_TOPICS = {
  start: ['getting-started', 'companies'],
  register: ['transactions'],
  accountsRegister: ['accounts-register'],
  journal: ['journal-entries', 'correcting-a-posted-transaction'],
  recurring: ['recurring-entries'],
  accounts: ['accounts-chart-of-accounts'],
  payees: ['payees-customers-vendors-and-other-names'],
  reports: ['reports'],
  close: ['closing-the-books'],
  invoices: ['invoices', 'receiving-payments'],
  estimates: ['estimates'],
  recurringInvoices: ['recurring-invoices'],
  items: ['products--services'],
  bills: ['purchases-bills'],
  banking: ['importing-statements', 'reviewing-transactions'],
  rules: ['bank-rules'],
  reconcile: ['reconciling'],
  migration: ['quickbooks-import'],
  company: ['company-settings-and-modules'],
  backups: ['backups', 'test-a-backup-the-restore-drill', 'restore', 'export'],
  audit: ['audit-log'],
  security: ['passphrase', 'your-passphrase'],
  m1: ['test-companies-and-the-technical-test'],
} as const satisfies Record<Page | 'start', readonly string[]>;
