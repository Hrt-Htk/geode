-- Re-key session auth (#556): key-derived auth secret (stored as hash) and the
-- active re-key mode. auth_hash is set once (TOFU); rekey_mode blocks sync
-- while a re-key session is open.
ALTER TABLE vaults ADD COLUMN auth_hash TEXT;
ALTER TABLE vaults ADD COLUMN rekey_mode TEXT;
