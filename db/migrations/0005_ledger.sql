-- 0005: the ledger — accounts, journal entries and journal lines (GL-1, GL-3,
-- GL-6, GL-7, GL-8). Every posting goes through postEntry() in
-- src/ledger/postEntry.ts; these constraints and triggers hold no matter what.
-- Money is integer cents.

-- ---- accounts (GL-1, GL-7) ----------------------------------------------

CREATE TABLE account (
  id          TEXT    NOT NULL PRIMARY KEY,
  company_id  TEXT    NOT NULL REFERENCES company (id),
  number      TEXT    CHECK (number IS NULL OR length(trim(number)) > 0),
  name        TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  type        TEXT    NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  -- Descriptive sub-type (catalog in src/shared/accounts.ts). The few the
  -- ledger relies on are pinned to their type here.
  detail_type TEXT    NOT NULL CHECK (detail_type GLOB '[a-z]*' AND detail_type NOT GLOB '*[^a-z_]*'),
  parent_id   TEXT    REFERENCES account (id),
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  description TEXT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (detail_type NOT IN ('bank', 'cash_on_hand', 'undeposited_funds', 'accounts_receivable') OR type = 'asset'),
  CHECK (detail_type NOT IN ('credit_card', 'accounts_payable') OR type = 'liability'),
  CHECK (detail_type NOT IN ('retained_earnings', 'opening_balance_equity') OR type = 'equity'),
  CHECK (parent_id IS NULL OR parent_id <> id)
) STRICT;

-- Names are unique among siblings, numbers unique overall
CREATE UNIQUE INDEX account_name ON account (company_id, coalesce(parent_id, ''), name COLLATE NOCASE);
CREATE UNIQUE INDEX account_number ON account (company_id, number) WHERE number IS NOT NULL;
-- The accounts reports and deposits rely on exist at most once
CREATE UNIQUE INDEX account_single_special ON account (company_id, detail_type)
  WHERE detail_type IN ('retained_earnings', 'opening_balance_equity', 'undeposited_funds');
CREATE INDEX account_parent ON account (parent_id);

-- A sub-account has its parent's type, and an account can't sit under itself (GL-1)
CREATE TRIGGER account_parent_check_insert
BEFORE INSERT ON account
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'GL-1: a sub-account must have the same type as its parent')
  WHERE (SELECT type FROM account WHERE id = NEW.parent_id) IS NOT NEW.type;
END;

CREATE TRIGGER account_parent_check_update
BEFORE UPDATE OF parent_id, type ON account
BEGIN
  SELECT RAISE(ABORT, 'GL-1: a sub-account must have the same type as its parent')
  WHERE NEW.parent_id IS NOT NULL
    AND (SELECT type FROM account WHERE id = NEW.parent_id) IS NOT NEW.type;
  SELECT RAISE(ABORT, 'GL-1: an account cannot be placed under its own sub-account')
  WHERE NEW.parent_id IS NOT NULL AND NEW.id IN (
    WITH RECURSIVE up (id) AS (
      SELECT NEW.parent_id
      UNION
      SELECT a.parent_id FROM account a JOIN up ON a.id = up.id WHERE a.parent_id IS NOT NULL
    )
    SELECT id FROM up);
  SELECT RAISE(ABORT, 'GL-1: an account with sub-accounts must keep its type')
  WHERE NEW.type <> OLD.type AND EXISTS (SELECT 1 FROM account WHERE parent_id = NEW.id);
END;

-- ---- journal entries and lines (GL-3, GL-6) --------------------------------

CREATE TABLE journal_entry (
  id          INTEGER NOT NULL PRIMARY KEY,
  company_id  TEXT    NOT NULL REFERENCES company (id),
  date        TEXT    NOT NULL CHECK (date = date(date) AND date BETWEEN '1900-01-01' AND '2999-12-31'),
  ref         TEXT,   -- the document's own number: journal no., check no., invoice no.
  memo        TEXT,
  -- Which document produced the entry (CLAUDE.md rule 4): 'journal' for a manual
  -- journal entry, 'qbo_migration' for migrated history, module names later
  source_type TEXT    NOT NULL CHECK (source_type GLOB '[a-z]*' AND source_type NOT GLOB '*[^a-z_]*'),
  source_id   TEXT,
  status      TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'void')),
  posted_at   TEXT,
  voided_at   TEXT,
  void_reason TEXT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((status = 'void') = (voided_at IS NOT NULL))
) STRICT;

CREATE INDEX journal_entry_date ON journal_entry (date, status);
CREATE INDEX journal_entry_source ON journal_entry (source_type, source_id);

CREATE TABLE journal_line (
  id         INTEGER NOT NULL PRIMARY KEY,
  company_id TEXT    NOT NULL REFERENCES company (id),
  entry_id   INTEGER NOT NULL REFERENCES journal_entry (id),
  line_no    INTEGER NOT NULL CHECK (line_no >= 1),
  account_id TEXT    NOT NULL REFERENCES account (id),
  -- Integer cents, at most $100 billion per line, one side per line
  debit      INTEGER NOT NULL DEFAULT 0 CHECK (debit BETWEEN 0 AND 10000000000000),
  credit     INTEGER NOT NULL DEFAULT 0 CHECK (credit BETWEEN 0 AND 10000000000000),
  memo       TEXT,
  CHECK (debit = 0 OR credit = 0),
  UNIQUE (entry_id, line_no)
) STRICT;

CREATE INDEX journal_line_account ON journal_line (account_id, entry_id);

