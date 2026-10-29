// Shared types and helpers for ws.ts: extracted to keep ws.ts under 300 LOC.
import type { ServerVersion } from "../core/protocol.ts";
import { b64encode } from "../core/protocol.ts";
import type { VersionRow } from "./db.ts";

export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024; // 8 MiB: hard cap for dead-client memory guard
export const REPLAY_PACE_HWM = 1 * 1024 * 1024; // 1 MiB: high-water mark to pace replay
export const MAX_QUEUE_MESSAGES = 1000; // receive queue cap: messages (#533)
export const MAX_QUEUE_BYTES = 8 * 1024 * 1024; // receive queue cap: bytes, mirrors MAX_BUFFERED_BYTES

export interface HubConnection {
  ws: WebSocket;
  deviceId: string;
}

export function rowToVersion(row: VersionRow, vaultId: string): ServerVersion {
  const meta = row.enc_metadata;
  const metaB64 = typeof meta === "string" ? meta : b64encode(meta as unknown as Uint8Array);
  const msg: ServerVersion = {
    type: "server_version",
    vault_id: vaultId,
    seq: row.seq,
    path_hash: row.path_hash,
    parent_version: row.parent ?? 0,
    enc_metadata: metaB64,
    chunk_hashes: JSON.parse(row.chunk_hashes) as string[],
    deleted: row.deleted === 1,
    device_id: row.device_id,
    version: row.version,
    rename_mark: row.rename_mark,
  };
  if (row.restored === 1) msg.restored = true;
  if (row.path_ciphertext) {
    msg.path_ciphertext = b64encode(row.path_ciphertext as unknown as Uint8Array);
  }
  return msg;
}
