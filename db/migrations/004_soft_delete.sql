CREATE TABLE trashed_heads (
    path_hash         TEXT PRIMARY KEY,
    vault_id          TEXT NOT NULL,
    head_json         TEXT NOT NULL,
    deleted_by_device TEXT NOT NULL,
    trashed_at        INTEGER NOT NULL
);

CREATE INDEX idx_trashed_vault ON trashed_heads(vault_id);
