import { type ApplyDeps, applyVersion } from "../../../plugin/sync/apply.ts";
import { getRecentLog, setDebugLogging } from "../../../plugin/plumbing/log.ts";
import { StateDB } from "../../../plugin/plumbing/state.ts";
import { type ServerVersion } from "../../../core/protocol.ts";
import { type VaultKeys } from "../../../core/crypto.ts";
import { assert, assertEquals } from "@std/assert";

/**
 * Test the already-processed skip branch of applyVersion.
 *
 * This branch is exercised by pre-seeding a LocalFileRow with
 * last_seen_version >= msg.version. No decrypt is needed: the function
 * just calls updateSyncCursor and returns.
 *
 * Expected log: log.debug("apply skipped (already processed)", { version })
 */

function makeMinimalDeps(state: StateDB): ApplyDeps {
  return {
    vault: {
      getAllLoadedFiles: () => [],
      adapter: {
        writeBinary: () => Promise.resolve(),
        write: () => Promise.resolve(),
        remove: () => Promise.resolve(),
      },
    },
    state,
    keys: {} as VaultKeys,
    getBlob: () => Promise.resolve(new Uint8Array()),
    hasLocalEdits: () => false,
    onConflict: () => {},
    markLocalEdit: () => {},
    myDeviceId: "device-a",
    suppressSelfWrite: () => {},
    pendingRenameTarget: () => undefined,
  };
}

Deno.test({
  name: "apply-log - already-processed skip emits debug log",
  async fn() {
    setDebugLogging(true);

    const state = new StateDB();
    // Pre-seed: this path_hash already tracked at version 5
    state.upsertLocalFile({
      path: "test.md",
      path_hash: "abc123def456",
      size: 100,
      mtime: Date.now(),
      plaintext_hash: "def456",
      last_seen_version: 5,
      chunk_hashes: [],
      deleted: false,
    });

    const deps = makeMinimalDeps(state);

    const msg: ServerVersion = {
      type: "server_version",
      vault_id: "test-vault",
      seq: 10,
      path_hash: "abc123def456",
      parent_version: 4,
      enc_metadata: "", // not used: already-processed branch skips decrypt
      chunk_hashes: [],
      deleted: false,
      device_id: "device-b", // peer device (not own)
      version: 3, // <= last_seen_version (5) → skip
    };

    const logBefore = getRecentLog().length;

    await applyVersion(msg, deps);

    const entries = getRecentLog();
    const newEntries = entries.slice(logBefore);

    // Must have emitted at least one log entry
    assert(newEntries.length > 0, "Expected at least one log entry from applyVersion");

    // The skip entry should be a debug-level message about already-processed
    const skipEntry = newEntries.find((e) =>
      e.level === "debug" && e.msg.includes("already processed")
    );
    assert(skipEntry !== undefined, "Expected debug log with 'already processed' message");
    assertEquals(skipEntry.fields.version, 3);
  },
});
