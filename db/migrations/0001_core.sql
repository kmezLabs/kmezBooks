-- 0001 core: the company row (CO-1).
-- One company per database file (CO-3). Every table is STRICT, so a column
-- declared INTEGER (such as money in cents) can never hold a float or text.

CREATE TABLE company (
  id                      TEXT    NOT NULL PRIMARY KEY,  -- UUID; the company_id on every other table
  legal_name              TEXT    NOT NULL CHECK (length(trim(legal_name)) > 0),
  ein                     TEXT             CHECK (ein IS NULL OR ein GLOB '[0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  fiscal_year_start_month INTEGER NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  created_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TRIGGER company_single_row
BEFORE INSERT ON company
WHEN (SELECT count(*) FROM company) > 0
BEGIN
  SELECT RAISE(ABORT, 'CO-3: a company file holds exactly one company');
END;

CREATE TRIGGER company_id_immutable
BEFORE UPDATE OF id ON company
BEGIN
  SELECT RAISE(ABORT, 'CO-3: a company''s id never changes');
END;

CREATE TRIGGER company_no_delete
BEFORE DELETE ON company
BEGIN
  SELECT RAISE(ABORT, 'CO-3: the company row cannot be deleted');
END;
