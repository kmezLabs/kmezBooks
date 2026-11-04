# kmezBooks

Double-entry bookkeeping for small US businesses, as a standalone Chrome PWA. Each company's books are an encrypted folder on your own disk.

**Use it:** https://kmezlabs.github.io/kmezBooks/ (home page, the app and the user guide).

- Scope: [docs/MVP-REQUIREMENTS.md](docs/MVP-REQUIREMENTS.md)
- Build plan: [docs/IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md)
- Progress: M1 to M7 are built: the technical test ([results](docs/spikes/M1-results.md)), company files, ledger and period close, reports, QuickBooks migration, banking, the transactions register, and slim M7 (payees with customer and vendor records, expenses). M8 (polish) is in progress
- User guide (every screen, plus folders, passphrases, backups, restore drill, export): [docs/USER-GUIDE.md](docs/USER-GUIDE.md)
- Importing a company from QuickBooks Online: [docs/import-qbo.md](docs/import-qbo.md)

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
| `npm run coverage`          | The tests with coverage of `src/`; report in `coverage/index.html`         |
| `npm run build` / `preview` | Production build (needs free memory; see the M1 results)                   |
| `npm run build:pages`       | The GitHub Pages site in `pages-dist/`: home page, app and user guide      |
| `npm run icons`             | Redraw `public/icons`                                                      |

### Running the app from this computer

Besides the web address, the app can run from the project folder: `npm run build`, then `npx vite preview` and open **http://localhost:4180**. That copy is separate from the one at the web address: Chrome keeps a few things for each address (the recent companies list, backup folder choices, the theme, device name and idle time), so each starts without the other's. The books aren't affected: they stay in their folders.

To move from `localhost:4180` to the web address:

1. Close every company in the old copy.
2. Open https://kmezlabs.github.io/kmezBooks/app/ and install it.
3. Open each company with **Open company folder…**, once. After that it's in the recent list.
4. Choose each company's backup folder again, under **Backups**, and set the device name, idle time and theme in **Settings** (the gear).
5. Then uninstall the old copy, or keep it as a spare. Don't use both at once: the folder lock stops the second one from opening a company the first has open.

## Branches and releases

- Work happens on a branch and goes to `develop` by a pull request, squash-merged; the branch is then deleted.
- A pull request from `develop` to `release` is a release: merging it publishes the site to GitHub Pages (`.github/workflows/pages.yml`).
- `develop` and `release` change only through pull requests that pass the CI check (`.github/workflows/ci.yml`: `npm run check` and `npm run build:pages`) and are merged by the owner.

## The site

`npm run build:pages` (`scripts/build-pages.mjs`) builds the site for `/kmezBooks/`:

- the home page from `site/`
- the app under `app/`, built with `KMB_BASE=/kmezBooks/app/` (a plain `npm run build` stays at `/` for `localhost`)
- the user guide under `guide/`, rendered from `docs/USER-GUIDE.md`
- the license and the third-party licenses the app ships with

A broken link on the home page or in the guide fails the build.

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

## License

Copyright (C) 2026 kmezLabs

kmezBooks is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

kmezBooks is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with kmezBooks, in [LICENSE](LICENSE). If not, see <https://www.gnu.org/licenses/>.
