ALTER TABLE devices DROP COLUMN last_seen;
UPDATE _meta SET value = '10' WHERE key = 'schema_version';
