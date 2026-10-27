# EasyBooks

Double-entry bookkeeping for four US small businesses, as a standalone Chrome PWA. Each company's books are an encrypted folder on your own disk.

- Scope: [docs/MVP-REQUIREMENTS.md](docs/MVP-REQUIREMENTS.md)
- Build plan: [docs/IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md)
- Progress: M1 (technical test, [results](docs/spikes/M1-results.md)) M2 (company files, unlock, audit log), M3 (ledger, period close), M4 (reports), M5 (QuickBooks migration) and M6 (banking) are built; M7 (expenses, bills, sales) is next

## Run it

Needs Node 24+ and Chrome.

```sh
npm install
npm run dev        # http://localhost:5173
npm run check      # typecheck + lint + tests
```

| Script                      | What                                                                       |
| --------------------------- | -------------------------------------------------------------------------- |
| `npm run dev`               | Development server. `PWA_DEV=1 npm run dev` also serves the service worker |
| `npm test`                  | Vitest: TypeScript logic and integrity rules against the real schema       |
| `npm run build` / `preview` | Production build (needs free memory; see the M1 results)                   |
| `npm run icons`             | Redraw `public/icons`                                                      |

## Layout

```
src/app/        UI: start screen, workspace, pages
src/worker/     SQLite worker: company file format, folder access, session
                (autosave, locks, backups), migrations, audit triggers
src/ledger/     ledger service: postEntry(), accounts, balances, reports, allocation
src/shared/     worker client and code shared by UI and worker (money, accounts)
src/modules/    optional modules: screens, logic and tests (migration: QuickBooks import; banking: statements, review, rules, reconciliation)
db/migrations/  numbered SQL migrations, one sequence
db/tests/       schema and integrity-rule tests
```
