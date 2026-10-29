CREATE TABLE pairing_codes (
  code_hash  TEXT    PRIMARY KEY,
  vault_id   TEXT    NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_pairing_vault ON pairing_codes(vault_id);
