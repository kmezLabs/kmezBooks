# M1 technical test — results

Oct 26, 2026 · in progress (manual runs on real disk and Android outstanding)

What M1 had to find out (docs/IMPLEMENTATION-PLAN.md, M1): whether a company can live in an encrypted folder on disk, loaded into memory and saved whole; how long that takes at 17 years of history; and whether Chrome for Android can open folders.

## Summary so far

At the planned size (17 years × 6,000 entries = 102,000 entries, 407,000 lines), in Chrome 155 on the development PC:

| | Result |
| --- | --- |
| Company file size | 30 MB without indexes, 42 MB with |
| Open (read, unlock, decrypt, load) | 0.5–0.7 s, of which PBKDF2 is 0.2–0.27 s |
| Save (serialize, encrypt, verify, write) | 0.3–0.4 s |
| P&L for one year | 27–40 ms (indexed) |
| P&L over 17 years / trial balance over all history | 0.6–0.7 s |
| Memory (SQLite WebAssembly heap) | about 110 MB with the 42 MB database open |
| Interrupted save | Old file intact; company reopens |
| File changed by someone else | Save refused (DF-3) |

All comfortably inside "no hard targets". Whole-file save is viable at this size.

## Proven in automated tests (Node, `npm test`)

| What | Result |
| --- | --- |
| Encrypted file format: round trip, wrong passphrase, damaged body, tampered header, unknown version, NFC/NFD passphrases | Pass |
| Passphrase change re-wraps the data key; files saved before the change still open with the new key, and old backups with the old passphrase | Pass |
| In-memory SQLite serialize/deserialize; garbage and truncated databases rejected as damaged | Pass |
| Migrations: ordering, gaps, failed migration rolls back including `user_version`, newer schema refused | Pass |
| `company.kmb` never contains the plaintext database or the company name | Pass |
| On-disk change check refuses to overwrite a file another copy saved (DF-3); a failed write keeps the old file | Pass (fake folder that behaves like Chrome's swap-file writes) |
| STRICT tables refuse text and fractions in INTEGER columns | Pass |
| Every worker error class names itself (the production build shortens class names) | Pass |

## Headless Chrome run (automated, production build)

Chrome 155 headless on the development PC (8 cores, 16 GB), driving the real test screen over the DevTools protocol against `npm run preview`. Headless Chrome has no folder picker, so the picker was replaced with a folder in Chrome's private storage. That swap is only for this test, not where books live. Everything else ran exactly as in the app: unlock, encryption, the SQLite worker, `createWritable` saves.

| Step | Run 1 | Run 2 |
| --- | --- | --- |
| Generate 17 × 6,000 entries | 9.9 s | — |
| Save 29.7 MB (serialize / encrypt / verify / write) | 42 / 73 / 95 / 104 ms = 317 ms | 39 / 76 / 106 / 118 ms = 340 ms |
| Open 29.7 MB (read / PBKDF2 / decrypt / deserialize + integrity check) | 57 / 271 / 71 / 155 ms = 558 ms | 48 / 241 / 69 / 153 ms = 517 ms |
| WebAssembly heap after open | 61 MB | 61 MB |
| Create indexes | 1,029 ms | 857 ms |
| P&L one year: no index / indexed | 102 / 40 ms | 122 / 27 ms |
| P&L 17 years: no index / indexed | 698 / 689 ms | 768 / 615 ms |
| Trial balance, all history: no index / indexed | 852 / 733 ms | 786 / 669 ms |
| Save 42 MB with indexes | 404 ms | 403 ms |
| WebAssembly heap with 42 MB open | 107 MB | 107 MB |
| PBKDF2-SHA256, 600,000 iterations | 200 ms | 200 ms |
| Overwrite `company.kmb` from outside, then Save | Refused: `FileChangedOnDiskError` | Same |
| Reload the page 3 s into the 10 s atomic-save test, reopen | Opens | Opens |

The first run showed the refusal as `N: …`: the production build had shortened the error class names the UI matches on. Fixed by spelling each name out, with a test.

Findings for later milestones:

- **Reports over all history** (M4): indexes barely help 17-year queries; they scan most rows anyway. If 0.7 s feels slow in use, add the monthly account-balance table the plan already mentions.
- **Save verify** (decrypting the new file before writing it) costs about 100 ms at 30–42 MB. Keep it: it's the guard behind CLAUDE.md rule 2.
- **Unused SQLite helper files** (`sqlite3-worker1`, `sqlite3-opfs-async-proxy`, about 250 KB) are bundled and precached. Exclude them in M8.

## Node baseline

`SPIKE_FULL=1 npx vitest run src/worker/spike.test.ts --silent=false`, 17 × 6,000:

| Measure | Value |
| --- | --- |
| Entries / lines | 102,000 / 406,813 |
| Database size (with indexes) | 42 MB |
| Serialize / encrypt / decrypt / deserialize + check | 33 / 36 / 27 / 149 ms |
| P&L one year / 17 years, indexed | 32 / 547 ms |
| Trial balance, indexed | 581 ms |

## Machine memory

The first attempt hit the PC's memory commit limit (19.3 of 19.7 GB committed): parallel Node processes crashed and the production build failed. After freeing memory (16.7 GB limit, 11.0 GB committed) everything ran, including `npm run build`. Kept from that episode:

- Vitest runs in one reused worker (`vite.config.ts`); the suite still takes about a second.
- The development service worker is opt-in (`PWA_DEV=1 npm run dev`); the production build always includes it.
- The page file is 1 GB and not system-managed, so memory can run short again with many apps open.

## Still to do by hand

### Desktop Chrome on the real disk

What the headless run couldn't cover: the real folder picker, Chrome's permission prompts, whether permission persists, and saves to a real NTFS folder.

`npm run build && npm run preview`, open http://localhost:4173 in Chrome.

1. Check that Chrome offers to **install** the app (address-bar icon). Install it and continue in the installed window.
2. Enter a passphrase. **New company in a folder…** → pick an empty folder, for example `Documents\kmezBooks-spike`.
3. **Generate history** (17 × 6,000), **Save**, **Close**, reopen from the recent list.
4. Close the installed app, reopen it, open the company from the recent list. **Does Chrome ask for folder permission again?** Does it offer "Allow on every visit"?
5. With the company open, edit `company.kmb` from Explorer (or copy another file over it), then **Save**. It must refuse.
6. Offline: stop the preview server, reopen the installed app, open the company. It must still work.

Results:

_(paste here)_

### Android Chrome

1. On the phone, enable USB debugging and connect it. On the PC: `chrome://inspect` → Port forwarding → `4173` → `localhost:4173`.
2. Open `http://localhost:4173` on the phone. The first result block shows `folderPicker`.
3. If `folderPicker` is `true`, repeat the desktop steps. If `false`, Android is out of scope for the MVP (Client NFR).

Results:

_(paste here)_

## Conclusions

_(after the manual runs)_
