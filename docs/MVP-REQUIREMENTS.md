# Accounting App — MVP Requirements

Oct 24, 2026 · revised Oct 26, 2026 (standalone PWA with company files on your own disk; cash-basis ledger; owner-only MVP) · @Khaleel

## Overview

The MVP is a double-entry bookkeeping app that keeps the books for four US small businesses in one app, covering sales, bills, expenses, banking and the core financial statements.

It is a standalone, installable Chrome PWA with no server behind it. Each company's books are an encrypted company folder on your own disk, which the app opens the way a desktop program opens a document. All four sets of books are kept on a cash basis with calendar fiscal years.

- **Primary user:** the owner of all four businesses. A bookkeeper can be added later by checking out a company to them (S).
- **Inspiration:** QuickBooks Online, trimmed to the essentials.
- **MVP scope:** chart of accounts, journal entries, period close, customers and invoicing, payments, vendors and bills, expenses, bank and card statement import, reconciliation, QuickBooks migration, on-demand P&L and balance sheet, passphrase unlock with an audit log, and company file handling (open, save, lock, backup).
- **Design rule:** every feature is a module that can be added or removed without touching the ledger.

The MVP maps to these items from the QuickBooks feature list: 1–4, 7–11, 16–18, 23, 27–30, 56–59, 64, plus 68 (multiple companies), which is promoted to the MVP because you run four businesses.

## Architecture principles

The app has no backend and no database server. The PWA holds the screens, the workflow logic and the database engine. SQLite, compiled to WebAssembly and running in a Web Worker, enforces the rules that protect the books. The books themselves live in folders on your disk.

```
┌──────────────────────────────────────────────────────────────────────┐
│ Chrome PWA, installed, runs fully offline (React, TypeScript)        │
│ [Sales/AR] [Bills/AP] [Expenses] [Banking] [Reports] [Migration] [+] │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ Ledger service: postEntry(), open/save, backups, events          │ │
│ └──────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────┬───────────────────────────────────┘
                                   ▼  Web Worker
┌──────────────────────────────────────────────────────────────────────┐
│ SQLite (WebAssembly): the open company's database, held in memory    │
│ [Balanced entries] [Closing-date lock] [Void-not-delete] [Audit log] │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ Ledger: accounts, journal entries, journal lines                 │ │
│ └──────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────┬───────────────────────────────────┘
                                   ▼  open and save (File System Access)
┌──────────────────────────────────────────────────────────────────────┐
│ Your disk: one company folder per company, wherever you choose       │
│ encrypted database, encrypted attachments/, backups/                 │
└──────────────────────────────────────────────────────────────────────┘
```

- **No server for data.** The app's code is static files. During development it runs from a local server on your machine. Once installed it runs offline, and the books never leave your disk except as encrypted backup files.
- **Your files, not the browser's.** Each company is a folder you choose on your disk (DF-1), holding its encrypted database and encrypted attachments. The browser stores only the list of recently opened folders, so clearing Chrome's site data or reinstalling the app loses no books, and your normal backups already cover them. Company isolation (CO-3) holds by construction.
- **Opened into memory, saved whole.** SQLite can't write a file picked from your disk in small pieces, as it normally does, so the app loads the company's database into memory and saves the whole file back shortly after each change (DF-2). Each save is atomic: a crash leaves either the old file or the new one, never a broken file, and at worst loses the last few seconds of work. The whole file is encrypted on save with the browser's built-in cryptography.
- **The ledger is cash basis.** Only cash movements post to the ledger. Invoices and bills are documents in their modules and don't post when created; a payment against one posts on the payment date, spread pro rata over the document's lines (GL-8). This matches the key output, a cash-basis P&L and balance sheet. Migrated history also loads straight from QuickBooks Online's cash-basis reports, so every year ties out exactly. The trade-off: accrual reporting later needs A/R and A/P posting added, and won't cover migrated history.
- **Integrity rules live in the database schema.** Balanced entries, the closing-date lock, void-not-delete and the audit log are `CHECK` constraints and triggers in SQLite. They hold no matter which module writes the data. SQLite has no deferred constraints, so an entry's lines are written as a draft and a trigger checks the balance when its status changes to posted.
- **Workflow logic lives in TypeScript.** Matching, categorization rules, invoice behavior, payment allocation, reports and the migration importer are TypeScript. A bug there can't unbalance or corrupt the books, because the schema refuses invalid writes.
- **One posting function.** Modules post through a single `postEntry()` function in the ledger service, which writes the entry and its lines in one transaction. No other code writes ledger rows.
- **One editor per company at a time.** There is no sync. A lock file in the company folder and a check that the file hasn't changed since it was opened stop two copies from overwriting each other (DF-3, DF-4). Handing a company to a bookkeeper by check-out is S (DF-5 to DF-8).
- **Backups.** Company folders are ordinary files, so your usual backups cover them. The app also keeps its own versioned, encrypted backups and can restore them (DF-9, DF-10).
- **Modules are optional.** Each module is a folder of PWA screens plus its own tables, toggled per company (CO-4).
- **Events for extension.** The ledger service emits an in-app event after each committed posting, so future modules react to posted documents without editing existing ones.
- **Schema changes are versioned.** Every schema or rule change is a numbered SQL migration file in git, bundled with the app and applied when a company is opened (version tracked with `PRAGMA user_version`).

