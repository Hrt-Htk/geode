import { assertEquals } from "@std/assert";
import { hashPathHex } from "../../../core/hash.ts";
import {
  b64encode,
  type HeadRecord,
  RENAME_MARKER,
  type VersionRecord,
} from "../../../core/protocol.ts";
import { deriveKeys, encryptMetadata, type VaultKeys } from "../../../core/crypto.ts";
import { ConflictHandler } from "../../../plugin/sync/conflict-handler.ts";
import { openStateDB } from "../../../plugin/plumbing/state.ts";
import { FakeVault } from "../../two-vault-driver.ts";

// #583: two names whose markers point at each other (A renamed to B, B renamed
// back to A) and a device that is carrying an edit between them: resolving A walks
// into B, which walks back into A while A's resolution is still in flight. Queueing
// that second A behind the first deadlocks both: it must be skipped instead.

const FROM = "n1.md";
const TO = "n2.md";

async function markerMeta(
  keys: VaultKeys,
  path: string,
  to: string,
  pathHash: string,
): Promise<string> {
  const meta = { path, renamed_to: to, mtime: 1, size: 0, mime: "", plaintext_hash: "" };
  return b64encode(await encryptMetadata(meta, keys, pathHash));
}

function head(
  pathHash: string,
  version: number,
  encMetadata: string,
  deleted: boolean,
  renameMark = 0,
): HeadRecord {
  return {
    path_hash: pathHash,
    version,
    seq: version,
    enc_metadata: encMetadata,
    chunk_hashes: [],
    deleted,
    path_ciphertext: null,
    rename_mark: renameMark,
  };
}

function chainRecord(h: HeadRecord, deviceId: string): VersionRecord {
  return {
    version: h.version,
    parent: h.version - 1,
    path_hash: h.path_hash,
    chunk_hashes: h.chunk_hashes,
    enc_metadata: h.enc_metadata,
    compacted_range: null,
    path_ciphertext: null,
    device_id: deviceId,
    seq: h.seq,
    created_at: 1,
    deleted: h.deleted ? 1 : 0,
  } as VersionRecord;
}

Deno.test({
  name: "conflict-handler-rename-cycle - a marker cycle between two names does not self-wait",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const keys = await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
    const state = openStateDB();
    const vault = new FakeVault();
    vault.write(FROM, "edit made while the rename was pending");
    const fromHash = hashPathHex(keys.mac_key, FROM);
    const toHash = hashPathHex(keys.mac_key, TO);

    // The name this device is being walked off is re-created on the server (live v8),
    // so the destination is free and the carry walks straight back into the first name.
    const live = head(
      fromHash,
      8,
      await markerMeta(keys, FROM, FROM, fromHash),
      false,
    );
    const toMarker = head(
      toHash,
      6,
      await markerMeta(keys, TO, FROM, toHash),
      true,
      RENAME_MARKER,
    );
    const fromMarker = head(
      fromHash,
      5,
      await markerMeta(keys, FROM, TO, fromHash),
      true,
      RENAME_MARKER,
    );
    const heads = [live, toMarker];
    const transport = {
      async *getHeads() {
        for (const h of heads) yield h;
      },
      getVersionChain(pathHash: string) {
        return heads.filter((h) => h.path_hash === pathHash).map((h) =>
          chainRecord(h, "device-other")
        );
      },
      getBlob: () => new Uint8Array(),
    };
    const handler = new ConflictHandler({
      vault: vault as never,
      vaultId: "v",
      transport: transport as never,
      getState: () => state,
      getKeys: () => keys,
      getDeviceName: () => "device-self",
      deviceId: "device-self",
      suppressSelfWrite: () => {},
      pendingRenameTarget: () => undefined,
      onStatusUpdate: () => {},
      // The marker for the first name is what the apply path already resolved.
      versionCache: new Map([[`${fromHash}:5`, {
        ...fromMarker,
        type: "server_version",
        vault_id: "v",
      }]]),
      localEditPaths: new Set(),
      files: () => [],
    });

    const resolving = handler.handleConflict(FROM, { path_hash: fromHash, version: 5 });
    const hang = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("resolution self-waited on its own path")), 5_000)
    );
    await Promise.race([resolving, hang]);

    assertEquals(vault.fileExists(FROM) || vault.fileExists(TO), true, "the edit is still on disk");
    state.close();
  },
});
