-- 0013: reconcile an account together with its sub-accounts (BK-7).
--
-- QuickBooks companies often keep one credit card as a parent account with a
-- sub-account per card holder: charges on the sub-accounts, payments on the
-- parent. Only the parent and all its sub-accounts together are the card the
-- statement shows, so a reconciliation can include the sub-accounts. Fixed
-- when the reconciliation starts.

ALTER TABLE reconciliation ADD COLUMN include_subaccounts INTEGER NOT NULL DEFAULT 0
  CHECK (include_subaccounts IN (0, 1));

DROP TRIGGER reconciliation_update;
CREATE TRIGGER reconciliation_update
BEFORE UPDATE ON reconciliation
BEGIN
  SELECT RAISE(ABORT, 'BK-7: a finished reconciliation cannot be changed')
  WHERE OLD.status = 'done';
  SELECT RAISE(ABORT, 'BK-7: a reconciliation stays with its account')
  WHERE NEW.id IS NOT OLD.id OR NEW.company_id IS NOT OLD.company_id
     OR NEW.account_id IS NOT OLD.account_id OR NEW.created_at IS NOT OLD.created_at
     OR NEW.include_subaccounts IS NOT OLD.include_subaccounts;
  SELECT RAISE(ABORT, 'BK-7: statements are reconciled in date order; this date is on or before the last reconciled statement')
  WHERE NEW.statement_date <= (SELECT max(statement_date) FROM reconciliation
                               WHERE account_id = NEW.account_id AND status = 'done');
  SELECT RAISE(ABORT, 'BK-7: cleared items must be dated on or before the statement date')
  WHERE EXISTS (SELECT 1 FROM reconciled_line r
                JOIN journal_line l ON l.id = r.line_id
                JOIN journal_entry e ON e.id = l.entry_id
                WHERE r.reconciliation_id = NEW.id AND e.date > NEW.statement_date);
END;

-- A cleared line is in the reconciled account, or with include_subaccounts
-- in one of its sub-accounts at any depth
DROP TRIGGER reconciled_line_insert;
CREATE TRIGGER reconciled_line_insert
BEFORE INSERT ON reconciled_line
BEGIN
  SELECT RAISE(ABORT, 'BK-7: a finished reconciliation cannot be changed')
  WHERE (SELECT status FROM reconciliation WHERE id = NEW.reconciliation_id) IS NOT 'open';
  SELECT RAISE(ABORT, 'BK-7: that item is in another account')
  WHERE (SELECT account_id FROM journal_line WHERE id = NEW.line_id) NOT IN (
    WITH RECURSIVE covered (id) AS (
      SELECT account_id FROM reconciliation WHERE id = NEW.reconciliation_id
      UNION
      SELECT a.id FROM account a JOIN covered ON a.parent_id = covered.id
      WHERE (SELECT include_subaccounts FROM reconciliation WHERE id = NEW.reconciliation_id) = 1
    )
    SELECT id FROM covered);
  SELECT RAISE(ABORT, 'BK-7: only posted entries can be cleared')
  WHERE (SELECT e.status FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
         WHERE l.id = NEW.line_id) IS NOT 'posted';
  SELECT RAISE(ABORT, 'BK-7: cleared items must be dated on or before the statement date')
  WHERE (SELECT e.date FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
         WHERE l.id = NEW.line_id)
      > (SELECT statement_date FROM reconciliation WHERE id = NEW.reconciliation_id);
END;
