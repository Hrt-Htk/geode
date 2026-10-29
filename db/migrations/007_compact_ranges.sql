ALTER TABLE file_versions ADD COLUMN compacted_range TEXT DEFAULT NULL;
UPDATE _meta SET value = '7' WHERE key = 'schema_version';
