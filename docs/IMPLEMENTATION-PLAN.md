# Implementation Plan — MVP

Oct 26, 2026 · @Khaleel

How the MVP in `docs/MVP-REQUIREMENTS.md` gets built. M1 is planned in detail; M2–M8 are outlined and get detailed when they start. Requirement IDs in brackets.

## Build order (agreed Oct 26, 2026)

| Milestone | What | Requirements |
| --- | --- | --- |
| M1 | Technical test + project scaffold | Risks behind DF-1, DF-2, Client and Performance NFRs |
| M2 | Company files, owner unlock, audit log (done) | DF-1–DF-4, DF-9–DF-11, CO-1–CO-4, US-1, US-3, US-5 |
| M3 | Ledger core and period close (done) | GL-1–GL-4, GL-6–GL-8, PC-1–PC-3 |
| M4 | Reports (done) | RP-1–RP-6, RP-10 |
| M5 | QuickBooks Online migration | MG-1–MG-6 |
| M6 | Banking (built) | BK-1, BK-3–BK-9 |
| M7 | Expenses, bills, sales | EX-1, EX-2, AP-1–AP-5, AR-1–AR-8 |
| M8 | Polish, export, restore drill | Offline, Portability, Backup NFRs |
| Later | Should-haves, bookkeeper handoff first | DF-5–DF-8, US-2, US-4, then the other S items |

Reports come right after the ledger so every later milestone can be checked against a trial balance. Migration comes before banking so `.qbo` duplicate detection (BK-6) can be tested against real migrated history.

## Decisions this plan relies on

- **Standalone PWA, no backend.** Each company is a folder on the owner's disk, opened with the File System Access API. No OPFS or other browser storage for books.
- **In-memory database, saved whole.** Open = read file → decrypt → `sqlite3_deserialize`. Save = `sqlite3_js_db_export` → encrypt → `createWritable()` → `close()`. Chrome writes to a temporary file and swaps it in on `close()`, so each save is atomic.
- **Cash-basis ledger.** Only cash movements post. Invoices and bills don't post; their payments post pro rata over the document's lines (GL-8). No settlement or cash-view tables.
- **Owner only.** Bookkeeper handoff comes after the MVP.
- **PBKDF2** for the key derivation, **no hard performance targets**, **develop on `localhost`**, hosting later.

## Repository layout

```
src/
  app/                 shell, routing, company switcher, lock screen
  worker/              SQLite worker: database, file access, crypto, save loop
  ledger/              postEntry(), allocateProRata(), events
  shared/              money (cents), dates, typed worker client, UI kit
  modules/
    companies/  ledger-ui/  period-close/  reports/
    migration/  banking/  expenses/  bills/  sales/
db/
  migrations/          0001_core.sql, 0002_audit.sql, … one numbered sequence
  tests/               schema and integrity-rule tests (Vitest)
tests/fixtures/        QuickBooks exports, .qbo files (anonymized)
docs/
```

Modules own their tables, but migrations share one numbered sequence (`NNNN_<module>_<what>.sql`) because a company has a single `user_version`. Disabling a module (CO-4) hides its screens and never drops its tables.

## Company folder and file format

```
Acme LLC/                    folder the owner picks or creates
  company.ebk                encrypted SQLite database
  company.lock               who has it open, plus a heartbeat (DF-4)
  attachments/<sha256>.ebk   one encrypted file per attachment
  backups/company-2026-10-26T15-30.ebk
```

`.ebk` file layout:

| Part | Contents |
| --- | --- |
| Header (plain) | magic `EBK1`, format version, PBKDF2-SHA256 iterations (600,000) and 16-byte salt, wrapped data key, 12-byte IV |
| Body | AES-256-GCM ciphertext of the SQLite database, with the header as additional authenticated data |

- **Key wrapping.** A random data key encrypts the database and attachments. The passphrase-derived key only wraps it (AES-KW). Changing the passphrase (US-1) rewrites the header, not every attachment. A backup opens with the passphrase that was current when it was made.
- **Fresh IV on every save.** The data key stays in the worker as a non-extractable `CryptoKey` while the company is unlocked, and is dropped on lock.
- **Wrong passphrase vs damaged file.** A failed unwrap means a wrong passphrase. A failed body decrypt means the file is damaged; the app offers a restore (DF-10).

