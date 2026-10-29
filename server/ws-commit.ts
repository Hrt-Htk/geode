// Boundary validation for client_commit: reject malformed or oversized fields
// so they never reach insertVersion (#533). Own module so ws.ts stays a
// single-responsibility relay loop within the ≤300 LOC tripwire.
import type { ClientCommit } from "../core/protocol.ts";
import { b64decode, RENAME_MARKER, RENAME_NOTE } from "../core/protocol.ts";

const PATH_HASH_RE = /^[0-9a-f]{64}$/;
const CHUNK_HASH_RE = /^[0-9a-f]{64}$/;

// Chunker emits 64 KB to 1 MB chunks (core/chunker.ts): 10 000 bounds 640 MB+ of content.
export const MAX_CHUNK_HASHES = 10_000;
// Far past any real path.
export const MAX_ENC_METADATA_LEN = 64 * 1024;
// ~1.5x the base64 of a PATH_MAX (4 KiB) path, plus nonce and tag.
export const MAX_PATH_CIPHERTEXT_LEN = 8 * 1024;

// A rows body carries each row's chunk_hashes as a JSON string of a JSON array
// (plugin/sync/rekey-run.ts), so every quote arrives escaped: one 64-hex hash costs
// JSON.stringify's quoted length plus the two escape backslashes and a comma.
const CHUNK_HASH_WIRE_LEN = JSON.stringify("0".repeat(64)).length + 3; // 69

// A rows batch is ROW_BATCH (50, plugin/sync/rekey-run.ts) whole rows, each up to
// MAX_CHUNK_HASHES hashes plus MAX_ENC_METADATA_LEN. 64 rows leaves room for a single
// chain that outgrows a batch and travels alone.
export const MAX_REKEY_ROWS_BODY = 64 *
  (MAX_CHUNK_HASHES * CHUNK_HASH_WIRE_LEN + MAX_ENC_METADATA_LEN);

// The two payloads of a commit, which a re-key rows batch re-posts verbatim.
function payloadTooLarge(encMetadata: unknown, pathCiphertext: unknown): string | null {
  if (typeof encMetadata !== "string" || encMetadata.length > MAX_ENC_METADATA_LEN) {
    return "enc_metadata too large";
  }
  if (
    pathCiphertext != null &&
    (typeof pathCiphertext !== "string" || pathCiphertext.length > MAX_PATH_CIPHERTEXT_LEN)
  ) {
    return "path_ciphertext too large";
  }
  return null;
}

// A version row carries the payloads; a trash row carries the head it saved, serialized.
function rowPayload(row: unknown): Record<string, unknown> | null {
  if (typeof row !== "object" || row === null) return null;
  const fields = row as Record<string, unknown>;
  if (!("head_json" in fields)) return fields;
  if (typeof fields.head_json !== "string") return null;
  try {
    const head = JSON.parse(fields.head_json) as unknown;
    return typeof head === "object" && head !== null ? head as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

// A version row carries chunk_hashes as the column's own JSON string; a trash
// head_json carries the parsed array. `/heads`, blob GC and compaction all
// JSON.parse the stored value, so one unparseable or oversized list would wedge
// them for the whole vault (#680 N-9).
function chunkHashesInvalid(raw: unknown): boolean {
  let list = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      return true;
    }
  }
  return !Array.isArray(list) || list.length > MAX_CHUNK_HASHES ||
    list.some((h) => typeof h !== "string" || !CHUNK_HASH_RE.test(h));
}

/** #679: a re-key rows batch re-posts stored payloads, so it holds the same caps. */
export function validateRekeyBatch(versions: unknown, trash: unknown): string | null {
  if (!Array.isArray(versions) || !Array.isArray(trash)) {
    return "versions and trash must be arrays";
  }
  for (const item of [...versions, ...trash]) {
    const fields = rowPayload((item as { row?: unknown } | null)?.row);
    if (fields === null) return "invalid row";
    const invalid = payloadTooLarge(fields.enc_metadata, fields.path_ciphertext);
    if (invalid) return invalid;
    if (chunkHashesInvalid(fields.chunk_hashes)) return "invalid chunk_hashes";
  }
  return null;
}

// #583: absent means 0 (a pre-marker client). A marker closes a delete and a
// note opens a create; any other pairing is malformed.
function validateRenameMark(msg: ClientCommit): string | null {
  const mark = msg.rename_mark ?? 0;
  if (mark === 0) return null;
  if (mark !== RENAME_MARKER && mark !== RENAME_NOTE) return "invalid rename_mark";
  if (mark === RENAME_MARKER) return msg.deleted ? null : "rename_mark 1 requires deleted";
  return msg.deleted ? "rename_mark 2 requires a create" : null;
}

export function validateCommit(msg: ClientCommit): string | null {
  if (typeof msg.path_hash !== "string" || !PATH_HASH_RE.test(msg.path_hash)) {
    return "invalid path_hash";
  }
  if (
    typeof msg.parent_version !== "number" ||
    !Number.isInteger(msg.parent_version) ||
    msg.parent_version < 0
  ) {
    return "invalid parent_version";
  }
  if (typeof msg.deleted !== "boolean") return "invalid deleted";
  const oversized = payloadTooLarge(msg.enc_metadata, msg.path_ciphertext);
  if (oversized) return oversized;
  if (!Array.isArray(msg.chunk_hashes)) return "invalid chunk_hashes";
  if (msg.chunk_hashes.length > MAX_CHUNK_HASHES) return "too many chunk_hashes";
  if (msg.chunk_hashes.some((h) => typeof h !== "string" || !CHUNK_HASH_RE.test(h))) {
    return "invalid chunk_hashes";
  }
  return validateRenameMark(msg);
}

// Decode the two base64 payload fields. Distinct error codes per field, so the
// caller can surface exactly which field was malformed without leaking the other.
type DecodedCommit = { encMetadata: Uint8Array; pathCiphertext: Uint8Array | null };
type DecodeError = { code: "bad_metadata" | "bad_path_ciphertext"; message: string };

export function decodeCommitBase64(
  msg: ClientCommit,
): DecodedCommit | DecodeError {
  let encMetadata: Uint8Array;
  try {
    encMetadata = b64decode(msg.enc_metadata);
  } catch {
    return { code: "bad_metadata", message: "enc_metadata not base64" };
  }
  let pathCiphertext: Uint8Array | null = null;
  if (msg.path_ciphertext) {
    try {
      pathCiphertext = b64decode(msg.path_ciphertext);
    } catch {
      return { code: "bad_path_ciphertext", message: "path_ciphertext not base64" };
    }
  }
  return { encMetadata, pathCiphertext };
}
