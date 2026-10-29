// #583 PR2: the client writes the rename link: a marker on the old path
// (`deleted` + rename_mark 1, enc_metadata.renamed_to) and a note on the new one
// (create + rename_mark 2, enc_metadata.renamed_from/_version). These tests pin
// the op payloads, the case-only guard skip (decision 7), the §6 promotion over a
// concurrent plain delete and the §9 "an earlier marker keeps the history" rule.

import { assertEquals } from "@std/assert";
import {
  b64decode,
  b64encode,
  type FileMeta,
  RENAME_MARKER,
  RENAME_NOTE,
  type ServerVersion,
} from "../../../core/protocol.ts";
import {
  decryptMetadata,
  deriveKeys,
  encryptMetadata,
  type VaultKeys,
} from "../../../core/crypto.ts";
import { blake3Hex, hashPathHex } from "../../../core/hash.ts";
import { normalizeForHash } from "../../../core/normalize.ts";
import { commitOp } from "../../../plugin/sync/commit.ts";
import { type ApplyDeps, applyVersion } from "../../../plugin/sync/apply.ts";
import { carryLocalEdit } from "../../../plugin/sync/rename-carry.ts";
import { type PendingOp, VaultEventHandler } from "../../../plugin/sync/events.ts";
import { openStateDB } from "../../../plugin/plumbing/state.ts";
import type { CommitRequest, CommitResult } from "../../../plugin/sync/commit-channel.ts";
import type { VersionRecord } from "../../../core/protocol.ts";

const FAST = { opsLimit: 1, memLimit: 8192 };

function keysFor(passphrase = "test"): Promise<VaultKeys> {
  return deriveKeys(passphrase, new Uint8Array(16), FAST);
}

function stubVault(files: Record<string, string> = {}) {
  const disk = new Map(Object.entries(files).map(([p, c]) => [p, new TextEncoder().encode(c)]));
  return {
    getAbstractFileByPath: (p: string) => (disk.has(p) ? { path: p } : null),
    adapter: {
      readBinary: (p: string) => {
        const body = disk.get(p);
        if (!body) return Promise.reject(new Error(`missing: ${p}`));
        return Promise.resolve(body);
      },
      stat: (p: string) =>
        Promise.resolve(disk.has(p) ? { size: disk.get(p)!.length, mtime: 4 } : null),
    },
  };
}

function stubTransport(
  results: CommitResult[] = [],
  chain: Array<Partial<VersionRecord>> = [],
  getBlob: (hash: string) => Promise<Uint8Array> = () => Promise.resolve(new Uint8Array()),
) {
  const commits: CommitRequest[] = [];
  const transport = {
    headBlob: () => Promise.resolve(true),
    putBlob: () => Promise.resolve(),
    commit: (req: CommitRequest) => {
      commits.push(req);
      return Promise.resolve(results.shift() ?? { kind: "ack" as const, seq: 1, version: 7 });
    },
    getVersionChain: () => Promise.resolve(chain as VersionRecord[]),
    getBlob,
  };
  return { transport, commits };
}

/** A mutable disk with optional case-insensitive path matching (a real APFS/NTFS
 * vault holds one inode for "a.md" and "A.md"). */
function diskVault(files: Record<string, string>, opts: { caseInsensitive?: boolean } = {}) {
  const disk = new Map(Object.entries(files));
  const key = (p: string) => {
    if (!opts.caseInsensitive) return p;
    for (const k of disk.keys()) if (k.toLowerCase() === p.toLowerCase()) return k;
    return p;
  };
  return {
    getAbstractFileByPath: (p: string) => (disk.has(key(p)) ? { path: key(p) } : null),
    adapter: {
      readBinary: (p: string) => {
        const body = disk.get(key(p));
        if (!body) return Promise.reject(new Error(`missing: ${p}`));
        return Promise.resolve(new TextEncoder().encode(body));
      },
      writeBinary: (p: string, data: Uint8Array) => {
        disk.set(p, new TextDecoder().decode(data));
        return Promise.resolve();
      },
      remove: (p: string) => {
        disk.delete(key(p));
        return Promise.resolve();
      },
      exists: (p: string) => Promise.resolve(disk.has(key(p))),
      stat: (p: string) => Promise.resolve(disk.has(key(p)) ? { size: 1, mtime: 4 } : null),
    },
    disk,
  };
}

