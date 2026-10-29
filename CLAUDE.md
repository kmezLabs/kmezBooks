# CLAUDE.md — Accounting App (MVP)

Context for Claude Code. This project is a standalone, double-entry accounting PWA, inspired by QuickBooks Online, for the owner's four US small businesses. Each company's books are an encrypted company folder on the user's own disk, which the app opens like a document.

**Source of truth for scope:** `docs/MVP-REQUIREMENTS.md` (exported from the requirements doc). Every requirement has a stable ID (e.g. `GL-3`, `BK-6`, `MG-5`) with priority **M** (must) or **S** (should). Reference these IDs in commits, PRs, tests and code comments. If this file and the requirements doc disagree, the requirements doc wins; flag the conflict to the user.

**Build plan:** `docs/IMPLEMENTATION-PLAN.md` (M1 in detail, M2–M8 outlined).

---

## Project facts (decided)

| Topic | Decision |
| --- | --- |
| Audience | Owner's own use for 4 US businesses; may become a sellable product later (keep the door open, don't build for it yet) |
| Users | **Owner only in the MVP.** Bookkeeper handoff by check-out (`DF-5`–`DF-8`, `US-2`, `US-4`) is S, first after the MVP. One editor per company at a time: lock file + on-disk change check (`DF-3`, `DF-4`); no sync |
| Companies | 4, fully isolated (one folder and database each); **no intercompany transactions** |
| Accounting basis | **Cash basis**, calendar fiscal year, all companies. **The ledger itself is cash basis**: only cash movements post. Invoices and bills are documents; their payments post pro rata over the document's lines (`GL-8`). No A/R or A/P postings except migrated history |
| Bank data | Statement **file import, `.qbo` first** (all their banks/cards provide it). `.ofx/.qfx`, CSV, Excel are a fallback (S). Live bank feeds are a future module (need a server) |
| History | Migrate **~17 years from QuickBooks Online** via list exports + a **cash-basis** transaction report (Journal if it offers cash basis, else General Ledger) exported to Excel, one file per year (`MG-2`) |
| Key output | On-demand cash-basis P&L and balance sheet |
| Not needed now | Sales tax, inventory, payroll, multi-currency (future modules) |
| Architecture | **Standalone PWA, no backend.** SQLite (WebAssembly) in a Web Worker. Each company is a **folder on the user's disk** (encrypted database + encrypted `attachments/`), opened with the File System Access API and unlocked with a per-company passphrase. **Do not use OPFS or other browser storage for books**; the browser keeps only the recent-folders list (handles in IndexedDB) |
| Hosting | **Develop and run on `localhost`** for now (a secure context, so install, service worker and folder access work). Where to host is decided later |
| Client | Installable **PWA targeting desktop Chrome**, fully offline once installed. Android only if Chrome for Android has the folder picker (checked in M1); otherwise out of MVP scope. Other browsers best-effort |
| Performance | **No hard targets** for the MVP (opening over 5 s and reports over 2 s are acceptable); measured in M1 |

## Tech stack

- **Client:** React + TypeScript, Vite, Workbox (PWA), Vitest for tests
- **Database:** `@sqlite.org/sqlite-wasm` in a Web Worker. The open company's database is **held in memory**: decrypted and deserialized on open, then serialized, encrypted and written back whole on save (`DF-2`). No OPFS VFS and no SQLite cipher build
- **File access:** File System Access API (`showDirectoryPicker`, persistent permission for the installed PWA). Saves go through `createWritable()`, which writes to a temporary file and swaps it in on `close()`, so saves are atomic
- **Encryption:** WebCrypto. A random AES-256-GCM data key encrypts the database and each attachment. It is wrapped (AES-KW) by a key derived from the passphrase with **PBKDF2-SHA256, 600,000 iterations**; the iteration count and salt are stored in the file header. File format in the implementation plan
- **Money:** **integer cents** (`INTEGER`) in SQLite, because SQLite has no exact decimal type and its `NUMERIC` can store floating point. Every table is declared `STRICT`, so an `INTEGER` column can never hold a float or text
- **Schema changes:** numbered SQL migration files in `db/migrations/` (one sequence across modules), bundled with the app, applied when a company is opened (`PRAGMA user_version`); take a backup first and refuse companies from a newer version (`DF-11`). Never edit a company database by hand
- **DB tests:** Vitest against the real schema (SQLite in Node, same `@sqlite.org/sqlite-wasm` package, migrations loaded through the same `import.meta.glob` as the app). Vitest runs in one reused worker (`isolate: false, maxWorkers: 1`) because the dev PC is short of memory; tests must not depend on module isolation. Its on-disk module cache is off (`fsModuleCache: false`) because it missed new migration files
- **Backups:** the user's normal file backups cover the company folders; the app adds versioned encrypted backups and restore (`DF-9`, `DF-10`)

