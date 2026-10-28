-- 0014: one list of payees (GL-11), with customer and vendor records (AR-1, AP-1).
--
-- QuickBooks keeps one list of names, unique across customers and vendors; so
-- does this. A payee can be a customer, a vendor, both, or neither (a name used
-- only on transactions). The customer and vendor tables from 0009 move in here.
--
-- Entries and lines name their payee by payee_id, and keep its name as text
-- (MG-3: the name as it was imported or entered). Names aren't amounts: a
-- posted or void entry's payee and name may change, but only together, with
-- the name always the payee's own, so renaming a payee renames it everywhere
-- and merging two moves every entry over. Each such change is audited.

CREATE TABLE payee (
  id                 TEXT    NOT NULL PRIMARY KEY,
  company_id         TEXT    NOT NULL REFERENCES company (id),
  name               TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  is_customer        INTEGER NOT NULL DEFAULT 0 CHECK (is_customer IN (0, 1)),
  is_vendor          INTEGER NOT NULL DEFAULT 0 CHECK (is_vendor IN (0, 1)),
  contact_name       TEXT,
  email              TEXT,
  phone              TEXT,
  address            TEXT,    -- billing address for a customer, address for a vendor
  shipping_address   TEXT,
  account_number     TEXT,    -- the company's account number with this vendor
  terms_days         INTEGER  CHECK (terms_days IS NULL OR terms_days BETWEEN 0 AND 365),
  -- The category a vendor's expenses usually go to (AP-1)
  default_account_id TEXT     REFERENCES account (id),
  is_1099            INTEGER NOT NULL DEFAULT 0 CHECK (is_1099 IN (0, 1)),
  notes              TEXT,
  active             INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE UNIQUE INDEX payee_name ON payee (company_id, name COLLATE NOCASE);

-- ---- customers and vendors move in ------------------------------------------

INSERT INTO payee (id, company_id, name, is_customer, contact_name, email, phone, address,
                   shipping_address, active, created_at)
SELECT id, company_id, trim(name), 1, contact_name, email, phone, billing_address,
       shipping_address, active, created_at
FROM customer;

-- A vendor with a customer's name is the same payee
UPDATE payee SET
  is_vendor = 1,
  account_number = (SELECT v.account_number FROM vendor v WHERE trim(v.name) = payee.name COLLATE NOCASE),
  contact_name = coalesce(contact_name, (SELECT v.contact_name FROM vendor v WHERE trim(v.name) = payee.name COLLATE NOCASE)),
  email = coalesce(email, (SELECT v.email FROM vendor v WHERE trim(v.name) = payee.name COLLATE NOCASE)),
  phone = coalesce(phone, (SELECT v.phone FROM vendor v WHERE trim(v.name) = payee.name COLLATE NOCASE)),
  address = coalesce(address, (SELECT v.address FROM vendor v WHERE trim(v.name) = payee.name COLLATE NOCASE))
WHERE EXISTS (SELECT 1 FROM vendor v WHERE trim(v.name) = payee.name COLLATE NOCASE);

INSERT INTO payee (id, company_id, name, is_vendor, contact_name, email, phone, address,
                   account_number, active, created_at)
SELECT id, company_id, trim(name), 1, contact_name, email, phone, address, account_number,
       active, created_at
FROM vendor v
WHERE NOT EXISTS (SELECT 1 FROM payee p WHERE p.name = trim(v.name) COLLATE NOCASE);

DROP TABLE customer;
DROP TABLE vendor;

-- ---- every name already on an entry or line becomes a payee ------------------

INSERT INTO payee (id, company_id, name)
SELECT lower(hex(randomblob(16))), (SELECT id FROM company), n.name
FROM (SELECT trim(name) AS name FROM journal_entry WHERE trim(name) <> ''
      UNION
      SELECT trim(name) FROM journal_line WHERE trim(name) <> '') AS n
WHERE NOT EXISTS (SELECT 1 FROM payee p WHERE p.name = n.name COLLATE NOCASE)
GROUP BY n.name COLLATE NOCASE;

ALTER TABLE journal_entry ADD COLUMN payee_id TEXT REFERENCES payee (id);
ALTER TABLE journal_line ADD COLUMN payee_id TEXT REFERENCES payee (id);
CREATE INDEX journal_entry_payee ON journal_entry (payee_id);
CREATE INDEX journal_line_payee ON journal_line (payee_id) WHERE payee_id IS NOT NULL;

-- Link the existing names before the rules below, and without audit events:
-- this is the upgrade itself. The name text stays as it was, even where it
-- differs from its payee's only in capitals.
DROP TRIGGER journal_line_update_draft_only;
UPDATE journal_entry SET payee_id = (SELECT id FROM payee p WHERE p.name = trim(journal_entry.name) COLLATE NOCASE)
WHERE trim(name) <> '';
UPDATE journal_line SET payee_id = (SELECT id FROM payee p WHERE p.name = trim(journal_line.name) COLLATE NOCASE)
WHERE trim(name) <> '';

-- ---- names on posted entries follow their payee -----------------------------

DROP TRIGGER journal_entry_immutable;
CREATE TRIGGER journal_entry_immutable
BEFORE UPDATE ON journal_entry
WHEN OLD.status <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'GL-6: a posted entry cannot be changed; void it and enter a correction')
  WHERE NEW.id IS NOT OLD.id OR NEW.company_id IS NOT OLD.company_id OR NEW.date IS NOT OLD.date
     OR NEW.ref IS NOT OLD.ref OR NEW.memo IS NOT OLD.memo
     OR NEW.source_type IS NOT OLD.source_type OR NEW.source_id IS NOT OLD.source_id
     OR NEW.posted_at IS NOT OLD.posted_at OR NEW.created_at IS NOT OLD.created_at
     OR (OLD.status = 'void' AND (NEW.status IS NOT OLD.status OR NEW.voided_at IS NOT OLD.voided_at
                                   OR NEW.void_reason IS NOT OLD.void_reason));
  SELECT RAISE(ABORT, 'GL-11: a posted entry''s name changes only with its payee')
  WHERE (NEW.name IS NOT OLD.name OR NEW.payee_id IS NOT OLD.payee_id)
    AND (NEW.payee_id IS NULL
         OR NEW.name IS NOT (SELECT name FROM payee WHERE id = NEW.payee_id));