async function markerVersion(
  keys: VaultKeys,
  meta: FileMeta,
  pathHash: string,
  version: number,
): Promise<ServerVersion> {
  return {
    type: "server_version",
    vault_id: "v",
    seq: version,
    path_hash: pathHash,
    parent_version: version - 1,
    enc_metadata: b64encode(await encryptMetadata(meta, keys, pathHash)),
    chunk_hashes: [],
    deleted: true,
    device_id: "dev-other",
    version,
    rename_mark: RENAME_MARKER,
  };
}

function applyDepsFor(
  keys: VaultKeys,
  state: ReturnType<typeof openStateDB>,
  vault: unknown,
  over: Partial<ApplyDeps> = {},
): ApplyDeps {
  return {
    vault: vault as never,
    state,
    keys,
    getBlob: () => Promise.reject(new Error("no chunks expected")),
    hasLocalEdits: () => false,
    onConflict: () => {},
    markLocalEdit: () => {},
    myDeviceId: "dev-self",
    suppressSelfWrite: () => {},
    pendingRenameTarget: () => undefined,
    ...over,
  };
}

Deno.test("rename-note - a rename delete sends a marker carrying the new name", async () => {
  const keys = await keysFor();
  const state = openStateDB();
  const path = "a.md";
  const pathHash = hashPathHex(keys.mac_key, path);
  state.upsertLocalFile({
    path,
    path_hash: pathHash,
    size: 4,
    mtime: 1,
    plaintext_hash: "hash",
    last_seen_version: 3,
    chunk_hashes: [],
  });
  const { transport, commits } = stubTransport();

  await commitOp({ path, kind: "delete", renamedTo: "b.md" }, {
    pendingRenameTarget: () => undefined,
    vault: stubVault() as never,
    state,
    keys,
    transport: transport as never,
    onConflict: () => {},
  });

  assertEquals(commits.length, 1, "one marker commit");
  assertEquals(commits[0].deleted, true);
  assertEquals(commits[0].rename_mark, RENAME_MARKER);
  assertEquals(commits[0].parent_version, 3);
  const meta = await decryptMetadata(b64decode(commits[0].enc_metadata), keys, pathHash);
  assertEquals(meta.renamed_to, "b.md");
  assertEquals(state.getLocalFile(path)?.deleted, true);
  state.close();
});

Deno.test("rename-note - a case-only rename keeps its marker when the old name still resolves", async () => {
  const keys = await keysFor();
  const state = openStateDB();
  const path = "a.md";
  state.upsertLocalFile({
    path,
    path_hash: hashPathHex(keys.mac_key, path),
    size: 4,
    mtime: 1,
    plaintext_hash: "hash",
    last_seen_version: 3,
    chunk_hashes: [],
  });
  // Case-insensitive FS: the old spelling still resolves after the rename.
  const vault = stubVault({ "a.md": "body", "A.md": "body" });
  const plain = stubTransport();
  await commitOp({ path, kind: "delete" }, {
    pendingRenameTarget: () => undefined,
    vault: vault as never,
    state,
    keys,
    transport: plain.transport as never,
    onConflict: () => {},
  });
  assertEquals(
    plain.commits.length,
    0,
    "a plain delete is still eaten by the #498 existence guard",
  );

  const rename = stubTransport();
  await commitOp({ path, kind: "delete", renamedTo: "A.md" }, {
    pendingRenameTarget: () => undefined,
    vault: vault as never,
    state,
    keys,
    transport: rename.transport as never,
    onConflict: () => {},
  });
  assertEquals(rename.commits.length, 1, "the marker must survive the guard");
  assertEquals(rename.commits[0].rename_mark, RENAME_MARKER);
  state.close();
});

