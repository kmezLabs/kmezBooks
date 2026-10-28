-- 0016: products & services, estimates and invoices, customer payments
-- (AR-2 to AR-5, AR-7). The ledger stays cash basis (GL-8): an estimate or
-- invoice is a document and never posts. A customer payment posts one entry
-- through postEntry() (source 'invoice_payment', the payment's id), its income
-- spread over the invoices' lines by allocateProRata(); the payment and how it
-- applies to invoices are recorded here. Paid, partially paid and overdue are
-- worked out from the payments, not stored.

CREATE TABLE item (
  id                TEXT    NOT NULL PRIMARY KEY,
  company_id        TEXT    NOT NULL REFERENCES company (id),
  name              TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  description       TEXT,
  -- Price per unit in cents; optional
  rate              INTEGER CHECK (rate IS NULL OR rate BETWEEN -10000000000000 AND 10000000000000),
  income_account_id TEXT    NOT NULL REFERENCES account (id),
  active            INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE UNIQUE INDEX item_name ON item (company_id, name COLLATE NOCASE);

CREATE TABLE sales_doc (
  id           TEXT    NOT NULL PRIMARY KEY,
  company_id   TEXT    NOT NULL REFERENCES company (id),
  kind         TEXT    NOT NULL CHECK (kind IN ('estimate', 'invoice')),
  number       TEXT    NOT NULL CHECK (length(trim(number)) > 0),
  customer_id  TEXT    NOT NULL REFERENCES payee (id),
  date         TEXT    NOT NULL CHECK (date = date(date)),
  due_date     TEXT    CHECK (due_date IS NULL OR due_date = date(due_date)),
  terms_days   INTEGER CHECK (terms_days IS NULL OR terms_days BETWEEN 0 AND 365),
  -- The message to the customer, on the document
  memo         TEXT,
  status       TEXT    NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'sent', 'accepted', 'declined', 'void')),
  sent_at      TEXT,
  voided_at    TEXT,
  -- An estimate's invoice, once converted
  converted_to TEXT    REFERENCES sales_doc (id),
  -- The recurring invoice that created it (AR-9, later)
  recurring_id TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((status = 'void') = (voided_at IS NOT NULL)),
  CHECK (kind = 'estimate' OR status NOT IN ('accepted', 'declined')),
  CHECK (kind = 'estimate' OR converted_to IS NULL),
  CHECK (due_date IS NULL OR due_date >= date)
) STRICT;

CREATE UNIQUE INDEX sales_doc_number ON sales_doc (company_id, kind, number COLLATE NOCASE);
CREATE INDEX sales_doc_customer ON sales_doc (customer_id, kind);

CREATE TABLE sales_doc_line (
  id                INTEGER NOT NULL PRIMARY KEY,
  company_id        TEXT    NOT NULL REFERENCES company (id),
  doc_id            TEXT    NOT NULL REFERENCES sales_doc (id),
  line_no           INTEGER NOT NULL CHECK (line_no >= 1),
  item_id           TEXT    REFERENCES item (id),
  description       TEXT,
  -- Quantity in thousandths (2.5 is 2500) and price per unit in cents; optional
  quantity          INTEGER CHECK (quantity IS NULL OR quantity BETWEEN -1000000000000 AND 1000000000000),
  rate              INTEGER CHECK (rate IS NULL OR rate BETWEEN -10000000000000 AND 10000000000000),
  -- What the line charges; negative for a discount
  amount            INTEGER NOT NULL CHECK (amount BETWEEN -10000000000000 AND 10000000000000),
  income_account_id TEXT    NOT NULL REFERENCES account (id),
  UNIQUE (doc_id, line_no)
) STRICT;

CREATE TABLE customer_payment (
  id                 TEXT    NOT NULL PRIMARY KEY,
  company_id         TEXT    NOT NULL REFERENCES company (id),
  customer_id        TEXT    NOT NULL REFERENCES payee (id),
  date               TEXT    NOT NULL CHECK (date = date(date)),
  -- Where the money went: a bank (or cash) account
  deposit_account_id TEXT    NOT NULL REFERENCES account (id),
  amount             INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 10000000000000),
  method             TEXT,
  ref                TEXT,
  memo               TEXT,
  entry_id           INTEGER REFERENCES journal_entry (id),
  -- Written as a draft with its applications, then posted; void with its entry
  status             TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'void')),
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX customer_payment_customer ON customer_payment (customer_id);

CREATE TABLE payment_application (
  payment_id TEXT    NOT NULL REFERENCES customer_payment (id),
  doc_id     TEXT    NOT NULL REFERENCES sales_doc (id),
  company_id TEXT    NOT NULL REFERENCES company (id),
  amount     INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 10000000000000),
  PRIMARY KEY (payment_id, doc_id)
) STRICT;

CREATE INDEX payment_application_doc ON payment_application (doc_id);

-- ---- what an invoice has been paid: by payments that aren't void ----------

