-- Re-key staging (#555): a staging vault row points at the vault it stages for.
-- Staging vaults never get devices, never appear in admin listings, and are
-- unreachable through device routes.
ALTER TABLE vaults ADD COLUMN rekey_of TEXT REFERENCES vaults(id);