Deno.test("rename-note - a rename create sends the note pointing at the marker version", async () => {
  const keys = await keysFor();
  const state = openStateDB();
  const from = "a.md";
  state.upsertLocalFile({
    path: from,
    path_hash: hashPathHex(keys.mac_key, from),
    size: 0,
    mtime: 1,
    plaintext_hash: "",
    last_seen_version: 5,
    chunk_hashes: [],
    deleted: true,
  });
  // The marker's ack landed: the source's head is this rename's marker, so the note can
  // cap at it exactly.
  const { transport, commits } = stubTransport([], [
    { version: 5, deleted: 1, rename_mark: RENAME_MARKER, device_id: "dev-1" },
  ]);

  await commitOp({ path: "b.md", kind: "commit", renamedFrom: from }, {
    pendingRenameTarget: () => undefined,
    vault: stubVault({ "b.md": "body" }) as never,
    state,
    keys,
    transport: transport as never,
    onConflict: () => {},
    deviceId: "dev-1",
  });

  assertEquals(commits.length, 1);
  const to = "b.md";
  const meta = await decryptMetadata(
    b64decode(commits[0].enc_metadata),
    keys,
    hashPathHex(keys.mac_key, to),
  );
  assertEquals(commits[0].deleted, false);
  assertEquals(commits[0].rename_mark, RENAME_NOTE);
  assertEquals(meta.renamed_from, from);
  assertEquals(meta.renamed_from_version, 5, "the marker's version caps the history walk");
  assertEquals(state.getLocalFile(to)?.last_seen_version, 7);
  state.close();
});

Deno.test("rename-note - a note capped below the marker is never written", async () => {
  const keys = await keysFor();
  const state = openStateDB();
  const from = "a.md";
  // The rename fired before the marker's ack: this row is still the pre-rename
  // generation, so its version is NOT this rename's cap. Capping the note at it makes
  // the note point below its own marker and the link reads as missing (#583).
  state.upsertLocalFile({
    path: from,
    path_hash: hashPathHex(keys.mac_key, from),
    size: 4,
    mtime: 1,
    plaintext_hash: "hash",
    last_seen_version: 1,
    chunk_hashes: [],
  });
  const { transport, commits } = stubTransport();

  await commitOp({ path: "b.md", kind: "commit", renamedFrom: from }, {
    pendingRenameTarget: () => undefined,
    vault: stubVault({ "b.md": "body" }) as never,
    state,
    keys,
    transport: transport as never,
    onConflict: () => {},
  });

  assertEquals(commits.length, 1);
  assertEquals(commits[0].rename_mark, RENAME_NOTE);
  const meta = await decryptMetadata(
    b64decode(commits[0].enc_metadata),
    keys,
    hashPathHex(keys.mac_key, "b.md"),
  );
  assertEquals(
    meta.renamed_from_version,
    0,
    "no exact marker version yet: 0 makes the walk find the newest marker",
  );
  state.close();
});

Deno.test("rename-note - no note when the new name already has its own history", async () => {
  const keys = await keysFor();
  const state = openStateDB();
  const to = "b.md";
  state.upsertLocalFile({
    path: "a.md",
    path_hash: hashPathHex(keys.mac_key, "a.md"),
    size: 0,
    mtime: 1,
    plaintext_hash: "",
    last_seen_version: 5,
    chunk_hashes: [],
    deleted: true,
  });
  state.upsertLocalFile({
    path: to,
    path_hash: hashPathHex(keys.mac_key, to),
    size: 3,
    mtime: 1,
    plaintext_hash: "old",
    last_seen_version: 2,
    chunk_hashes: [],
  });
  const { transport, commits } = stubTransport();

  await commitOp({ path: to, kind: "commit", renamedFrom: "a.md" }, {
    pendingRenameTarget: () => undefined,
    vault: stubVault({ [to]: "body" }) as never,
    state,
    keys,
    transport: transport as never,
    onConflict: () => {},
  });

  assertEquals(commits.length, 1);
  assertEquals(commits[0].rename_mark, undefined, "a reused name starts its own history");
  const meta = await decryptMetadata(
    b64decode(commits[0].enc_metadata),
    keys,
    hashPathHex(keys.mac_key, to),
  );
  assertEquals((meta as FileMeta).renamed_from, undefined);
  state.close();
});

