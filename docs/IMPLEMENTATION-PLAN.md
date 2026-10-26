# Implementation Plan — MVP

Oct 26, 2026 · @Khaleel

How the MVP in `docs/MVP-REQUIREMENTS.md` gets built. M1 is planned in detail; M2–M8 are outlined and get detailed when they start. Requirement IDs in brackets.

## Build order (agreed Oct 26, 2026)

| Milestone | What | Requirements |
| --- | --- | --- |
| M1 | Technical test + project scaffold | Risks behind DF-1, DF-2, Client and Performance NFRs |
| M2 | Company files, owner unlock, audit log | DF-1–DF-4, DF-9–DF-11, CO-1–CO-4, US-1, US-3, US-5 |
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

- [ ] `git init`, `.gitignore`, first commit of the docs
- [ ] Vite + React + TypeScript (strict), ESLint, Prettier; npm scripts `dev`, `build`, `test`, `check` (typecheck + lint + test)
- [ ] `vite-plugin-pwa` (Workbox): manifest, icons, service worker; confirm the app installs from `localhost`
- [ ] `@sqlite.org/sqlite-wasm` in a dedicated Web Worker (exclude it from Vite's dependency pre-bundling); typed message API between UI and worker (Comlink or a small typed wrapper)

### 2. Company file prototype

- [ ] Pick or create a folder with `showDirectoryPicker({ mode: 'readwrite' })`; store the handle in IndexedDB as the recent-folders entry; on reopen, `queryPermission` and then `requestPermission`; check whether the installed app gets "allow on every visit"
- [ ] Encrypted file round trip: create the database, run a migration, write `company.ebk`, close, reopen with the passphrase, read back
- [ ] Atomic save: kill the tab during a save and confirm the old file survives intact
- [ ] On-disk change check (DF-3): record `lastModified` and size after open and after each save; edit the file from outside and confirm the save refuses
- [ ] Migration runner: `import.meta.glob('/db/migrations/*.sql', { query: '?raw', eager: true })`; apply pending files in one transaction; set `PRAGMA user_version`

### 3. Measurements (recorded, not pass/fail)

- [ ] Synthetic-company generator: 17 years, about 6,000 entries a year, 2–6 lines each. Adjust once real QuickBooks volumes are known
- [ ] Record database size; open time (read, key derivation, decrypt, deserialize); save time (export, encrypt, write); worker memory; cash-basis P&L for one year and for all 17 years, with and without indexes on `(account_id, date)`
- [ ] PBKDF2 at 600,000 iterations: unlock time on desktop and Android
- [ ] Desktop Chrome on the owner's PC, and Android Chrome
- [ ] Write the results to `docs/spikes/M1-results.md`

### 4. Android check

- [ ] Phone on USB debugging, `chrome://inspect` → port forwarding `5173 → localhost:5173`, open the dev server on the phone
- [ ] Check `'showDirectoryPicker' in window`. If present, run the same file prototype and measurements. If absent, record it; Android is then out of scope for the MVP (Client NFR)

### 5. Test setup

- [ ] Vitest for TypeScript logic
- [ ] Schema tests in `db/tests`, running the real migrations against an in-memory database in Node with the same `@sqlite.org/sqlite-wasm` package (fall back to `better-sqlite3` on a matching SQLite version if the package won't run under Node)
- [ ] One example integrity test (a table `CHECK` constraint) to prove the setup
- [ ] CI later, once there's a git remote; until then `npm run check` before each commit

### Owner task, can run in parallel (needed before M5)

- [ ] In QuickBooks Online, for one company and one year: check whether the **Journal** report offers a Cash basis option. Export Journal (Cash) if it does, otherwise **General Ledger** (Cash), to Excel
- [ ] Also export that year's cash-basis Trial Balance and year-end Balance Sheet for the tie-out
- [ ] Drop the files in a private folder outside the repo; they become anonymized fixtures in M5

**Done when:** the app installs from `localhost`; an encrypted company file round-trips; the atomic-save and change-check tests pass; measurements and the Android result are written up; `npm run check` is green.

## M2 — Company files, owner unlock, audit log (outline)

- **Create company** (CO-1): pick or create a folder, enter legal name, EIN, address and fiscal year start, then set the passphrase twice. This writes `company.ebk` with the schema.
- **Open company** (DF-1): recent-folders list, permission prompt, passphrase, lock check, load. **Lock** (US-1) after configurable inactivity, which drops the key and closes the database after a final save.
- **Save loop** (DF-2): a "dirty" flag after each committed write; save 2 seconds after the last change, and on lock, close or the page being hidden; an unsaved-changes indicator; a `beforeunload` warning while dirty.
- **One editor** (DF-4): a Web Lock per company id for tabs; `company.lock` with device name and a heartbeat, where a stale heartbeat lets the owner clear it; others open read-only.
- **Backups** (DF-9, DF-10): first save of the day and every few hours while dirty; keep the last 30; warn after 7 days without one. Restore validates the header, decrypts and shows the date and latest entry before replacing anything.
- **Schema upgrade** (DF-11): back up, migrate, refuse `user_version` newer than the app.
- **Company switcher and banner** (CO-2), **module toggles** (CO-4).
- **Owner** (US-3): a single user row; the app sets the current user in a one-row `session` table at unlock, so triggers can stamp it.
- **Audit log** (US-5): migration helper that generates insert/update/delete triggers per table writing `audit_event` (before/after as JSON); unlock, lock and restore events written by the app.
- **Passphrase change**: rewrap the data key (US-1).

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
