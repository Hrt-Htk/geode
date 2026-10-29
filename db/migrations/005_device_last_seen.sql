ALTER TABLE devices ADD COLUMN last_seen_at INTEGER DEFAULT 0;
UPDATE _meta SET value = '5' WHERE key = 'schema_version';
