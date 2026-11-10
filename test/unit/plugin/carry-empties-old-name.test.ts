// #55 review blocker: a carry that finds its edit already at the destination ("same") must
// empty the renamed-away name in every caller, or the file left there is re-derived as a new
// note at the abandoned name and uploaded beside the note that still exists.

import { assertEquals } from "@std/assert";
import {
  b64encode,
  RENAME_MARKER,
  type ServerVersion,
  type VersionRecord,
} from "../../../core/protocol.ts";
import { deriveKeys, encryptMetadata, type VaultKeys } from "../../../core/crypto.ts";
import { blake3Hex, hashPathHex } from "../../../core/hash.ts";
import { type CommitDeps, commitOp } from "../../../plugin/sync/commit.ts";
import { ConflictHandler } from "../../../plugin/sync/conflict-handler.ts";
import { type ReconcileOp, Reconciler } from "../../../plugin/sync/reconciler.ts";
import { openStateDB, type StateDB } from "../../../plugin/plumbing/state.ts";
import { diskVault } from "../../helpers/disk-vault.ts";

const FAST = { opsLimit: 1, memLimit: 8192 };
const FROM = "a.md";
const TO = "b.md";
const BODY = "same bytes\n";
const encoder = new TextEncoder();

async function keys(): Promise<VaultKeys> {
  return await deriveKeys("carry-close", new Uint8Array(16), FAST);
}

/** The server's head at `from`: a peer's rename marker pointing at `to` (version 3). */
async function markerHead(
  vaultKeys: VaultKeys,
): Promise<{ head: VersionRecord; pathHash: string }> {
  const pathHash = hashPathHex(vaultKeys.mac_key, FROM);
  const enc = await encryptMetadata(
    {
      path: FROM,
      mtime: 1,
      size: 0,
      mime: "",
      plaintext_hash: "",
      renamed_to: TO,
    },
    vaultKeys,
    pathHash,
  );
  return {
    pathHash,
    head: {
      path_hash: pathHash,
      version: 3,
      seq: 3,
      enc_metadata: b64encode(enc),
      chunk_hashes: [],
      deleted: 1,
      path_ciphertext: null,
      rename_mark: RENAME_MARKER,
      device_id: "dev-other",
    } as unknown as VersionRecord,
  };
}

/** The row a remote marker close leaves: the old name closed at the marker's version. */
function closedRow(state: StateDB, vaultKeys: VaultKeys): void {
  state.upsertLocalFile({
    path: FROM,
    path_hash: hashPathHex(vaultKeys.mac_key, FROM),
    size: BODY.length,
    mtime: 1,
    plaintext_hash: blake3Hex(encoder.encode(BODY)),
    last_seen_version: 3,
    chunk_hashes: [],
    deleted: true,
  });
}

function commitDeps(
  vault: ReturnType<typeof diskVault>,
  state: StateDB,
  vaultKeys: VaultKeys,
  head: VersionRecord,
): { deps: CommitDeps; sent: unknown[] } {
  const sent: unknown[] = [];
  const transport = {
    headBlob: () => Promise.resolve(true),
    putBlob: () => Promise.resolve(),
    commit: (req: unknown) => {
      sent.push(req);
      return Promise.resolve({ kind: "ack" as const, seq: 9, version: 9 });
    },
    getVersionChain: () => Promise.resolve([head]),
  };
  return {
    sent,
    deps: {
      vault: vault as never,
      state,
      keys: vaultKeys,
      transport: transport as never,
      onConflict: () => {},
      deviceId: "dev-self",
      deviceName: "Laptop",
      pendingRenameTarget: () => undefined,
      suppressSelfWrite: () => {},
    },
  };
}

