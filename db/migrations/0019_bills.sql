-- 0019: bills and bill payments (AP-2 to AP-5). The ledger stays cash basis
-- (GL-8): a bill is a document and never posts. A bill payment posts one
-- entry through postEntry() (source 'bill_payment', the payment's id): the
-- account it was paid from is credited, and each bill's part is spread over
-- that bill's lines by allocateProRata(). The payment and how it applies to
-- bills are recorded here. Paid, partially paid and overdue are worked out
-- from the payments, not stored.

CREATE TABLE bill (
  id          TEXT    NOT NULL PRIMARY KEY,
  company_id  TEXT    NOT NULL REFERENCES company (id),
  vendor_id   TEXT    NOT NULL REFERENCES payee (id),
  -- The vendor's own bill or invoice number; optional, and not unique
  number      TEXT,
  date        TEXT    NOT NULL CHECK (date = date(date)),
  due_date    TEXT    NOT NULL CHECK (due_date = date(due_date)),
  terms_days  INTEGER CHECK (terms_days IS NULL OR terms_days BETWEEN 0 AND 365),
  memo        TEXT,
  status      TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'void')),
  voided_at   TEXT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((status = 'void') = (voided_at IS NOT NULL)),
  CHECK (due_date >= date)
) STRICT;

CREATE INDEX bill_vendor ON bill (vendor_id);
CREATE INDEX bill_due ON bill (due_date);

CREATE TABLE bill_line (
  id          INTEGER NOT NULL PRIMARY KEY,
  company_id  TEXT    NOT NULL REFERENCES company (id),
  bill_id     TEXT    NOT NULL REFERENCES bill (id),
  line_no     INTEGER NOT NULL CHECK (line_no >= 1),
  -- The expense (or other) account the line goes to when paid
  account_id  TEXT    NOT NULL REFERENCES account (id),
  description TEXT,
  -- What the line costs; negative for a credit on the bill
  amount      INTEGER NOT NULL CHECK (amount BETWEEN -10000000000000 AND 10000000000000),
  UNIQUE (bill_id, line_no)
) STRICT;

CREATE TABLE bill_payment (
  id         TEXT    NOT NULL PRIMARY KEY,
  company_id TEXT    NOT NULL REFERENCES company (id),
  vendor_id  TEXT    NOT NULL REFERENCES payee (id),
  date       TEXT    NOT NULL CHECK (date = date(date)),
  -- Where the money came from: a bank or credit card account
  account_id TEXT    NOT NULL REFERENCES account (id),
  amount     INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 10000000000000),
  -- Check, ACH, card…
  method     TEXT,
  -- The check number, or another reference
  ref        TEXT,
  memo       TEXT,
  entry_id   INTEGER REFERENCES journal_entry (id),
  -- Written as a draft with its applications, then posted; void with its entry
  status     TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'void')),
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX bill_payment_vendor ON bill_payment (vendor_id);

CREATE TABLE bill_payment_application (
  payment_id TEXT    NOT NULL REFERENCES bill_payment (id),
  bill_id    TEXT    NOT NULL REFERENCES bill (id),
  company_id TEXT    NOT NULL REFERENCES company (id),
  amount     INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 10000000000000),
  PRIMARY KEY (payment_id, bill_id)
) STRICT;

CREATE INDEX bill_payment_application_bill ON bill_payment_application (bill_id);

-- ---- what a bill has been paid: by payments that aren't void --------------

CREATE VIEW bill_paid AS
SELECT a.bill_id, sum(a.amount) AS paid
FROM bill_payment_application a
JOIN bill_payment p ON p.id = a.payment_id AND p.status <> 'void'
GROUP BY a.bill_id;

-- ---- applications (AP-3) ---------------------------------------------------

CREATE TRIGGER bill_payment_application_insert
BEFORE INSERT ON bill_payment_application
BEGIN
  SELECT RAISE(ABORT, 'AP-3: applications are written while the payment is a draft')
  WHERE (SELECT status FROM bill_payment WHERE id = NEW.payment_id) IS NOT 'draft';
  SELECT RAISE(ABORT, 'AP-3: a payment applies only to a bill that isn''t void')
  WHERE (SELECT status FROM bill WHERE id = NEW.bill_id) IS NOT 'open';
  SELECT RAISE(ABORT, 'AP-3: a payment applies only to its vendor''s bills')
  WHERE (SELECT vendor_id FROM bill WHERE id = NEW.bill_id)
     IS NOT (SELECT vendor_id FROM bill_payment WHERE id = NEW.payment_id);
  SELECT RAISE(ABORT, 'AP-3: a payment can''t exceed what is still owed on the bill')
  WHERE coalesce((SELECT paid FROM bill_paid WHERE bill_id = NEW.bill_id), 0) + NEW.amount
      > coalesce((SELECT sum(amount) FROM bill_line WHERE bill_id = NEW.bill_id), 0);
