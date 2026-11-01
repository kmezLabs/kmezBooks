-- 0020: test companies (CO-7). A company can be created as a test company,
-- for trying things out. Its name shows "– Test", and only a test company
-- has the Development pages (the M1 technical test, which fills the company
-- with made-up history). It is set when the company is created and the app
-- never changes it; companies made before this are real companies.

ALTER TABLE company ADD COLUMN test INTEGER NOT NULL DEFAULT 0
  CHECK (test IN (0, 1));

-- Made-up history (source 'test_history') in a test company is replaced on
-- every run of the technical test, so it may be deleted although posted, and
-- it isn't logged entry by entry: each run is one audit event, like a
-- QuickBooks import. Everywhere else posted entries are never deleted
-- (GL-6), and the closing date still protects made-up history (PC-1).

DROP TRIGGER journal_line_delete_draft_only;
CREATE TRIGGER journal_line_delete_draft_only
BEFORE DELETE ON journal_line
BEGIN
  SELECT RAISE(ABORT, 'GL-6: posted lines cannot be deleted; void the entry instead')
  WHERE (SELECT status FROM journal_entry WHERE id = OLD.entry_id) IS NOT 'draft'
    AND NOT EXISTS (SELECT 1 FROM journal_entry e
                    WHERE e.id = OLD.entry_id AND e.source_type = 'test_history'
                      AND (SELECT test FROM company) = 1
                      AND e.date > coalesce((SELECT closing_date FROM company), ''));
END;

DROP TRIGGER journal_entry_no_delete;
CREATE TRIGGER journal_entry_no_delete
BEFORE DELETE ON journal_entry
WHEN OLD.status <> 'draft'
 AND NOT (OLD.source_type = 'test_history' AND (SELECT test FROM company) = 1
          AND OLD.date > coalesce((SELECT closing_date FROM company), ''))
BEGIN
  SELECT RAISE(ABORT, 'GL-6: posted entries are never deleted; void the entry instead');
END;

DROP TRIGGER audit_journal_entry_posted;
CREATE TRIGGER audit_journal_entry_posted
AFTER UPDATE OF status ON journal_entry
WHEN OLD.status = 'draft' AND NEW.status = 'posted' AND NEW.source_type <> 'qbo_migration'
 AND NOT (NEW.source_type = 'test_history' AND (SELECT test FROM company) = 1)
BEGIN
  INSERT INTO audit_event (company_id, user_id, action, entity, entity_id, after)
  VALUES ((SELECT id FROM company), (SELECT user_id FROM session WHERE id = 1), 'post',
          'journal_entry', CAST(NEW.id AS TEXT),
          json_object('date', NEW.date, 'ref', NEW.ref, 'name', NEW.name, 'memo', NEW.memo,
                      'source_type', NEW.source_type, 'source_id', NEW.source_id,
                      'amount', (SELECT sum(debit) FROM journal_line WHERE entry_id = NEW.id)));
END;

DROP TRIGGER audit_journal_entry_deleted;
CREATE TRIGGER audit_journal_entry_deleted
AFTER DELETE ON journal_entry
WHEN OLD.posted_at IS NOT NULL
 AND NOT (OLD.source_type = 'test_history' AND (SELECT test FROM company) = 1)
BEGIN
  INSERT INTO audit_event (company_id, user_id, action, entity, entity_id, before)
  VALUES ((SELECT id FROM company), (SELECT user_id FROM session WHERE id = 1), 'delete',
          'journal_entry', CAST(OLD.id AS TEXT),
          json_object('date', OLD.date, 'ref', OLD.ref, 'name', OLD.name, 'memo', OLD.memo,
                      'source_type', OLD.source_type, 'source_id', OLD.source_id));
END;
