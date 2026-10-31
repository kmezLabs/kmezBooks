# kmezBooks owner guide

How to keep your books safe: where they live, how backups work, and what your passphrase means. Read this once, and keep a copy of the "Write this down" list somewhere safe.

## Starting kmezBooks

For now kmezBooks runs from this computer:

1. In the project folder, run `npx vite preview` and leave it running. It always uses port 4180; if another program has that port, it stops with an error instead of moving to another one.
2. Open Chrome at **http://localhost:4180**.
3. To install it as an app, click the install icon at the right of Chrome's address bar. It then opens in its own window and works **offline**: no internet connection is needed to open, change or save your books.

When a new version is ready, a bar at the top says **"A new version of kmezBooks is ready"**. Click **Save, close and update**: your open company is saved and closed first, then the new version starts. Open the company again afterwards. If the save fails, nothing updates and the bar tells you why.

The first time an update arrives after this guide was written, close every kmezBooks window and open it again. From then on, the bar handles updates.

The **status bar** at the bottom shows whether your changes are saved, when the last backup was made, whether this computer is online (kmezBooks works the same offline), and a short message after you do something, such as an export. On the far right is the version, with the build it came from, for example `v0.1.0 · build 6035081, Oct 31`; it tells you which version is running after an update.

The browser tab, or the title bar of the installed app, shows the open company's name, "Acme LLC – kmezBooks" in a tab and "kmezBooks - Acme LLC" in the installed app, so you can tell windows apart. With no company open it says just "kmezBooks".

## Your company folders

Each company is one folder on your disk, which you chose when you created it. Nothing about your books is stored in the browser except the list of recently opened folders.

| In the folder | What it is |
| --- | --- |
| `company.kmb` | The books: every account, transaction, payee and setting, **encrypted** with the company's passphrase |
| `attachments/` | Receipts and documents, each encrypted |
| `backups/` | kmezBooks' own backups (unless you chose another backup folder) |
| `company.lock` | Present while the company is open, so two computers don't change it at once |

Until October 31, 2026 this app was called EasyBooks, and a company folder held `company.ebk` instead of `company.kmb`. Such a folder opens as before; the first time it saves, `company.ebk` becomes `company.kmb`. Older attachments (`.eba`) and backups (`.ebk`) keep their names and still open.

- Keep the folders somewhere your normal backups cover (File History, a cloud-synced folder, restic on the home lab…).
- Never edit or rename the files inside. To move a company, close it, move the whole folder, then use **Open company folder…** and pick the new location.
- kmezBooks saves on its own about two seconds after each change, and when you close the company. **Close company** (top right) saves, closes and forgets the key. A company also closes by itself after **15 minutes** without activity; change that on **Passphrase and device**.

### One computer at a time

While a company is open, its folder has a lock. If you open it on another computer, kmezBooks offers **Open read-only**. If the first computer crashed or its laptop lid was closed, the lock goes stale after about two minutes, and kmezBooks also offers **Take over and edit here**. Only take over when you're sure the other session has really ended.

## Your passphrase

Each company has its own passphrase (at least 10 characters). It encrypts the books, the attachments and the backups.

- **If you lose a company's passphrase, its books cannot be opened. Not by you, not by anyone, not by the developer.** There's no reset, because the passphrase is the key itself.
- Write each passphrase down and keep it somewhere safe and separate from the computer, such as a password manager or a sealed envelope.
- Change it on **Passphrase and device**. Backups made before the change still open with the **old** passphrase, so keep the old one until those backups have aged out (kmezBooks keeps the newest 30).

## Backups

kmezBooks makes its own encrypted backups, on top of your normal file backups.

- **When:** on the first save of each day, then every 4 hours while you work, before a restore, and before an app update changes the company's format. **Back up now** (on **Backups**) makes one on demand.
- **How many:** the newest 30 regular backups are kept; older ones are removed.
- **Where:** in `backups/` inside the company folder, unless you choose another folder. **Choose a folder that's synced to cloud storage or on another drive**, so a lost or broken disk doesn't take the backups with it. Attachments are copied there too. All four companies can share one such folder: each gets its own folder inside it, named after the company.
- **Warning:** if a company has had no backup for 7 days, kmezBooks says so.

