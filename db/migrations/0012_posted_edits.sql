-- 0012: changing and deleting posted entries, when the company allows it (GL-6).
--
-- By default posted entries never change: corrections are voids or adjusting
-- entries. A company can switch that off. Then an entry can be taken back to
-- draft, its lines rewritten, and posted again, or deleted while a draft. The
-- usual checks still hold, because posting again runs them all: the balance
-- (GL-3), the closing date on the way out and on the way back (PC-1), inactive
-- accounts (GL-7) and the cash-basis rule (GL-8). Entries cleared by a
-- finished reconciliation stay as they are (BK-8), and QuickBooks history can
-- be corrected but not deleted (MG-6). Every change is in the audit log.

ALTER TABLE company ADD COLUMN posted_edits INTEGER NOT NULL DEFAULT 0
  CHECK (posted_edits IN (0, 1));

-- Status moves draft → posted → void, and back from posted to draft only
-- where the company allows changing posted entries (GL-6)
DROP TRIGGER journal_entry_status_flow;
CREATE TRIGGER journal_entry_status_flow
BEFORE UPDATE OF status ON journal_entry
WHEN NEW.status IS NOT OLD.status
BEGIN
  SELECT RAISE(ABORT, 'GL-6: posted entries cannot be changed in this company; void the entry and enter a correction')
  WHERE OLD.status = 'posted' AND NEW.status = 'draft' AND (SELECT posted_edits FROM company) IS NOT 1;
  SELECT RAISE(ABORT, 'GL-6: an entry can only go from draft to posted, or from posted to void')
  WHERE NOT ((OLD.status = 'draft' AND NEW.status = 'posted')
          OR (OLD.status = 'posted' AND NEW.status IN ('void', 'draft')));
END;

CREATE TRIGGER journal_entry_unpost_checks
BEFORE UPDATE OF status ON journal_entry
WHEN OLD.status = 'posted' AND NEW.status = 'draft'
BEGIN
  SELECT RAISE(ABORT, 'BK-8: this entry was reconciled; void it and enter a correction instead')
  WHERE EXISTS (SELECT 1 FROM reconciled_line r
                JOIN journal_line l ON l.id = r.line_id
                JOIN reconciliation c ON c.id = r.reconciliation_id AND c.status = 'done'
                WHERE l.entry_id = NEW.id);
END;

-- Taken back to draft: it leaves a reconciliation in progress, and the bank
-- transactions it accounted for go back to review (the app links them again
-- when the corrected entry still fits)
CREATE TRIGGER journal_entry_unposted
AFTER UPDATE OF status ON journal_entry
WHEN OLD.status = 'posted' AND NEW.status = 'draft'
BEGIN
  DELETE FROM reconciled_line WHERE line_id IN (SELECT id FROM journal_line WHERE entry_id = NEW.id);
  UPDATE bank_txn SET status = 'new', entry_id = NULL WHERE entry_id = NEW.id;
  INSERT INTO audit_event (company_id, user_id, action, entity, entity_id, before)
  VALUES ((SELECT id FROM company), (SELECT user_id FROM session WHERE id = 1), 'unpost',
          'journal_entry', CAST(NEW.id AS TEXT),
          json_object('date', OLD.date, 'ref', OLD.ref, 'name', OLD.name, 'memo', OLD.memo,
                      'lines', json((SELECT json_group_array(json_object('account_id', account_id,
                                  'debit', debit, 'credit', credit, 'memo', memo, 'name', name))
                                FROM journal_line WHERE entry_id = NEW.id))));
END;

-- A corrected migrated entry posts again without an import run; new history
-- still needs one (MG-6)
DROP TRIGGER journal_entry_migration_run;
CREATE TRIGGER journal_entry_migration_run
BEFORE UPDATE OF status ON journal_entry
WHEN OLD.status = 'draft' AND NEW.status = 'posted' AND NEW.source_type = 'qbo_migration'
 AND NOT EXISTS (SELECT 1 FROM qbo_entry WHERE entry_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'MG-6: QuickBooks history can only be posted by a running import')
  WHERE NOT EXISTS (SELECT 1 FROM qbo_import_run WHERE id = NEW.source_id AND status = 'running');
END;

-- A draft that was posted before is a posted entry being changed: deleting it
-- is logged, and QuickBooks history is kept (void it instead)
CREATE TRIGGER journal_entry_delete_checks
BEFORE DELETE ON journal_entry
WHEN OLD.posted_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'MG-6: QuickBooks history cannot be deleted; void the entry instead')
  WHERE EXISTS (SELECT 1 FROM qbo_entry WHERE entry_id = OLD.id);
END;

CREATE TRIGGER audit_journal_entry_deleted
AFTER DELETE ON journal_entry
WHEN OLD.posted_at IS NOT NULL
BEGIN
  INSERT INTO audit_event (company_id, user_id, action, entity, entity_id, before)
  VALUES ((SELECT id FROM company), (SELECT user_id FROM session WHERE id = 1), 'delete',
          'journal_entry', CAST(OLD.id AS TEXT),
          json_object('date', OLD.date, 'ref', OLD.ref, 'name', OLD.name, 'memo', OLD.memo,
                      'source_type', OLD.source_type, 'source_id', OLD.source_id));
END;