END;

CREATE TRIGGER bill_payment_application_update
BEFORE UPDATE ON bill_payment_application
BEGIN
  SELECT RAISE(ABORT, 'AP-3: a payment''s applications cannot be changed; void the payment');
END;

CREATE TRIGGER bill_payment_application_delete
BEFORE DELETE ON bill_payment_application
BEGIN
  SELECT RAISE(ABORT, 'AP-3: a payment''s applications cannot be changed; void the payment')
  WHERE (SELECT status FROM bill_payment WHERE id = OLD.payment_id) IS NOT 'draft';
END;

-- ---- payments: draft → posted with its entry → void with it ----------------

CREATE TRIGGER bill_payment_update
BEFORE UPDATE ON bill_payment
BEGIN
  SELECT RAISE(ABORT, 'AP-3: a payment goes from draft to posted, and from posted to void')
  WHERE NEW.status IS NOT OLD.status
    AND NOT ((OLD.status = 'draft' AND NEW.status = 'posted')
          OR (OLD.status = 'posted' AND NEW.status = 'void'));
  -- The vendor may change, as a name does: merging two payees moves payments
  SELECT RAISE(ABORT, 'AP-3: a posted payment cannot be changed; void it and pay again')
  WHERE OLD.status <> 'draft'
    AND (NEW.id IS NOT OLD.id OR NEW.company_id IS NOT OLD.company_id
         OR NEW.date IS NOT OLD.date
         OR NEW.account_id IS NOT OLD.account_id OR NEW.amount IS NOT OLD.amount
         OR NEW.method IS NOT OLD.method OR NEW.ref IS NOT OLD.ref OR NEW.memo IS NOT OLD.memo
         OR NEW.entry_id IS NOT OLD.entry_id OR NEW.created_at IS NOT OLD.created_at);
  SELECT RAISE(ABORT, 'AP-3: the applications must add up to the payment')
  WHERE OLD.status = 'draft' AND NEW.status = 'posted'
    AND NEW.amount IS NOT (SELECT sum(amount) FROM bill_payment_application WHERE payment_id = NEW.id);
  SELECT RAISE(ABORT, 'AP-3: a posted payment records its own posted entry, moving its amount out of the account it was paid from on its date')
  WHERE OLD.status = 'draft' AND NEW.status = 'posted'
    AND NOT EXISTS (
      SELECT 1 FROM journal_entry e
      WHERE e.id = NEW.entry_id AND e.status = 'posted' AND e.source_type = 'bill_payment'
        AND e.source_id = NEW.id AND e.date = NEW.date
        AND (SELECT sum(credit - debit) FROM journal_line
             WHERE entry_id = e.id AND account_id = NEW.account_id) = NEW.amount);
  SELECT RAISE(ABORT, 'AP-3: a payment is void only with its entry')
  WHERE OLD.status = 'posted' AND NEW.status = 'void'
    AND (SELECT status FROM journal_entry WHERE id = OLD.entry_id) IS NOT 'void';
END;

CREATE TRIGGER bill_payment_delete
BEFORE DELETE ON bill_payment
BEGIN
  SELECT RAISE(ABORT, 'AP-3: payments are kept; void one instead')
  WHERE OLD.status <> 'draft';
END;

-- A payment's entry voided in the journal voids the payment, so the bill
-- shows as owed again
CREATE TRIGGER journal_entry_void_bill_payment
AFTER UPDATE OF status ON journal_entry
WHEN OLD.status = 'posted' AND NEW.status = 'void' AND NEW.source_type = 'bill_payment'
BEGIN
  UPDATE bill_payment SET status = 'void' WHERE id = NEW.source_id AND status = 'posted';
END;