### Tech stack

| Layer | Choice |
| --- | --- |
| Client | React + TypeScript PWA (Vite, Workbox), built for Chrome |
| Database | Official SQLite WebAssembly build in a Web Worker, with the open company's database in memory |
| Company files | Opened from and saved to your disk with Chrome's File System Access API; whole-file encryption with the browser's built-in WebCrypto: AES-GCM, with the key derived from the passphrase by PBKDF2 |
| Money | Integer cents in SQLite (`INTEGER`); integer cents or a decimal library in TypeScript |
| Migrations and tests | Numbered SQL migration files in git; Vitest for TypeScript logic and for integrity rules, run against the real schema |
| Hosting | GitHub Pages (decided Nov 1): a home page at https://mawadk.github.io/kmezBooks/, the app at …/app/ and the user guide at …/guide/, published from the `release` branch. The local server (`localhost:4180`) still works |
| Backups | Your usual file backups, plus encrypted versioned copies written by the app |

The earlier plan, self-hosted Supabase over PostgreSQL on the home lab (Oct 24), was replaced on Oct 26 by this standalone design: no server to run, full offline use, and each company in files you control.

## Functional requirements

Each requirement has a stable ID (module prefix + number) so it can be traced, reprioritized or dropped. Priority: **M** = must for MVP, **S** = should if time allows.

### Companies (CO)

