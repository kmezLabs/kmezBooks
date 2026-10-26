-- 0006: period close (PC-1, PC-2).
-- Nothing dated on or before the company's closing date can be posted or
-- voided, unless the owner overrides it for that one action. Each override
-- is written to the audit log by the trigger itself.

ALTER TABLE company ADD COLUMN closing_date TEXT
  CHECK (closing_date IS NULL OR (closing_date = date(closing_date)));

-- Set by the app for the duration of one overridden action, after the owner
-- re-enters the company passphrase; cleared again in the same transaction
ALTER TABLE session ADD COLUMN closing_override INTEGER NOT NULL DEFAULT 0
  CHECK (closing_override IN (0, 1));

-- The audit log's action list was fixed by a CHECK; new kinds of events would
-- each need a table rebuild. Allow any lower_snake_case word instead.
CREATE TABLE audit_event_new (
  id         INTEGER NOT NULL PRIMARY KEY,
  company_id TEXT    NOT NULL REFERENCES company (id) DEFERRABLE INITIALLY DEFERRED,
  at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  user_id    TEXT,
  action     TEXT    NOT NULL CHECK (action GLOB '[a-z]*' AND action NOT GLOB '*[^a-z_]*'),
  entity     TEXT,
  entity_id  TEXT,
  before     TEXT    CHECK (before IS NULL OR json_valid(before)),
  after      TEXT    CHECK (after IS NULL OR json_valid(after)),
  note       TEXT
) STRICT;
INSERT INTO audit_event_new SELECT id, company_id, at, user_id, action, entity, entity_id, before, after, note FROM audit_event;
DROP TABLE audit_event;
ALTER TABLE audit_event_new RENAME TO audit_event;
CREATE INDEX audit_event_at ON audit_event (at);
CREATE INDEX audit_event_entity ON audit_event (entity, entity_id);
CREATE TRIGGER audit_event_no_update
BEFORE UPDATE ON audit_event
BEGIN
  SELECT RAISE(ABORT, 'US-5: the audit log cannot be changed');
END;
CREATE TRIGGER audit_event_no_delete
BEFORE DELETE ON audit_event
BEGIN
  SELECT RAISE(ABORT, 'US-5: the audit log cannot be changed');
END;

-- Posting or voiding in a closed period (PC-1), or with the override (PC-2)
CREATE TRIGGER journal_entry_closing_date
BEFORE UPDATE OF status ON journal_entry
WHEN NEW.status IS NOT OLD.status
 AND NEW.date <= (SELECT closing_date FROM company)
BEGIN
  SELECT RAISE(ABORT, 'PC-1: this date is in a closed period')
  WHERE (SELECT closing_override FROM session WHERE id = 1) IS NOT 1;
  INSERT INTO audit_event (company_id, user_id, action, entity, entity_id, note)
  VALUES ((SELECT id FROM company), (SELECT user_id FROM session WHERE id = 1),
          'closed_period_override', 'journal_entry', CAST(NEW.id AS TEXT),
          (CASE NEW.status WHEN 'posted' THEN 'posted' ELSE 'voided' END)
          || ' an entry dated ' || NEW.date || ' (closing date ' || (SELECT closing_date FROM company) || ')');
END;
