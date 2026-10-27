-- 0010: QuickBooks Online history import (MG-2 to MG-6), and names on
-- entries (MG-3).

-- ---- names on entries (MG-3) ------------------------------------------------

-- The payee, customer or vendor as text: on the entry, and on a line when the
-- line names someone else (QuickBooks journal entries can name each line)
ALTER TABLE journal_entry ADD COLUMN name TEXT;
ALTER TABLE journal_line ADD COLUMN name TEXT;

-- Posted entries never change (GL-6); the column list now includes name
DROP TRIGGER journal_entry_immutable;
CREATE TRIGGER journal_entry_immutable
BEFORE UPDATE ON journal_entry
WHEN OLD.status <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'GL-6: a posted entry cannot be changed; void it and enter a correction')
  WHERE NEW.id IS NOT OLD.id OR NEW.company_id IS NOT OLD.company_id OR NEW.date IS NOT OLD.date
     OR NEW.ref IS NOT OLD.ref OR NEW.memo IS NOT OLD.memo OR NEW.name IS NOT OLD.name
     OR NEW.source_type IS NOT OLD.source_type OR NEW.source_id IS NOT OLD.source_id
     OR NEW.posted_at IS NOT OLD.posted_at OR NEW.created_at IS NOT OLD.created_at
     OR (OLD.status = 'void' AND (NEW.status IS NOT OLD.status OR NEW.voided_at IS NOT OLD.voided_at
                                   OR NEW.void_reason IS NOT OLD.void_reason));
END;

-- ---- import runs (MG-6) -----------------------------------------------------

-- One run imports all of a company's history at once, into a company that has
-- no transactions yet. Everything it writes happens in one transaction, so a
-- run that fails or is discarded leaves nothing behind. Migrated entries carry
-- source_type 'qbo_migration' and the run's id as source_id.
CREATE TABLE qbo_import_run (
  id          TEXT NOT NULL PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES company (id),
  status      TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done')),
  started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT,
  -- Files, counts and the tie-out result, as JSON
  summary     TEXT CHECK (summary IS NULL OR json_valid(summary)),
  CHECK ((status = 'done') = (finished_at IS NOT NULL))
) STRICT;

CREATE TRIGGER qbo_import_run_fresh_company
BEFORE INSERT ON qbo_import_run
BEGIN
  SELECT RAISE(ABORT, 'MG-6: import QuickBooks history into a new company; this one already has transactions')
  WHERE EXISTS (SELECT 1 FROM journal_entry WHERE status <> 'draft');
  SELECT RAISE(ABORT, 'MG-6: an import run starts as running')
  WHERE NEW.status <> 'running';
END;

CREATE TRIGGER qbo_import_run_finish_only
BEFORE UPDATE ON qbo_import_run
BEGIN
  SELECT RAISE(ABORT, 'MG-6: a finished import run cannot be changed')
  WHERE OLD.status = 'done'
     OR NEW.id IS NOT OLD.id OR NEW.company_id IS NOT OLD.company_id
     OR NEW.started_at IS NOT OLD.started_at;
END;

CREATE TRIGGER qbo_import_run_no_delete
BEFORE DELETE ON qbo_import_run
BEGIN
  SELECT RAISE(ABORT, 'MG-6: import runs are kept');
END;

-- Migrated history is posted only by a running import. This also keeps the
-- A/R and A/P exception (GL-8) and the bulk audit below to real imports.
CREATE TRIGGER journal_entry_migration_run
BEFORE UPDATE OF status ON journal_entry
WHEN OLD.status = 'draft' AND NEW.status = 'posted' AND NEW.source_type = 'qbo_migration'
BEGIN
  SELECT RAISE(ABORT, 'MG-6: QuickBooks history can only be posted by a running import')
  WHERE NOT EXISTS (SELECT 1 FROM qbo_import_run WHERE id = NEW.source_id AND status = 'running');
END;

-- Where each migrated entry came from: QuickBooks's transaction type and the
-- file and row. Excluded from the generated audit triggers (one row per entry
-- would add tens of megabytes); it can't be changed, and the run is audited.
CREATE TABLE qbo_entry (
  entry_id   INTEGER NOT NULL PRIMARY KEY REFERENCES journal_entry (id),
  company_id TEXT    NOT NULL REFERENCES company (id),
  run_id     TEXT    NOT NULL REFERENCES qbo_import_run (id),
  txn_type   TEXT    NOT NULL,
  source     TEXT    NOT NULL
) STRICT;

CREATE TRIGGER qbo_entry_running_import
BEFORE INSERT ON qbo_entry
BEGIN
  SELECT RAISE(ABORT, 'MG-6: QuickBooks history can only be recorded by a running import')
  WHERE NOT EXISTS (SELECT 1 FROM qbo_import_run WHERE id = NEW.run_id AND status = 'running');
END;

CREATE TRIGGER qbo_entry_no_update
BEFORE UPDATE ON qbo_entry
BEGIN
  SELECT RAISE(ABORT, 'MG-6: imported history records cannot be changed');
END;

CREATE TRIGGER qbo_entry_no_delete
BEFORE DELETE ON qbo_entry
BEGIN
  SELECT RAISE(ABORT, 'MG-6: imported history records cannot be changed');
END;

-- ---- bulk audit (US-5) ------------------------------------------------------

-- An import posts tens of thousands of entries. Instead of one "post" event
-- each, the run is audited once (its insert and its finish, with the summary).
DROP TRIGGER audit_journal_entry_posted;
CREATE TRIGGER audit_journal_entry_posted
AFTER UPDATE OF status ON journal_entry
WHEN OLD.status = 'draft' AND NEW.status = 'posted' AND NEW.source_type <> 'qbo_migration'
BEGIN
  INSERT INTO audit_event (company_id, user_id, action, entity, entity_id, after)
  VALUES ((SELECT id FROM company), (SELECT user_id FROM session WHERE id = 1), 'post',
          'journal_entry', CAST(NEW.id AS TEXT),
          json_object('date', NEW.date, 'ref', NEW.ref, 'name', NEW.name, 'memo', NEW.memo,
                      'source_type', NEW.source_type, 'source_id', NEW.source_id,
                      'amount', (SELECT sum(debit) FROM journal_line WHERE entry_id = NEW.id)));
END;