Deno.test("rename-note - a marker promotes over a concurrent plain delete (§6)", async () => {
  const keys = await keysFor();
  const state = openStateDB();
  const path = "a.md";
  const pathHash = hashPathHex(keys.mac_key, path);
  state.upsertLocalFile({
    path,
    path_hash: pathHash,
    size: 4,
    mtime: 1,
    plaintext_hash: "hash",
    last_seen_version: 3,
    chunk_hashes: [],
  });
  const { transport, commits } = stubTransport(
    [
      { kind: "conflict", path_hash: pathHash, parent_version: 4, reason: "parent_mismatch" },
      { kind: "ack", seq: 9, version: 5 },
    ],
    [{ version: 4, deleted: 1, rename_mark: 0 }],
  );

  await commitOp({ path, kind: "delete", renamedTo: "b.md" }, {
    pendingRenameTarget: () => undefined,
    vault: stubVault() as never,
    state,
    keys,
    transport: transport as never,
    onConflict: () => {},
  });

  assertEquals(commits.length, 2, "the marker is re-sent over the tombstone");
  assertEquals(commits[1].parent_version, 4);
  assertEquals(commits[1].rename_mark, RENAME_MARKER);
  assertEquals(state.getLocalFile(path)?.last_seen_version, 5);
  state.close();
});

Deno.test("rename-note - a rename that loses to an earlier marker stays a plain copy (decision 9)", async () => {
  const keys = await keysFor();
  const state = openStateDB();
  const path = "a.md";
  const pathHash = hashPathHex(keys.mac_key, path);
  state.upsertLocalFile({
    path,
    path_hash: pathHash,
    size: 4,
    mtime: 1,
    plaintext_hash: "hash",
    last_seen_version: 3,
    chunk_hashes: [],
  });
  const { transport, commits } = stubTransport(
    [{ kind: "conflict", path_hash: pathHash, parent_version: 4, reason: "parent_mismatch" }],
    [{ version: 4, deleted: 1, rename_mark: RENAME_MARKER, device_id: "dev-other" }],
  );
  const conflicts: string[] = [];
  // The commit queue owns this set: one per session (vault-scoped).
  const abandonedRenames = new Set<string>();
  const deps = {
    vault: stubVault() as never,
    state,
    keys,
    transport: transport as never,
    onConflict: (p: string) => conflicts.push(p),
    deviceId: "dev-self",
    abandonedRenames,
    pendingRenameTarget: () => undefined,
  };

  await commitOp({ path, kind: "delete", renamedTo: "c.md" }, deps);

  assertEquals(commits.length, 1, "no second marker over another device's marker");
  assertEquals(conflicts, [], "the old name is closed, not conflicted");
  assertEquals(state.getLocalFile(path)?.deleted, true);
  assertEquals(state.getLocalFile(path)?.last_seen_version, 4);

  // The loser's file starts its own history: no note claiming the shared chain.
  const note = stubTransport();
  await commitOp({ path: "c.md", kind: "commit", renamedFrom: path }, {
    ...deps,
    vault: stubVault({ "c.md": "body" }) as never,
    transport: note.transport as never,
  });
  assertEquals(note.commits.length, 1);
  assertEquals(note.commits[0].rename_mark, undefined);

  // After a restart the in-session record is gone: the old path's head still says
  // another device owns the history, so the note must not be written.
  const afterRestart = stubTransport(
    [],
    [{ version: 4, deleted: 1, rename_mark: RENAME_MARKER, device_id: "dev-other" }],
  );
  await commitOp({ path: "d.md", kind: "commit", renamedFrom: path }, {
    pendingRenameTarget: () => undefined,
    vault: stubVault({ "d.md": "body" }) as never,
    state,
    keys,
    transport: afterRestart.transport as never,
    onConflict: () => {},
    deviceId: "dev-self",
  });
  assertEquals(afterRestart.commits.length, 1);
  assertEquals(afterRestart.commits[0].rename_mark, undefined, "no note claiming another marker");
  state.close();
});