END;

CREATE TRIGGER journal_line_update_draft_only
BEFORE UPDATE ON journal_line
BEGIN
  SELECT RAISE(ABORT, 'GL-6: posted lines cannot be changed; void the entry instead')
  WHERE ((SELECT status FROM journal_entry WHERE id = OLD.entry_id) IS NOT 'draft'
         OR (SELECT status FROM journal_entry WHERE id = NEW.entry_id) IS NOT 'draft')
    AND (NEW.id IS NOT OLD.id OR NEW.company_id IS NOT OLD.company_id
         OR NEW.entry_id IS NOT OLD.entry_id OR NEW.line_no IS NOT OLD.line_no
         OR NEW.account_id IS NOT OLD.account_id OR NEW.debit IS NOT OLD.debit
         OR NEW.credit IS NOT OLD.credit OR NEW.memo IS NOT OLD.memo
         OR NEW.payee_id IS NULL
         OR NEW.name IS NOT (SELECT name FROM payee WHERE id = NEW.payee_id));
  SELECT RAISE(ABORT, 'GL-7: this account is inactive')
  WHERE NEW.account_id <> OLD.account_id AND (SELECT active FROM account WHERE id = NEW.account_id) = 0;
END;

-- A payee that names entries stays (merge it into another instead)
CREATE TRIGGER payee_delete_unused
BEFORE DELETE ON payee
BEGIN
  SELECT RAISE(ABORT, 'GL-11: this payee is on transactions; merge it into another payee or make it inactive')
  WHERE EXISTS (SELECT 1 FROM journal_entry WHERE payee_id = OLD.id)
     OR EXISTS (SELECT 1 FROM journal_line WHERE payee_id = OLD.id);
END;

-- ---- audit: one compact event per entry or line whose payee changes (US-5) ---

CREATE TRIGGER audit_journal_entry_payee
AFTER UPDATE OF name, payee_id ON journal_entry
WHEN OLD.status <> 'draft' AND (NEW.name IS NOT OLD.name OR NEW.payee_id IS NOT OLD.payee_id)
BEGIN
  INSERT INTO audit_event (company_id, user_id, action, entity, entity_id, before, after)
  VALUES ((SELECT id FROM company), (SELECT user_id FROM session WHERE id = 1), 'payee',
          'journal_entry', CAST(NEW.id AS TEXT),
          json_object('name', OLD.name, 'payee_id', OLD.payee_id),
          json_object('name', NEW.name, 'payee_id', NEW.payee_id));
END;

CREATE TRIGGER audit_journal_line_payee
AFTER UPDATE OF name, payee_id ON journal_line
WHEN (SELECT status FROM journal_entry WHERE id = NEW.entry_id) <> 'draft'
 AND (NEW.name IS NOT OLD.name OR NEW.payee_id IS NOT OLD.payee_id)
BEGIN
  INSERT INTO audit_event (company_id, user_id, action, entity, entity_id, before, after)
  VALUES ((SELECT id FROM company), (SELECT user_id FROM session WHERE id = 1), 'payee',
          'journal_line', CAST(NEW.id AS TEXT),
          json_object('name', OLD.name, 'payee_id', OLD.payee_id),
          json_object('name', NEW.name, 'payee_id', NEW.payee_id));
END;
