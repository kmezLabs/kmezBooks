# EasyBooks

Double-entry bookkeeping for four US small businesses, as a standalone Chrome PWA. Each company's books are an encrypted folder on your own disk.

- Scope: [docs/MVP-REQUIREMENTS.md](docs/MVP-REQUIREMENTS.md)
- Build plan: [docs/IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md)
- Current milestone: M1 technical test, see [docs/spikes/M1-results.md](docs/spikes/M1-results.md)

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
src/app/        UI (M1: technical-test screen)
src/worker/     SQLite worker: company file format, folder access, migrations
src/shared/     worker client and shared helpers
db/migrations/  numbered SQL migrations, one sequence
db/tests/       schema and integrity-rule tests
```
