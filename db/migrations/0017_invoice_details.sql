-- 0017: what invoices and estimates show about the company (AR-8): contact
-- details, a footer (payment instructions), and a logo. The logo has its own
-- table: as a company column, every change to the company row (a closing
-- date, say) would copy the image into the audit log twice.

ALTER TABLE company ADD COLUMN email TEXT;
ALTER TABLE company ADD COLUMN phone TEXT;
ALTER TABLE company ADD COLUMN website TEXT;
-- Printed at the foot of every invoice: how to pay, thank-you notes
ALTER TABLE company ADD COLUMN invoice_footer TEXT;

CREATE TABLE company_logo (
  company_id TEXT NOT NULL PRIMARY KEY REFERENCES company (id),
  -- A PNG, made small in the browser before it's stored (at most 300 KB)
  png        BLOB NOT NULL CHECK (length(png) BETWEEN 8 AND 300000
                                  AND substr(png, 1, 8) = x'89504e470d0a1a0a'),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