## Architecture rules (follow these when writing code)

1. **Integrity rules live in the SQLite schema, and stay small and stable.** Implement as `CHECK` constraints and triggers:
   - Every journal entry balances (debits = credits). SQLite has no deferred constraints, so lines are written while the entry is `draft`, and a trigger checks the balance when its status changes to `posted`
   - No create/edit/void on or before a company's closing date (owner override is logged)
   - Company isolation: one folder and database per company; every table has `company_id TEXT NOT NULL REFERENCES company (id)` (a test checks every table)
   - Audit log trigger on every change (user, action, entity, before/after, timestamp); the current user comes from a one-row `session` table set at unlock. **Audit triggers are generated** from the live schema by `src/worker/audit.ts` after every migration; never hand-write them in a migration. The one exception is the ledger: `journal_entry` and `journal_line` are excluded and have compact hand-written triggers (migration 0008, one "post" and one "void" event per entry), because full row copies made the company file several times larger
   - Posted entries are never deleted (a `BEFORE DELETE` trigger aborts); corrections are voids or adjusting entries. Exception, per company (`company.posted_edits`, GL-6 off, owner decision 2026-10-27): a posted entry may go back to draft to be rewritten and posted again, or deleted; posting again runs every check, the closing date guards both ways, finished reconciliations and QuickBooks history (delete) stay protected, and the audit log keeps the old version
   - Cash basis: no postings to A/R or A/P accounts except entries whose source is the QuickBooks migration
   - Schema rule messages start with the requirement ID (`RAISE(ABORT, 'GL-3: …')`); `fromRule()` in `src/worker/errors.ts` turns them into readable errors, and `PC-1` into `ClosedPeriodError`
2. **Never lose or clobber a company file.** Saves are whole-file and atomic. Before writing, check that the file on disk hasn't changed since it was opened or last saved (`DF-3`). Respect the folder lock (`DF-4`). Never write a partially encrypted or unverified file over a good one.
3. **Workflow logic lives in TypeScript:** bank matching, categorization rules, invoice behavior, payment allocation, report building, the QuickBooks importer, backups. A bug here must never be able to unbalance or corrupt the books, because the schema rejects invalid writes.
4. **One posting path.** Modules never insert ledger rows directly. They call a single `postEntry()` (`src/ledger/postEntry.ts`), which writes the entry and its lines in one transaction. `JournalEntry` carries `source_type` + `source_id`, so the ledger never needs to know what an invoice is.
5. **One allocation function.** Payments against invoices and bills are split over the document's lines only by `allocateProRata()` in `src/ledger/` (BigInt, largest-remainder rounding, parts always sum to the payment). Covered by property-based tests.
6. **Database and file access only through the worker.** UI code talks to the SQLite worker through a typed message API; no module opens the database or company files itself.
7. **Modules are optional.** Each module = a folder of PWA screens + its own tables + its migrations, toggleable per company (`CO-4`). Removing a module must not affect the ledger or reports.
8. **Extension via events.** The ledger service emits an in-app event after each committed posting; future modules subscribe instead of editing existing modules.
9. **Money:** integer cents in SQLite; in TypeScript use integer cents or a decimal library. Never use JS `number` arithmetic on currency beyond adding safe-integer cents.
10. **Future-proofing:** keep `company_id` on every row and keep the SQL portable, so a later move to a server database or sync needs no redesign.

## MVP modules (prefix = requirement IDs)

`CO` Companies · `GL` Ledger core · `PC` Period close · `AR` Customers and sales · `AP` Vendors and bills · `EX` Expenses · `BK` Banking (statement import, review queue, matching, rules, reconciliation) · `RP` Reports · `MG` QuickBooks migration · `US` Users and access · `DF` Company files (open/save, locking, backup, restore, schema upgrade; check-out is S)

## Build order (agreed 2026-10-26)

Details in `docs/IMPLEMENTATION-PLAN.md`.

