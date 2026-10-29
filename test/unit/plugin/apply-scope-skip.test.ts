import { type ApplyDeps, applyVersion } from "../../../plugin/sync/apply.ts";
import { StateDB } from "../../../plugin/plumbing/state.ts";
import { type ServerVersion } from "../../../core/protocol.ts";
import { deriveKeys, encryptMetadata, type VaultKeys } from "../../../core/crypto.ts";
import { b64encode } from "../../../core/protocol.ts";
import { assert, assertEquals } from "@std/assert";

// applyVersion must skip (and advance the cursor past) versions for out-of-scope
// paths, and apply in-scope ones. #342

let keys: VaultKeys;
Deno.test({
  name: "setup keys",
  sanitizeOps: false,
  fn: async () => {
    keys = await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
  },
});

function makeDeps(isSyncable: (path: string) => boolean): { deps: ApplyDeps; state: StateDB } {
  const state = new StateDB();
  const deps: ApplyDeps = {
    vault: {
      getAllLoadedFiles: () => [],
      adapter: {
        writeBinary: () => Promise.resolve(),
        write: () => Promise.resolve(),
        remove: () => Promise.resolve(),
      },
    },
    state,
    keys,
    getBlob: () => Promise.resolve(new Uint8Array()),
    hasLocalEdits: () => false,
    onConflict: () => {},
    markLocalEdit: () => {},
    myDeviceId: "device-a",
    suppressSelfWrite: () => {},
    pendingRenameTarget: () => undefined,
    isSyncable,
  };
  return { deps, state };
}

// BLAKE3 of the empty byte string: the fake version carries no chunks.
const EMPTY_HASH = "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262";

async function makeMsg(path: string, version: number, seq: number): Promise<ServerVersion> {
  const enc = await encryptMetadata(
    { path, mtime: 1, size: 0, mime: "text/markdown", plaintext_hash: EMPTY_HASH },
    keys,
    "ph",
  );
  return {
    type: "server_version",
    vault_id: "v",
    seq,
    path_hash: "ph",
    parent_version: 0,
    enc_metadata: b64encode(enc),
    chunk_hashes: [],
    deleted: false,
    device_id: "device-b",
    version,
  };
}

Deno.test("apply - out-of-scope version is skipped and the cursor advances", async () => {
  const { deps, state } = makeDeps((p) => !p.startsWith("excluded/"));
  const msg = await makeMsg("excluded/x.md", 1, 1);
  state.noteReceived(1); // the transport records receipt before apply
  await applyVersion(msg, deps);
  assertEquals(state.getSyncCursor(), 1, "cursor must advance past the skipped version");
  assertEquals(state.getLocalFile("excluded/x.md"), null, "no local row for a skipped path");
});

Deno.test("apply - in-scope version still applies", async () => {
  let wrote = false;
  const { deps } = makeDeps((p) => !p.startsWith("excluded/"));
  deps.vault.adapter.writeBinary = () => {
    wrote = true;
    return Promise.resolve();
  };
  const msg = await makeMsg("notes/x.md", 1, 1);
  deps.state.noteReceived(1);
  await applyVersion(msg, deps);
  assert(wrote, "in-scope version must be applied");
});

Deno.test("apply - scope is re-read live: a path that becomes in-scope applies", async () => {
  let inScope = false;
  const { deps } = makeDeps(() => inScope);
  let msg = await makeMsg("excluded/x.md", 1, 1);
  deps.state.noteReceived(1);
  await applyVersion(msg, deps);
  assertEquals(deps.state.getSyncCursor(), 1);
  inScope = true;
  msg = await makeMsg("excluded/x.md", 2, 2);
  deps.state.noteReceived(2);
  await applyVersion(msg, deps);
  assertEquals(deps.state.getLocalFile("excluded/x.md")?.last_seen_version, 2);
});
