import { httpBase, request } from "./provisioning-client.ts";
import { HttpClient } from "../sync/http-client.ts";
import { b64decode } from "../../core/protocol.ts";
import { decryptMetadata, decryptPath, VaultKeys } from "../../core/crypto.ts";
import { reassemble } from "../../core/reassemble.ts";

export interface TrashEntry {
  path_hash: string;
  trashed_at: number;
  deleted_by_device: string;
  path_ciphertext?: string;
  // #455: additive server fields: encrypted FileMeta (base64); the client
  // decrypts size/mime locally. Present only when the server supports it.
  enc_metadata?: string;
  // #583: additive: the trashed head's version, the ceiling of the trash row's
  // History action. Present only when the server supports it.
  version?: number;
  path?: string;
  size?: number;
  mime?: string;
}

export async function listTrash(
  serverUrl: string,
  vaultId: string,
  deviceToken: string,
): Promise<{ entries: TrashEntry[]; serverRetentionDays: number | null }> {
  const url = `${httpBase(serverUrl)}/vaults/${vaultId}/trash`;
  const body = (await request(url, "GET", deviceToken)) as {
    trash?: TrashEntry[];
    retention_days?: number;
  };
  return {
    entries: body.trash ?? [],
    serverRetentionDays: typeof body.retention_days === "number" ? body.retention_days : null,
  };
}

async function fetchTrashContent(
  serverUrl: string,
  vaultId: string,
  deviceToken: string,
  pathHash: string,
): Promise<{ chunk_hashes: string[]; enc_metadata: string }> {
  const url = `${httpBase(serverUrl)}/vaults/${vaultId}/trash/${
    encodeURIComponent(pathHash)
  }/content`;
  return (await request(url, "GET", deviceToken)) as {
    chunk_hashes: string[];
    enc_metadata: string;
  };
}

export async function restoreTrashOne(
  serverUrl: string,
  vaultId: string,
  deviceToken: string,
  pathHash: string,
): Promise<void> {
  const url = `${httpBase(serverUrl)}/vaults/${vaultId}/trash/${
    encodeURIComponent(pathHash)
  }/restore`;
  await request(url, "POST", deviceToken);
}

export async function restoreTrashAll(
  serverUrl: string,
  vaultId: string,
  deviceToken: string,
): Promise<{ restored: number; skipped: number }> {
  const url = `${httpBase(serverUrl)}/vaults/${vaultId}/trash/restore-all`;
  return (await request(url, "POST", deviceToken)) as { restored: number; skipped: number };
}

/** #582: one name of a file's chain: the versions this file owns at it. */
export type TrashChainEntry = { path_hash: string; up_to: number };

/** #677: `token` is the device token, or the admin token for a purge inside the
 * server's retention floor (the server refuses a device token there). */
export async function purgeTrashOne(
  serverUrl: string,
  vaultId: string,
  token: string,
  pathHash: string,
  chain: TrashChainEntry[],
): Promise<{ versions: number }> {
  const url = `${httpBase(serverUrl)}/vaults/${vaultId}/trash/${
    encodeURIComponent(pathHash)
  }/purge`;
  return (await request(url, "POST", token, { chain })) as { versions: number };
}

export async function purgeExpiredTrash(
  serverUrl: string,
  vaultId: string,
  deviceToken: string,
  retentionDays: number,
): Promise<{ purged: number }> {
  const url = `${httpBase(serverUrl)}/vaults/${vaultId}/trash/purge-expired`;
  return (await request(url, "POST", deviceToken, {
    retention_days: retentionDays,
  })) as { purged: number };
}

export interface TrashSettingsLike {
  serverUrl: string;
  vaultId: string;
  deviceToken: string;
  trashRetentionDays: number;
}

/** Decrypt per-entry size/mime and path for display; failures leave fields undefined. */
async function annotateEntries(entries: TrashEntry[], keys: VaultKeys): Promise<void> {
  for (const entry of entries) {
    if (entry.enc_metadata) {
      try {
        const meta = await decryptMetadata(b64decode(entry.enc_metadata), keys, entry.path_hash);
        entry.size = meta.size;
        entry.mime = meta.mime;
      } catch {
        // leave size/mime undefined on decryption failure
      }
    }
    if (entry.path_ciphertext) {
      try {
        entry.path = await decryptPath(b64decode(entry.path_ciphertext), keys, entry.path_hash);
      } catch {
        // leave path undefined on decryption failure
      }
    }
  }
}

export function makeTrashApi(
  getSettings: () => TrashSettingsLike,
  getKeys: () => VaultKeys | null,
) {
  let contentFetches = 0;
  // The server's retention floor (from the last list response). The server
  // purges at max(its floor, the client setting), so the UI must display that
  // effective cutoff, not the raw setting (#532).
  let serverRetentionDays: number | null = null;
  return {
    /** The effective retention the server actually purges at. */
    retentionDays: () => Math.max(s().trashRetentionDays, serverRetentionDays ?? 0),
    /** #677: the server's own floor, from the last list response: a purge inside it
     * needs the admin token. Null until a list has answered. */
    serverFloor: (): number | null => serverRetentionDays,
    list: async () => {
      const { entries, serverRetentionDays: serverFloor } = await listTrash(
        s().serverUrl,
        s().vaultId,
        s().deviceToken,
      );
      serverRetentionDays = serverFloor;
      const keys = getKeys();
      if (keys) await annotateEntries(entries, keys);
      return entries;
    },
    /** #455: the deleted file's decrypted content + meta, fetched from its blobs. */
    preview: async (pathHash: string) => {
      contentFetches++;
      const cfg = s();
      const keys = getKeys();
      if (!keys) throw new Error("vault locked");
      const { chunk_hashes, enc_metadata } = await fetchTrashContent(
        cfg.serverUrl,
        cfg.vaultId,
        cfg.deviceToken,
        pathHash,
      );
      const meta = await decryptMetadata(b64decode(enc_metadata), keys, pathHash);
      const http = new HttpClient(cfg.serverUrl, cfg.vaultId, cfg.deviceToken);
      const bytes = await reassemble(
        chunk_hashes,
        keys,
        (h) => http.getBlob(h),
        meta.plaintext_hash,
      );
      return { bytes, size: meta.size, mime: meta.mime, path: meta.path };
    },
    /** E2E seam: content fetches so a test can assert a preview never fetched. */
    contentFetchCount: () => contentFetches,
    restore: (h: string) => restoreTrashOne(s().serverUrl, s().vaultId, s().deviceToken, h),
    restoreAll: () => restoreTrashAll(s().serverUrl, s().vaultId, s().deviceToken),
    purge: (h: string, chain: TrashChainEntry[], adminToken?: string) =>
      purgeTrashOne(
        s().serverUrl,
        s().vaultId,
        adminToken ?? s().deviceToken,
        h,
        chain,
      ),
    purgeExpired: () =>
      purgeExpiredTrash(
        s().serverUrl,
        s().vaultId,
        s().deviceToken,
        Math.max(s().trashRetentionDays, serverRetentionDays ?? 0),
      ),
  };
  function s() {
    return getSettings();
  }
}

export type TrashApi = ReturnType<typeof makeTrashApi>;
