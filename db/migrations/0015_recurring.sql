-- 0015: recurring journal entries (GL-5).
--
-- A template (monthly depreciation, say) posts an ordinary journal entry
-- through postEntry() on each due date, when the company is next opened:
-- nothing runs while the app is closed. Each posting is recorded as a run,
-- one per template and date, so the same date can never post twice, even if
-- the entry is later voided or deleted.

CREATE TABLE recurring_entry (
  id           TEXT    NOT NULL PRIMARY KEY,
  company_id   TEXT    NOT NULL REFERENCES company (id),
  name         TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  frequency    TEXT    NOT NULL CHECK (frequency IN ('monthly', 'quarterly', 'yearly')),
  -- 1 to 31; a day past the month's end means its last day
  day_of_month INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
  start_date   TEXT    NOT NULL CHECK (start_date = date(start_date)),
  end_date     TEXT    CHECK (end_date IS NULL OR end_date = date(end_date)),
  -- The next date to post; null once past the end date
  next_date    TEXT    CHECK (next_date IS NULL OR next_date = date(next_date)),
  ref          TEXT,
  payee        TEXT,
  memo         TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (end_date IS NULL OR end_date >= start_date)
) STRICT;

CREATE TABLE recurring_line (
  id           INTEGER NOT NULL PRIMARY KEY,
  company_id   TEXT    NOT NULL REFERENCES company (id),
  recurring_id TEXT    NOT NULL REFERENCES recurring_entry (id),
  line_no      INTEGER NOT NULL CHECK (line_no >= 1),
  account_id   TEXT    NOT NULL REFERENCES account (id),
  -- As journal lines: integer cents, one side per line
  debit        INTEGER NOT NULL DEFAULT 0 CHECK (debit BETWEEN 0 AND 10000000000000),
  credit       INTEGER NOT NULL DEFAULT 0 CHECK (credit BETWEEN 0 AND 10000000000000),
  memo         TEXT,
  CHECK (debit = 0 OR credit = 0),
  UNIQUE (recurring_id, line_no)
) STRICT;

CREATE TABLE recurring_run (
  recurring_id TEXT    NOT NULL REFERENCES recurring_entry (id),
  date         TEXT    NOT NULL CHECK (date = date(date)),
  company_id   TEXT    NOT NULL REFERENCES company (id),
  -- Null once the entry is deleted (GL-6 off); the date still counts as posted
  entry_id     INTEGER REFERENCES journal_entry (id) ON DELETE SET NULL,
  posted_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (recurring_id, date)
) STRICT;

CREATE INDEX recurring_run_entry ON recurring_run (entry_id);

-- A run is the template's own posting on that date
CREATE TRIGGER recurring_run_insert
BEFORE INSERT ON recurring_run
BEGIN
  SELECT RAISE(ABORT, 'GL-5: a recurring run must record that template''s entry for that date')
  WHERE NOT EXISTS (SELECT 1 FROM journal_entry e
                    WHERE e.id = NEW.entry_id AND e.source_type = 'recurring'
                      AND e.source_id = NEW.recurring_id AND e.date = NEW.date);
END;

-- Runs are history: only the link to a deleted entry may go
CREATE TRIGGER recurring_run_update
BEFORE UPDATE ON recurring_run
BEGIN
  SELECT RAISE(ABORT, 'GL-5: recurring runs cannot be changed')
  WHERE NEW.recurring_id IS NOT OLD.recurring_id OR NEW.date IS NOT OLD.date
     OR NEW.company_id IS NOT OLD.company_id OR NEW.posted_at IS NOT OLD.posted_at
     OR (NEW.entry_id IS NOT OLD.entry_id AND NEW.entry_id IS NOT NULL);
END;

CREATE TRIGGER recurring_run_delete
BEFORE DELETE ON recurring_run
BEGIN
  SELECT RAISE(ABORT, 'GL-5: recurring runs cannot be deleted');
END;

-- A template that has posted stays, for its history; make it inactive instead
CREATE TRIGGER recurring_entry_delete
BEFORE DELETE ON recurring_entry
BEGIN
  SELECT RAISE(ABORT, 'GL-5: this recurring entry has posted entries; make it inactive instead')
  WHERE EXISTS (SELECT 1 FROM recurring_run WHERE recurring_id = OLD.id);
END;