function makeEventVault() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    on: (name: string, cb: (...args: unknown[]) => void) => {
      listeners.set(name, [...(listeners.get(name) ?? []), cb]);
    },
    off: () => {},
    adapter: { exists: () => Promise.resolve(false) },
    trigger: (name: string, ...args: unknown[]) => {
      for (const cb of listeners.get(name) ?? []) cb(...args);
    },
  };
}

function newEventHandler() {
  const vault = makeEventVault();
  const flushes: PendingOp[][] = [];
  const handler = new VaultEventHandler(vault as never, (ops) => flushes.push(ops), () => true);
  return { vault, handler, flushes };
}

Deno.test("rename-note - an in-scope rename emits a linked delete + commit", () => {
  const { vault, handler, flushes } = newEventHandler();
  handler.start();
  vault.trigger("rename", { path: "notes/b.md" }, "notes/a.md");
  handler.flushNow();
  const ops = flushes.flat();
  assertEquals(ops.map((o) => `${o.kind}:${o.path}`), ["delete:notes/a.md", "commit:notes/b.md"]);
  assertEquals(ops[0].renamedTo, "notes/b.md");
  assertEquals(ops[1].renamedFrom, "notes/a.md");
  handler.stop();
});

Deno.test("rename-note - a normalization-only rename is one commit, no marker (§9)", () => {
  const { vault, handler, flushes } = newEventHandler();
  handler.start();
  // NFD spelling of "café.md" → NFC: the same path key, not a rename.
  vault.trigger("rename", { path: "caf\u00e9.md" }, "cafe\u0301.md");
  handler.flushNow();
  const ops = flushes.flat();
  assertEquals(ops.map((o) => `${o.kind}:${o.path}`), ["commit:caf\u00e9.md"]);
  assertEquals(ops[0].renamedFrom, undefined);
  assertEquals(ops[0].renamedTo, undefined);
  handler.stop();
});

Deno.test("rename-note - a marker is not sent when the head edit cannot be read", async () => {
  const keys = await keysFor();
  const state = openStateDB();
  const path = "a.md";
  const pathHash = hashPathHex(keys.mac_key, path);
  state.upsertLocalFile({
    path,
    path_hash: pathHash,
    size: 4,
    mtime: 1,
    plaintext_hash: "hash",
    last_seen_version: 3,
    chunk_hashes: [],
  });
  const headMeta: FileMeta = {
    path,
    mtime: 1,
    size: 4,
    mime: "text/markdown",
    plaintext_hash: "c1",
  };
  const { transport, commits } = stubTransport(
    [{ kind: "conflict", path_hash: pathHash, parent_version: 4, reason: "parent_mismatch" }],
    [{
      version: 4,
      deleted: 0,
      rename_mark: 0,
      device_id: "dev-other",
      chunk_hashes: ["c1"],
      enc_metadata: b64encode(await encryptMetadata(headMeta, keys, pathHash)),
    }],
    () => Promise.reject(new Error("blob fetch failed")),
  );

  const ok = await commitOp({ path, kind: "delete", renamedTo: "b.md" }, {
    pendingRenameTarget: () => undefined,
    vault: diskVault({ "b.md": "renamed" }) as never,
    state,
    keys,
    transport: transport as never,
    onConflict: () => {},
    deviceId: "dev-self",
  });

  assertEquals(ok, false, "a failed carry must be retryable, not a success");
  assertEquals(commits.length, 1, "the marker must not close the old name over an unread edit");
  assertEquals(state.getLocalFile(path)?.deleted, false, "the old name stays open");
  state.close();
});