### Test a backup (the restore drill)

Once a month, for each company: open **Backups**, click **Test…** on the newest backup and enter its passphrase. kmezBooks opens the backup in memory and checks that:

- the passphrase opens it
- the database is sound
- it opens in this version of kmezBooks
- every account balance matches your books as they were when it was made
- its attachments are present

Nothing is restored or changed. If any check fails, the dialog shows which one.

If balances differ, entries were probably changed in place or deleted since the backup. That can only happen when **Allow changing and deleting posted transactions** is on (**Company** page). The Audit log shows those changes.

### Restore

**Restore…** on a backup puts the company back to how it was then. Everything since is replaced, but the current version is backed up first, so a restore can itself be undone. To restore into a new folder from a backup file, use **Restore from backup…** on the start screen.

## Invoices (optional)

A company that bills customers can turn on **Customers and sales** on the **Modules** page. Its Sales pages then appear: **Invoices**, **Estimates** and **Products & services**.

An invoice only records what a customer owes. Nothing goes into the books until the customer pays. **Receive payment** puts the money into the bank account it went to, and counts it as income that day (cash basis). Bank review then offers that payment as the match for the deposit on your statement.

To send an invoice or estimate, open it and click **Send…**. The customer's email, a subject and a message are filled in. **Share…** (where Chrome offers it) hands the PDF to your mail app. **Download and email** saves the PDF and opens your mail app; attach the PDF there. Either marks it sent. Your logo, contact details and a footer (how to pay, say) go on the **Company** page.

For an invoice that repeats, such as monthly tuition, open an invoice and click **Make recurring**, or use **Recurring invoices**. Each time you open the company, kmezBooks makes the invoices that have come due as drafts and tells you in a bar at the top; check them and send them from **Invoices**. **Skip next** leaves out a month; **Create now** makes the next one early.

## Bills (optional)

A company that gets bills to pay later can turn on **Vendors and bills** on the **Modules** page. **Bills** then appears under Purchases, showing the bills due, oldest first.

Like an invoice, a bill only records what you owe; nothing goes into the books until you pay it. Enter the vendor, the dates and the lines by account, and attach the vendor's PDF or a photo. A vendor's terms and default category (on the Payees page) fill in for you.

**Pay bills** pays one vendor's bills with one check or transfer, fully or in part, from a bank or credit card account. The expenses count on the day you pay (cash basis), split over each bill's accounts, and bank review then offers the payment as the match for the line on your statement.

## Accounts register

**Accounts register** (under Books) shows one account at a time, like a checkbook: any account, picked from the drop-down at the top (grouped as Assets, Liabilities, Equity, Income and Expenses), with its balance beside it. A card shows what you owe. For bank and card accounts, the last reconciliation shows too, and the ✓ column shows **R** for reconciled transactions and **C** for those checked off in a reconciliation you haven't finished.

**Transfer** moves money between your own accounts: checking to savings, or paying the card from checking (with a card picked, it starts from your first bank to the card). A transfer isn't income or an expense. **Add Transaction** also has a Transfer tab, on the Transactions page too.

## Recurring entries

Depreciation, amortization and other entries that repeat are set up once, on **Recurring entries**. The quickest way is to open last month's entry in **Journal entries** and click **Make recurring**.

kmezBooks doesn't run in the background, so recurring entries post **when you open the company**. Whatever came due since the last time is posted, each on its own date. A bar at the top then says what was posted.

An entry dated in a closed period isn't posted on its own. The bar says it's waiting, and **Recurring entries** lets you post it (with your passphrase) or skip it.

## Export

On **Backups**, under **Export**:

- **Export all data (.zip):**
  - every journal line in `journal.csv`, with accounts and dollar amounts, which opens in Excel
  - every table as CSV and JSON
  - the attachments
  - a README explaining the files
- **Decrypted database copy (.sqlite):** the database itself, for any SQLite tool.

**Exports are not encrypted.** Anyone with the file can read your books, so delete them when you're done. Each export is recorded in the Audit log.

## Write this down

For each company:

- the company name and where its folder is
- its passphrase (and the previous one, while old backups use it)
- where its backups go

Keep this list somewhere safe and separate from this computer.
