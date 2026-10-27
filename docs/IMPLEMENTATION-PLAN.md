# Implementation Plan — MVP

Oct 26, 2026 · @Khaleel

How the MVP in `docs/MVP-REQUIREMENTS.md` gets built. M1 is planned in detail; M2–M8 are outlined and get detailed when they start. Requirement IDs in brackets.

## Build order (agreed Oct 26, 2026)

| Milestone | What | Requirements |
| --- | --- | --- |
| M1 | Technical test + project scaffold | Risks behind DF-1, DF-2, Client and Performance NFRs |
| M2 | Company files, owner unlock, audit log (done) | DF-1–DF-4, DF-9–DF-11, CO-1–CO-4, US-1, US-3, US-5 |
| M3 | Ledger core and period close (done) | GL-1–GL-4, GL-6–GL-8, PC-1–PC-3 |
| M4 | Reports (done) | RP-1–RP-6 |
| M5 | QuickBooks Online migration | MG-1–MG-6 |
| M6 | Banking | BK-1, BK-3–BK-9 |
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

- [ ] In QuickBooks Online, for one company and one year: check whether the **Journal** report offers a Cash basis option. Export Journal (Cash) if it does, otherwise **General Ledger** (Cash), to Excel
- [ ] Also export that year's cash-basis Trial Balance and year-end Balance Sheet for the tie-out
- [ ] Drop the files in a private folder outside the repo; they become anonymized fixtures in M5

**Done when:** the app installs from `localhost`; an encrypted company file round-trips; the atomic-save and change-check tests pass; measurements and the Android result are written up; `npm run check` is green.

## M2 — Company files, owner unlock, audit log (done Oct 26)

Built on branch `m2-company-files`. Unit tests in Node, plus an end-to-end run of every screen in headless Chrome.

| Requirement | How |
| --- | --- |
| CO-1 | New company: legal name, EIN, address, fiscal year start, owner name, passphrase twice, then an empty folder. Company page edits the details. Validation in `src/shared/company.ts`, `CHECK` constraints as the backstop |
| CO-2 | Active company in the top bar. Switching = **Lock**, then open another company from the start screen |
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

All reports are cash basis with no conversion step, because the ledger is cash basis (GL-8).

Benchmark (`REPORT_BENCH=1`, Node, 17 years × 6,000 entries posted through `postEntry()`): one-year P&L 30 ms, 17-year P&L 0.4 s, balance sheet 0.7 s, trial balance 0.4 s, one account's general ledger for a year 0.35 s.

The same benchmark found that the generated audit triggers made the company file 325 MB (71 MB of it ledger) because every entry and line was copied into the audit log as JSON. Fixed in migration 0008: journal entries and lines now get compact hand-written audit triggers, one "post" and one "void" event per entry with its date, ref, memo, source and amount. That gave 104 MB, of which about 33 MB is one audit row per entry.

Also fixed: clicking the current page's sidebar item now returns to its list (after posting an entry, "Journal entries" did nothing).

## M5 — QuickBooks Online migration (outline)

- List imports (MG-1): chart of accounts, customers, vendors, products/services.
- **Import in bulk mode**: one audit event summarising each import run instead of one per entry, so 17 years of history adds about 71 MB (the ledger) rather than about 104 MB (M4 benchmark). Posting through `postEntry()` took about 60 s for 102,000 entries in Node; reuse prepared statements if the browser is much slower.
- History import (MG-2, MG-3): parse the cash-basis exports and group rows back into balanced transactions. Keep dates, numbers, names and memos; entries carry `source_type = 'qbo_migration'`.
- Dry run (MG-4): validate, map QuickBooks accounts to new accounts, and list errors before writing.
- Writes go into a fresh company folder (MG-6), so a failed run is simply deleted.
- Tie-out (MG-5): compare our trial balance at every year-end and the latest balance sheet with QuickBooks's cash-basis reports, with differences by account and year. Migrated history keeps any A/R or A/P amounts QuickBooks's own cash-basis reports still show, so the tie-out is exact.
- Every edge case found in real exports becomes an anonymized fixture plus a Vitest test.
- Run per company against real data. The QuickBooks Online subscription stays active until all four pass.

## M6 — Banking (outline)

- `.qbo` parser for both OFX 1.x (SGML) and 2.x (XML) (BK-1); import into a review queue (BK-3).
- Duplicates (BK-6): match on FITID + date + amount. Migrated transactions have no FITID, so date + amount + account matches against them are flagged for review rather than skipped.
- Matching to existing payments, bill payments and expenses (BK-4); rules (BK-5); transfers auto-matched across accounts (BK-9).
- Reconciliation (BK-7) and its saved reports, with a warning when a reconciled transaction changes (BK-8).

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
| QuickBooks's cash-basis export can't be grouped back into balanced transactions | Owner task in M1 checks one year early; Journal report preferred; MG-7 (API) is the fallback |
| Chrome for Android lacks the folder picker | Checked in M1; Android drops out of the MVP if so |
| A large company is slow to open or save | Measured in M1; attachments already outside the database; no hard targets accepted |
| Work lost in a crash | Save within seconds of each change; at most those seconds are lost |
| Forgotten passphrase | No recovery by design; backups with a known passphrase are the only way back; the owner guide (M8) says so |
| Pro-rata rounding drifts | One shared `allocateProRata()` with property-based tests; ledger balance enforced by the schema regardless |