Deno.test("rename-note - a marker carries an edit under a deleted row", async () => {
  const keys = await keysFor();
  const state = openStateDB();
  const path = "a.md";
  const pathHash = hashPathHex(keys.mac_key, path);
  const to = "b.md";
  state.upsertLocalFile({
    path,
    path_hash: pathHash,
    size: 4,
    mtime: 1,
    plaintext_hash: "old",
    last_seen_version: 1,
    chunk_hashes: [],
    deleted: true,
  });
  const vault = diskVault({ [path]: "edited after delete" });
  const msg = await markerVersion(
    keys,
    {
      path,
      mtime: 1,
      size: 0,
      mime: "",
      plaintext_hash: "",
      renamed_to: to,
    },
    pathHash,
    2,
  );

  await applyVersion(msg, applyDepsFor(keys, state, vault));

  assertEquals(vault.disk.get(to), "edited after delete", "the local edit followed the note");
  assertEquals(vault.disk.has(path), false, "the old name is gone");
  assertEquals(state.getLocalFile(to)?.last_seen_version, 0, "carried, not versioned");
  assertEquals(state.getLocalFile(path)?.deleted, true);
  state.close();
});

Deno.test("rename-note - a marker carries an edit for an untracked file", async () => {
  const keys = await keysFor();
  const state = openStateDB();
  const path = "a.md";
  const pathHash = hashPathHex(keys.mac_key, path);
  const to = "b.md";
  const vault = diskVault({ [path]: "never uploaded" });
  const msg = await markerVersion(
    keys,
    {
      path,
      mtime: 1,
      size: 0,
      mime: "",
      plaintext_hash: "",
      renamed_to: to,
    },
    pathHash,
    1,
  );

  await applyVersion(msg, applyDepsFor(keys, state, vault));

  assertEquals(vault.disk.get(to), "never uploaded", "an untracked edit is not deleted");
  assertEquals(vault.disk.has(path), false);
  state.close();
});

Deno.test("rename-note - a cleared destination row does not block the carry", async () => {
  const keys = await keysFor();
  const state = openStateDB();
  const from = "a.md";
  const to = "b.md";
  state.upsertLocalFile({
    path: from,
    path_hash: hashPathHex(keys.mac_key, from),
    size: 4,
    mtime: 1,
    plaintext_hash: "old",
    last_seen_version: 1,
    chunk_hashes: [],
  });
  // The name was used and deleted before: a free recycled name.
  state.upsertLocalFile({
    path: to,
    path_hash: hashPathHex(keys.mac_key, to),
    size: 0,
    mtime: 1,
    plaintext_hash: "",
    last_seen_version: 2,
    chunk_hashes: [],
    deleted: true,
  });
  const vault = diskVault({ [from]: "edit" });

  const carried = await carryLocalEdit({ path: from, renamedTo: to, pendingEdit: true }, {
    pendingRenameTarget: () => undefined,
    vault: vault as never,
    state,
    keys,
    suppressSelfWrite: () => {},
    renameHeadOf: () => Promise.resolve(null), // no server history: a free name
  });

  assertEquals(carried, { kind: "moved", to });
  assertEquals(vault.disk.get(to), "edit");
  state.close();
});

Deno.test("rename-note - a destination the server renamed away again keeps both", async () => {
  const keys = await keysFor();
  const state = openStateDB();
  const from = "a.md";
  const to = "b.md";
  state.upsertLocalFile({
    path: from,
    path_hash: hashPathHex(keys.mac_key, from),
    size: 4,
    mtime: 1,
    plaintext_hash: "old",
    last_seen_version: 1,
    chunk_hashes: [],
  });
  state.upsertLocalFile({
    path: to,
    path_hash: hashPathHex(keys.mac_key, to),
    size: 0,
    mtime: 1,
    plaintext_hash: "",
    last_seen_version: 2,
    chunk_hashes: [],
    deleted: true,
  });
  const vault = diskVault({ [from]: "edit" });

  const carried = await carryLocalEdit({ path: from, renamedTo: to, pendingEdit: true }, {
    pendingRenameTarget: () => undefined,
    vault: vault as never,
    state,
    keys,
    suppressSelfWrite: () => {},
    // The name was itself renamed away (a marker is its head): writing there would
    // walk a rename cycle, so both are kept next to it instead.
    renameHeadOf: () => Promise.resolve({ deleted: 1, rename_mark: RENAME_MARKER }),
  });

  assertEquals(carried.kind, "kept");
  assertEquals(vault.disk.has(from), false, "the renamed-away name is left empty");
  const conflictPath = (carried as { conflictPath: string }).conflictPath;
  assertEquals(vault.disk.get(conflictPath), "edit", "the edit is kept next to the name");
  state.close();
});

