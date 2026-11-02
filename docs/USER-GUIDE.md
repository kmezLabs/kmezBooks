# kmezBooks user guide

kmezBooks keeps the books for your companies: double-entry, on a **cash basis**, with a calendar fiscal year. Each company is an encrypted folder on your own disk, which kmezBooks opens like a document. Nothing about your books is stored online or in the browser.

This guide covers every screen. You don't need to read it all at once: start with [Getting started](#getting-started) and [Keeping your books safe](#keeping-your-books-safe), then look up the rest as you need it. Keep a copy of the [Write this down](#write-this-down) list somewhere safe.

## Contents

1. [Getting started](#getting-started)
2. [Companies](#companies)
3. [Transactions](#transactions)
4. [Accounts register](#accounts-register)
5. [Journal entries](#journal-entries)
6. [Correcting a posted transaction](#correcting-a-posted-transaction)
7. [Recurring entries](#recurring-entries)
8. [Accounts (chart of accounts)](#accounts-chart-of-accounts)
9. [Payees: customers, vendors and other names](#payees-customers-vendors-and-other-names)
10. [Banking](#banking)
11. [Sales: invoices and estimates](#sales-invoices-and-estimates)
12. [Purchases: bills](#purchases-bills)
13. [Reports](#reports)
14. [Closing the books](#closing-the-books)
15. [QuickBooks import](#quickbooks-import)
16. [Company settings and modules](#company-settings-and-modules)
17. [Keeping your books safe](#keeping-your-books-safe)
18. [Audit log](#audit-log)
19. [Passphrase](#passphrase)
20. [Test companies and the technical test](#test-companies-and-the-technical-test)
21. [When something goes wrong](#when-something-goes-wrong)
22. [Words used in kmezBooks](#words-used-in-kmezbooks)
23. [Write this down](#write-this-down)
24. [License](#license)

---

## Getting started

### Starting kmezBooks

1. Open Chrome at **https://mawadk.github.io/kmezBooks/app/**. The home page, https://mawadk.github.io/kmezBooks/, links to it and to this guide.
2. To install it as an app, click the install icon at the right of Chrome's address bar. It then opens in its own window and works **offline**: no internet connection is needed to open, change or save your books.

kmezBooks runs entirely in your browser. Nothing about your books is sent to that address or anywhere else; it only delivers the app.

It can also run from this computer: in the project folder, run `npx vite preview` and open **http://localhost:4180**. That copy is separate from the one above (see [Moving from this computer to the web address](#moving-from-this-computer-to-the-web-address)).

kmezBooks is made for **Chrome on a computer**. A browser that can't open folders on your disk says so on the start screen.

### Updates

New versions are published to the web address from time to time. When one is ready, a bar at the top says **"A new version of kmezBooks is ready"**. Click **Save, close and update**. Your open company is saved and closed first, then the new version starts; open the company again afterwards. If the save fails, nothing updates and the bar tells you why. With no company open, the button is **Update now**.

### Moving from this computer to the web address

Chrome keeps a few things for each address, so the web address starts without the ones from `localhost:4180`. Your books aren't affected: they stay in their folders.

1. Close every company in the old copy.
2. Open https://mawadk.github.io/kmezBooks/app/ and install it.
3. Open each company with **Open company folder…**, once. After that it's in the recent list.
4. Choose each company's backup folder again, under **Backups**, and set this computer's device name and idle time in **Settings** (the gear).
5. Then uninstall the old copy, or keep it as a spare. Don't use both at once: the folder lock stops the second one from opening a company the first has open.

### The screen

- **Top bar:** the open company's name, **Close company**, **?** for help with the page you're on, the gear for **Settings** (see [Settings](#settings)), and, at the far right, **About**. It stays in place while you scroll.
- **Sidebar** (left): the pages, in groups: Books, Sales, Purchases, Banking, Company (with **QuickBooks import** last), and Development in a test company. Pages of modules that are off aren't shown (see [Modules](#modules)). The sidebar and the page each scroll on their own.
- **Status bar** (bottom):
  - whether your changes are saved ("Saved 2:14 PM" or "All changes saved")
  - when the last backup was made ("Backed up 2 hours ago"); hover over it for the exact time
  - **Online** or **Offline: everything still works**
  - a short message after you do something, such as an export or a posting
  - on the far right, the version and the build it came from, for example `v0.1.0 · build b30b99c, Nov 1`. It tells you which version is running after an update. Click it to open **About**.
- **Window title:** the browser tab shows "Acme LLC – kmezBooks", and the installed app's title bar "kmezBooks - Acme LLC", so you can tell windows apart. With no company open it says just "kmezBooks".

The **About** button (also on the start screen, next to the title) shows the version and build, a reminder that your books never leave your computer and that kmezBooks sends no usage data, links to the home page, this guide and the source code, and the copyright and license. Press **Esc** or **Close** to go back.

The **?** in the top bar, after **Close company** (and on the start screen, next to the gear and **About**), opens help for the page you're on: the parts of this guide that cover it, in a panel beside the page, so you can keep working while you read. Links in it take you to other parts of the guide, and **Back** returns. Help is built into kmezBooks, so it works offline; **Open the full guide online** at the bottom opens this guide in a new tab. Press **Esc** or **×** to close it; going to another page closes it too.

On a phone-sized window the sidebar becomes a strip of page buttons under the top bar, and help covers the whole screen.

### Settings

The gear in the top bar, next to **?** (and on the start screen), opens **Settings**. Settings belong to this computer, not to a company: they apply to every company you open here, and to the start screen. Press **Esc** or **Close** when you're done.

**Theme** sets the colours. Click one and it applies at once:

| Theme | Looks like |
| --- | --- |
| **System** (the default) | follows your computer's light or dark setting, and changes when it does |
| **Light** | white pages, dark text |
| **Dark** | dark pages, light text, for dim rooms |
| **Grey** | softer than Light, with less glare |
| **High contrast** | black on white with stronger lines, easiest to read |
| **Warm** | cream paper and brown ink, for long sessions |

Each choice shows a small sample in its own colours. Printed reports and PDFs are always light, whatever the theme. The theme is remembered by this browser, so the web address and `localhost:4180` each keep their own (see [Moving from this computer to the web address](#moving-from-this-computer-to-the-web-address)).

**This device:**

- **Device name:** shown to other devices in the folder lock while you have a company open ("Office PC has this company open"). It starts as what Chrome says about the computer, such as "Windows 11 PC"; give each computer its own name to tell them apart.
- **Close company after (minutes idle):** 1 to 240, 15 by default.
- **Save device settings** saves the device name and the idle time, for this computer.

---

## Companies

Each company has its own folder, database, passphrase and backups. Companies are completely separate: no transaction can involve two companies.

### Creating a company

On the start screen, click **New company…** and fill in:

- **Legal name** (required), **EIN** (like 12-3456789), **Address**, **City**, **State** (two letters, such as IL), **ZIP** and the month the **fiscal year starts**
- **Your name (owner)**: shown in the audit log against everything you do
- **Start with the standard chart of accounts**: about 45 accounts for a US small business on a cash basis. Untick it if the company's history will come from QuickBooks, which brings its own accounts.
- **Test company**: see [Test companies](#test-companies-and-the-technical-test). Ticking it also ticks the standard chart and greys that box out.
- **Passphrase**, twice: at least 10 characters. Read [Your passphrase](#your-passphrase) first: a lost passphrase can't be recovered.

Then click **Choose folder and create** and pick an **empty folder**, for example `Documents\kmezBooks\Acme LLC`. The company opens straight away.

### Opening a company

The start screen lists the companies opened on this computer, with their folder and when they were last opened. Click one and enter its passphrase. Chrome may first ask to allow access to the folder again; click **Allow**.

- **Open company folder…** opens a company that isn't in the list: pick its folder.
- **Remove** takes a company off the list. Its folder isn't touched.
- **Restore from backup…** rebuilds a lost company from a backup file (see [Restore](#restore)).

### One computer at a time

While a company is open, its folder holds a lock file (`company.lock`) naming the device. If you open the company somewhere else:

- **Open read-only** lets you look without changing anything. A bar at the top says the company is read-only.
- If the other device stopped without closing (a crash, or a laptop lid closed), the lock goes stale after about two minutes, and kmezBooks also offers **Take over and edit here**. Only take over when you're sure the other session has really ended. The other device then stops saving.

The same company can't be open in two tabs of the same browser either.

### Saving and closing

There is no Save button. kmezBooks saves about two seconds after each change, when you switch away from the window, and when you close the company. Every save writes the whole company file at once, so a power cut mid-save leaves the previous version intact.

**Close company** (top right) saves, closes the company, forgets its key and goes back to the start screen. A company also closes by itself after **15 minutes** without activity; change that in [Settings](#settings).

### Moving a company or renaming its folder

Close the company, move or rename the whole folder, then use **Open company folder…** and pick the new location. Never edit, rename or move the files *inside* a company folder.

### Folders from before October 31, 2026

Until then this app was called EasyBooks, and a company folder held `company.ebk` instead of `company.kmb`. Such a folder opens as before; the first time it saves, `company.ebk` becomes `company.kmb`. Older attachments (`.eba`) and backups (`.ebk`) keep their names and still open.

---

## Transactions

**Transactions** (under Books) is the home page: every transaction in the books, one row each, with its date, ref, payee, category, account and amount.

### Finding transactions

- **Period:** all dates, this month, this quarter, this year to date, this year, last month, last quarter, last year, or custom dates (**From** and **To**)
- **Account:** only transactions that use one account
- **Search:** payee, ref or memo
- **Show:** all transactions, or only income and expenses
- **Order:** oldest first or newest first
- **Show void:** include voided transactions, greyed out

Totals of income and expenses for what's shown are at the bottom. Long lists load a page at a time: **Show earlier** (oldest first) or **Show more** (newest first) loads the next page. From a payee on the **Payees** page, **Show transactions** narrows the list to that payee.

### Adding a transaction

Click **Add Transaction** and choose a kind:

- **Expense:** money paid out of a bank or card account. Fill in the date, **Paid from**, the payee, a ref or check number, the **Category** (an expense account) and the amount.
- **Income:** money received into a bank account (**Deposited to**), with an income account as the category.
- **Transfer:** money moved between your own accounts, such as checking to savings or paying the card from checking. A transfer isn't income or an expense.

Then:

- **Split: add a line** spreads the amount over several categories, each with its own amount and line memo.
- Attach receipts or documents (images or PDFs). They're stored encrypted in the company folder.
- A payee you haven't used before is added to **Payees** for you. A known vendor's default category fills itself in.
- Click **Add expense**, **Add income** or **Add transfer**. The transaction is posted straight away.

### Looking at and changing a transaction

Click a row to open it underneath. You see its lines, attachments and where it came from (quick entry, journal entry, bank review, recurring entry, invoice payment, bill payment, or QuickBooks). From there you can:

- change the date, payee, accounts, amounts and memos, then **Save correction** (or **Save changes**); see [Correcting a posted transaction](#correcting-a-posted-transaction)
- **Void** it, with an optional reason
- **Delete** it, only when changing posted transactions is allowed
- **Open in journal** to see the full entry

A transaction with several accounts on both sides can only be changed in the journal.

---

## Accounts register

**Accounts register** (under Books) shows one account at a time, like a checkbook. Pick any account from the drop-down at the top; accounts are grouped as Assets, Liabilities, Equity, Income and Expenses. The account's balance is beside it, and a credit card shows what you owe.

For bank and card accounts:

- the last reconciliation shows ("Reconciled to Sep 30: $4,210.55")
- the ✓ column shows **R** for reconciled transactions and **C** for those checked off in a reconciliation you haven't finished

**Transfer** moves money between your own accounts. With a card picked, it starts from your first bank to the card. **Add Transaction** works as on the Transactions page, for the picked account.

---

## Journal entries

**Journal entries** lists every entry with all its lines: the general journal. Use it for anything the Transactions page can't do in one line, such as depreciation, payroll from a payroll service, owner contributions, or opening balances.

- **New journal entry:** a date, a ref (journal or check number), a payee, a memo, and two or more lines, each with an account, a debit or a credit, an optional line memo and an optional name. **Post entry** only works when debits equal credits.
- **Attachments:** receipts or documents up to 25 MB each, stored encrypted in the company folder. **Add attachment** adds more to a posted entry.
- **Search** by ref, name or memo, and **Show void** to include voided entries. From **Accounts**, **Show entries** lists the entries that use one account.
- Opening an entry shows its lines and history, and the buttons **Correct entry** (or **Edit entry**), **Void entry**, **Make recurring**, and **Delete entry** where allowed.
- A voided entry has **Re-enter**: a new entry filled in from the voided one, to check and post. The voided one stays on record.

When you open an entry from a report or the register, **← Back** returns there.

---

## Correcting a posted transaction

By default, kmezBooks works the accountant's way: a posted transaction never changes.

- **Correct entry** or **Save correction** voids the original and posts the corrected copy, in one step.
- **Void** keeps the transaction on record, marked void, and removes it from every balance and report. It can't be undone; to bring it back, use **Re-enter**.

If you prefer to change transactions in place, turn on **Allow changing and deleting posted transactions** on the **Company** page (it asks for your passphrase). Then **Edit** changes a transaction in place and **Delete** removes it.

Either way:

- the [audit log](#audit-log) keeps every version
- transactions in a [closed period](#closing-the-books) need your passphrase to change
- reconciled transactions can't be changed in place or deleted; void them and enter a correction
- QuickBooks history can be corrected but not deleted

Voiding a transaction that came from bank review sends its bank transaction back to review. A reconciled transaction can still be voided, but that reconciliation's report will then show it as changed.

---

## Recurring entries

Depreciation, amortization and other entries that repeat are set up once, on **Recurring entries**. The quickest way is to open last month's entry in **Journal entries** and click **Make recurring**.

Each recurring entry has a name, a frequency (monthly, quarterly or yearly), the day, a start date and an optional last day, and the entry's lines.

kmezBooks doesn't run in the background, so recurring entries post **when you open the company**. Whatever came due since the last time is posted, each on its own date, and a bar at the top says what was posted.

- **Post due now** posts what has come due since the company was opened.
- **Post now** posts the next date early; **Skip next** leaves it out.
- **Make inactive** pauses a recurring entry.
- Changes apply only to the dates still to come.

An entry dated in a closed period isn't posted on its own. The bar says it's waiting; post it with your passphrase, or skip it.

---

## Accounts (chart of accounts)

**Accounts** lists the chart of accounts as a tree, with each account's balance on its normal side (posted entries to date). Click an account to edit it.

- **Add an account:** a name, an optional number, a **type** (asset, liability, equity, income or expense), a **detail type** (such as Bank, Credit card, Office expenses), an optional parent (**Sub-account of**) and a description. Bank and card accounts need the detail type **Bank** or **Credit card** to appear in Banking and as places money moves from.
- **Copy…** starts a new account with the same type, detail type, parent and description.
- **Make inactive** hides an account from new entries; its history stays. **Make active** brings it back.
- **Delete** works only for an account with no transactions.
- **Show entries** lists the journal entries that use the account.
- A company with no accounts yet can **Add the standard chart of accounts**.

---

## Payees: customers, vendors and other names

**Payees** lists everyone named on your transactions. Filter by **All**, **Customers**, **Vendors** or **Other names**, search by name, contact or email, and **Show inactive** to include inactive ones.

A payee can be a customer, a vendor, both, or neither. Their details:

- contact name, email, phone, address (billing and shipping for customers)
- **Terms** in days, such as 30 for net 30, used for due dates on invoices and bills
- for vendors: your **Account number** with them, a **Default category** that fills in on new transactions and in bank review, and **Track for 1099** (it marks the vendor only; there are no 1099 forms yet)

Untick **Active** to hide a payee from new transactions. Renaming a payee renames it on every transaction. To bring two spellings together, open one and use **Merge into…**: the payee you choose keeps its own details and fills in what it lacks from the other. **Show transactions** opens the Transactions page for that payee.

---

## Banking

The Banking pages appear when the **Banking** module is on (it is by default).

### Importing statements

On **Bank import**, click **Import statements (.qbo)** and choose one or more `.qbo` files (QuickBooks Web Connect) downloaded from your bank's or card's website. For each file, choose the account it belongs to; kmezBooks remembers that for next time. Bank and card accounts must exist first, with the detail type Bank or Credit card.

- Transactions already imported are skipped, by the bank's own transaction ID.
- One with the same ID but a different date or amount is flagged **possible duplicate** for you to check.
- **Statement files imported into…** lists each import. **Undo import** removes that file's transactions that aren't in the books yet.

### Reviewing transactions

Each account has three tabs: **For review**, **In the books** and **Excluded**. For each transaction waiting for review:

- **Already in the books?** If entries move the same amount through the account within 10 days, kmezBooks lists them. Match one instead of adding the transaction twice. Invoice and bill payments you recorded show up here.
- **Record transfer:** when the other side of a transfer between your own accounts was imported too, both are matched to one transfer.
- **Add to the books:** choose the category (split it if needed) and the payee, then **Add to books**. Suggestions come from your [bank rules](#bank-rules), the payee's default category, or what you did last time with the same bank text.
- **Exclude:** for transactions that don't belong in the books, such as a duplicate the bank sent.

To work faster, **Match N already in the books** and **Add N suggested transactions** handle every transaction with a sure match or a suggestion in one go.

On the **In the books** tab, **Undo** sends a transaction back for review. If it was added from bank review, its entry is voided.

### Bank rules

**Bank rules** tell kmezBooks how to add transactions. A rule applies when a transaction's payee or description contains some text, optionally within an amount range and in one account. It then sets the category, and optionally replaces the bank's payee name.

- The first rule in the list that fits wins, so put specific rules above general ones.
- **Add to the books automatically on import** posts matching transactions as they're imported. Without it, the rule only suggests. Transactions that might already be in the books are always left for review.
- **Rule is on** turns a rule off without deleting it.

### Reconciling

**Reconcile** checks your books against a bank or card statement.

1. Pick the account. Enter the **statement date** and the **statement ending balance**, or the balance owed for a card. When a statement was imported, its date is filled in; check the balance against the statement itself, because the file gives the balance on the day it was downloaded.
2. For a card kept as one account per card holder, tick **Include its sub-accounts**.
3. Click **Start reconciling**, then check off each transaction that's on the statement until the **Difference** is zero. **Check all** and **Uncheck all** help, and your progress is saved as you go.
4. Click **Finish**. The checked transactions become reconciled (**R** in the register), and a **Reconciliation report** is kept, which you can print or save as PDF.

The first reconciliation of an account starts from zero: check off everything up to the statement date, including history from QuickBooks. **Check all** does that in one step. **Cancel reconciliation** stops one in progress and unchecks everything. **Finished reconciliations** lists past ones with their reports.

---

## Sales: invoices and estimates

Turn on **Customers and sales** under **Modules** on the **Company** page. The Sales group then shows **Invoices**, **Estimates**, **Recurring invoices** and **Products & services**.

On a cash basis, an invoice only records what a customer owes. **Nothing goes into the books until the customer pays.** The payment then counts as income on the day it arrives.

### Products & services

What you sell, each with a name, a description, a rate and the income account it goes to. Pick them on invoice and estimate lines; quantity × rate fills the amount. No stock is tracked. Untick **Active** to hide one from new documents, and **Show inactive** to see those again.

### Invoices

- **New invoice:** the customer, number, invoice date and due date, lines (product or service, description, quantity, rate, amount, income account), and a message to the customer. The customer's terms fill in the due date (or "Due on receipt").
- The list shows each invoice's status and what's owed, with **Customers owe $X, of which $Y is overdue** at the top and **What customers owe** per customer.
- **Download PDF** makes the invoice as a PDF, with your logo, contact details and footer from the **Company** page.
- **Send…** prepares an email to the customer, with the subject and message filled in:
  - **Share…** (where Chrome offers it) hands the PDF to your mail app
  - **Download and email** saves the PDF to your Downloads folder and opens your mail app; attach the PDF there
  - either way, the invoice is marked sent. **Mark as sent** does that for an invoice you sent another way.
- **Void** keeps an invoice on record, marked void. **Delete** removes a draft.

### Receiving payments

**Receive payment** records money from a customer: the date, the bank account it went into, the amount for each of the customer's open invoices, and a ref or check number. It posts to the bank and counts as income that day, split over each invoice's lines and their income accounts. Bank review then offers it as the match for the deposit on your statement.

An invoice with payments keeps its customer and lines fixed; to change them, open the payment under the invoice and **Void payment** first. The invoice is then owed again.

### Estimates

An estimate is a quote, with the same lines as an invoice. Send it the same way, and click **Convert to invoice** when the customer accepts. Estimates never touch the books.

### Recurring invoices

For an invoice that repeats, such as monthly tuition, open an invoice and click **Make recurring**, or use **Recurring invoices**. Each has a customer, a frequency, dates, terms, lines and a message.

Each time you open the company, kmezBooks makes the invoices that have come due **as drafts** and says so in a bar at the top. Check them and send them from **Invoices**. **Create due now**, **Create now** (the next one early), **Skip next** and **Make inactive** work like [recurring entries](#recurring-entries).

---

## Purchases: bills

Turn on **Vendors and bills** under **Modules** on the **Company** page. **Bills** then appears under Purchases.

Like an invoice, a bill only records what you owe; **nothing goes into the books until you pay it**. The payment then counts as an expense on the day you pay.

- **New bill:** the vendor, bill number, bill date, terms and due date, lines by account (**+ Add line**), and a memo. Attach the vendor's PDF or a photo with **Add attachment**. The vendor's terms and default category fill in for you.
- The list shows the bills due, oldest first: **You owe $X on bills; $Y is overdue; $Z is due within a week**. Filters show all bills, paid bills and void bills.
- **Pay bills** pays one vendor's bills with one check or transfer, fully or in part, from a bank or card account. It's one payment, so one line on your statement; the expenses go to each bill's accounts, on the day you pay. Bank review then offers it as the match.
- A bill with payments keeps its vendor and lines fixed; **Void payment** first to change them. **Void** keeps a bill on record; **Delete** removes one.

---

## Reports

**Reports** has four reports, all on a cash basis:

| Report | Shows | Period |
| --- | --- | --- |
| **General Ledger** | every posted line, account by account, with running balances | a date range, all accounts or one |
| **Profit and Loss** | income, cost of goods sold and expenses, and net income | a date range |
| **Balance Sheet** | assets, liabilities and equity, with net income for the year | as of a date |
| **Trial Balance** | each account's debit or credit balance, which must sum to zero | as of a date |

- **Periods:** this month, this quarter, this year to date, this year, last month, last quarter, last year, or custom dates. As-of dates: today, the end of last month, quarter or year, or a custom date. Quarters and years follow the company's fiscal year.
- **% of income** adds a column to the Profit and Loss.
- **Click any figure** to see the entries behind it, and click an entry to open it. **← Back** returns to the report as it was.
- **Export CSV**, **Export Excel**, and **Print or save as PDF**. Printing leaves out the sidebar and bars.

The ledger itself is cash basis: only money that moved is in it. Invoices and bills you haven't been paid for or haven't paid aren't in any report until the payment.

---

## Closing the books

On **Close books**, set a **closing date** to lock everything on or before it. Nothing dated then can be posted, changed or voided, by you, recurring entries, imports or bank review.

- You can still make a change in a closed period by entering your passphrase again. Each such change is recorded in the audit log ("Changed a closed period").
- **Remove closing date** opens every period again; moving the date back works too.
- A typical routine is to close each year once the tax return is filed.

**Year end needs nothing run.** The balance sheet and trial balance show each earlier year's net income in Retained Earnings, and income and expenses start again from zero each fiscal year. Check the year with the trial balance as of the closing date.

---

## QuickBooks import

**QuickBooks import**, the last page under Company in the sidebar, brings a company's history over from QuickBooks Online: the chart of accounts, customers, vendors and every transaction, from QuickBooks' cash-basis exports. It needs a company with **no transactions yet**, ideally created with **Start with the standard chart of accounts** unticked.

### Exporting from QuickBooks Online

The page's **How to export from QuickBooks Online** has the steps:

1. Set the accounting method to **Cash**: gear icon → Account and settings → Advanced → Accounting → Accounting method. This only changes how reports are shown; switch it back afterwards if you like.
2. Gear icon → Tools → **Export data**. On Reports, choose one year (January 1 to December 31) and export; on Lists, export customers and vendors. Repeat for **every year**, back to the first year in QuickBooks.
   - One export for **All Dates** also works: kmezBooks dates it from the first transaction to the day it was exported. But then only that last day can be tied out, not each year-end, so exporting year by year is the better check.
3. Chart of accounts → Run report → **Export to Excel**, for the Account List with each account's type.
4. Put everything in one folder (subfolders are fine).

### Dry run and import

1. **Choose the exports folder…** (or pick the files). kmezBooks reads them and shows **What was found**: the company name in the exports, the years, the transactions, and anything to **fix before importing**. Check that the exports are from the right company.
2. Map the accounts. Each QuickBooks account becomes a new account with the same name, or points at an account this company already has. Accounts with the same name are matched for you. Types and detail types can be changed later on **Accounts**, except the type of an account with transactions.
3. **Dry run…** posts everything, compares the result year by year with QuickBooks' own trial balances and balance sheets, then undoes it. It takes about as long as the import: roughly a minute for 100,000 lines. A ✓ means every line matches QuickBooks.
4. When **The dry run ties out**, import. The import is all or nothing.
5. Afterwards, compare a few reports with QuickBooks, and **Close the books through** the last imported day so migrated history isn't changed by accident.

If the dry run shows differences, fix the cause (a missing year, or an account mapped to the wrong place) and dry run again. **Import anyway** exists, but use it only when you understand the differences.

Keep the QuickBooks subscription until every company has been imported and checked.

---

## Company settings and modules

### Company page

- **Details:** legal name, EIN, address and fiscal year, as when the company was created.
- **On invoices and estimates:** email, phone, website, and a **footer** printed at the foot of every invoice and estimate (how to pay, a thank-you).
- **Logo:** **Add logo…** takes any picture and makes it small; it's shown at the top of invoices and estimates.
- **Posted transactions:** **Allow changing and deleting posted transactions**; see [Correcting a posted transaction](#correcting-a-posted-transaction).
- **Modules:** see below.
- When the company was created, and its id.

### Modules

**Modules**, at the bottom of the **Company** page, turns parts of kmezBooks on or off for each company. The sidebar shows or hides their pages straight away:

| Module | What it adds | Starts |
| --- | --- | --- |
| Customers and sales | Invoices, estimates, recurring invoices, products & services, customer payments | off |
| Vendors and bills | Bills and bill payments | off |
| Expenses | Expenses and checks with splits and receipts (Add Transaction is always available) | on |
| Banking | Statement import, review, rules, reconciliation | on |
| QuickBooks migration | QuickBooks import | on |

The ledger, closing the books and reports are always on. Turning a module off only hides its screens. Its records and everything they posted stay in the books and reports.

---

## Keeping your books safe

### Your company folders

| In the folder | What it is |
| --- | --- |
| `company.kmb` | The books: every account, transaction, payee and setting, **encrypted** with the company's passphrase |
| `attachments/` | Receipts and documents, each encrypted |
| `backups/` | kmezBooks' own backups (unless you chose another backup folder) |
| `company.lock` | Present while the company is open, so two computers don't change it at once |

- Keep the folders somewhere your normal backups cover (File History, a cloud-synced folder, restic on the home lab…).
- Never edit or rename the files inside.

### Your passphrase

Each company has its own passphrase (at least 10 characters). It encrypts the books, the attachments and the backups.

- **If you lose a company's passphrase, its books cannot be opened. Not by you, not by anyone, not by the developer.** There's no reset, because the passphrase is the key itself.
- Write each passphrase down and keep it somewhere safe and separate from the computer, such as a password manager or a sealed envelope.
- Change it on the **Passphrase** page. Backups made before the change still open with the **old** passphrase, so keep the old one until those backups have aged out (kmezBooks keeps the newest 30).

### Backups

kmezBooks makes its own encrypted backups, on top of your normal file backups.

- **When:** on the first save of each day, then every 4 hours while you work, before a restore, and before an app update changes the company's format. **Back up now** (on **Backups**) makes one on demand.
- **How many:** the newest 30 regular backups are kept; older ones are removed.
- **Where:** in `backups/` inside the company folder, unless you choose another with **Choose backup folder…**. **Choose a folder that's synced to cloud storage or on another drive**, so a lost or broken disk doesn't take the backups with it. Attachments are copied there too. All your companies can share one such folder: each gets its own folder inside it, named after the company. **Use the company folder again** switches back.
- **Warning:** if a company has had no backup for 7 days, a bar at the top says so.

### Test a backup (the restore drill)

Once a month, for each company: open **Backups**, click **Test…** on the newest backup and enter its passphrase. kmezBooks opens the backup in memory and checks that:

- the passphrase opens it
- the database is sound
- it opens in this version of kmezBooks
- every account balance matches your books as they were when it was made
- its attachments are present

Nothing is restored or changed. If any check fails, the dialog shows which one.

If balances differ, entries were probably changed in place or deleted since the backup. That can only happen when **Allow changing and deleting posted transactions** is on. The audit log shows those changes.

### Restore

**Restore…** on a backup puts the company back to how it was then. Everything since is replaced, but the current version is backed up first, so a restore can itself be undone.

If a company folder is lost, use **Restore from backup…** on the start screen: choose the backup file (from the backup folder), enter the passphrase it was made with, **Check backup**, then **Choose folder and restore** into an empty folder.

### Export

On **Backups**, under **Export**:

- **Export all data (.zip):**
  - every journal line in `journal.csv`, with accounts and dollar amounts, which opens in Excel
  - every table as CSV and JSON
  - the attachments
  - a README explaining the files
- **Decrypted database copy (.sqlite):** the database itself, for any SQLite tool.

**Exports are not encrypted.** Anyone with the file can read your books, so delete them when you're done. Each export is recorded in the audit log.

---

## Audit log

**Audit log** lists every change to the company, newest first: who, when, what, and the record it changed, with the before and after. It includes unlocks and locks, postings, voids, changes in closed periods, passphrase changes, restores, exports and upgrades. **Show older** loads more. The log can't be edited or deleted, by anyone.

---

## Passphrase

**Change passphrase:** enter the current one and the new one twice. It takes effect at once. Existing backups keep the passphrase they were made with.

This computer's device name and idle time are in [Settings](#settings).

---

## Test companies and the technical test

To try things out without touching real books, tick **Test company** when you create a company. It's set then and can't be changed later.

- Its name shows "– Test" at the top, in the browser tab and in the title bar.
- It always starts with the standard chart of accounts.
- Only a test company has the **Development** pages.

**Technical test (M1)** under Development measures kmezBooks at full size:

- **Generate history and save** posts made-up deposits and payments (10 years of 6,000 a year by default) into the test company's bank, card, income and expense accounts. They show in Transactions, the registers and the reports, marked "Made-up history (technical test)". **Each run replaces the made-up history of the last run**; entries you made yourself stay. At the defaults it takes about two minutes, and the file grows to around 70 MB. Made-up history in a closed period isn't replaced; move the closing date back first.
- **Time the reports**, **Reopen and time it**, **Time PBKDF2** and the **Atomic-save test** measure how long things take. **Copy results as Markdown** copies the results.

---

## When something goes wrong

| What you see | What it means and what to do |
| --- | --- |
| **"kmezBooks no longer has permission to save in the folder…"** | Chrome withdrew permission for the company folder. Click **Allow access and save** and allow it. If Chrome still doesn't allow it ("Nothing was saved…"), **Save a copy in another folder…** keeps your work. |
| **"The company file changed on disk since you opened it, so it was not overwritten."** | Something else wrote the company file since kmezBooks opened it, such as another computer or a sync tool restoring an old copy. kmezBooks won't overwrite it. **Save a copy in another folder…** keeps your work; **Close without saving** discards it. Then open the right copy. |
| **"… has taken over this company, so your changes can't be saved here."** | Another computer used **Take over and edit here**. This window stops saving; **Save a copy in another folder…** keeps your changes since the last save. |
| **"This company is open read-only"** | You chose read-only, or another device has it open. Close and open it again when the other device has closed it. |
| **"PC-1: this date is in a closed period"** | The date is on or before the closing date. Change the date, enter your passphrase when asked, or move the closing date on **Close books**. |
| **"GL-6: posted entries are never deleted; void the entry instead"** | Posted transactions can't be deleted unless the Company page allows it. Void it, or correct it. |
| **"GL-7: this account has transactions; make it inactive instead"** | An account with history can't be deleted. Make it inactive. |
| **"BK-8: this entry was reconciled…"** | A reconciled transaction can't be changed in place or deleted. Void it and enter a correction. |
| A wrong passphrase | Passphrases are case-sensitive. Check which passphrase the company (or that backup) had at the time. |
| A recurring entry or invoice is **waiting** | It's dated in a closed period, or something it needs is missing. The bar says why; post it from **Recurring entries** with your passphrase, or skip it. |
| **"The newest backup is from … more than 7 days ago"** | Open **Backups** and click **Back up now**, and check the backup folder is reachable. |

Messages starting with an ID like GL-6 or PC-1 come from the rules that keep the books sound. Nothing was written when you see one.

---

## Words used in kmezBooks

- **Cash basis:** income counts when money comes in, expenses when money goes out. Unpaid invoices and bills aren't income or expenses yet.
- **Posted:** in the books, counted in every balance and report.
- **Void:** kept on record but no longer counted. A voided transaction can't be un-voided; **Re-enter** makes a fresh copy.
- **Category:** the income or expense account a transaction is recorded against.
- **Reconciled:** checked against a bank or card statement and finished. Reconciled transactions are protected.
- **Closing date:** the last day of the closed period; nothing on or before it changes without your passphrase.
- **Module:** an optional part of kmezBooks, turned on per company.

---

## Write this down

For each company:

- the company name and where its folder is
- its passphrase (and the previous one, while old backups use it)
- where its backups go

Keep this list somewhere safe and separate from this computer.

---

## License

kmezBooks is free and open source software under the GNU General Public License, version 3 or later, and comes with no warranty. The source code is at https://github.com/mawadk/kmezBooks.
