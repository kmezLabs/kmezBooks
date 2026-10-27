-- 0009: customers and vendors (MG-1). The QuickBooks import fills them from
-- its contact lists; sales and bills (AR, AP) use them from M7. Names are
-- unique within each list, ignoring case, as in QuickBooks.

CREATE TABLE customer (
  id               TEXT    NOT NULL PRIMARY KEY,
  company_id       TEXT    NOT NULL REFERENCES company (id),
  name             TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  contact_name     TEXT,
  email            TEXT,
  phone            TEXT,
  billing_address  TEXT,
  shipping_address TEXT,
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE UNIQUE INDEX customer_name ON customer (company_id, name COLLATE NOCASE);

CREATE TABLE vendor (
  id             TEXT    NOT NULL PRIMARY KEY,
  company_id     TEXT    NOT NULL REFERENCES company (id),
  name           TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  contact_name   TEXT,
  email          TEXT,
  phone          TEXT,
  address        TEXT,
  account_number TEXT,   -- the company's account number with this vendor
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE UNIQUE INDEX vendor_name ON vendor (company_id, name COLLATE NOCASE);
