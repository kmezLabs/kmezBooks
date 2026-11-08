-- 0022: the company's theme (CO-11), its colours while it is open. NULL follows
-- the computer's light or dark setting. The ids are checked by the app
-- (src/shared/themes.ts), so a new theme needs no migration.

ALTER TABLE company ADD COLUMN theme TEXT
  CHECK (theme IS NULL OR length(theme) BETWEEN 1 AND 40);