| ID | Requirement | Pri |
| --- | --- | --- |
| CO-1 | Create and manage multiple companies, each with its own legal name, EIN, address, fiscal year start and books | M |
| CO-2 | Switch between companies in one app; every screen shows the active company, and so do the browser tab and the installed app's title bar ("Acme LLC – kmezBooks" in a tab, "kmezBooks - Acme LLC" in the app, added Oct 31) | M |
| CO-3 | Data is fully isolated per company: each company is a separate folder and database, and no transaction can reference another company's records | M |
| CO-4 | Enable or disable feature modules per company | M |
| CO-5 | Copy chart of accounts and settings from one company to a new one | S |
| CO-6 | Status bar at the bottom of every screen (owner, Oct 31): save state, the last backup, online or offline, short messages after actions (exports, postings, payments, imports, backups), and on the far right the app's version and the build (git commit and date) it came from. Built Oct 31 | S |
| CO-7 | A company can be created as a test company (owner, Nov 1): its name shows “– Test” at the top, in the browser tab and in the installed app's title bar, and only test companies have the Development pages (the M1 technical test, which writes made-up history). Set when the company is created and never changed; companies made before it are real companies. Built Nov 1 | S |
| CO-8 | About panel (owner, Nov 2), opened from the About link at the top (start screen and open company) or the version in the status bar: the version and build; that your books never leave your computer and no telemetry is sent (the app goes online only to load itself and check for updates); links to the home page, user guide and source; the copyright, the GPL and no-warranty notice, and the license files. Built Nov 2 | S |
| CO-9 | Help on every page (owner, Nov 2): a **?** in the top bar (between Close company and About, so it stays in view while the page scrolls), and on the start screen, opens that page's sections of the user guide in a panel beside the page. The guide is built into the app from `docs/USER-GUIDE.md`, so help always matches the guide and works offline; links inside it move within the panel (with Back), and one opens the guide online. Built Nov 2 | S |
| CO-10 | Settings dialog (owner, Nov 2), opened from the gear in the top bar and on the start screen; settings there belong to this computer, not to a company. Theme: System (follows the computer's light or dark setting; the default), Light, Dark, Grey, High contrast or Warm, applied at once and remembered by the browser. Also **This device** (device name for the lock file and the idle time before a company closes), moved there from the Passphrase and device page, which becomes Passphrase. Every theme meets WCAG AA contrast (High contrast AAA); printing is always light. Built Nov 2 | S |

### Ledger core (GL)

| ID | Requirement | Pri |
| --- | --- | --- |
| GL-1 | Chart of accounts with the five types (asset, liability, equity, income, expense), detail types and sub-accounts | M |
| GL-2 | Seed a default US small-business chart of accounts on company creation | M |
| GL-3 | Every transaction posts balanced debit/credit lines to the ledger; unbalanced postings are rejected | M |
| GL-4 | Manual journal entries with memo, date and attachments | M |
| GL-5 | Recurring journal entries (monthly, quarterly or yearly on a day of the month, with an optional end), such as depreciation and amortization. Nothing runs while the app is closed: what came due posts when the company is opened, and a notice says what posted. A due date in a closed period, or one that can't post, waits with the reason, to post with the passphrase or skip. Owner's decision, Oct 28: was S, with reversing entries now GL-12 | M |
| GL-6 | By default posted entries are never changed or deleted; corrections are voids or adjusting entries (the Edit buttons void and enter the corrected copy in one step), with full audit history. A per-company setting, which needs the passphrase to turn on, allows changing posted entries in place and deleting them. Closed periods, reconciled entries (BK-8) and QuickBooks history (no delete) stay protected, and the audit log keeps every version | M |
| GL-7 | Inactivate (not delete) accounts that have history | M |
| GL-9 | Transactions register, the home panel when a company opens: every entry (or every income and expense) in date order, oldest first and opening at the latest; filters at the top (defaults: this year to date, all transactions, oldest first); with one account chosen, that account's payments, deposits and balance after each transaction, and the account is remembered per company; income, expense and net totals and an Add Transaction button (expense or income dialog) at the bottom; edit, void and (where GL-6 allows) delete from the list | M |
| GL-8 | Cash-basis ledger: only cash movements post. Invoices and bills don't post when created; a payment against one posts on its date, spread pro rata over the document's lines, to the cent, so the parts always add up exactly to the payment. A/R and A/P accounts take no new postings; they exist only for migrated history | M |
| GL-10 | Re-enter a voided entry: a new entry filled in from it (date, ref, payee, memo, lines), checked and posted like any other; the void stays on record. Added at the owner's request, Oct 28 | M |
| GL-11 | Payees: one list of the names on transactions, unique ignoring case, each a customer, a vendor, both, or just a name. Name fields suggest payees and a new name adds one. Rename a payee on every transaction, merge two payees into one, make one inactive, and see its transactions in the register. Added at the owner's request, Oct 28 | M |
| GL-12 | Reversing journal entries (split from GL-5, Oct 28) | S |
| GL-13 | Accounts register (owner, Oct 29; first built as separate bank and credit card registers, made one page the same day): any one account at a time, picked from a drop-down grouped by type, with its balance beside it; QuickBooks-style columns and the balance after each transaction; for bank, card and other balance sheet accounts also a reconciled mark (R reconciled, C cleared in the reconciliation in progress) and the reconciled balance. Built Oct 29 | S |
| GL-14 | Transfers between bank, cash and card accounts (owner, Oct 29), such as paying the card from checking or moving money to savings, from Add Transaction or the Accounts register's Transfer button; not income or an expense. Built Oct 29 | S |

### Period close (PC)

| ID | Requirement | Pri |
| --- | --- | --- |
| PC-1 | Set a closing date per company; edits on or before it are blocked | M |
| PC-2 | Owner override to change a closed period by re-entering the company passphrase, each use logged in the audit trail | M |
| PC-3 | Year-end close rolls net income into retained earnings automatically | M |

### Customers and sales (AR)

Owner's decision, Oct 28 (later): invoices and bills are built as module M9 for a new company, and any company can turn them on (Modules page); they start off. Still cash basis: documents never post, payments do (GL-8). Bringing open QuickBooks invoices and bills over (MG-9) stays out until needed.

Owner's decision, Oct 28: none of the four companies uses invoices, estimates or bills today (their QuickBooks history is expenses, deposits, checks and journal entries), so AR-2 to AR-8 and AP-2 to AP-5 are S: built when a company needs them. Customer and vendor records stay M.

| ID | Requirement | Pri |
| --- | --- | --- |
| AR-1 | Customer records: name, contact, billing/shipping address, terms, notes | M |
| AR-2 | Products and services list with name, rate and income account (no inventory tracking). Built Oct 28 (M9 slice 1) | S |
| AR-3 | Create estimates and convert them to invoices. Built Oct 28 (M9 slice 1) | S |
| AR-4 | Create invoices with line items, discounts, due date from terms; produce a PDF and hand it to your mail app to send (share sheet where Chrome supports it; otherwise download plus a prefilled email). Sending directly from the app needs a server and is out of scope. Built Oct 28 (M9 slices 1 and 2): Send… shares the PDF through the share sheet where Chrome offers one, or downloads it and opens the mail app with the email filled in | S |
| AR-5 | Invoice statuses: draft, sent, partially paid, paid, overdue, void. Built Oct 28 (M9 slice 1): paid, partly paid and overdue are worked out from payments and the due date | S |
| AR-6 | Sales receipts for paid-on-the-spot sales. Not planned (owner, Oct 28): Add Transaction on the Transactions page records a sale paid on the spot | S |
| AR-7 | Record full or partial payments against one or more invoices; deposit to a bank or Undeposited Funds; each payment posts its income pro rata over the invoice's lines (GL-8). In the MVP a payment can't exceed what is still owed (customer credits are a future Receivables extra). Built Oct 28 (M9 slice 1) with deposits straight to a bank account (owner's choice); Undeposited Funds is not used | S |
| AR-8 | Invoice template with each company's logo and details. Built Oct 28 (M9 slice 2): logo, contact details and a footer, on the Company page | S |
| AR-9 | Recurring invoices (created when the company is next opened, since nothing runs while the app is closed). Built Oct 28 (M9 slice 3): made as drafts to check and send, with a notice; Make recurring from an invoice | S |

### Vendors and bills (AP)

| ID | Requirement | Pri |
| --- | --- | --- |
| AP-1 | Vendor records: name, contact, address, terms, default expense account, 1099 flag (flag only) | M |
| AP-2 | Enter bills with line items by account, due date from terms, attachments. Built Oct 28 (M9 slice 4): the vendor's terms and default category fill in; receipts and PDFs attached | S |
| AP-3 | Pay one or many bills, recording check, ACH or card, fully or partially; each payment posts its expenses pro rata over the bill's lines (GL-8) and can't exceed what is still owed. Built Oct 28 (M9 slice 4): one payment per vendor and check, from a bank or credit card account | S |
| AP-4 | Bill statuses: open, partially paid, paid, overdue, void. Built Oct 28 (M9 slice 4) | S |
| AP-5 | List of bills due, sorted by due date. Built Oct 28 (M9 slice 4): Bills due, with what is overdue and due within a week | S |

### Expenses (EX)

| ID | Requirement | Pri |
| --- | --- | --- |
| EX-1 | Record an expense or check paid directly from a bank or card account, split across accounts | M |
| EX-2 | Attach receipt images or PDFs to any expense (stored encrypted in the company folder's attachments, and included in backups) | M |
| EX-3 | Optional payee and customer (for billable tracking later) | M |

### Banking (BK)

| ID | Requirement | Pri |
| --- | --- | --- |
| BK-1 | Import bank and credit card statements in .qbo (QuickBooks Web Connect) format, which all your banks and cards provide | M |
| BK-2 | Also accept .ofx/.qfx, CSV and Excel, with a column mapping saved per account | S |
| BK-3 | Review queue for imported transactions: categorize, match, split, exclude | M |
| BK-4 | Match imported transactions to existing payments, bill payments and expenses | M |
| BK-5 | Rules that auto-categorize by payee, amount or description | M |
| BK-6 | Duplicate detection on import, using the .qbo transaction IDs plus date and amount, including transactions already brought over from QuickBooks | M |
| BK-7 | Reconcile an account against a statement: ending balance, check off cleared items, difference must be zero. A card kept as a parent account with sub-accounts per card holder is reconciled together with its sub-accounts | M |
| BK-8 | Keep reconciliation reports; warn when a reconciled transaction is edited | M |
| BK-9 | Transfers between accounts, auto-matched when both sides appear in imports | M |

### Reports (RP)

| ID | Requirement | Pri |
| --- | --- | --- |
| RP-1 | Profit and loss, cash basis, for any date range | M |
| RP-2 | Balance sheet, cash basis, as of any date | M |
| RP-3 | Run either report on demand for any company, with presets (this month, this quarter, year to date, last year) and custom dates | M |
| RP-4 | Trial balance and general ledger detail (also used to verify the QuickBooks migration) | M |
| RP-5 | Drill down from any report figure to the underlying transactions | M |
| RP-6 | Export to PDF and CSV/Excel; print (PDF through the browser's print dialog, which prints only the report) | M |
| RP-7 | Columns by month or quarter, and prior-period comparison | S |
| RP-8 | Statement of cash flows | S |
| RP-9 | Combined view across all four companies, side by side (opens all four company folders) | S |
| RP-10 | Profit and loss option to show each line as a percentage of total income ("% of Income" column, on screen and in exports) | S |

### QuickBooks migration (MG)

| ID | Requirement | Pri |
| --- | --- | --- |
| MG-1 | Import chart of accounts, customers, vendors and products/services from QuickBooks Online list exports (Excel/CSV) | M |
| MG-2 | Import about 17 years of history from a QuickBooks Online transaction report run on **Cash basis** and exported to Excel, one file per year (the Journal report if it offers a cash-basis option, otherwise the General Ledger report); one run accepts many files | M |
| MG-3 | Keep original dates, reference numbers (invoice, check), names and memos | M |
| MG-4 | Dry run first: validate the files, map QuickBooks accounts to new accounts, and list errors before anything is written | M |
| MG-5 | Tie-out check: cash-basis trial balance at every year-end and the latest cash-basis balance sheet must match QuickBooks Online's own cash-basis reports; differences shown by account and year | M |
| MG-6 | Run per company into a fresh company folder, repeatable until the tie-out passes; a failed run is discarded entirely | M |
| MG-7 | Pull data directly through the QuickBooks Online API instead of files, if the file exports prove incomplete (would need a small server or desktop helper for OAuth; reassess if needed) | S |
| MG-8 | Set the closing date to the cutover date after a successful migration | S |
| MG-9 | Bring over open invoices and bills, with what is still owed on them, as open documents so they can be paid in the new app (no ledger effect, since the ledger is cash basis) | S |
| MG-10 | ~~Import payment-to-invoice and payment-to-bill links for migrated history~~ Retired Oct 26: history is imported on a cash basis (MG-2), so no links are needed | — |

Keep the QuickBooks Online subscription active until every company passes the tie-out, since access to the data ends some time after cancelling.

### Users and access (US)

| ID | Requirement | Pri |
| --- | --- | --- |
| US-1 | Unlock each company with its passphrase; lock again after inactivity; the owner can change the passphrase | M |
| US-2 | Give the bookkeeper access to a company by checking it out to them (DF-5); their name and role are recorded in the company's database | S |
| US-3 | The owner can do everything, including company settings and the closing date | M |
| US-4 | Bookkeeper role: enter, import, categorize and reconcile; cannot change users, company settings or the closing date (enforced by the app; a guardrail, not a security boundary, since whoever holds a company's files and passphrase can change anything) | S |
| US-5 | Audit log of every create, edit, void, unlock and restore (and check-out and check-in once built), with user and timestamp | M |
| US-6 | More roles (Accountant, View-only) | S |

### Company files (DF)

New module (Oct 26) for the standalone design.

| ID | Requirement | Pri |
| --- | --- | --- |
| DF-1 | Each company is a folder on your disk, created or opened through Chrome's folder picker, holding the encrypted database and an attachments subfolder. The app asks Chrome for lasting permission to the folder and remembers recently opened folders, but stores no books in the browser | M |
| DF-2 | Open a company by loading its database into memory, and save it back as a whole, atomically, within a few seconds of each committed change and on lock or close; show whether there are unsaved changes, and warn before closing with unsaved changes | M |
| DF-3 | Before each save, check that the file hasn't changed on disk since it was opened or last saved; if it has, don't overwrite it, and offer to save the changes as a separate copy | M |
| DF-4 | One editor at a time: the same company can't be open in two browser tabs, and a lock file in the folder shows other devices who has it open and opens it read-only for them; the owner can clear a stale lock | M |
| DF-5 | Check out a company to another person or device as a single encrypted file holding the database and attachments; the original turns read-only until the file is checked back in | S |
| DF-6 | Check-in accepts only the file from the latest check-out, at the same schema version, and replaces the original; anything else is refused with the reason shown | S |
| DF-7 | The owner can cancel a check-out to recover from a lost file; the cancelled copy can then never be checked in | S |
| DF-8 | Export a read-only snapshot of a company for viewing on another device | S |
| DF-9 | Automatic encrypted backups to a folder you choose (by default, `backups` in the company folder), after changes and at least daily while the company is open; keep a set number of versions; warn when the newest backup is older than 7 days | M |
| DF-10 | Restore a company from a backup, after checking that it is a valid company backup and showing its date and latest entry | M |
| DF-11 | Upgrade a company's schema when it is opened, after taking a backup; refuse a company written by a newer app version | M |

## Non-functional requirements

| Area | Requirement |
| --- | --- |
| Deployment | The app is static files (HTML, JavaScript, WebAssembly); no database server or Docker stack. Served over HTTPS from GitHub Pages (Nov 1), which needs no custom headers because nothing uses OPFS |
| Client | Installable PWA built and tested for desktop Chrome. Developed on `localhost`, which Chrome treats as secure, so installing, offline use and folder access all work without a certificate. On Android, opening and saving company folders depends on Chrome for Android's support for the folder picker, which sources disagree on; this is checked in the first technical test, against the development machine over USB port forwarding. If it's missing, Android is out of scope for the MVP. Other browsers best-effort |
| Offline | Everything, including saving, works offline once the app is installed |
| Accuracy | Money stored as integer cents, never floating point (SQLite has no exact decimal type, and its `NUMERIC` can store floating point); every report ties back to the ledger |
| Integrity | Ledger writes are transactional: a document and its journal lines save together or not at all, and saving to disk is atomic (DF-2) |
| Storage | The books exist only in the company folders. Clearing Chrome's site data or uninstalling the app only forgets the list of recent folders. Moving, renaming or deleting a folder outside the app works as it would for any document |
| Security | Database, attachments and backups encrypted with AES-GCM; the key is derived from the passphrase with PBKDF2-SHA256 (600,000 iterations, stored in the file so it can be raised later); lock after inactivity; no bank credentials stored, since data comes from files. A forgotten passphrase cannot be recovered, except from a backup whose passphrase you know |
| Backup | Company folders are ordinary files covered by your usual backups (for example a cloud-synced folder or restic on the home lab), plus the app's own versioned backups (DF-9); keep at least one copy off the device; one-step restore (DF-10), tested regularly |
| Version compatibility | Once bookkeeper handoff is built, owner and bookkeeper must run the same app version to hand off a company; check-in refuses a schema mismatch (DF-6) |
| Retention | Keep records at least 7 years to cover IRS record-keeping expectations; migrated history is kept in full |
| Performance | Fast enough for daily use over the full \~17 years of history for one company. No hard targets for the MVP: opening a company in over 5 seconds and reports in over 2 seconds are acceptable. Measured in the first technical test. Attachments are kept outside the database so they don't add to the time each save takes |
| Portability | Full export of each company's data (CSV/JSON) at any time, and a decrypted SQLite copy on request |
| Future-proofing | Every row keeps its company id and the schema stays plain SQL, so a later move to a server database, cloud or multi-tenant hosting is a data copy, not a redesign |
| Extensibility | New modules plug in through the posting function and in-app events without schema changes to the ledger |

## Core data model

The ledger tables are the only source of truth for the financial statements; invoices and bills are documents that reach the ledger only through their payments. Every posting goes through one posting function. Each company's database holds only that company's rows, and every table still carries `company_id`.

| Entity | Key fields | Owned by |
| --- | --- | --- |
| Company | id, legal name, EIN, address, fiscal year start, closing date (one row per company database) | CO |
| CompanyModule | module, enabled (CO-4) | CO |
| User | name, role (owner only in the MVP) | US |
| Session | the user working now, set at unlock; one row, read by the audit triggers | US |
| Checkout | token, holder name, role, checked out at, checked in or cancelled at, schema version (S) | DF |
| Account | id, company, type, detail type, parent account, active | GL |
| JournalEntry | id, company, date, ref, name (payee, customer or vendor), source type, source id, memo, status (draft/posted/void) | GL |
| JournalLine | entry id, account, debit, credit (integer cents), memo, name (when the line names someone else), source document line (optional, for payments) | GL |
| Payee (customer, vendor) | one list of names (GL-11), flagged customer and/or vendor, with contact details, terms, default category and 1099 flag (imported from QuickBooks in M5); entries and lines link to their payee | GL / AR / AP |
| RecurringEntry, RecurringRun | a template's schedule, payee, memo and lines; one run per template and date, with the entry it posted (GL-5) | GL |
| QboImportRun, QboEntry | one row per QuickBooks import (status, summary, tie-out); per migrated entry its QuickBooks transaction type and source file and row | MG |
| Item | name, rate, income or expense account | AR |
| Invoice, Estimate, SalesReceipt | header, lines, totals, status | AR |
| Payment, PaymentApplication | amount, method, deposit account, invoices paid and amount applied to each | AR |
| Bill, BillPayment, BillPaymentApplication | header, lines, status; payment amount, method, bills paid and amount applied to each | AP |
| Expense | payment account, payee, split lines | EX |
| BankFeed, StatementImport, BankTransaction | which ledger account a statement account is; per imported file its name, period and closing balance; per transaction the bank id, date, amount, payee, memo, check number, review status (new, posted, matched, excluded) and the entry that accounts for it. Column mapping for CSV/Excel (BK-2) later | BK |
| BankRule | priority, on/off, conditions (text in payee or description, money in or out, amount range, account), category, payee, memo, post automatically | BK |
| Reconciliation, ReconciledLine | account, statement date, beginning and ending balance, open or done; the ledger lines it cleared | BK |
| Attachment | file name, type, size, content hash, linked entity; the encrypted file is `attachments/<id>.kma` in the company folder (`.eba` before the rename) | shared |
| AuditEvent | user, action, entity, before/after, timestamp | shared |

Backups are not tracked in the database: they are files named by time in the backup folder, and the app finds them by listing that folder (DF-9).

The `source type` + `source id` pair on JournalEntry is what keeps modules optional: the ledger never needs to know what an invoice is, only which document produced each entry.

## Future modules (out of MVP scope)

These are excluded from the MVP but the architecture leaves a slot for each. Numbers refer to the QuickBooks feature list.

| Module | Includes | What it plugs into |
| --- | --- | --- |
| Bookkeeper handoff | Check-out, check-in, snapshots and the bookkeeper role (DF-5 to DF-8, US-2, US-4) | Company files module; first in line after the MVP |
| Sync | Replace file check-out with a sync service so two people can work at once | Data layer; one database per company already |
| Bank feeds | Live bank and card connections through an aggregator (27); needs a server, since aggregator credentials can't live in the browser | Feeds the same review queue as file import |
| Accrual reporting | Accrual-basis P&L and balance sheet; needs invoices and bills to post to A/R and A/P, and covers only transactions entered after it is added | Ledger posting rules and report engine |
| More roles | Accountant and View-only roles (US-6) | Users module |
| Cloud hosting | Managed hosting, later multi-tenant SaaS if sold as a product | Data layer; schema already company-scoped |
| Dimensions | Classes and locations (6) | Extra tag columns on JournalLine |
| Multi-currency | Currencies, rates, FX gains (5) | Currency + rate on documents and lines |
| Receivables extras | Credit memos, customer credits and overpayments, statements, reminders, A/R aging, online payment links (12–15); payment links need a server | AR events, payment processor adapter |
| Payables extras | Purchase orders, vendor credits, A/P aging, 1099 filing (19–22) | AP events |
| Expense capture | Receipt OCR, mileage, reimbursements (24–26) | EX module |
| Inventory | Quantities, FIFO costing, reorder points (34–40) | Item gains stock fields; COGS postings |
| Projects and time | Job costing, timesheets, billable time (41–45) | Project tag on lines |
| Payroll | Pay runs, tax filing, W-2s (46–51) | Typically a third-party payroll integration posting journal entries |
| Sales tax | Rates, calculation, returns (52–53) | Tax lines on invoices |
| Budgeting | Budgets and forecasts (54–55) | Read-only over the ledger |
| Advanced reporting | Custom reports, dashboards, consolidation (60–63) | Read-only over the ledger |
| Automation and AI | Workflows, assistant, anomaly detection (69–71) | In-app events |
| Platform | Public API, webhooks, integrations, native mobile apps (72–77); needs a server | Sync or cloud hosting first |

## Decisions and open questions

| Topic | Decision |
| --- | --- |
| Audience | Own use for four businesses; may become a product later |
| Users | Owner only in the MVP; bookkeeper handoff by check-out is S, first after the MVP |
| Intercompany | None; companies are fully separate |
| Bank data | .qbo statement import, supported by all your banks and cards; live feeds deferred |
| Accounting basis | Cash basis, calendar fiscal year, all four companies. The ledger itself is cash basis: only cash movements post, and history is migrated from QuickBooks Online's cash-basis reports (decided Oct 26, replacing the Oct 25 accrual ledger with a cash view) |
| History | Migrate about 17 years from QuickBooks Online |
| Key output | On-demand P&L and balance sheet |
| Sales tax, inventory | Not needed now; future modules |
| Architecture | Standalone Chrome PWA with no backend. Each company is an encrypted folder on your own disk, opened like a document and unlocked with a passphrase; nothing is kept in the browser's own storage (decided Oct 26, replacing self-hosted Supabase) |
| Hosting | GitHub Pages, published from the `release` branch; `develop` and `release` change only by PRs the owner merges (decided Nov 1) |
| License | Free and open source under the GNU GPL, version 3 or later; the repository is public (decided Nov 1) |
| Performance | No hard targets for the MVP; measured in the first technical test |
| Key derivation | PBKDF2 (built into the browser), chosen over Argon2id |

Still open:

- [x] ~~Full self-hosted Supabase chosen over PostgREST plus a separate login service.~~ Replaced Oct 26 by a standalone PWA with encrypted company folders on your disk.
- [x] ~~Accrual ledger with a cash view for reports.~~ Replaced Oct 26 by a cash-basis ledger.
- [x] ~~Payment-to-invoice and payment-to-bill links in QuickBooks exports (MG-10).~~ Not needed with cash-basis history.
- [x] Before the migration milestone: export one year of one company from QuickBooks Online on Cash basis and confirm the rows can be grouped back into balanced transactions. Done Oct 27 (one company's 2025): QuickBooks's Export data gives the Journal (no accounting method; grouped by transaction) and cash-basis General Ledger, Trial Balance and Balance Sheet. The import uses the Journal where it matches the cash-basis General Ledger, and rebuilds from the General Ledger where it doesn't; that year tied out exactly.
- [ ] First technical test results: Chrome for Android folder support, and time and memory to open and save a company with 17 years of history.
- [x] Where to host the app: GitHub Pages at https://mawadk.github.io/kmezBooks/ (Nov 1).
