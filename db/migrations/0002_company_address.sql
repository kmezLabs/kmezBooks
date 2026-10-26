-- 0002: company address (CO-1). US addresses only; all optional.

ALTER TABLE company ADD COLUMN address_line1 TEXT;
ALTER TABLE company ADD COLUMN address_line2 TEXT;
ALTER TABLE company ADD COLUMN city TEXT;
ALTER TABLE company ADD COLUMN state TEXT
  CHECK (state IS NULL OR state GLOB '[A-Z][A-Z]');
ALTER TABLE company ADD COLUMN postal_code TEXT
  CHECK (postal_code IS NULL
         OR postal_code GLOB '[0-9][0-9][0-9][0-9][0-9]'
         OR postal_code GLOB '[0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]');