CREATE VIEW invoice_paid AS
SELECT a.doc_id, sum(a.amount) AS paid
FROM payment_application a
JOIN customer_payment p ON p.id = a.payment_id AND p.status <> 'void'
GROUP BY a.doc_id;

-- ---- applications (AR-7) ---------------------------------------------------

CREATE TRIGGER payment_application_insert
BEFORE INSERT ON payment_application
BEGIN
  SELECT RAISE(ABORT, 'AR-7: applications are written while the payment is a draft')
  WHERE (SELECT status FROM customer_payment WHERE id = NEW.payment_id) IS NOT 'draft';
  SELECT RAISE(ABORT, 'AR-7: a payment applies only to an invoice that isn''t void')
  WHERE (SELECT kind FROM sales_doc WHERE id = NEW.doc_id) IS NOT 'invoice'
     OR (SELECT status FROM sales_doc WHERE id = NEW.doc_id) = 'void';
  SELECT RAISE(ABORT, 'AR-7: a payment applies only to its customer''s invoices')
  WHERE (SELECT customer_id FROM sales_doc WHERE id = NEW.doc_id)
     IS NOT (SELECT customer_id FROM customer_payment WHERE id = NEW.payment_id);
  SELECT RAISE(ABORT, 'AR-7: a payment can''t exceed what is still owed on the invoice')
  WHERE coalesce((SELECT paid FROM invoice_paid WHERE doc_id = NEW.doc_id), 0) + NEW.amount
      > coalesce((SELECT sum(amount) FROM sales_doc_line WHERE doc_id = NEW.doc_id), 0);
END;

CREATE TRIGGER payment_application_update
BEFORE UPDATE ON payment_application
BEGIN
  SELECT RAISE(ABORT, 'AR-7: a payment''s applications cannot be changed; void the payment');
END;

CREATE TRIGGER payment_application_delete
BEFORE DELETE ON payment_application
BEGIN
  SELECT RAISE(ABORT, 'AR-7: a payment''s applications cannot be changed; void the payment')
  WHERE (SELECT status FROM customer_payment WHERE id = OLD.payment_id) IS NOT 'draft';
END;

-- ---- payments: draft → posted with its entry → void with it ----------------

CREATE TRIGGER customer_payment_update
BEFORE UPDATE ON customer_payment
BEGIN
  SELECT RAISE(ABORT, 'AR-7: a payment goes from draft to posted, and from posted to void')
  WHERE NEW.status IS NOT OLD.status
    AND NOT ((OLD.status = 'draft' AND NEW.status = 'posted')
          OR (OLD.status = 'posted' AND NEW.status = 'void'));
  -- The customer may change, as a name does: merging two payees moves payments
  SELECT RAISE(ABORT, 'AR-7: a posted payment cannot be changed; void it and receive it again')
  WHERE OLD.status <> 'draft'
    AND (NEW.id IS NOT OLD.id OR NEW.company_id IS NOT OLD.company_id
         OR NEW.date IS NOT OLD.date
         OR NEW.deposit_account_id IS NOT OLD.deposit_account_id OR NEW.amount IS NOT OLD.amount
         OR NEW.method IS NOT OLD.method OR NEW.ref IS NOT OLD.ref OR NEW.memo IS NOT OLD.memo
         OR NEW.entry_id IS NOT OLD.entry_id OR NEW.created_at IS NOT OLD.created_at);
  SELECT RAISE(ABORT, 'AR-7: the applications must add up to the payment')
  WHERE OLD.status = 'draft' AND NEW.status = 'posted'
    AND NEW.amount IS NOT (SELECT sum(amount) FROM payment_application WHERE payment_id = NEW.id);
  SELECT RAISE(ABORT, 'AR-7: a posted payment records its own posted entry, moving its amount into the deposit account on its date')
  WHERE OLD.status = 'draft' AND NEW.status = 'posted'
    AND NOT EXISTS (
      SELECT 1 FROM journal_entry e
      WHERE e.id = NEW.entry_id AND e.status = 'posted' AND e.source_type = 'invoice_payment'
        AND e.source_id = NEW.id AND e.date = NEW.date
        AND (SELECT sum(debit - credit) FROM journal_line
             WHERE entry_id = e.id AND account_id = NEW.deposit_account_id) = NEW.amount);
  SELECT RAISE(ABORT, 'AR-7: a payment is void only with its entry')
  WHERE OLD.status = 'posted' AND NEW.status = 'void'
    AND (SELECT status FROM journal_entry WHERE id = OLD.entry_id) IS NOT 'void';
END;

CREATE TRIGGER customer_payment_delete
BEFORE DELETE ON customer_payment
BEGIN
  SELECT RAISE(ABORT, 'AR-7: payments are kept; void one instead')
  WHERE OLD.status <> 'draft';
END;

-- A payment's entry voided in the journal voids the payment, so the invoice
-- shows as owed again
CREATE TRIGGER journal_entry_void_payment
AFTER UPDATE OF status ON journal_entry
WHEN OLD.status = 'posted' AND NEW.status = 'void' AND NEW.source_type = 'invoice_payment'
BEGIN
  UPDATE customer_payment SET status = 'void' WHERE id = NEW.source_id AND status = 'posted';
