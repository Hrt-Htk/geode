ALTER TABLE vaults ADD COLUMN argon2_ops INTEGER;
ALTER TABLE vaults ADD COLUMN argon2_mem INTEGER;
UPDATE _meta SET value = '9' WHERE key = 'schema_version';
