-- 0011: banking (BK-1, BK-3 to BK-9): statement imports, the review queue,
-- categorization rules and reconciliation.
--
-- Amounts on imported transactions are signed the way the ledger counts the
-- account: debit minus credit. For a bank account a deposit is positive; for
-- a credit card a payment is positive and a charge negative. That is also the
-- sign a .qbo file uses, so both kinds of account work the same way.

-- ---- statement files (BK-1) -------------------------------------------------

-- Which account in a statement file is which ledger account, remembered after
-- the first import. feed_key identifies the account in the file (bank routing
-- number and account number, or card number).
CREATE TABLE bank_feed (
  account_id TEXT NOT NULL PRIMARY KEY REFERENCES account (id),
  company_id TEXT NOT NULL REFERENCES company (id),
  feed_key   TEXT NOT NULL CHECK (length(feed_key) > 0),
  label      TEXT,   -- how the file names the account, e.g. "Checking ••7890"
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE UNIQUE INDEX bank_feed_key ON bank_feed (company_id, feed_key);

CREATE TRIGGER bank_feed_account_type
BEFORE INSERT ON bank_feed
BEGIN
  SELECT RAISE(ABORT, 'BK-1: statements can only be imported into an asset or liability account')
  WHERE (SELECT type FROM account WHERE id = NEW.account_id) NOT IN ('asset', 'liability');
END;

CREATE TRIGGER bank_feed_account_type_update
BEFORE UPDATE OF account_id ON bank_feed
BEGIN
  SELECT RAISE(ABORT, 'BK-1: statements can only be imported into an asset or liability account')
  WHERE (SELECT type FROM account WHERE id = NEW.account_id) NOT IN ('asset', 'liability');
END;

-- One imported file, for the import history and the statement's balance
CREATE TABLE bank_import (
  id             TEXT    NOT NULL PRIMARY KEY,
  company_id     TEXT    NOT NULL REFERENCES company (id),
  account_id     TEXT    NOT NULL REFERENCES account (id),
  file_name      TEXT    NOT NULL,
  imported_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  start_date     TEXT    CHECK (start_date IS NULL OR start_date = date(start_date)),
  end_date       TEXT    CHECK (end_date IS NULL OR end_date = date(end_date)),
  -- The bank's balance at the end of the statement, debit minus credit
  balance        INTEGER,
  balance_date   TEXT    CHECK (balance_date IS NULL OR balance_date = date(balance_date)),
  added          INTEGER NOT NULL CHECK (added >= 0),
  duplicates     INTEGER NOT NULL CHECK (duplicates >= 0)
) STRICT;

CREATE INDEX bank_import_account ON bank_import (account_id, imported_at);

-- ---- imported transactions and the review queue (BK-3, BK-4, BK-6) ----------

-- status: new (waiting for review), posted (reviewed into a new entry),
-- matched (linked to an entry already in the books), excluded (left out).
CREATE TABLE bank_txn (
  id           INTEGER NOT NULL PRIMARY KEY,
  company_id   TEXT    NOT NULL REFERENCES company (id),
  account_id   TEXT    NOT NULL REFERENCES account (id),
  import_id    TEXT    NOT NULL REFERENCES bank_import (id),
  fitid        TEXT,   -- the bank's own transaction id
  date         TEXT    NOT NULL CHECK (date = date(date) AND date BETWEEN '1900-01-01' AND '2999-12-31'),
  amount       INTEGER NOT NULL CHECK (amount <> 0 AND amount BETWEEN -10000000000000 AND 10000000000000),
  payee        TEXT,
  memo         TEXT,
  check_no     TEXT,
  trn_type     TEXT,   -- the file's transaction type: DEBIT, CHECK, XFER…
  status       TEXT    NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'posted', 'matched', 'excluded')),
  entry_id     INTEGER REFERENCES journal_entry (id),
  -- Same bank id as an earlier transaction but a different date or amount (BK-6)
  duplicate_of INTEGER REFERENCES bank_txn (id),
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((status IN ('posted', 'matched')) = (entry_id IS NOT NULL))
) STRICT;

