-- 0008: compact audit entries for the ledger (US-5).
--
-- The generic generated triggers (src/worker/audit.ts) copy whole rows before
-- and after every change. For journal entries that meant two full copies per
-- posting, and for lines one more each, which made a 17-year company several
-- times larger than its ledger (M4 benchmark). Drafts never leave postEntry()
-- and posted lines never change, so the ledger records just two events: an
-- entry was posted (with its total), and an entry was voided.
-- journal_entry and journal_line are excluded from the generated triggers.

CREATE TRIGGER audit_journal_entry_posted
AFTER UPDATE OF status ON journal_entry
WHEN OLD.status = 'draft' AND NEW.status = 'posted'
BEGIN
  INSERT INTO audit_event (company_id, user_id, action, entity, entity_id, after)
  VALUES ((SELECT id FROM company), (SELECT user_id FROM session WHERE id = 1), 'post',
          'journal_entry', CAST(NEW.id AS TEXT),
          json_object('date', NEW.date, 'ref', NEW.ref, 'memo', NEW.memo,
                      'source_type', NEW.source_type, 'source_id', NEW.source_id,
                      'amount', (SELECT sum(debit) FROM journal_line WHERE entry_id = NEW.id)));
END;

CREATE TRIGGER audit_journal_entry_voided
AFTER UPDATE OF status ON journal_entry
WHEN OLD.status = 'posted' AND NEW.status = 'void'
BEGIN
  INSERT INTO audit_event (company_id, user_id, action, entity, entity_id, after)
  VALUES ((SELECT id FROM company), (SELECT user_id FROM session WHERE id = 1), 'void',
          'journal_entry', CAST(NEW.id AS TEXT),
          json_object('date', NEW.date, 'void_reason', NEW.void_reason));
END;
