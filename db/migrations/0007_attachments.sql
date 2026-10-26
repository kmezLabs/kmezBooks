-- 0007: attachments (GL-4, EX-2). The files themselves live encrypted in the
-- company folder's attachments/ subfolder as <id>.eba; this table records what
-- each one is and what it belongs to. Removing an attachment removes the row;
-- the encrypted file stays, so restoring an older backup never loses one.

CREATE TABLE attachment (
  id         TEXT    NOT NULL PRIMARY KEY,
  company_id TEXT    NOT NULL REFERENCES company (id),
  entity     TEXT    NOT NULL CHECK (entity GLOB '[a-z]*' AND entity NOT GLOB '*[^a-z_]*'),
  entity_id  TEXT    NOT NULL,
  file_name  TEXT    NOT NULL CHECK (length(trim(file_name)) > 0),
  mime_type  TEXT    NOT NULL,
  size       INTEGER NOT NULL CHECK (size BETWEEN 0 AND 26214400),  -- 25 MB
  sha256     TEXT    NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  added_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX attachment_entity ON attachment (entity, entity_id);