-- Lines change only while their entry is a draft (GL-6)
CREATE TRIGGER journal_line_insert_draft_only
BEFORE INSERT ON journal_line
BEGIN
  SELECT RAISE(ABORT, 'GL-6: lines can only be added to a draft entry')
  WHERE (SELECT status FROM journal_entry WHERE id = NEW.entry_id) IS NOT 'draft';
  SELECT RAISE(ABORT, 'GL-7: this account is inactive')
  WHERE (SELECT active FROM account WHERE id = NEW.account_id) = 0;
END;

CREATE TRIGGER journal_line_update_draft_only
BEFORE UPDATE ON journal_line
BEGIN
  SELECT RAISE(ABORT, 'GL-6: posted lines cannot be changed; void the entry instead')
  WHERE (SELECT status FROM journal_entry WHERE id = OLD.entry_id) IS NOT 'draft'
     OR (SELECT status FROM journal_entry WHERE id = NEW.entry_id) IS NOT 'draft';
  SELECT RAISE(ABORT, 'GL-7: this account is inactive')
  WHERE NEW.account_id <> OLD.account_id AND (SELECT active FROM account WHERE id = NEW.account_id) = 0;
END;

CREATE TRIGGER journal_line_delete_draft_only
BEFORE DELETE ON journal_line
BEGIN
  SELECT RAISE(ABORT, 'GL-6: posted lines cannot be deleted; void the entry instead')
  WHERE (SELECT status FROM journal_entry WHERE id = OLD.entry_id) IS NOT 'draft';
END;

-- Entries are created as drafts
CREATE TRIGGER journal_entry_starts_draft
BEFORE INSERT ON journal_entry
BEGIN
  SELECT RAISE(ABORT, 'GL-3: entries are created as drafts and then posted')
  WHERE NEW.status <> 'draft';
END;

-- Status moves only draft → posted → void (GL-6)
CREATE TRIGGER journal_entry_status_flow
BEFORE UPDATE OF status ON journal_entry
WHEN NEW.status IS NOT OLD.status
BEGIN
  SELECT RAISE(ABORT, 'GL-6: an entry can only go from draft to posted, or from posted to void')
  WHERE NOT ((OLD.status = 'draft' AND NEW.status = 'posted')
          OR (OLD.status = 'posted' AND NEW.status = 'void'));
END;

-- Posting checks the balance (GL-3) and the cash-basis rule (GL-8)
CREATE TRIGGER journal_entry_post_checks
BEFORE UPDATE OF status ON journal_entry
WHEN OLD.status = 'draft' AND NEW.status = 'posted'
BEGIN
  SELECT RAISE(ABORT, 'GL-3: an entry needs at least two lines')
  WHERE (SELECT count(*) FROM journal_line WHERE entry_id = NEW.id) < 2;
  SELECT RAISE(ABORT, 'GL-3: debits and credits must be equal')
  WHERE (SELECT sum(debit) - sum(credit) FROM journal_line WHERE entry_id = NEW.id) <> 0;
  SELECT RAISE(ABORT, 'GL-3: an entry must move some money')
  WHERE (SELECT sum(debit) FROM journal_line WHERE entry_id = NEW.id) = 0;
  SELECT RAISE(ABORT, 'GL-8: the ledger is cash basis; A/R and A/P accounts take postings only from migrated history')
  WHERE NEW.source_type <> 'qbo_migration' AND EXISTS (
    SELECT 1 FROM journal_line l JOIN account a ON a.id = l.account_id
    WHERE l.entry_id = NEW.id AND a.detail_type IN ('accounts_receivable', 'accounts_payable'));
END;

-- A posted or void entry never changes, except posted → void (GL-6)
CREATE TRIGGER journal_entry_immutable
BEFORE UPDATE ON journal_entry
WHEN OLD.status <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'GL-6: a posted entry cannot be changed; void it and enter a correction')
  WHERE NEW.id IS NOT OLD.id OR NEW.company_id IS NOT OLD.company_id OR NEW.date IS NOT OLD.date
     OR NEW.ref IS NOT OLD.ref OR NEW.memo IS NOT OLD.memo OR NEW.source_type IS NOT OLD.source_type
     OR NEW.source_id IS NOT OLD.source_id OR NEW.posted_at IS NOT OLD.posted_at
     OR NEW.created_at IS NOT OLD.created_at
     OR (OLD.status = 'void' AND (NEW.status IS NOT OLD.status OR NEW.voided_at IS NOT OLD.voided_at
                                   OR NEW.void_reason IS NOT OLD.void_reason));
END;

-- Posted and void entries are never deleted (GL-6)
CREATE TRIGGER journal_entry_no_delete
BEFORE DELETE ON journal_entry
WHEN OLD.status <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'GL-6: posted entries are never deleted; void the entry instead');
END;

-- An account with history is inactivated, never deleted (GL-7), and keeps its type
CREATE TRIGGER account_no_delete_with_history
BEFORE DELETE ON account
BEGIN
  SELECT RAISE(ABORT, 'GL-7: this account has transactions; make it inactive instead')
  WHERE EXISTS (SELECT 1 FROM journal_line WHERE account_id = OLD.id);
  SELECT RAISE(ABORT, 'GL-1: move or delete its sub-accounts first')
  WHERE EXISTS (SELECT 1 FROM account WHERE parent_id = OLD.id);
END;

CREATE TRIGGER account_type_fixed_with_history
BEFORE UPDATE OF type ON account
WHEN NEW.type <> OLD.type
BEGIN
  SELECT RAISE(ABORT, 'GL-1: an account with transactions keeps its type')
  WHERE EXISTS (SELECT 1 FROM journal_line WHERE account_id = OLD.id);
END;
