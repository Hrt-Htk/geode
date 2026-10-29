import { assertEquals, assertRejects } from "@std/assert";
import { openStateDB } from "../../../plugin/plumbing/state.ts";
import { type ApplyDeps, applyVersion } from "../../../plugin/sync/apply.ts";
import { b64encode, type ServerVersion } from "../../../core/protocol.ts";
import { deriveKeys, encryptChunk, encryptMetadata, type VaultKeys } from "../../../core/crypto.ts";
import { blake3Hex, hashPathHex } from "../../../core/hash.ts";
import { FakeVault } from "../../two-vault-driver.ts";

/**
 * #212 regression: the persisted cursor must not advance past a seq whose apply
 * failed. With the old "persist on receipt" behavior the cursor ran ahead of the
 * async apply, so a transient failure (blob fetch / decrypt / write) permanently
 * orphaned that version: no reconnect ever replayed it.
 *
 * Here we wire the cursor sink EXACTLY like plugin/main.ts (sink -> advanceSyncCursor),
 * drive a 3-version stream where the middle seq's getBlob throws, and assert:
 *   - the cursor stays at failed-1
 *   - a later seq applying does not leap the cursor
 *   - after a simulated reconnect the failed version is re-delivered and applies,
 *     flushing the cursor to the top of the contiguous run.
 */

async function makeVersion(
  path: string,
  content: string,
  seq: number,
  version: number,
  deviceId: string,
  keys: VaultKeys,
): Promise<{ msg: ServerVersion; blob: Uint8Array }> {
  const normalized = new TextEncoder().encode(content);
  const plaintextHash = blake3Hex(normalized);
  const chunkHash = blake3Hex(normalized); // single chunk for small content
  const blob = await encryptChunk(normalized, keys, chunkHash);
  const pathHash = hashPathHex(keys.mac_key, path);
  const encMeta = await encryptMetadata(
    {
      path,
      mtime: 1,
      size: normalized.length,
      mime: "text/markdown",
      plaintext_hash: plaintextHash,
    },
    keys,
    pathHash,
  );
  return {
    msg: {
      type: "server_version",
      vault_id: "test-vault",
      seq,
      path_hash: pathHash,
      parent_version: version - 1,
      enc_metadata: b64encode(encMeta),
      chunk_hashes: [chunkHash],
      deleted: false,
      device_id: deviceId,
      version,
    },
    blob,
  };
}

Deno.test({
  name: "cursor-durable-apply - failed apply does not advance cursor; reconnect replays it",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const keys = await deriveKeys(
      "test",
      crypto.getRandomValues(new Uint8Array(16)),
      { opsLimit: 1, memLimit: 8192 },
    );
    const state = openStateDB();
    const vault = new FakeVault();

    const myDeviceId = "device-a";
    const peer = "device-b";
    const v1 = await makeVersion("a.md", "content a", 1, 1, peer, keys);
    const v2 = await makeVersion("b.md", "content b", 2, 1, peer, keys);
    const v3 = await makeVersion("c.md", "content c", 3, 1, peer, keys);

    const blobs = new Map<string, Uint8Array>([
      [v1.msg.chunk_hashes[0], v1.blob],
      [v2.msg.chunk_hashes[0], v2.blob],
      [v3.msg.chunk_hashes[0], v3.blob],
    ]);

    // Production wiring: the transport sink routes into advanceSyncCursor (main.ts).
    const makeDeps = (failHash: string | null): ApplyDeps => ({
      pendingRenameTarget: () => undefined,
      vault: vault as unknown as ApplyDeps["vault"],
      state,
      keys,
      getBlob: (h: string) => {
        if (failHash && h === failHash) {
          return Promise.reject(new Error(`blob GET ${h}: transient`));
        }
        const b = blobs.get(h);
        if (!b) return Promise.reject(new Error(`blob GET ${h}: not found`));
        return Promise.resolve(b);
      },
      hasLocalEdits: () => false,
      onConflict: () => {},
      markLocalEdit: () => {},
      myDeviceId,
      suppressSelfWrite: () => {},
    });

    // Phase 1: transient blob failure on seq 2's chunk.
    const deps = makeDeps(v2.msg.chunk_hashes[0]);

    await applyVersion(v1.msg, deps); // seq 1 applies -> cursor 1
    await assertRejects(() => applyVersion(v2.msg, deps)); // seq 2 fails
    await applyVersion(v3.msg, deps); // seq 3 applies but is gapped at 2

    // THE FIX: the persisted cursor must stay at failed-1; later seqs cannot leap it.
    assertEquals(state.getSyncCursor(), 1, "cursor must not advance past the failed seq");
    assertEquals(
      new TextDecoder().decode(await vault.readBinary("a.md")),
      "content a",
    );
    assertEquals(vault.files.has("b.md"), false, "failed version must not be on disk");
    assertEquals(
      new TextDecoder().decode(await vault.readBinary("c.md")),
      "content c",
    );
    // seq 3 is durably applied but parked behind the gap at 2.
    assertEquals(state.getLocalFile("c.md")?.last_seen_version, 1);

    // Phase 2: reconnect -> server replays seq > persistedCursor (seq 2 and 3).
    // The transient failure is gone; the failed version re-delivers and applies.
    const depsFixed = makeDeps(null);
    await applyVersion(v2.msg, depsFixed); // flushing 2 and the parked 3
    await applyVersion(v3.msg, depsFixed); // no-op (already durably applied)

    assertEquals(state.getSyncCursor(), 3, "cursor flushes to top after gap heals");
    assertEquals(
      new TextDecoder().decode(await vault.readBinary("b.md")),
      "content b",
    );

    state.close();
  },
});