-- The same transaction is never imported twice (BK-6)
CREATE UNIQUE INDEX bank_txn_fitid ON bank_txn (account_id, fitid, date, amount) WHERE fitid IS NOT NULL;
-- An entry accounts for at most one imported transaction per account; a
-- transfer's entry can account for one in each of its two accounts (BK-9)
CREATE UNIQUE INDEX bank_txn_entry ON bank_txn (entry_id, account_id) WHERE entry_id IS NOT NULL;
CREATE INDEX bank_txn_queue ON bank_txn (account_id, status, date);
CREATE INDEX bank_txn_import ON bank_txn (import_id);

CREATE TRIGGER bank_txn_starts_new
BEFORE INSERT ON bank_txn
BEGIN
  SELECT RAISE(ABORT, 'BK-3: imported transactions start in the review queue')
  WHERE NEW.status <> 'new' OR NEW.entry_id IS NOT NULL;
  SELECT RAISE(ABORT, 'BK-1: the transaction must belong to its import''s account')
  WHERE (SELECT account_id FROM bank_import WHERE id = NEW.import_id) IS NOT NEW.account_id;
END;

-- What the bank sent stays as it was; only the review changes
CREATE TRIGGER bank_txn_immutable
BEFORE UPDATE ON bank_txn
BEGIN
  SELECT RAISE(ABORT, 'BK-1: an imported transaction cannot be changed')
  WHERE NEW.id IS NOT OLD.id OR NEW.company_id IS NOT OLD.company_id
     OR NEW.account_id IS NOT OLD.account_id OR NEW.import_id IS NOT OLD.import_id
     OR NEW.fitid IS NOT OLD.fitid OR NEW.date IS NOT OLD.date OR NEW.amount IS NOT OLD.amount
     OR NEW.payee IS NOT OLD.payee OR NEW.memo IS NOT OLD.memo OR NEW.check_no IS NOT OLD.check_no
     OR NEW.trn_type IS NOT OLD.trn_type OR NEW.created_at IS NOT OLD.created_at
     -- the duplicate flag can only be cleared, when the earlier one is removed
     OR (NEW.duplicate_of IS NOT OLD.duplicate_of AND NEW.duplicate_of IS NOT NULL);
END;

-- A reviewed transaction points at a posted entry that moves exactly its
-- amount through its account (BK-4), whatever produced that entry
CREATE TRIGGER bank_txn_link_check
BEFORE UPDATE OF status, entry_id ON bank_txn
WHEN NEW.entry_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'BK-4: a transaction can only be matched to a posted entry')
  WHERE (SELECT status FROM journal_entry WHERE id = NEW.entry_id) IS NOT 'posted';
  SELECT RAISE(ABORT, 'BK-4: the entry must move the same amount through this account')
  WHERE (SELECT coalesce(sum(debit - credit), 0) FROM journal_line
         WHERE entry_id = NEW.entry_id AND account_id = NEW.account_id) <> NEW.amount;
END;

CREATE TRIGGER bank_txn_no_delete_reviewed
BEFORE DELETE ON bank_txn
WHEN OLD.status IN ('posted', 'matched')
BEGIN
  SELECT RAISE(ABORT, 'BK-3: this transaction is in the books; undo it before removing it');
END;

-- Voiding an entry sends the transactions it accounted for back to review
CREATE TRIGGER bank_txn_back_to_review
AFTER UPDATE OF status ON journal_entry
WHEN OLD.status = 'posted' AND NEW.status = 'void'
BEGIN
  UPDATE bank_txn SET status = 'new', entry_id = NULL WHERE entry_id = NEW.id;
END;

-- ---- rules (BK-5) -----------------------------------------------------------

-- The first active rule, by priority, whose conditions all hold suggests a
-- category, payee and memo; with auto_post it also posts on import.
CREATE TABLE bank_rule (
  id            TEXT    NOT NULL PRIMARY KEY,
  company_id    TEXT    NOT NULL REFERENCES company (id),
  name          TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  priority      INTEGER NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  -- Conditions: only this bank or card account (null: any), money in or out,
  -- payee or description contains the text (ignoring case), amount range
  account_id    TEXT    REFERENCES account (id),
  direction     TEXT    NOT NULL DEFAULT 'any' CHECK (direction IN ('any', 'in', 'out')),
  text_contains TEXT    CHECK (text_contains IS NULL OR length(trim(text_contains)) > 0),
  amount_min    INTEGER CHECK (amount_min IS NULL OR amount_min >= 0),
  amount_max    INTEGER CHECK (amount_max IS NULL OR amount_max >= 0),
  -- What to do
  category_id   TEXT    NOT NULL REFERENCES account (id),
  payee         TEXT,
  memo          TEXT,
  auto_post     INTEGER NOT NULL DEFAULT 0 CHECK (auto_post IN (0, 1)),
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (text_contains IS NOT NULL OR amount_min IS NOT NULL OR amount_max IS NOT NULL),
  CHECK (amount_min IS NULL OR amount_max IS NULL OR amount_min <= amount_max),
  CHECK (account_id IS NULL OR account_id <> category_id)
) STRICT;

