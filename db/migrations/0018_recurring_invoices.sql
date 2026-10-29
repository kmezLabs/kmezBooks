-- 0018: recurring invoices (AR-9).
--
-- A template (monthly tuition, say) creates an ordinary invoice on each due
-- date, when the company is next opened: nothing runs while the app is
-- closed. The invoice is a draft document, ready to check and send; nothing
-- posts (cash basis, GL-8). Each invoice made is recorded as a run, one per
-- template and date, so the same date never creates twice, even if the
-- invoice is later voided or deleted.

CREATE TABLE recurring_invoice (
  id           TEXT    NOT NULL PRIMARY KEY,
  company_id   TEXT    NOT NULL REFERENCES company (id),
  name         TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  customer_id  TEXT    NOT NULL REFERENCES payee (id),
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  frequency    TEXT    NOT NULL CHECK (frequency IN ('monthly', 'quarterly', 'yearly')),
  -- 1 to 31; a day past the month's end means its last day
  day_of_month INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
  start_date   TEXT    NOT NULL CHECK (start_date = date(start_date)),
  end_date     TEXT    CHECK (end_date IS NULL OR end_date = date(end_date)),
  -- The next date to create; null once past the end date
  next_date    TEXT    CHECK (next_date IS NULL OR next_date = date(next_date)),
  -- Each invoice is due this many days after its date; null is due on receipt
  terms_days   INTEGER CHECK (terms_days IS NULL OR terms_days BETWEEN 0 AND 365),
  -- The message to the customer on each invoice
  memo         TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (end_date IS NULL OR end_date >= start_date)
) STRICT;

CREATE INDEX recurring_invoice_customer ON recurring_invoice (customer_id);

CREATE TABLE recurring_invoice_line (
  id                INTEGER NOT NULL PRIMARY KEY,
  company_id        TEXT    NOT NULL REFERENCES company (id),
  recurring_id      TEXT    NOT NULL REFERENCES recurring_invoice (id),
  line_no           INTEGER NOT NULL CHECK (line_no >= 1),
  item_id           TEXT    REFERENCES item (id),
  description       TEXT,
  -- As invoice lines: quantity in thousandths, rate and amount in cents
  quantity          INTEGER CHECK (quantity IS NULL OR quantity BETWEEN -1000000000000 AND 1000000000000),
  rate              INTEGER CHECK (rate IS NULL OR rate BETWEEN -10000000000000 AND 10000000000000),
  amount            INTEGER NOT NULL CHECK (amount BETWEEN -10000000000000 AND 10000000000000),
  income_account_id TEXT    NOT NULL REFERENCES account (id),
  UNIQUE (recurring_id, line_no)
) STRICT;

CREATE TABLE recurring_invoice_run (
  recurring_id TEXT    NOT NULL REFERENCES recurring_invoice (id),
  date         TEXT    NOT NULL CHECK (date = date(date)),
  company_id   TEXT    NOT NULL REFERENCES company (id),
  -- Null once the invoice is deleted; the date still counts as made
  doc_id       TEXT    REFERENCES sales_doc (id) ON DELETE SET NULL,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (recurring_id, date)
) STRICT;

CREATE INDEX recurring_invoice_run_doc ON recurring_invoice_run (doc_id);

-- A run is the template's own invoice on that date
CREATE TRIGGER recurring_invoice_run_insert
BEFORE INSERT ON recurring_invoice_run
BEGIN
  SELECT RAISE(ABORT, 'AR-9: a recurring run must record that template''s invoice for that date')
  WHERE NOT EXISTS (SELECT 1 FROM sales_doc d
                    WHERE d.id = NEW.doc_id AND d.kind = 'invoice'
                      AND d.recurring_id = NEW.recurring_id AND d.date = NEW.date);
END;

-- Runs are history: only the link to a deleted invoice may go
CREATE TRIGGER recurring_invoice_run_update
BEFORE UPDATE ON recurring_invoice_run
BEGIN
  SELECT RAISE(ABORT, 'AR-9: recurring runs cannot be changed')
  WHERE NEW.recurring_id IS NOT OLD.recurring_id OR NEW.date IS NOT OLD.date
     OR NEW.company_id IS NOT OLD.company_id OR NEW.created_at IS NOT OLD.created_at
     OR (NEW.doc_id IS NOT OLD.doc_id AND NEW.doc_id IS NOT NULL);
END;

CREATE TRIGGER recurring_invoice_run_delete
BEFORE DELETE ON recurring_invoice_run
BEGIN
  SELECT RAISE(ABORT, 'AR-9: recurring runs cannot be deleted');
END;

-- A template that has made invoices stays, for its history; make it inactive instead
CREATE TRIGGER recurring_invoice_delete
BEFORE DELETE ON recurring_invoice
BEGIN
  SELECT RAISE(ABORT, 'AR-9: this recurring invoice has made invoices; make it inactive instead')
  WHERE EXISTS (SELECT 1 FROM recurring_invoice_run WHERE recurring_id = OLD.id);
END;

-- ---- payees named on recurring invoices stay (GL-11) -----------------------

DROP TRIGGER payee_delete_unused;
CREATE TRIGGER payee_delete_unused
BEFORE DELETE ON payee
BEGIN
  SELECT RAISE(ABORT, 'GL-11: this payee is on transactions; merge it into another payee or make it inactive')
  WHERE EXISTS (SELECT 1 FROM journal_entry WHERE payee_id = OLD.id)
     OR EXISTS (SELECT 1 FROM journal_line WHERE payee_id = OLD.id)
     OR EXISTS (SELECT 1 FROM sales_doc WHERE customer_id = OLD.id)
     OR EXISTS (SELECT 1 FROM customer_payment WHERE customer_id = OLD.id)
     OR EXISTS (SELECT 1 FROM recurring_invoice WHERE customer_id = OLD.id);
END;