-- A payment's entry isn't changed in place or deleted: that would leave the
-- bill showing a payment the books no longer have (void the payment instead)
CREATE TRIGGER journal_entry_bill_payment_unpost
BEFORE UPDATE OF status ON journal_entry
WHEN OLD.status = 'posted' AND NEW.status = 'draft' AND OLD.source_type = 'bill_payment'
BEGIN
  SELECT RAISE(ABORT, 'AP-3: this entry is a bill payment; void the payment on its bill instead');
END;

-- ---- bills (AP-2, AP-4) ----------------------------------------------------

-- Once a payment applies, a bill's lines and vendor stay as paid
CREATE TRIGGER bill_line_insert
BEFORE INSERT ON bill_line
BEGIN
  SELECT RAISE(ABORT, 'AP-2: this bill has payments; void them before changing its lines')
  WHERE EXISTS (SELECT 1 FROM bill_paid WHERE bill_id = NEW.bill_id);
  SELECT RAISE(ABORT, 'AP-2: a void bill cannot be changed')
  WHERE (SELECT status FROM bill WHERE id = NEW.bill_id) = 'void';
END;

CREATE TRIGGER bill_line_update
BEFORE UPDATE ON bill_line
BEGIN
  SELECT RAISE(ABORT, 'AP-2: this bill has payments; void them before changing its lines')
  WHERE EXISTS (SELECT 1 FROM bill_paid WHERE bill_id IN (OLD.bill_id, NEW.bill_id));
  SELECT RAISE(ABORT, 'AP-2: a void bill cannot be changed')
  WHERE (SELECT status FROM bill WHERE id = OLD.bill_id) = 'void';
END;

CREATE TRIGGER bill_line_delete
BEFORE DELETE ON bill_line
BEGIN
  SELECT RAISE(ABORT, 'AP-2: this bill has payments; void them before changing its lines')
  WHERE EXISTS (SELECT 1 FROM bill_paid WHERE bill_id = OLD.bill_id);
  SELECT RAISE(ABORT, 'AP-2: a void bill cannot be changed')
  WHERE (SELECT status FROM bill WHERE id = OLD.bill_id) = 'void';
END;

CREATE TRIGGER bill_update
BEFORE UPDATE ON bill
BEGIN
  SELECT RAISE(ABORT, 'AP-2: a void bill cannot be changed')
  WHERE OLD.status = 'void';
  SELECT RAISE(ABORT, 'AP-4: this bill has payments; void them first')
  WHERE EXISTS (SELECT 1 FROM bill_paid WHERE bill_id = OLD.id) AND NEW.status = 'void';
  -- A paid bill's vendor changes only to its payments' vendor (a merge moves
  -- the payments first)
  SELECT RAISE(ABORT, 'AP-4: this bill has payments; void them first')
  WHERE NEW.vendor_id IS NOT OLD.vendor_id
    AND EXISTS (SELECT 1 FROM bill_payment_application a
                JOIN bill_payment p ON p.id = a.payment_id AND p.status <> 'void'
                WHERE a.bill_id = OLD.id AND p.vendor_id IS NOT NEW.vendor_id);
END;

-- A bill that a payment ever applied to stays, for the record
CREATE TRIGGER bill_delete
BEFORE DELETE ON bill
BEGIN
  SELECT RAISE(ABORT, 'AP-4: this bill has had payments; void it instead')
  WHERE EXISTS (SELECT 1 FROM bill_payment_application WHERE bill_id = OLD.id);
END;

-- ---- payees named on bills stay (GL-11) ------------------------------------

DROP TRIGGER payee_delete_unused;
CREATE TRIGGER payee_delete_unused
BEFORE DELETE ON payee
BEGIN
  SELECT RAISE(ABORT, 'GL-11: this payee is on transactions; merge it into another payee or make it inactive')
  WHERE EXISTS (SELECT 1 FROM journal_entry WHERE payee_id = OLD.id)
     OR EXISTS (SELECT 1 FROM journal_line WHERE payee_id = OLD.id)
     OR EXISTS (SELECT 1 FROM sales_doc WHERE customer_id = OLD.id)
     OR EXISTS (SELECT 1 FROM customer_payment WHERE customer_id = OLD.id)
     OR EXISTS (SELECT 1 FROM recurring_invoice WHERE customer_id = OLD.id)
     OR EXISTS (SELECT 1 FROM bill WHERE vendor_id = OLD.id)
     OR EXISTS (SELECT 1 FROM bill_payment WHERE vendor_id = OLD.id);
END;