1. **M1** Technical test + scaffold (done except the hand checks in `docs/spikes/M1-results.md`): in-memory SQLite worker, encrypted open/save to a picked folder, measurements at 17-year size, Chrome for Android folder-picker check, migration runner, Vitest
2. **M2** Company files, owner unlock, audit log (`DF`, `CO`, `US-1`, `US-3`, `US-5`) (done)
3. **M3** `GL` + `PC`: chart of accounts, `postEntry()`, balance check, closing-date lock, voids, `allocateProRata()` (done)
4. **M4** `RP`: trial balance, GL detail, P&L, balance sheet (done)
5. **M5** `MG`: QuickBooks Online cash-basis import with dry run and year-end tie-out (`MG-5`), run against real data per company (built; one company-year tied out; the full runs per company are the owner's, with the app)
6. **M6** `BK`: `.qbo` import, duplicate detection, review queue, rules, reconciliation (built; tried on real bank statements; card statements still to try)
7. **M7** (slim, owner decision 2026-10-28): payees with customer and vendor records (`GL-11`, `AR-1`, `AP-1`), then expenses (`EX`). Invoices, estimates and bills are S until a company needs them (done)
8. **M8** Offline polish, export, restore drill, owner guide (`docs/OWNER-GUIDE.md`) (built 2026-10-28)
9. After the MVP, at the owner's request: recurring journal entries (`GL-5`, for depreciation and amortization; built 2026-10-28)
10. **M9** Invoices and bills, cash basis, per-company modules that start off (planned 2026-10-28): slice 1 products & services, estimates, invoices, customer payments, slice 2 the invoice PDF and sending it, slice 3 recurring invoices, slice 4 bills and bill payments (built)

## Conversation history (how we got here)

- Started from a full list of QuickBooks Online functions (77 items); the owner picked the suggested minimum set and asked for an open, modular architecture. Multi-company was promoted into the MVP because there are four businesses.
- Answers to open questions: own use first; no intercompany; file import instead of live bank feeds; cash basis, calendar year; migrate all QBO history (~17 years); no sales tax or inventory yet; Chrome PWA.
- Tech stacks considered: Python/Django, TypeScript/Node, C#/.NET, and building on ERPNext. The first choice (Oct 24) was a database-centric design on self-hosted Supabase (PostgreSQL, RLS, pgTAP) on the home lab over VPN. Local-first in-browser databases were rejected at that point because two users editing the same books risks sync conflicts.
- Concern raised: will SQL business rules keep changing? Resolution: keep only the stable integrity rules in SQL (tested, versioned migrations); put changing feature logic in TypeScript.
- 2026-10-25: accrual ledger plus a cash-basis view was chosen, so the accrual QBO Journal export would load as is. **Superseded 2026-10-26** (see below).
- **2026-10-26, standalone PWA, replacing Supabase.** Each company's data stored locally in SQLite. No sync: one editor per company at a time; file check-out chosen over shared-folder sync, single-device and a sync server for the bookkeeper. Per-company passphrase with encryption chosen over app-lock only. TOTP 2FA and email invites dropped; invoices handed to the device's mail app (`AR-4`); new module `DF`.
- **2026-10-26, company folders on the user's disk, not OPFS.** The owner wants books opened from their own file system. SQLite can't write a picked file in small pieces, so the database is held in memory and saved whole and atomically. This also allows plain WebCrypto whole-file encryption. Each company is a folder so attachments stay out of the database file.
- **2026-10-26, cash-basis ledger and other decisions.** To stay focused on cash basis, the ledger posts only cash movements and history comes from QBO's cash-basis reports, so every year ties out exactly and no payment links are needed (`MG-10` retired). This replaced the accrual ledger plus cash view, so Settlement and CashBasisLine are gone; accrual reporting later is real rework. Same day: bookkeeper handoff moved to S (owner-only MVP); develop on `localhost` and decide hosting later; no hard performance targets; PBKDF2 over Argon2id; build order agreed.

## Working agreements

- Ask before changing scope: if a task needs something not in `docs/MVP-REQUIREMENTS.md`, propose it with a new requirement ID rather than silently adding it.
- Every integrity rule gets a Vitest test against the real schema; every migration-importer edge case gets a Vitest test with a fixture file.
- Keep the QuickBooks Online subscription active until all four companies pass the migration tie-out.
