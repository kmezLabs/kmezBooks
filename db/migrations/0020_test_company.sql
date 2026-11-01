-- 0020: test companies (CO-7). A company can be created as a test company,
-- for trying things out. Its name shows "– Test", and only a test company
-- has the Development pages (the M1 technical test, which fills the company
-- with made-up history). It is set when the company is created and the app
-- never changes it; companies made before this are real companies.

ALTER TABLE company ADD COLUMN test INTEGER NOT NULL DEFAULT 0
  CHECK (test IN (0, 1));
