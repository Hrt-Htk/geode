import { diff3Merge } from "node-diff3";
import { b64decode, type FileMeta, ServerVersion, VersionRecord } from "../../core/protocol.ts";
import { decryptMetadata, VaultKeys } from "../../core/crypto.ts";
import { blake3Hex } from "../../core/hash.ts";
import { normalizeForHash, normalizeMarkdownLineEndings, stripBOM } from "../../core/normalize.ts";
import { reassemble } from "../../core/reassemble.ts";
import { log } from "../plumbing/log.ts";
import { StateDB } from "../plumbing/state.ts";
import { Transport } from "./transport.ts";
import { conflictDeviceLabel, conflictDeviceName, generateConflictPath } from "./conflicts.ts";
import type { ActivityRecord } from "./activity-log.ts";

// The per-hunk fallback in mergeText costs O(hunk size), not document size, so it is
// capped in chars: a hunk above this goes straight to the conflict-file path rather
// than freezing the UI (#385).
const HUNK_MAX_LENGTH = 2048;

/** Words and whitespace runs. A word is atomic in the fallback below: two devices
 * editing the SAME word must conflict, never splice into a token neither wrote (#611). */
const wordsOf = (text: string): string[] => text.match(/\s+|\S+/g) ?? [];

export type MergeInput = {
  pathHash: string;
  path: string;
  mime: string;
  local: Uint8Array;
  localVersion: number | null;
  /** #583: the local row was carried across a rename: it has no version of this
   * path, so the device-authored fallback must not pick one. */
  carried?: boolean;
  serverVersion: ServerVersion;
};

export type MergeOutcome =
  | { kind: "clean"; merged: Uint8Array; commitParent: number; serverPlaintextHash: string }
  | { kind: "conflict_file"; serverContent: Uint8Array; localContent: Uint8Array; reason: string }
  | { kind: "no_op" };

export interface MergeDeps {
  transport: Transport;
  keys: VaultKeys;
  state: StateDB;
  /** Presence of the local file (a re-creation, or a stale read of a removed one). */
  vault: Vault;
  /** This device's id: the no-base fallback finds its newest version in the server chain (#549). */
  deviceId: string;
}

type Vault = {
  adapter: {
    writeBinary: (path: string, data: Uint8Array, opts?: { mtime?: number }) => Promise<void>;
    remove: (path: string) => Promise<void>;
    readBinary: (path: string) => Promise<Uint8Array>;
    exists: (path: string) => Promise<boolean>;
  };
};

export interface MergeOrchestrationDeps extends MergeDeps {
  commitMerged: (path: string, merged: Uint8Array, parentVersion: number) => Promise<void>;
  /** #431: a clean merge records "merge"; a conflict_file records "conflict". */
  recordActivity?: ActivityRecord;
  /** #432: this device's name, embedded in the generated conflict file name. */
  deviceName: string;
}

async function merge(input: MergeInput, deps: MergeDeps): Promise<MergeOutcome> {
  const { mime, local, localVersion, serverVersion } = input;

  const Rmeta = await decryptMetadata(
    b64decode(serverVersion.enc_metadata),
    deps.keys,
    input.pathHash,
  );

  // Short-circuit: server deleted. Local bytes still on disk are an edit against
  // the tombstone, so they win (clean): the same rule as a local delete whose file
  // was re-created; only a device that also deleted this name and has nothing left
  // is a no-op (#590).
  if (serverVersion.deleted) {
    if (!isLocallyDeletedPlaceholder(input.path, deps.state) || local.length > 0) {
      return {
        kind: "clean",
        merged: local,
        commitParent: serverVersion.version,
        serverPlaintextHash: Rmeta.plaintext_hash,
      };
    }
    return { kind: "no_op" };
  }

  // Short-circuit: local closed the row and nothing was re-created → the server copy
  // wins (clean). A file that is back on disk means the row is closed but the file is
  // not: that is a create over a tombstone, and the closed generation is no ancestor of
  // it: keep both (#589, #590). Presence, not bytes: a mobile adapter still answers a
  // read for a file it has just removed, and a re-created file can be empty.
  const closedLocally = isLocallyDeletedPlaceholder(input.path, deps.state);
  const recreated = closedLocally && await fileIsPresent(input.path, deps.vault);

  const R = await reassemble(
    serverVersion.chunk_hashes,
    deps.keys,
    (hash: string) => deps.transport.getBlob(hash),
    Rmeta.plaintext_hash,
  );

  if (closedLocally && !recreated) {
    return {
      kind: "clean",
      merged: R,
      commitParent: serverVersion.version,
      serverPlaintextHash: Rmeta.plaintext_hash,
    };
  }

  const Lhash = blake3Hex(local);
  if (Lhash === Rmeta.plaintext_hash) {
    return { kind: "no_op" };
  }

  const A = input.carried || recreated
    ? null
    : await findAncestor(input.pathHash, localVersion, serverVersion.version, deps);
  if (A === null) return noBaseOutcome(input, R, Rmeta, deps);

  if (mime === "text/markdown" || mime === "text/plain") {
    const text = mergeText(local, A, R);
    if ("merged" in text) {
      return {
        kind: "clean",
        merged: text.merged,
        commitParent: serverVersion.version,
        serverPlaintextHash: Rmeta.plaintext_hash,
      };
    }
    return {
      kind: "conflict_file",
      serverContent: R,
      localContent: local,
      reason: text.conflict,
    };
  }

  return {
    kind: "conflict_file",
    serverContent: R,
    localContent: local,
    reason: "binary_conflict",
  };
}

