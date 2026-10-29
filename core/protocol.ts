// Wire protocol types and the shared base64 codec. Server and client both import this.

// #559: 4: the re-key surface. An old plugin must not write old-key data
// into a re-keyed vault, so the bump ships with the re-key modal.
// #583: 5: a rename marker on a version row. Server-visible, so it is a wire
// change; the bump ships plugin + server from the same tag.
// #687: 6: a `restored` mark on a version row (a trash restore credited to the
// device that asked for it). An older plugin skips its own versions, so it would
// silently lose its own restore: the bump blocks it with an update prompt instead.
export const PROTOCOL_VERSION = 6;

/** #625: a hard refusal (protocol or minimum plugin version) ends its close reason with this marker. */
export const UPDATE_REQUIRED = "update required";

/** #583: the old path's closing version (`deleted: true` + this mark): a rename link, never a trash entry. */
export const RENAME_MARKER = 1;
/** #583: the new path's first version (`deleted: false` + this mark): the only link a history walk follows. */
export const RENAME_NOTE = 2;

// Client → Server
export interface ClientHello {
  type: "client_hello";
  protocol_version: number;
  device_id: string;
  last_seen_seq: number;
  plugin_version?: string;
}

export interface ClientProgress {
  type: "client_progress";
  applied_seq: number; // additive: this device's applied position after a catch-up (#433)
}

export interface ClientCommit {
  type: "client_commit";
  vault_id: string;
  path_hash: string; // hex BLAKE3 of NFC path
  parent_version: number;
  enc_metadata: string; // base64
  chunk_hashes: string[]; // hex BLAKE3 hashes of PLAINTEXT chunks (blob IDs; unkeyed, dedup-addressed)
  deleted: boolean;
  path_ciphertext?: string; // base64, encrypted with vault content_key (additive)
  /** #583: additive: RENAME_MARKER | RENAME_NOTE; absent = 0 (a plain commit). */
  rename_mark?: number;
}

// Server → Client
export interface ServerHelloAck {
  type: "server_hello_ack";
  vault_id: string;
  vault_name: string;
  seq: number;
  server_version: string;
  rekey?: boolean; // additive (#556): a re-key session is in progress, pause sync
  verifier_hash?: string; // additive (#560): blake3 of the vault's current verifier
}

export interface ServerVersion {
  type: "server_version";
  vault_id: string;
  seq: number;
  path_hash: string;
  parent_version: number;
  enc_metadata: string; // base64
  chunk_hashes: string[];
  deleted: boolean;
  device_id: string;
  version: number;
  path_ciphertext?: string; // base64, encrypted with vault content_key (additive)
  /** #583: additive: RENAME_MARKER | RENAME_NOTE; 0 for an ordinary version. */
  rename_mark?: number;
  /** #687: additive: restored from the trash. A device applies its own version only
   * when this is set; absent = an ordinary version. */
  restored?: boolean;
}

export function b64encode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function b64decode(s: string): Uint8Array {
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export interface ServerCommitAck {
  type: "server_commit_ack";
  seq: number;
  version: number;
}

export interface ServerConflict {
  type: "server_conflict";
  vault_id: string;
  path_hash: string;
  parent_version: number;
  reason: string;
}

export interface ServerError {
  type: "server_error";
  code: string;
  message: string;
}

export interface ServerVersionMismatch {
  type: "server_version_mismatch";
  server_version: string;
  client_version: string;
}

export type ServerMessage =
  | ServerHelloAck
  | ServerVersion
  | ServerCommitAck
  | ServerConflict
  | ServerError
  | ServerVersionMismatch;

export type ClientMessage = ClientHello | ClientCommit | ClientProgress;

// File metadata (encrypted in transit, stored on server)
export type FileMeta = {
  path: string;
  mtime: number;
  size: number;
  mime: string;
  plaintext_hash: string;
  // #583: additive, encrypted: the rename link the history walk follows. The
  // server never sees these (only the row's `rename_mark`).
  renamed_to?: string;
  renamed_from?: string;
  renamed_from_version?: number;
};

// HTTP route payloads (server emits, plugin parses). Must match server/routes.ts.
// /vaults/:id/heads NDJSON line.
export interface HeadRecord {
  path_hash: string;
  version: number;
  seq: number;
  enc_metadata: string; // base64
  chunk_hashes: string[];
  deleted: boolean;
  path_ciphertext: string | null; // base64, or null when absent
  /** #583: additive: a heads-based apply must see a marker, not a plain delete. */
  rename_mark: number;
}

// /vaults/:id/versions/:pathHash JSON array element.
export interface VersionRecord {
  version: number;
  parent: number | null;
  /** #557: additive: the re-key row rewrite needs the row's own path hash. */
  path_hash: string;
  chunk_hashes: string[];
  enc_metadata: string; // base64
  compacted_range: string | null;
  path_ciphertext: string | null; // base64, or null when absent
  /** device that committed this version (added #432 for conflict attribution). */
  device_id: string;
  /** #557: additive: re-key row rewrite needs the row's seq/created_at/deleted. */
  seq: number;
  created_at: number;
  deleted: number;
  /** #583: additive: RENAME_MARKER | RENAME_NOTE; 0 for an ordinary version. */
  rename_mark: number;
  /** #687: additive: restored from the trash; absent = an ordinary version. */
  restored?: boolean;
}

// /heads omits parent_version & device_id; heads-derived consumers read only
// version/chunk_hashes/enc_metadata/deleted, so leave them unset. It omits `restored`
// for the same reason: with no device_id a catch-up is never an own version, so the
// own-version skip `restored` overrides cannot fire there.
export function headToServerVersion(head: HeadRecord, vaultId: string): ServerVersion {
  return {
    type: "server_version",
    vault_id: vaultId,
    seq: head.seq,
    path_hash: head.path_hash,
    enc_metadata: head.enc_metadata,
    chunk_hashes: head.chunk_hashes,
    deleted: head.deleted,
    version: head.version,
    rename_mark: head.rename_mark,
  } as ServerVersion;
}