CREATE INDEX bank_rule_priority ON bank_rule (priority);

-- ---- reconciliation (BK-7, BK-8) ----------------------------------------------

-- A statement reconciled against one account. Balances are debit minus
-- credit, as the ledger counts the account. Open while the owner works on it;
-- done once the difference is zero, and never changed after that.
CREATE TABLE reconciliation (
  id                TEXT    NOT NULL PRIMARY KEY,
  company_id        TEXT    NOT NULL REFERENCES company (id),
  account_id        TEXT    NOT NULL REFERENCES account (id),
  statement_date    TEXT    NOT NULL CHECK (statement_date = date(statement_date)),
  ending_balance    INTEGER NOT NULL,
  -- The previous statement's ending balance, recorded when finished
  beginning_balance INTEGER,
  status            TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  finished_at       TEXT,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((status = 'done') = (finished_at IS NOT NULL)),
  CHECK (status = 'open' OR beginning_balance IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX reconciliation_one_open ON reconciliation (account_id) WHERE status = 'open';
CREATE INDEX reconciliation_account ON reconciliation (account_id, statement_date);

-- The ledger lines cleared by a reconciliation. A line is cleared once.
CREATE TABLE reconciled_line (
  line_id           INTEGER NOT NULL PRIMARY KEY REFERENCES journal_line (id),
  company_id        TEXT    NOT NULL REFERENCES company (id),
  reconciliation_id TEXT    NOT NULL REFERENCES reconciliation (id)
) STRICT;

CREATE INDEX reconciled_line_reconciliation ON reconciled_line (reconciliation_id);

CREATE TRIGGER reconciliation_insert
BEFORE INSERT ON reconciliation
BEGIN
  SELECT RAISE(ABORT, 'BK-7: a reconciliation starts open')
  WHERE NEW.status <> 'open';
  SELECT RAISE(ABORT, 'BK-7: only asset and liability accounts are reconciled')
  WHERE (SELECT type FROM account WHERE id = NEW.account_id) NOT IN ('asset', 'liability');
  SELECT RAISE(ABORT, 'BK-7: statements are reconciled in date order; this date is on or before the last reconciled statement')
  WHERE NEW.statement_date <= (SELECT max(statement_date) FROM reconciliation
                               WHERE account_id = NEW.account_id AND status = 'done');
END;

CREATE TRIGGER reconciliation_update
BEFORE UPDATE ON reconciliation
BEGIN
  SELECT RAISE(ABORT, 'BK-7: a finished reconciliation cannot be changed')
  WHERE OLD.status = 'done';
  SELECT RAISE(ABORT, 'BK-7: a reconciliation stays with its account')
  WHERE NEW.id IS NOT OLD.id OR NEW.company_id IS NOT OLD.company_id
     OR NEW.account_id IS NOT OLD.account_id OR NEW.created_at IS NOT OLD.created_at;
  SELECT RAISE(ABORT, 'BK-7: statements are reconciled in date order; this date is on or before the last reconciled statement')
  WHERE NEW.statement_date <= (SELECT max(statement_date) FROM reconciliation
                               WHERE account_id = NEW.account_id AND status = 'done');
  SELECT RAISE(ABORT, 'BK-7: cleared items must be dated on or before the statement date')
  WHERE EXISTS (SELECT 1 FROM reconciled_line r
                JOIN journal_line l ON l.id = r.line_id
                JOIN journal_entry e ON e.id = l.entry_id
                WHERE r.reconciliation_id = NEW.id AND e.date > NEW.statement_date);
END;

-- Finishing: it starts where the last statement ended, and the cleared items
-- bring it to this statement's ending balance (BK-7)
CREATE TRIGGER reconciliation_finish
BEFORE UPDATE OF status ON reconciliation
WHEN OLD.status = 'open' AND NEW.status = 'done'
BEGIN
  SELECT RAISE(ABORT, 'BK-7: the beginning balance must be the last statement''s ending balance')
  WHERE NEW.beginning_balance IS NOT coalesce(
    (SELECT ending_balance FROM reconciliation
     WHERE account_id = NEW.account_id AND status = 'done'
     ORDER BY statement_date DESC LIMIT 1), 0);
  SELECT RAISE(ABORT, 'BK-7: the difference must be zero to finish')
  WHERE NEW.beginning_balance + (
    SELECT coalesce(sum(l.debit - l.credit), 0) FROM reconciled_line r
    JOIN journal_line l ON l.id = r.line_id
    JOIN journal_entry e ON e.id = l.entry_id AND e.status = 'posted'
    WHERE r.reconciliation_id = NEW.id) <> NEW.ending_balance;
END;

CREATE TRIGGER reconciliation_no_delete_done
BEFORE DELETE ON reconciliation
WHEN OLD.status = 'done'
BEGIN
  SELECT RAISE(ABORT, 'BK-8: a finished reconciliation is kept');
END;

CREATE TRIGGER reconciled_line_insert
BEFORE INSERT ON reconciled_line
BEGIN
  SELECT RAISE(ABORT, 'BK-7: a finished reconciliation cannot be changed')
  WHERE (SELECT status FROM reconciliation WHERE id = NEW.reconciliation_id) IS NOT 'open';
  SELECT RAISE(ABORT, 'BK-7: that item is in another account')
  WHERE (SELECT account_id FROM journal_line WHERE id = NEW.line_id)
     IS NOT (SELECT account_id FROM reconciliation WHERE id = NEW.reconciliation_id);
  SELECT RAISE(ABORT, 'BK-7: only posted entries can be cleared')
  WHERE (SELECT e.status FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
         WHERE l.id = NEW.line_id) IS NOT 'posted';
  SELECT RAISE(ABORT, 'BK-7: cleared items must be dated on or before the statement date')
  WHERE (SELECT e.date FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
         WHERE l.id = NEW.line_id)
      > (SELECT statement_date FROM reconciliation WHERE id = NEW.reconciliation_id);
END;

CREATE TRIGGER reconciled_line_no_update
BEFORE UPDATE ON reconciled_line
BEGIN
  SELECT RAISE(ABORT, 'BK-7: a cleared item cannot be moved; uncheck it instead');
END;

CREATE TRIGGER reconciled_line_delete
BEFORE DELETE ON reconciled_line
BEGIN
  SELECT RAISE(ABORT, 'BK-7: a finished reconciliation cannot be changed')
  WHERE (SELECT status FROM reconciliation WHERE id = OLD.reconciliation_id) IS NOT 'open';
END;

-- ---- audit (US-5) -------------------------------------------------------------

-- bank_txn and reconciled_line are bulk tables (a statement, or years of
-- cleared lines), so like the ledger they don't get the generated full-row
-- triggers (src/worker/audit.ts). Imports and reconciliations are audited in
-- full; a transaction's review gets one compact event; cleared lines aren't
-- logged one by one, because a finished reconciliation's lines never change.
CREATE TRIGGER audit_bank_txn_review
AFTER UPDATE OF status, entry_id ON bank_txn
WHEN NEW.status IS NOT OLD.status OR NEW.entry_id IS NOT OLD.entry_id
BEGIN
  INSERT INTO audit_event (company_id, user_id, action, entity, entity_id, before, after)
  VALUES ((SELECT id FROM company), (SELECT user_id FROM session WHERE id = 1), 'review',
          'bank_txn', CAST(NEW.id AS TEXT),
          json_object('status', OLD.status, 'entry_id', OLD.entry_id),
          json_object('status', NEW.status, 'entry_id', NEW.entry_id, 'date', NEW.date,
                      'amount', NEW.amount, 'payee', NEW.payee));
END;

CREATE TRIGGER audit_bank_txn_delete
AFTER DELETE ON bank_txn
BEGIN
  INSERT INTO audit_event (company_id, user_id, action, entity, entity_id, before)
  VALUES ((SELECT id FROM company), (SELECT user_id FROM session WHERE id = 1), 'delete',
          'bank_txn', CAST(OLD.id AS TEXT),
          json_object('date', OLD.date, 'amount', OLD.amount, 'payee', OLD.payee,
                      'import_id', OLD.import_id));
END;
