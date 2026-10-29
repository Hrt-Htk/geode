ALTER TABLE file_versions ADD COLUMN path_ciphertext BLOB;
UPDATE _meta SET value = '8' WHERE key = 'schema_version';