END;

-- A payment's entry isn't changed in place or deleted: that would leave the
-- invoice showing a payment the books no longer have (void the payment instead)
CREATE TRIGGER journal_entry_payment_unpost
BEFORE UPDATE OF status ON journal_entry
WHEN OLD.status = 'posted' AND NEW.status = 'draft' AND OLD.source_type = 'invoice_payment'
BEGIN
  SELECT RAISE(ABORT, 'AR-7: this entry is an invoice payment; void the payment on its invoice instead');
END;

-- ---- documents (AR-3, AR-4) ------------------------------------------------

-- Once a payment applies, an invoice's lines and customer stay as paid
CREATE TRIGGER sales_doc_line_insert
BEFORE INSERT ON sales_doc_line
BEGIN
  SELECT RAISE(ABORT, 'AR-4: this invoice has payments; void them before changing its lines')
  WHERE EXISTS (SELECT 1 FROM invoice_paid WHERE doc_id = NEW.doc_id);
  SELECT RAISE(ABORT, 'AR-4: a void document cannot be changed')
  WHERE (SELECT status FROM sales_doc WHERE id = NEW.doc_id) = 'void';
END;

CREATE TRIGGER sales_doc_line_update
BEFORE UPDATE ON sales_doc_line
BEGIN
  SELECT RAISE(ABORT, 'AR-4: this invoice has payments; void them before changing its lines')
  WHERE EXISTS (SELECT 1 FROM invoice_paid WHERE doc_id IN (OLD.doc_id, NEW.doc_id));
  SELECT RAISE(ABORT, 'AR-4: a void document cannot be changed')
  WHERE (SELECT status FROM sales_doc WHERE id = OLD.doc_id) = 'void';
END;

CREATE TRIGGER sales_doc_line_delete
BEFORE DELETE ON sales_doc_line
BEGIN
  SELECT RAISE(ABORT, 'AR-4: this invoice has payments; void them before changing its lines')
  WHERE EXISTS (SELECT 1 FROM invoice_paid WHERE doc_id = OLD.doc_id);
  SELECT RAISE(ABORT, 'AR-4: a void document cannot be changed')
  WHERE (SELECT status FROM sales_doc WHERE id = OLD.doc_id) = 'void';
END;

CREATE TRIGGER sales_doc_update
BEFORE UPDATE ON sales_doc
BEGIN
  SELECT RAISE(ABORT, 'AR-4: a document stays an estimate or an invoice')
  WHERE NEW.kind IS NOT OLD.kind;
  SELECT RAISE(ABORT, 'AR-4: a void document cannot be changed')
  WHERE OLD.status = 'void';
  SELECT RAISE(ABORT, 'AR-4: this invoice has payments; void them first')
  WHERE EXISTS (SELECT 1 FROM invoice_paid WHERE doc_id = OLD.id) AND NEW.status = 'void';
  -- A paid invoice's customer changes only to its payments' customer (a merge
  -- moves the payments first)
  SELECT RAISE(ABORT, 'AR-4: this invoice has payments; void them first')
  WHERE NEW.customer_id IS NOT OLD.customer_id
    AND EXISTS (SELECT 1 FROM payment_application a
                JOIN customer_payment p ON p.id = a.payment_id AND p.status <> 'void'
                WHERE a.doc_id = OLD.id AND p.customer_id IS NOT NEW.customer_id);
END;

-- A document that a payment ever applied to stays, for the record
CREATE TRIGGER sales_doc_delete
BEFORE DELETE ON sales_doc
BEGIN
  SELECT RAISE(ABORT, 'AR-4: this invoice has had payments; void it instead')
  WHERE EXISTS (SELECT 1 FROM payment_application WHERE doc_id = OLD.id);
  SELECT RAISE(ABORT, 'AR-3: this estimate became an invoice; it stays')
  WHERE OLD.converted_to IS NOT NULL;
END;

-- ---- payees named on documents stay (GL-11) --------------------------------

DROP TRIGGER payee_delete_unused;
CREATE TRIGGER payee_delete_unused
BEFORE DELETE ON payee
BEGIN
  SELECT RAISE(ABORT, 'GL-11: this payee is on transactions; merge it into another payee or make it inactive')
  WHERE EXISTS (SELECT 1 FROM journal_entry WHERE payee_id = OLD.id)
     OR EXISTS (SELECT 1 FROM journal_line WHERE payee_id = OLD.id)
     OR EXISTS (SELECT 1 FROM sales_doc WHERE customer_id = OLD.id)
     OR EXISTS (SELECT 1 FROM customer_payment WHERE customer_id = OLD.id);
END;

-- ---- modules: off until a company chooses them (CO-4) ----------------------

-- Sales and bills were switched on for every company at creation; no company
-- has used them yet, so they start off and each company opts in
UPDATE company_module SET enabled = 0 WHERE module IN ('sales', 'bills');
