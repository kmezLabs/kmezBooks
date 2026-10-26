# M1 technical test — results

Oct 26, 2026 · in progress

What M1 had to find out (docs/IMPLEMENTATION-PLAN.md, M1): whether a company can live in an encrypted folder on disk, loaded into memory and saved whole; how long that takes at 17 years of history; and whether Chrome for Android can open folders.

## Proven in automated tests (Node, `npm test`)

| What | Result |
| --- | --- |
| Encrypted file format: round trip, wrong passphrase, damaged body, tampered header, unknown version, NFC/NFD passphrases | Pass |
| Passphrase change re-wraps the data key; files saved before the change still open with the new key, and old backups with the old passphrase | Pass |
| In-memory SQLite serialize/deserialize; garbage and truncated databases rejected as damaged | Pass |
| Migrations: ordering, gaps, failed migration rolls back including `user_version`, newer schema refused | Pass |
| `company.ebk` never contains the plaintext database or the company name | Pass |
| On-disk change check refuses to overwrite a file another copy saved (DF-3); a failed write keeps the old file | Pass (with a fake folder that behaves like Chrome's swap-file writes) |
| STRICT tables refuse text and fractions in INTEGER columns | Pass |

## Node baseline (not the browser)

17 years × 2,000 entries (a third of the planned size; the full size couldn't run on this machine, see "Machine memory" below). `SPIKE_FULL=1 SPIKE_PER_YEAR=2000 npx vitest run src/worker/spike.test.ts --silent=false`

| Measure | Value |
| --- | --- |
| Entries / lines | 34,000 / 135,734 |
| Database size | 13.7 MB |
| WebAssembly heap | 49 MB |
| Serialize + encrypt (save, before the disk write) | 11 + 14 ms |
| Decrypt + load and integrity check (open, after the disk read) | 12 + 64 ms |
| P&L one year / 17 years (indexed) | 10 ms / 175 ms |
| Trial balance, all history (indexed) | 298 ms |
| P&L one year / 17 years (no indexes) | 27 ms / 212 ms |

Scaled to 6,000 entries a year, expect roughly a 40–55 MB database, and well under a second for each step of open and save. The browser numbers below are the ones that count.

## Machine memory (found during M1)

The development PC is at its memory commit limit: 19.3 GB committed of a 19.7 GB limit, with a fixed 4 GB page file. Node processes that start several worker threads crash with "Zone Allocation failed". Consequences so far:

- Vitest runs in one reused worker (`vite.config.ts`). The whole suite still takes under a second.
- `npm run build` crashes while generating the service worker, so the production build and the **install test** wait until memory is freed.
- The development service worker is off by default; `PWA_DEV=1 npm run dev` turns it on.
- Chrome measurements on this PC may be distorted until memory is freed. Close other apps first, or let Windows manage the page file size and reboot.

## Browser results (to fill in)

Run `npm run dev`, open http://localhost:5173 in Chrome, and use the test screen. "Copy results as Markdown" puts every measurement on the clipboard; paste it under the matching heading.

### Desktop Chrome

1. Enter a passphrase. **New company in a folder…** → pick an empty folder (for example `Documents\EasyBooks-spike`).
2. **Generate history** (17 years × 6,000), then **Save**.
3. **Close**, then open it again from the recent list: this gives the open timings.
4. **Measure queries** and **Time PBKDF2**.
5. Atomic-save test: **Atomic-save test (10 s)**, close the tab within 10 seconds, reopen the app and the company. It must open.
6. Change check: with the company open, copy any other file over `company.ebk` in Explorer, then **Save**. It must refuse with "changed on disk".

Results:

_(paste here)_

### Android Chrome

1. On the phone, enable USB debugging and connect it. On the PC: `chrome://inspect` → Port forwarding → `5173` → `localhost:5173`.
2. Open `http://localhost:5173` on the phone. The first result block shows `folderPicker`.
3. If `folderPicker` is `true`, repeat the desktop steps. If `false`, Android is out of scope for the MVP (Client NFR).

Results:

_(paste here)_

### Installation (after freeing memory)

`npm run build && npm run preview`, open the preview URL in Chrome, and check that it offers to install, then that the installed app opens a company folder offline.

## Conclusions

_(after the browser results)_