## M1 — Technical test + scaffold (detailed)

**Goal:** prove the risky parts on real hardware before building features, and leave a working skeleton.

### 1. Scaffold

- [x] `git init`, `.gitignore`, first commit of the docs
- [x] Vite + React + TypeScript (strict), ESLint, Prettier; npm scripts `dev`, `build`, `test`, `check` (typecheck + lint + test)
- [ ] `vite-plugin-pwa` (Workbox): manifest, icons, service worker; confirm the app installs from `localhost` — production build and service worker work; install needs a manual run in Chrome
- [x] `@sqlite.org/sqlite-wasm` in a dedicated Web Worker (exclude it from Vite's dependency pre-bundling); typed message API between UI and worker (Comlink)

### 2. Company file prototype

- [ ] Pick or create a folder with `showDirectoryPicker({ mode: 'readwrite' })`; store the handle in IndexedDB as the recent-folders entry; on reopen, `queryPermission` and then `requestPermission`; check whether the installed app gets "allow on every visit" — built; needs a run in Chrome
- [x] Encrypted file round trip: create the database, run a migration, write `company.ebk`, close, reopen with the passphrase, read back (Node tests; Chrome run pending)
- [x] Atomic save: kill the tab during a save and confirm the old file survives intact (headless Chrome: page reloaded mid-write, company reopens)
- [x] On-disk change check (DF-3): record `lastModified` and size after open and after each save; refuse the save if either changed (Node tests; manual Chrome check pending)
- [x] Migration runner: `import.meta.glob('/db/migrations/*.sql', { query: '?raw', eager: true })`; each file in its own transaction with its `PRAGMA user_version`

### 3. Measurements (recorded, not pass/fail)

- [x] Synthetic-company generator: 17 years, about 6,000 entries a year, 2–6 lines each. Adjust once real QuickBooks volumes are known
- [x] Record database size; open time (read, key derivation, decrypt, deserialize); save time (export, encrypt, write); worker memory; cash-basis P&L for one year and for all 17 years, with and without indexes on `(account_id, date)`
- [ ] PBKDF2 at 600,000 iterations: unlock time on desktop and Android — desktop 200 ms; Android pending
- [ ] Desktop Chrome on the owner's PC, and Android Chrome — headless desktop Chrome done; real-disk desktop run and Android pending
- [x] Write the results to `docs/spikes/M1-results.md` (manual runs to add)

### 4. Android check

- [ ] Phone on USB debugging, `chrome://inspect` → port forwarding `5173 → localhost:5173`, open the dev server on the phone
- [ ] Check `'showDirectoryPicker' in window`. If present, run the same file prototype and measurements. If absent, record it; Android is then out of scope for the MVP (Client NFR)

### 5. Test setup

- [x] Vitest for TypeScript logic
- [x] Schema tests in `db/tests`, running the real migrations against an in-memory database in Node with the same `@sqlite.org/sqlite-wasm` package
- [x] One example integrity test (a table `CHECK` constraint) to prove the setup
- [ ] CI later, once there's a git remote; until then `npm run check` before each commit

### Owner task, can run in parallel (needed before M5)

- [x] In QuickBooks Online, for one company and one year: check whether the **Journal** report offers a Cash basis option. Done Oct 27 with **Export data**: the Journal has no accounting method; the General Ledger, Trial Balance and Balance Sheet follow the company's default (set to Cash). See M5
- [x] Also export that year's cash-basis Trial Balance and year-end Balance Sheet for the tie-out
- [x] Drop the files in a private folder outside the repo (`C:\KM\QBO\<company>`); the fixtures are anonymized look-alikes written by `src/modules/migration/testing/qboFixtures.ts`

**Done when:** the app installs from `localhost`; an encrypted company file round-trips; the atomic-save and change-check tests pass; measurements and the Android result are written up; `npm run check` is green.

## M2 — Company files, owner unlock, audit log (done Oct 26)

Built on branch `m2-company-files`. Unit tests in Node, plus an end-to-end run of every screen in headless Chrome.

| Requirement | How |
| --- | --- |
| CO-1 | New company: legal name, EIN, address, fiscal year start, owner name, passphrase twice, then an empty folder. Company page edits the details. Validation in `src/shared/company.ts`, `CHECK` constraints as the backstop |
| CO-2 | Active company in the top bar. Switching = **Close company**, then open another company from the start screen |
| CO-3 | One folder and database per company; every table's `company_id` has a foreign key to the one company row (tested for every table) |
| CO-4 | Modules page; `company_module` table. Screens for the modules arrive in M5–M7 |
| DF-1 | Folder picker; recent-folders list (handles in IndexedDB, nothing else); permission asked on the click that opens a company |
| DF-2 | In-memory database, saved whole 2 s after the last change, and on lock, close or the tab being hidden. Unsaved changes are detected from SQLite's own change counter, so no module can forget to flag them. Save state in the top bar; `beforeunload` warning while unsaved |
| DF-3 | Every save compares the file's time and size with the last open/save. If they differ the save is refused, and the owner can **Save a copy in another folder** and keep working there, or close without saving. Restoring a backup also goes through this check |
| DF-4 | `company.lock` (device, owner, heartbeat every 30 s). A fresh lock offers **Open read-only**; a lock silent for 2 minutes also offers **Take over**. A heartbeat that finds another device's lock stops saving and offers a copy. A Web Lock per company stops a second tab. Read-only is enforced by SQLite (`PRAGMA query_only`) |
| DF-9 | Backup on the first save of each day and every 4 hours while working; newest 30 kept; banner after 7 days without one. Default folder `backups` inside the company folder, or a folder of the owner's choice (remembered per company on this device) |
| DF-10 | Backups page: restore any backup after checking its passphrase and showing its company and last activity; the current file is backed up first; a backup of another company is refused. Start screen: restore a backup file into an empty folder |
| DF-11 | Before a schema upgrade the untouched file is copied to `backups` as `…-before-upgrade-vN`; files from a newer app version are refused |
| US-1 | Passphrase unlock (10 characters minimum); lock after 15 minutes idle (per-device setting); passphrase change re-wraps the key and saves at once; old backups keep their passphrase |
| US-3 | One owner row (`app_user`, unique owner index); the session row points at the owner |
| US-5 | Audit triggers on every table are generated from the live schema after each migration (`src/worker/audit.ts`), so new tables and columns are covered automatically; before/after as JSON; unlock, lock, restore, schema upgrade and passphrase change written by the app; the log is append-only; Audit log page |

Decisions made while building (all adjustable):

- Passphrase at least 10 characters; inactivity lock 15 minutes by default.
- Autosave 2 s after the last change; backup cadence and retention as above.
- Backups are found by listing the backup folder, not recorded in the database, so writing a backup never makes the company "unsaved" again.
- Opening an editable company records the unlock and saves it within seconds, so every open touches the file.

Left for later milestones:

- Bulk imports (M5) would write one audit row per imported entry; add a bulk-import mode that logs one summary event instead (see M5).
- The M1 technical-test page stays until the M1 hand checks are recorded.

## M3 — Ledger core and period close (done Oct 26)

Built on branch `m3-ledger`. Integrity rules tested against the real schema, including property-based tests; every screen checked end to end in headless Chrome.

| Requirement | How |
| --- | --- |
| GL-1 | `account` table: five types, detail types (catalog in `src/shared/accounts.ts`), sub-accounts shown as `Parent:Child`. Triggers keep a sub-account the parent's type, prevent cycles, and keep the type of an account with history or sub-accounts. Names unique among siblings (ignoring case), numbers unique |
| GL-2 | 40-account cash-basis chart (no A/R or A/P; one each of Undeposited Funds, Retained Earnings and Opening Balance Equity). Seeded at creation unless "Start with the standard chart" is unticked (for companies that will be imported); an empty company can add it later |
| GL-3 | `postEntry()` (`src/ledger/postEntry.ts`) writes a draft and its lines and posts it in one savepoint, so it can also run inside a document's own transaction later. The posting trigger requires two or more lines, debits = credits and a non-zero total. Entries can only be created as drafts |
| GL-4 | Journal entry screen: date, ref, memo, lines with running totals, attachments. Attachments are encrypted with the company's data key (`EBA1` format) as `attachments/<id>.eba`, with a copy in the backup folder; the database keeps name, type, size and SHA-256, checked on open |
| GL-6 | Lines change only while the entry is a draft; posted and void entries never change (except posted → void) and are never deleted. Void keeps the lines and drops the entry from balances |
| GL-7 | An account with transactions can't be deleted, only made inactive; inactive accounts take no postings |
| GL-8 | Postings to A/R or A/P accounts are refused unless the entry comes from the QuickBooks migration. `allocateProRata()` (`src/ledger/allocate.ts`) is ready for M7, with property tests |
| PC-1 | `company.closing_date`; posting or voiding on or before it is refused by a trigger |
| PC-2 | The owner re-enters the company passphrase; the app sets a one-action override flag in the session row, and the trigger writes a `closed_period_override` audit event for each use. The flag is cleared in the same transaction, even when the change fails, and at every unlock |
| PC-3 | Nothing to run at year end: the trial balance (`src/ledger/balances.ts`) shows income and expenses for the current fiscal year and puts earlier years' net income in Retained Earnings, following the company's fiscal year start |

Decisions made while building:

- Ledger tables use integer ids (`journal_entry.id`, `journal_line.id`) for speed at 17 years of history; companies, users and accounts keep UUIDs.
- Posted entries can't be edited at all, not even the memo: corrections are a void plus a new entry. M7 documents follow the same rule (editing an invoice voids and re-posts its payment entries).
- The closed-period override uses the company passphrase rather than a separate override password, so there is no second secret to manage.
- The audit log's fixed list of actions became "any lower_snake_case word" (migration 0006), so new kinds of events don't need a table rebuild.
- Removing an attachment unlinks it; the encrypted file stays, so restoring an older database backup still finds it.
- The Vitest on-disk module cache is off: it didn't notice new migration files.

## M4 — Reports (done Oct 26)

Built on branch `m4-reports`. Report builders tested in Node, including property tests; the Reports page checked end to end in headless Chrome, with real CSV and Excel downloads and a printed PDF.

| Requirement | How |
| --- | --- |
| RP-1 | Profit and Loss for any range: Income, Cost of Goods Sold and Gross Profit (when there is any), Expenses, Net Income. Sub-accounts nest under their parent with a "Total" line |
| RP-2 | Balance Sheet as of any date: Assets, Liabilities, Equity with Retained Earnings (earlier years' net income) and Net Income (this fiscal year). A property test checks it always balances and that its net income equals the P&L's |
| RP-3 | Presets: this month, quarter, year to date and year; last month, quarter and year; custom dates. As-of presets for the balance sheet and trial balance. Quarters and years follow the company's fiscal year |
| RP-4 | Trial Balance, and General Ledger detail with the balance before the period, every line with a running balance, the "split" account (or "-Split-"), and totals. General ledger shows at most 20,000 lines and says so; choose one account or a shorter period |
| RP-5 | Every account figure opens the general ledger for that account and period; Retained Earnings and Net Income open the P&L behind them; a ledger line opens its journal entry, with "Back to report". A Back button retraces drill-downs |
| RP-6 | Export CSV (UTF-8, Excel-friendly) and Excel (.xlsx with numbers as numbers, bold totals); "Print or save as PDF" uses a print stylesheet that shows only the report, and Chrome's print dialog saves it as PDF |
| RP-10 | Added Oct 27 at the owner's request: a "% of income" checkbox on the P&L adds a "% of Income" column (each figure over total income, to 0.01%, rounded half away from zero; blank when there is no income). It stays ticked across report switches and drill-downs, and exports as percentages (CSV "12.34%", Excel numbers formatted 0.00%) |

All reports are cash basis with no conversion step, because the ledger is cash basis (GL-8).

Benchmark (`REPORT_BENCH=1`, Node, 17 years × 6,000 entries posted through `postEntry()`): one-year P&L 30 ms, 17-year P&L 0.4 s, balance sheet 0.7 s, trial balance 0.4 s, one account's general ledger for a year 0.35 s.

The same benchmark found that the generated audit triggers made the company file 325 MB (71 MB of it ledger) because every entry and line was copied into the audit log as JSON. Fixed in migration 0008: journal entries and lines now get compact hand-written audit triggers, one "post" and one "void" event per entry with its date, ref, memo, source and amount. That gave 104 MB, of which about 33 MB is one audit row per entry.

Also fixed: clicking the current page's sidebar item now returns to its list (after posting an entry, "Journal entries" did nothing).

## M5 — QuickBooks Online migration (built Oct 27; real-data runs per company still to do)

Built on branch `m5-migration` in the `migration` module (`src/modules/migration/`). Tested in Node on anonymized exports in QuickBooks's exact layout, and against a real export (one company's 2025) in Node and end to end in headless Chrome: all 113 transactions imported, and the trial balance (23 accounts) and balance sheet (14 lines) match QuickBooks to the cent.

What QuickBooks gives (from the real export): **Export data** writes one folder per period (`Company 20250101-20251231`) with Journal, General Ledger, Trial Balance, Balance Sheet, Profit and Loss and the contact lists as `.xlsx`; the Account List comes from Chart of accounts → Run report. The cash-basis reports say "Cash Basis" in their footer and follow the company's default accounting method. **The Journal has no accounting method**: it shows transactions as entered, so it equals cash basis only when there are no invoices or bills.

| Requirement | How |
| --- | --- |
| MG-1 | Account List → accounts with QuickBooks's names, hierarchy (`Parent:Child`), numbers and descriptions; types and detail types mapped (`qboAccounts.ts`), editable in the dry run. Customer and vendor contact lists → new `customer` and `vendor` tables (migration 0009). Products and services: not yet (no sample export; they arrive with sales in M7) |
| MG-2 | The owner picks one folder (or files); every `.xlsx` in it and its subfolders is recognised by its title, not its name. A small `.xlsx` reader (`xlsx.ts`) keeps amounts as decimal text → integer cents. Periods must follow each other without gaps or overlaps. Transactions come from the Journal when it matches the cash-basis General Ledger account by account; otherwise they are rebuilt from the General Ledger (lines with the same date, type, number and name; leftovers combined per day). Balances before the first period become one opening entry, from the General Ledger's beginning balances |
| MG-3 | Dates, numbers (check numbers written as `2045.0` → `2045`), names and memos kept. New `name` columns on entries and lines (migration 0010). QuickBooks's transaction type and the source file and row are kept in `qbo_entry` |
| MG-4 | The dry run validates the files (company, cash basis, periods, balance of every transaction), shows the account mapping, then posts everything through `postEntry()` and the tie-out and rolls it all back. Errors are listed per file and row |
| MG-5 | Every trial balance account by account, and the latest balance sheet line by line with its net income, compared with our books; differences listed by account and date |
| MG-6 | One savepoint per run; it commits only with no errors and a clean tie-out (or differences the owner explicitly accepts). The schema refuses a run in a company that already has transactions, and migrated history (`source_type = 'qbo_migration'`) can only be posted by a running import |
| MG-8 (S) | After an import, one button closes the books through the last imported day |
| US-5 | Bulk mode: migrated entries don't get one audit event each; the run's row (inserted, then finished with its summary) is audited instead. Voiding a migrated entry is still audited |

Decisions made while building:

- Import into a **new, empty company** (create it with "Start with the standard chart" unticked). Accounts with the same name as an existing account, and the one-per-company accounts (Retained Earnings, Opening Balance Equity, Undeposited Funds), are matched to the existing ones.
- Accounts shown as "(deleted)" are created inactive after their history is posted. Accounts missing from the Account List get their type from the heading they sit under on the balance sheet or the profit and loss (Bank Accounts, Credit Cards, Fixed Assets, Long-Term Liabilities, Income, Cost of Goods Sold, Expenses…), from their sub-accounts or parent, and Retained Earnings and Opening Balance Equity by name; only what's left is the owner's to choose. So the Account List is optional (checked Oct 27 on a second company exported without one: every one of its 90 accounts was typed).
- $0 transactions (voided in QuickBooks) are left out.
- A dry run doesn't mark the company as having unsaved changes.
- Migrated history doesn't announce each posting as a ledger event (rule 8): it is history, not new activity.

Still to do (owner, with the app):

- Export every year for each of the four companies and run the import into a new company per company; keep QuickBooks until all four tie out.
- Each real-data surprise becomes a fixture case in `importer.test.ts`. The opt-in test `realData.test.ts` (`QBO_DIR=…`) dry-runs a folder of real exports on this computer without committing any of it.
- The rebuild from the General Ledger is tested on fixtures only; the first company with invoices or bills will show whether QuickBooks's cash-basis General Ledger groups as expected.
- Run per company against real data. The QuickBooks Online subscription stays active until all four pass.

## M6 — Banking (built Oct 27; tried on real bank statements, card statements still to try)

Built on branch `m6-banking` in the `banking` module (`src/modules/banking/`, migration 0011). Tested in Node on made-up statements in both OFX dialects, and end to end in headless Chrome: two statement files imported through the file picker, a check matched to an entry already in the books, a card payment recorded as a transfer with both sides matched, a rule's suggestion added, a split, a reconciliation finished at zero with its report, and the warning before voiding a reconciled entry.

| Requirement | How |
| --- | --- |
| BK-1 | `.qbo` files (also `.ofx` and `.qfx`, the same format) are read by one parser for OFX 1.x SGML and 2.x XML (`ofx.ts`), honouring the file's character set; amounts go from their digits to cents. The first import of an account asks which ledger account it is (asset or liability only, enforced by the schema) and remembers it by bank and account number (`bank_feed`). Statements in another currency are refused. An import can be undone while its transactions are still waiting for review |
| BK-3 | Each account has a queue: For review, In the books, Excluded. A transaction is added to the books through `postEntry()` (`source_type = 'bank'`) with one category or a split; matched; recorded as a transfer; or excluded. Undo voids an entry the review posted (or undoes a match), and voiding such an entry anywhere sends its transaction back to review (a trigger) |
| BK-4 | Entries already in the books that move the same amount through the account within 10 days are offered as matches, a matching check number first. The schema checks that a matched entry is posted and moves exactly the transaction's amount through its account, and that an entry accounts for at most one transaction per account. Payments, bill payments and expenses from M7 are entries, so they will be matched the same way |
| BK-5 | Rules in priority order: payee or description contains text (ignoring capitals), money in or out, amount range, account. A rule suggests a category, payee and memo; with "add automatically" it posts on import. Without a rule, the category used the last time for the same payee is suggested. "Add N suggested transactions" accepts them in one step |
| BK-6 | A transaction with the same bank id (FITID), date and amount as one already imported into the account is skipped; the schema's unique index enforces it. The same bank id with a different date or amount is imported but flagged. A transaction that matches an entry from the QuickBooks migration is marked "already in the books" with the match offered. QuickBooks exports carry no bank id, but its memo keeps the bank's own text for what came from its bank feed: a match with that text is marked "same bank text" and listed first, and "Match … already in the books" matches those in one go, pairing the whole text and then the closest dates first when several are alike. Transactions with any possible match are never added automatically or in bulk |
| BK-7 | Reconcile against a statement date and ending balance (filled in from the last imported statement's balance), check items off, finish when the difference is zero. The schema enforces the rest: it starts at the previous statement's ending balance, a line is cleared once, only posted lines of that account dated on or before the statement date, statements in date order, one open reconciliation per account, a finished one never changes |
| BK-8 | Finished reconciliations are kept with their cleared lines and shown as a report (cleared and outstanding items, printable). The journal shows where an entry was reconciled, and voiding it warns first; the report and the history flag items voided since |
| BK-9 | A waiting transaction with the opposite amount in another account within 5 days is suggested as the other side of a transfer; recording it matches both. A transfer entered from one account is matched automatically when the other account's statement is imported |
| US-5 | `bank_txn` and `reconciled_line` are bulk tables: a review gets one compact audit event, and imports, rules and reconciliations are audited in full (migration 0011) |

Decisions made while building:

- Amounts are stored debit minus credit for the account, which is also the sign a `.qbo` file uses, so bank and card accounts work the same way; the screens show card balances owed as positive, as the statement does.
- The first reconciliation of an account starts from zero; "Check all" clears all its history up to the statement date in one step.
- Suggestions are worked out when the queue is read, so a new or edited rule applies at once to everything waiting.
- Rules and the review never post into a closed period without the passphrase override; a rule's automatic post skips it and leaves the transaction for review.

Tried on real files (Oct 27): two Bank of America checking statements for one company, with its 2025 QuickBooks history imported first (`realStatements.test.ts`, opt-in with `QBO_DIR`; no real data committed). All January 2025 transactions were offered as matches to the migrated entries; importing the files again added nothing; the January 2025 statement reconciled to a zero difference. What they taught:

- Bank of America dates a statement's ending balance when the file was downloaded, not at the statement's end. A balance dated after the statement period is taken as the balance on its last day.
- Banks shorten and vary payee text between statements ("… DES:ROYALTY ID:DP_67 I" one month, "… DES:ROYALTY" the next). Suggestions compare payees ignoring capitals, ids and words with digits, using the first four words.
- "Like last time" also learns from transactions matched to existing entries, so matching the QuickBooks history once gives suggestions (category and the QuickBooks payee name) for the following statements: five of January 2026's seven transactions.
- A second company (Oct 27: two Bank of America checking statements, two Capital One card statements): its card files carry the balance on the download day, not each statement's (both statements showed the same balance). So a balance dated after the statement period is trusted as its ending balance only when the transactions confirm it (the previous statement's balance plus the transactions in between); otherwise the reconcile screen fills in the statement date and asks for the balance. The checking statements confirmed each other this way. Bank of America also reuses a bank id for two different transactions on one day in one file; a shared id is flagged as a possible duplicate only across files. The card payment from checking was offered as a transfer on both sides.
- The same company's cash-basis export (Oct 28): all 2,880 transactions of 2025 imported, trial balance (84 accounts) and balance sheet (31 lines) tie out to the cent, every account typed without an Account List. Its Bank of America Mastercard files gave a start date after the end date; the period then comes from the transactions. New statements are matched to the ledger account whose name has the account's last four digits ("BoA Mastercard (AFM-0860)"): five of seven. After importing the history and closing 2025, 88 December checking transactions and all 25 Mastercard ones were offered as matches to QuickBooks entries. Two safeguards came out of it: "Add suggested" never posts into a closed period (December bank items that QuickBooks holds differently, such as combined deposits, would otherwise be entered twice), and "like last time" suggests only when a payee's last three uses agree (a bank's "Check" or "Zelle payment to" is a different payee each time). Matching an entry already matched in the account gives a readable error. The company's own QuickBooks books don't agree with its bank: checking about 230,000 apart, and its Mastercard (a parent with a sub-account per card holder, charges on the sub-accounts and payments on the parent) about 131,000 apart in total.
- "Like last time" by direction (owner's decision, Oct 28): a payee's deposits and payments are remembered apart, as a refund or rebate usually goes to another category than the purchases. On the second company's checking account, 74 suggestions instead of 51; a card refund from a payee never refunded before now waits for the owner instead of taking the purchases' category.
- Matching by bank text (owner's decision, Oct 28): QuickBooks' exports have no FITID, but 284 of the 290 matches to its history across both companies carry the bank's text in the memo (Capital One repeats the payee as the memo, which QuickBooks keeps once). Card history is often dated one to four days before the statement, so the text decides, not the date; the payee alone counts only on the same day (ADP payroll, whose memo QuickBooks kept from an earlier month).
- Reconciling with sub-accounts (owner's decision, Oct 28; migration 0013): a reconciliation can include the account's sub-accounts at any depth, ticked by default for an account that has them. The schema checks every cleared line is in the account or one of its sub-accounts, and the choice is fixed when the reconciliation starts. The lists and the report show each line's sub-account.

Still to do:

- Try real card statements, and other banks; each surprise becomes a fixture case in `ofx.test.ts` or `banking.test.ts`.
- BK-2 (S): CSV and Excel statements with a saved column mapping.

## GL-9 and GL-6 setting — Transactions register (built Oct 27)

Added at the owner's request on branch `gl9-register` (migration 0012).

| Requirement | How |
| --- | --- |
| GL-9 | **Transactions** is the first page in the sidebar and where a company opens. Only filters at the top: period, account, text, all transactions or income and expenses, order, void; defaults all dates, all transactions, oldest first, and it opens scrolled to the latest (oldest first pages from the latest, 200 at a time, with Show earlier). With one account chosen it reads like a bank register: payment, deposit and the balance after each transaction (a card shows what's owed), counting entries the filter hides; that account is remembered per company on this device. At the bottom: income, expense and net totals over the whole filter, and Add Transaction, a dialog for an expense (paid from) or income (deposited to) with a category. Clicking a row opens quick changes: date, ref, payee, memo, money account and category lines (split), Void, Delete, Open in journal. Entries with several lines on both sides are changed in the journal, whose entry form now edits too |
| GL-6 | Off by default, as before: Edit is a **correction**, which voids the entry and posts the corrected copy from the same source in one step (bank links and attachments follow it). A Company page setting, which needs the passphrase to turn on, allows changing in place and deleting: the entry goes back to draft and is rewritten and posted again, so the schema checks it like a new entry. The closing date guards the old and the new date; entries cleared by a finished reconciliation can't be changed (BK-8); QuickBooks history can be corrected but not deleted (MG-6); bank transactions stay linked while the entry still fits them. The audit log records an "unpost" event with the old lines, then the new "post", or a "delete" |

## M7 — Expenses, bills, sales (outline)

- **Expenses** (EX-1, EX-2): post immediately, with split lines and encrypted attachments.
- **Bills** (AP-1–AP-5): documents only. Bill payments post pro rata over the bill's lines and can't exceed what's still owed. The bills-due list is sorted by due date.
- **Sales** (AR-1–AR-8):
  - Estimates convert to invoices.
  - Invoices are documents only; PDF uses the company template and logo. Sending goes through the Web Share API with the PDF where supported, otherwise download plus `mailto:`.
  - Sales receipts post immediately.
  - Payments post pro rata over the invoice lines into a bank account or Undeposited Funds; deposits move Undeposited Funds to the bank.
- **Statuses** are derived from payments and due dates (AR-5, AP-4).
- **Editing rules:**
  - Once any payment is applied, an invoice's or bill's lines are locked; void the payment first.
  - Voiding a document requires no applied payments.
  - Discounts are negative lines and reduce income pro rata.

## M8 — Polish (outline)

- Offline check of every screen; install flow; "new version available" prompt that saves before reloading.
- Full CSV/JSON export per company and a decrypted SQLite copy (Portability).
- Restore drill: restore each company from a backup into a scratch folder and tie the trial balance out against the live copy.
- Short owner guide: where company folders live, how backups work, what a lost passphrase means.

## Later: should-haves

Bookkeeper handoff first (DF-5–DF-8, US-2, US-4), then by value: MG-8, MG-9, GL-5, AR-9, BK-2, RP-7–RP-9, CO-5, EX-3, US-6, MG-7.

## Risks

| Risk | Mitigation |
| --- | --- |
| QuickBooks's cash-basis export can't be grouped back into balanced transactions | Checked Oct 27 on one company: the Journal groups transactions and matched the cash-basis General Ledger exactly. For companies with invoices or bills, transactions are rebuilt from the General Ledger (only fixture-tested so far); MG-7 (API) remains the fallback |
| Chrome for Android lacks the folder picker | Checked in M1; Android drops out of the MVP if so |
| A large company is slow to open or save | Measured in M1; attachments already outside the database; no hard targets accepted |
| Work lost in a crash | Save within seconds of each change; at most those seconds are lost |
| Forgotten passphrase | No recovery by design; backups with a known passphrase are the only way back; the owner guide (M8) says so |
| Pro-rata rounding drifts | One shared `allocateProRata()` with property-based tests; ledger balance enforced by the schema regardless |