Deno.test("rename-note - a case-only rename never removes the note's file", async () => {
  const keys = await keysFor();
  const state = openStateDB();
  const path = "a.md";
  const to = "A.md";
  const bodyHash = blake3Hex(normalizeForHash(path, new TextEncoder().encode("body")));
  // Heads are per path and can arrive out of seq order: the note's row and file are
  // already there when the marker applies. Nothing local is edited.
  state.upsertLocalFile({
    path,
    path_hash: hashPathHex(keys.mac_key, path),
    size: 4,
    mtime: 1,
    plaintext_hash: bodyHash,
    last_seen_version: 1,
    chunk_hashes: [],
  });
  state.upsertLocalFile({
    path: to,
    path_hash: hashPathHex(keys.mac_key, to),
    size: 4,
    mtime: 1,
    plaintext_hash: bodyHash,
    last_seen_version: 1,
    chunk_hashes: [],
  });
  const vault = diskVault({ [to]: "body" }, { caseInsensitive: true });
  const msg = await markerVersion(
    keys,
    {
      path,
      mtime: 1,
      size: 0,
      mime: "",
      plaintext_hash: "",
      renamed_to: to,
    },
    hashPathHex(keys.mac_key, path),
    2,
  );

  await applyVersion(msg, applyDepsFor(keys, state, vault));

  assertEquals(vault.disk.has(to), true, "the one inode must survive the marker");
  assertEquals(state.getLocalFile(to)?.deleted, false);
  assertEquals(state.getLocalFile(path)?.deleted, true);
  state.close();
});

Deno.test("rename-note - a create for the new path after the rename keeps the note link", () => {
  const { vault, handler, flushes } = newEventHandler();
  handler.start();
  vault.trigger("rename", { path: "notes/b.md" }, "notes/a.md");
  // Mobile also reports a create for the renamed path in the same window.
  vault.trigger("create", { path: "notes/b.md" });
  handler.flushNow();
  const commit = flushes.flat().find((o) => o.path === "notes/b.md")!;
  assertEquals(commit.kind, "commit");
  assertEquals(commit.renamedFrom, "notes/a.md");
  handler.stop();
});

Deno.test("rename-note - a deferred version is parked and the cursor stays behind it", async () => {
  const keys = await keysFor();
  const state = openStateDB();
  const path = "x.md";
  const pathHash = hashPathHex(keys.mac_key, path);
  state.upsertLocalFile({
    path,
    path_hash: pathHash,
    size: 3,
    mtime: 1,
    plaintext_hash: "v1",
    last_seen_version: 1,
    chunk_hashes: [],
  });
  const parked: Array<{ version: number; destination: string }> = [];
  const msg: ServerVersion = {
    type: "server_version",
    vault_id: "v",
    seq: 2,
    path_hash: pathHash,
    parent_version: 1,
    enc_metadata: b64encode(
      await encryptMetadata(
        {
          path,
          mtime: 1,
          size: 8,
          mime: "text/markdown",
          plaintext_hash: "v2",
        },
        keys,
        pathHash,
      ),
    ),
    chunk_hashes: [],
    deleted: false,
    device_id: "dev-other",
    version: 2,
  };

  await applyVersion(
    msg,
    applyDepsFor(keys, state, diskVault({ [path]: "x" }), {
      pendingRenameTarget: () => "y.md",
      parkDeferred: (m, destination) => parked.push({ version: m.version, destination }),
    }),
  );

  assertEquals(parked, [{ version: 2, destination: "y.md" }], "the version is parked");
  assertEquals(state.getSyncCursor(), 0, "the cursor must stay behind a deferred version");
  state.close();
});
