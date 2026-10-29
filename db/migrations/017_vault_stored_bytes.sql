-- #679: per-vault stored bytes (blob files + the payload of its version and trash rows).
-- Measured for every vault at startup, then kept by the writers and re-measured by
-- compaction, so the column is never unknown to a reader.
ALTER TABLE vaults ADD COLUMN stored_bytes INTEGER NOT NULL DEFAULT 0;
UPDATE _meta SET value = '17' WHERE key = 'schema_version';
