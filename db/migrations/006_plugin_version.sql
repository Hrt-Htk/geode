ALTER TABLE devices ADD COLUMN plugin_version TEXT DEFAULT '';
UPDATE _meta SET value = '6' WHERE key = 'schema_version';