/** #583: no base on this path: a rename carried the edit here, so the row holds the
 * pre-rename hash instead of a version. If the remote still equals that base it adds
 * nothing over the local edit (local wins); otherwise both sides changed and neither
 * may be dropped. */
function noBaseOutcome(
  input: MergeInput,
  remote: Uint8Array,
  remoteMeta: FileMeta,
  deps: MergeDeps,
): MergeOutcome {
  if (deps.state.getLocalFile(input.path)?.plaintext_hash === remoteMeta.plaintext_hash) {
    return {
      kind: "clean",
      merged: input.local,
      commitParent: input.serverVersion.version,
      serverPlaintextHash: remoteMeta.plaintext_hash,
    };
  }
  return {
    kind: "conflict_file",
    serverContent: remote,
    localContent: input.local,
    reason: "no_common_ancestor",
  };
}

export interface MergeResult {
  kind: MergeOutcome["kind"];
  conflictPath?: string;
}

export interface SurfaceConflictInput {
  path: string;
  pathHash: string;
  serverContent: Uint8Array;
  localContent: Uint8Array;
  serverVersion: number;
  chunkHashes: string[];
  reason: string;
}

// Shared conflict-surfacing: path gets the SERVER copy, the generated conflict
// file gets the LOCAL copy, and state records the server version so the next
// reconcile doesn't re-commit local over the server head (#367). Local content
// is written to the conflict file BEFORE the server copy overwrites the path,
// so a crash between the two never loses local content.
export async function surfaceConflict(
  input: SurfaceConflictInput,
  deps: { vault: Vault; state: StateDB; deviceName: string },
): Promise<string> {
  // A same-second collision would overwrite a DIFFERENT conflict's edit, so a
  // counter inside the marker disambiguates. A re-surface of the SAME conflict
  // (merge retry) writes identical content: that file already holds the edit,
  // so reuse it instead of stacking a duplicate sibling.
  const ts = new Date();
  let conflictPath = generateConflictPath(input.path, deps.deviceName, ts);
  const ourLabel = conflictDeviceLabel(deps.deviceName);
  for (let n = 2; await deps.vault.adapter.exists(conflictPath); n++) {
    // The same conflict re-surfaced (merge retry) holds identical content,
    // reuse the file instead of stacking a duplicate sibling. A genuine
    // same-second collision holds a different edit (or another device's): keep
    // both with a counter. When the existing file is unreadable (the write just
    // landed), fall back to the embedded device label: same device = retry.
    const existing = await deps.vault.adapter.readBinary(conflictPath).catch(() => null);
    // Compare the SAME normalized identity the reconciler uses (markdown line
    // endings), so a re-surface of an identical edit (CRLF vs LF) is recognized
    // as the same conflict, not a duplicate sibling.
    const same = existing
      ? bytesEqual(
        normalizeForHash(conflictPath, existing),
        normalizeForHash(conflictPath, input.localContent),
      )
      : conflictDeviceName(conflictPath) === ourLabel;
    if (same) break;
    conflictPath = generateConflictPath(input.path, deps.deviceName, ts, n);
  }
  await deps.vault.adapter.writeBinary(conflictPath, input.localContent);
  await deps.vault.adapter.writeBinary(input.path, input.serverContent);
  deps.state.upsertLocalFile({
    path: input.path,
    path_hash: input.pathHash,
    size: input.serverContent.length,
    mtime: Date.now(),
    // Same identity hash the reconciler compares (blake3Hex(normalizeForHash));
    // hashing the raw blob would differ for markdown with CRLF and re-commit.
    plaintext_hash: blake3Hex(normalizeForHash(input.path, input.serverContent)),
    last_seen_version: input.serverVersion,
    chunk_hashes: input.chunkHashes,
  });
  log.info("conflict surfaced", { path: input.path, conflictPath, reason: input.reason });
  return conflictPath;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export async function orchestrateMerge(
  input: MergeInput,
  deps: MergeOrchestrationDeps,
): Promise<MergeResult> {
  const outcome = await merge(input, deps);

  switch (outcome.kind) {
    case "clean": {
      await deps.vault.adapter.writeBinary(input.path, outcome.merged);
      const mergedHash = blake3Hex(outcome.merged);
      deps.recordActivity?.({
        path: input.path,
        kind: "merge",
        deviceId: input.serverVersion.device_id,
      });

      if (mergedHash === outcome.serverPlaintextHash) {
        // Merged content matches server: just update local state (no_op equivalent)
        deps.state.upsertLocalFile({
          path: input.path,
          path_hash: input.pathHash,
          size: outcome.merged.length,
          mtime: Date.now(),
          plaintext_hash: mergedHash,
          last_seen_version: input.serverVersion.version,
          chunk_hashes: input.serverVersion.chunk_hashes,
        });
      } else {
        // True merge, or local edit over a server tombstone: commit so peers get it (#361)
        await deps.commitMerged(input.path, outcome.merged, outcome.commitParent);
      }
      log.info("merged cleanly", { path: input.path });
      break;
    }

    case "conflict_file": {
      const conflictPath = await surfaceConflict(
        {
          path: input.path,
          pathHash: input.pathHash,
          serverContent: outcome.serverContent,
          localContent: outcome.localContent,
          serverVersion: input.serverVersion.version,
          chunkHashes: input.serverVersion.chunk_hashes,
          reason: outcome.reason,
        },
        { vault: deps.vault, state: deps.state, deviceName: deps.deviceName },
      );
      deps.recordActivity?.({
        path: input.path,
        kind: "conflict",
        deviceId: input.serverVersion.device_id,
      });
      return { kind: outcome.kind, conflictPath };
    }

    case "no_op": {
      if (input.serverVersion.deleted) {
        // Both sides deleted: keep the row closed, or the reconciler would commit a
        // spurious delete for a name the server already closed (#590).
        deps.state.closeLocalRow(input.path, input.pathHash, input.serverVersion.version);
      } else {
        deps.state.upsertLocalFile({
          path: input.path,
          path_hash: input.pathHash,
          size: input.local.length,
          mtime: Date.now(),
          plaintext_hash: blake3Hex(input.local),
          last_seen_version: input.serverVersion.version,
          chunk_hashes: input.serverVersion.chunk_hashes,
        });
      }
      log.info("conflict resolved as no-op", { path: input.path });
      break;
    }
  }
  return { kind: outcome.kind };
}

async function findAncestor(
  pathHash: string,
  localVersion: number | null,
  serverVersion: number,
  deps: MergeDeps,
): Promise<Uint8Array | null> {
  const chain = await deps.transport.getVersionChain(pathHash, serverVersion);

  let target: VersionRecord | undefined;
  if (localVersion === null) {
    // No local row (lost on a kill inside the persist window, #549): fall back
    // to this device's newest version in the chain. When it IS the head, the
    // 3-way merge degenerates to "local wins" (base == head) and commits local
    // with parent = head: no conflict file. No version from this device
    // (never uploaded, or compacted away) → null → conflict file, as before.
    target = chain.find((v) => v.device_id === deps.deviceId);
  } else {
    target = chain.find((v) => v.version <= localVersion);
    if (target === undefined) {
      log.error("ancestor walk failed: local version not in chain", {
        pathHash,
        localVersion,
        serverVersion,
      });
      return null;
    }
  }

  if (target === undefined) return null;
  return await readVersionBytes(
    target,
    pathHash,
    deps.keys,
    (hash) => deps.transport.getBlob(hash),
  );
}

/** A chain row's bytes, or null when the row deleted the file. */
export async function readVersionBytes(
  row: VersionRecord,
  pathHash: string,
  keys: VaultKeys,
  getBlob: (hash: string) => Promise<Uint8Array>,
): Promise<Uint8Array | null> {
  const meta = await decryptMetadata(b64decode(row.enc_metadata), keys, pathHash);
  // A delete carries no content (empty plaintext_hash): no usable merge base.
  if (meta.plaintext_hash === "") return null;
  return await reassemble(row.chunk_hashes, keys, getBlob, meta.plaintext_hash);
}

/** Line/char-level 3-way text merge. Clean ⇒ the merged bytes, otherwise the reason
 * the caller must keep both sides (a conflict file). */
export function mergeText(
  local: Uint8Array,
  ancestor: Uint8Array,
  remote: Uint8Array,
): { merged: Uint8Array } | { conflict: string } {
  const L = normalizeMarkdownLineEndings(stripBOM(new TextDecoder().decode(local)));
  const A = normalizeMarkdownLineEndings(stripBOM(new TextDecoder().decode(ancestor)));
  const R = normalizeMarkdownLineEndings(stripBOM(new TextDecoder().decode(remote)));

  const render = (
    regions: Array<{ ok: string[] } | { conflict: { a: string[]; b: string[] } }>,
    separator: string,
  ): string | null => {
    const out: string[] = [];
    for (const region of regions) {
      if (!("ok" in region)) return null;
      out.push(...region.ok);
    }
    return out.join(separator);
  };
  const regions = diff3Merge(L.split("\n"), A.split("\n"), R.split("\n")) as Array<
    { ok: string[] } | { conflict: { a: string[]; o: string[]; b: string[] } }
  >;

  // Fast path: no line-level conflicts → clean.
  const merged = render(regions, "\n");
  if (merged !== null) {
    return { merged: new TextEncoder().encode(merged) };
  }

  // Line-level conflicted. Run the fallback diff3 on each conflicting hunk alone,
  // at WORD granularity (cost bounded by hunk size, not doc size), and splice the
  // clean hunks back into the line structure. Character granularity would fuse two
  // independent edits inside one word into a third token and drop both (#611); a
  // clean word-level region only ever joins whole words, so no edit can be lost.
  // Any hunk that still conflicts, or exceeds the cap, aborts the whole merge to a
  // conflict file: never a marker commit.
  const out: string[] = [];
  for (const region of regions) {
    if ("ok" in region) {
      out.push(...region.ok);
      continue;
    }
    const hunk = region.conflict;
    const aText = hunk.a.join("\n");
    const oText = hunk.o.join("\n");
    const bText = hunk.b.join("\n");
    if (Math.max(aText.length, oText.length, bText.length) > HUNK_MAX_LENGTH) {
      return { conflict: "conflict_too_large" };
    }
    const wordMerged = render(
      diff3Merge(wordsOf(aText), wordsOf(oText), wordsOf(bText)) as Array<
        { ok: string[] } | { conflict: { a: string[]; b: string[] } }
      >,
      "",
    );
    if (wordMerged === null) {
      return { conflict: "merge_conflict_markers" };
    }
    out.push(...wordMerged.split("\n"));
  }

  return { merged: new TextEncoder().encode(out.join("\n")) };
}

function isLocallyDeletedPlaceholder(path: string, state: StateDB): boolean {
  return state.getLocalFile(path)?.deleted ?? false;
}

/** Is the file really there? A read can succeed for a file the adapter already
 * removed, so presence is asked directly; an adapter that throws is no evidence of
 * absence, and guessing "present" only costs a conflict sibling, never the bytes. */
async function fileIsPresent(path: string, vault: Vault): Promise<boolean> {
  try {
    return await vault.adapter.exists(path);
  } catch {
    return true;
  }
}
