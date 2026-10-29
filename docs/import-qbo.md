# Importing a company from QuickBooks Online

How to bring one company's full history from QuickBooks Online into EasyBooks. Do it once per company. Keep the QuickBooks subscription until all four companies have been imported and tie out.

## 1. Export from QuickBooks Online

Use QuickBooks' **Export data**, with the company's reports on **Cash basis** (the same setting as before).

**Pieces:** QuickBooks can't export the Journal or General Ledger for all dates at once (the report is too large). Export the history in pieces instead:

- Pieces can be any length: 5 years at a time worked for Mawad Child Services. Use one year at a time for a very busy company.
- If a piece still says it's too large, export it in two halves.
- The pieces must follow each other with **no gaps and no overlaps**, for example 2010–2015, 2016–2020, 2021 to today. Start each piece the day after the previous one ends.
- The last piece can end today.

**What each piece's folder needs** (Export data puts these in a folder named like `Company 20160101-20201231`):

| File | Why |
| --- | --- |
| Journal (and General Ledger) | The transactions. The General Ledger also proves the history is cash basis |
| Trial Balance, as of the piece's last day | The tie-out at that date |
| Balance Sheet, as of the piece's last day | The tie-out of the latest piece |
| Customers, Vendors | Contact details |

**Also export the Account List** (Chart of accounts → Run report → Export) into any of the folders. Without it, EasyBooks works out account types from the reports, but a **deleted** account with no balance can't be worked out, and you'll be asked to choose its type.

**Extra year-end checks (optional):** for a piece longer than a year, also export the Trial Balance as of each Dec 31 inside it. The tie-out then checks every year-end, not just the piece's last day. It's a small report, so it exports for any date.

**Folder layout:** put all the pieces' folders inside one folder for the company, for example `C:\KM\QBO\Mawad Child Services\full data\`.

## 2. Create a new, empty company in EasyBooks

The import only goes into a company with no transactions yet, so a company you've been testing with won't do.

1. On the start screen, choose **New company…**
2. **Untick "Start with the standard chart of accounts"**, so the chart comes from QuickBooks.
3. Choose a new, empty folder for it, and its passphrase.

## 3. Dry run, then import

1. Open the company and go to **QuickBooks import**.
2. Click **Choose the exports folder…** and pick the company's folder (the one holding all the pieces).
3. EasyBooks lists what it found: each piece and its dates, accounts, customers, vendors and transactions. Problems and warnings are listed too, and gaps or overlaps between pieces are named with the dates to export.
4. **Choose a type for any account it asks about.** For example, a deleted bank account is **Bank**, and a deleted card is **Credit card**.
5. Click **Dry run**.
   - It posts everything, compares the result with QuickBooks' own trial balances and balance sheet, and then undoes it.
   - It takes about a minute for 40,000 transactions.
   - "The dry run ties out" means every account matches QuickBooks at every checked date.
6. Click **Import through <last day>**. The import is all or nothing: if anything fails, nothing is kept, and you can fix the files and run it again.
7. Click **Close the books through <last day>**. This stops migrated history being changed by accident (MG-8); it can be changed later on **Close books**.

## 4. After the import

- **Check a few reports** against QuickBooks: Profit and Loss and Balance Sheet for a year or two.
- **Bank and card statements:**
  - Import your `.qbo` statements on **Bank import**.
  - Transactions QuickBooks already has show as **already in the books**. **Match … already in the books** matches them in one go.
  - Only newer transactions need reviewing.
- **Recurring entries:** open the latest depreciation (or amortization) entry in **Journal entries** and click **Make recurring**. It starts the month after that entry, so nothing posts twice.
- **Payees:** to tidy the payee list, merge spellings of the same name on **Payees**.
- **Backup:** run **Test…** on the newest backup (Backups page) to confirm it could replace the company.

## Tried so far

Mawad Child Services, 2010 to Oct 28, 2026, in three pieces of about 5 years: the dry run ties out with no differences at Dec 31, 2015, Dec 31, 2020 and Oct 28, 2026 (trial balances) and Oct 28, 2026 (balance sheet). Two deleted accounts needed a type chosen.
