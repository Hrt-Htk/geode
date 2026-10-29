ALTER TABLE devices ADD COLUMN applied_seq INTEGER;
UPDATE _meta SET value = '12' WHERE key = 'schema_version';
