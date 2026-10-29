PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE _meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO _meta(key, value) VALUES ('schema_version', '1');

CREATE TABLE vaults (
  id         TEXT PRIMARY KEY,             -- UUID v4
  name       TEXT NOT NULL,
  salt       BLOB NOT NULL,                -- 16 bytes, given to client for Argon2id
  created_at INTEGER NOT NULL
);

CREATE TABLE devices (
  id        TEXT PRIMARY KEY,              -- UUID v4
  vault_id  TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  token     TEXT NOT NULL UNIQUE,          -- 32 bytes, base64url
  last_seen INTEGER
);
CREATE INDEX idx_devices_token ON devices(token);
CREATE INDEX idx_devices_vault ON devices(vault_id);

CREATE TABLE file_versions (
  vault_id     TEXT    NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  path_hash    BLOB    NOT NULL,            -- 32 bytes, keyed-BLAKE3 of NFC path
  version      INTEGER NOT NULL,            -- monotonic per (vault, path_hash)
  seq          INTEGER NOT NULL,            -- monotonic per vault (global cursor)
  parent       INTEGER,                     -- previous version of same path, or NULL
  enc_metadata BLOB    NOT NULL,            -- encrypted JSON: { path, mtime, size, mime, plaintext_hash }
  chunk_hashes TEXT    NOT NULL,            -- JSON array of hex hashes (plaintext on server, for GC)
  deleted      INTEGER NOT NULL DEFAULT 0,
  device_id    TEXT    NOT NULL REFERENCES devices(id),
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (vault_id, path_hash, version)
);
CREATE INDEX idx_versions_seq    ON file_versions(vault_id, seq);
CREATE INDEX idx_versions_recent ON file_versions(vault_id, path_hash, version DESC);

CREATE TABLE seq_counters (
  vault_id TEXT PRIMARY KEY REFERENCES vaults(id) ON DELETE CASCADE,
  next_seq INTEGER NOT NULL DEFAULT 1
);