Deno.test("carry-empties-old-name - a commit at the abandoned name leaves no file there", async () => {
  const vaultKeys = await keys();
  const state = openStateDB();
  try {
    closedRow(state, vaultKeys);
    // The old name still holds the note's bytes; so does the destination the marker named.
    const vault = diskVault({ [FROM]: BODY, [TO]: BODY });
    const { head } = await markerHead(vaultKeys);
    const { deps, sent } = commitDeps(vault, state, vaultKeys, head);

    const handled = await commitOp({ kind: "commit", path: FROM }, deps);

    assertEquals(handled, true, "the commit is settled, not re-opened at the old name");
    assertEquals(vault.disk.has(FROM), false, "the abandoned name is emptied");
    assertEquals(vault.disk.get(TO), BODY, "the note's bytes stay at its new name");
    assertEquals(sent, [], "nothing is uploaded at the abandoned name");
  } finally {
    state.close();
  }
});

Deno.test("carry-empties-old-name - the reconciler derives no create at the abandoned name", async () => {
  const vaultKeys = await keys();
  const state = openStateDB();
  try {
    closedRow(state, vaultKeys);
    const vault = diskVault({ [FROM]: BODY, [TO]: BODY });
    const { head } = await markerHead(vaultKeys);
    const { deps } = commitDeps(vault, state, vaultKeys, head);
    await commitOp({ kind: "commit", path: FROM }, deps);

    let stop = () => {};
    const ops = await new Promise<ReconcileOp[]>((resolve) => {
      const reconciler = new Reconciler(
        vault as never,
        state,
        (next) => {
          stop();
          resolve(next);
        },
        () => true,
        false,
        undefined,
        ".obsidian",
        () => Promise.resolve(null),
      );
      stop = () => reconciler.stop();
      reconciler.start();
    });

    assertEquals(
      ops.filter((op) => op.path === FROM),
      [],
      "no create/modify/delete at the name the marker closed",
    );
    assertEquals(vault.disk.has(FROM), false);
  } finally {
    state.close();
  }
});

Deno.test("carry-empties-old-name - a remote close through the conflict handler empties it too", async () => {
  const vaultKeys = await keys();
  const state = openStateDB();
  try {
    const pathHash = hashPathHex(vaultKeys.mac_key, FROM);
    // A live row the marker overtakes: version 1 tracked, the marker is version 3.
    state.upsertLocalFile({
      path: FROM,
      path_hash: pathHash,
      size: BODY.length,
      mtime: 1,
      plaintext_hash: "stale",
      last_seen_version: 1,
      chunk_hashes: [],
    });
    const vault = diskVault({ [FROM]: BODY, [TO]: BODY });
    const marker = await markerHead(vaultKeys);
    const serverVersion = {
      type: "server_version",
      vault_id: "v",
      seq: marker.head.seq,
      path_hash: pathHash,
      enc_metadata: marker.head.enc_metadata,
      chunk_hashes: [],
      deleted: true,
      device_id: "dev-other",
      version: marker.head.version,
      rename_mark: RENAME_MARKER,
    } as ServerVersion;
    const versionCache = new Map([[`${pathHash}:${marker.head.version}`, serverVersion]]);
    const localEditPaths = new Set([FROM]);
    const handler = new ConflictHandler({
      vault: vault as never,
      vaultId: "v",
      getDeviceName: () => "Laptop",
      deviceId: "dev-self",
      transport: {
        getHeads: async function* () {},
        getBlob: () => Promise.resolve(new Uint8Array()),
      } as never,
      getState: () => state,
      getKeys: () => vaultKeys,
      onStatusUpdate: () => {},
      versionCache,
      localEditPaths,
      suppressSelfWrite: () => {},
      pendingRenameTarget: () => undefined,
      files: () => [...vault.disk.keys()].map((path) => ({ path })),
    });

    await handler.handleConflict(FROM, { path_hash: pathHash, version: marker.head.version });

    assertEquals(vault.disk.has(FROM), false, "the abandoned name is emptied");
    assertEquals(vault.disk.get(TO), BODY, "the note stays at its new name");
    assertEquals(state.getLocalFile(FROM)?.deleted, true, "the old name's row is closed");
    assertEquals(localEditPaths.has(FROM), false, "no local edit is left waiting on it");
  } finally {
    state.close();
  }
});
