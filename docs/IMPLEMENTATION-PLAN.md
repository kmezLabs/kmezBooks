# Implementation Plan — MVP

Oct 26, 2026 · @Khaleel

How the MVP in `docs/MVP-REQUIREMENTS.md` gets built. M1 is planned in detail; M2–M8 are outlined and get detailed when they start. Requirement IDs in brackets.

## Build order (agreed Oct 26, 2026)

| Milestone | What | Requirements |
| --- | --- | --- |
| M1 | Technical test + project scaffold | Risks behind DF-1, DF-2, Client and Performance NFRs |
| M2 | Company files, owner unlock, audit log (done) | DF-1–DF-4, DF-9–DF-11, CO-1–CO-4, US-1, US-3, US-5 |
| M3 | Ledger core and period close | GL-1–GL-4, GL-6–GL-8, PC-1–PC-3 |
| M4 | Reports | RP-1–RP-6 |
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

- Bulk imports (M5) would write one audit row per imported row; add a bulk-import mode that logs one summary event instead.
- The M1 technical-test page stays until the M1 hand checks are recorded.

## M3 — Ledger core and period close (outline)

- **Accounts** (GL-1, GL-7): five types, detail types, sub-accounts; no deleting an account with lines (trigger), only inactivating it.
- **Seeded chart of accounts** (GL-2): a US small-business set with no A/R or A/P accounts (cash basis); Undeposited Funds included.
- **Journal entries** (GL-3): lines are written while the entry is `draft`. A trigger on `draft → posted` rejects unbalanced or empty entries. Posted lines can't be updated or deleted (triggers).
- **`postEntry()`**: the only writer of ledger rows. It takes header + lines, runs one transaction, emits a `posted` event after commit.
- **Voids** (GL-6): status `void`, lines kept, excluded from reports, audit logged; no deletes.
- **Cash-basis rules** (GL-8):
  - `allocateProRata(amountCents, lineAmounts)` in `src/ledger/`, shared by sales and bills. It works in BigInt and gives leftover cents to the largest remainders, so the parts always sum exactly. Tested with fixed cases and property-based tests (fast-check).
  - A trigger rejects postings to A/R or A/P detail-type accounts unless the entry's source is the migration.
- **Closing date** (PC-1, PC-2): a trigger blocks insert, update or void of entries dated on or before the closing date, unless the `session` row carries an owner override. The override needs the owner override password, and each use is audit logged.
- **Year-end** (PC-3): no closing entries. Reports compute retained earnings as all prior years' net income, as QuickBooks does.
- **Manual journal entry screen** with attachments (GL-4).

## M4 — Reports (outline)

- Trial balance, general ledger detail, P&L, balance sheet (RP-1, RP-2, RP-4), straight from posted ledger lines.
- Date presets and custom ranges (RP-3); drill-down from any figure to the entries behind it (RP-5); CSV/Excel and PDF export, print (RP-6).
- Use the M1 measurements. If 17-year reports are slow, add a monthly account-balance table maintained by triggers, and test that it matches the raw lines.

## M5 — QuickBooks Online migration (outline)

- List imports (MG-1): chart of accounts, customers, vendors, products/services.
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
