-- 0004: feature modules switched on or off per company (CO-4).
-- The ledger, period close and reports are core and always on. Switching a
-- module off hides its screens; its tables and data stay.

CREATE TABLE company_module (
  company_id TEXT    NOT NULL REFERENCES company (id),
  module     TEXT    NOT NULL CHECK (module IN ('sales', 'bills', 'expenses', 'banking', 'migration')),
  enabled    INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  PRIMARY KEY (company_id, module)
) STRICT;

-- Companies created before this migration start with every module on
INSERT INTO company_module (company_id, module, enabled)
SELECT company.id, m.module, 1
FROM company
CROSS JOIN (SELECT 'sales' AS module UNION ALL SELECT 'bills' UNION ALL SELECT 'expenses'
            UNION ALL SELECT 'banking' UNION ALL SELECT 'migration') AS m;
