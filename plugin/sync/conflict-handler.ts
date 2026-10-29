import {
  b64decode,
  headToServerVersion,
  RENAME_MARKER,
  ServerVersion,
} from "../../core/protocol.ts";
import { decryptMetadata, VaultKeys } from "../../core/crypto.ts";
import { reassemble } from "../../core/reassemble.ts";
import { blake3Hex, hashPathHex } from "../../core/hash.ts";
import { detectMime, normalizeForHash } from "../../core/normalize.ts";
import { StateDB } from "../plumbing/state.ts";
import { Transport } from "./transport.ts";
import { commitFileBytes } from "./commit.ts";
import { acquirePathLock } from "./path-lock.ts";
import { renameHeadOf } from "./apply.ts";
import { carryLocalEdit } from "./rename-carry.ts";
import { countConflictFiles } from "./conflict-list.ts";
import { MergeResult, orchestrateMerge, surfaceConflict } from "./merger.ts";
import type { ActivityRecord } from "./activity-log.ts";
import { toUint8Array } from "../plumbing/bytes.ts";
import { log } from "../plumbing/log.ts";

const MAX_RETRIES = 5;

/** Positive absence only: a throwing adapter (#505, mobile) is NOT absence. */
async function isGoneFromDisk(
  path: string,
  adapter: { stat: (path: string) => Promise<unknown | null> },
): Promise<boolean> {
  try {
    return (await adapter.stat(path)) === null;
  } catch {
    return false;
  }
}

type Vault = {
  adapter: {
    readBinary: (path: string) => Promise<Uint8Array>;
    stat: (path: string) => Promise<{ size: number; mtime: number }>;
    writeBinary: (path: string, data: Uint8Array, opts?: { mtime?: number }) => Promise<void>;
    remove: (path: string) => Promise<void>;
    exists: (path: string) => Promise<boolean>;
  };
};

export interface ConflictHandlerDeps {
  vault: Vault;
  vaultId: string;
  /** #432: resolves this device's name at conflict time (a rename must stick). */
  getDeviceName: () => string;
  /** #549: this device's id; the merger's no-base fallback matches it in the version chain. */
  deviceId: string;
  transport: Transport;
  getState: () => StateDB | null;
  getKeys: () => VaultKeys | null;
  onStatusUpdate: ((status: string, data?: unknown) => void) | null;
  versionCache: Map<string, ServerVersion>;
  localEditPaths: Set<string>;
  /** #583: a marker's disk move must not enqueue a second rename. */
  suppressSelfWrite: (path: string) => void;
  /** #697: pair marks of this device's own applied renames. */
  suppressSelfRename?: (from: string, to: string) => () => void;
  /** #583: the destination of a pending rename delete (undefined when none): the
   * pending marker settles the old name, so it is never merged into here. */
  pendingRenameTarget: (path: string) => string | undefined;
  /** #431: conflicts surfaced outside the merge orchestration (retry limit). */
  recordActivity?: ActivityRecord;
  /** #432: the vault's file index; the conflict count derives from it so a
   * device that RECEIVES a conflict file (never surfaces one) sees it too. */
  files: () => Array<{ path: string }>;
}

export class ConflictHandler {
  private conflictRetries = new Map<string, number>();
  constructor(private deps: ConflictHandlerDeps) {}

  /** The open conflict count = conflict files present in the vault, on any device. */
  getConflictCount(): number {
    return countConflictFiles(this.deps.files());
  }

  onConflictFileDeleted(_path: string): void {
    // The file is gone from disk; re-report the derived count so the badge,
    // menu and settings row drop back down on every device.
    this.deps.onStatusUpdate?.("conflict", this.getConflictCount());
  }

  /** Resolutions are serialized per path: two that overlap read the disk and the row
   * before either writes, so the loser would overwrite the bytes the winner just kept
   * (#589/#590: an apply-triggered resolution and a rejected commit's, typically). A
   * queued one re-reads the head, which the running one may have moved past. */
  private inFlight = new Map<string, Promise<void>>();

  async handleConflict(
    path: string,
    head: { path_hash: string; version: number },
  ): Promise<void> {
    const running = this.inFlight.get(path);
    const run = (running
      ? running.catch(() => {}).then(async () => {
        const fresh = await this.fetchHead(head.path_hash);
        if (!fresh) return;
        await this.resolveConflict(path, fresh);
        log.info("conflict re-resolved after the one in flight", { path });
      })
      : this.resolveConflict(path, head))
      .finally(() => {
        if (this.inFlight.get(path) === run) this.inFlight.delete(path);
      });
    this.inFlight.set(path, run);
    await run;
  }

  private async resolveConflict(
    path: string,
    head: { path_hash: string; version: number },
  ): Promise<void> {
    const state = this.deps.getState();
    const keys = this.deps.getKeys();
    if (!state || !keys) return;

    // #630: one writer per path. The pending local edit this conflict is about may be
    // mid-commit: merging now writes the server copy over the bytes that commit is
    // pushing, and its ack then records this write's mtime against the committed hash,
    // a row and a disk that disagree under one mtime, which the reconciler's mtime
    // fast-path never re-reads, so the device keeps a version its peers do not, forever.
    // The lock also holds off a commit that would start mid-resolution, and lets the
    // staleness check below judge the head against whatever committed first.
    const lock = await acquirePathLock(state, path);
    if (!lock) {
      // That commit is still in flight (an unsent one over a closed socket waits for
      // reconnect). Defer instead of stalling the version queue behind it; the commit's
      // own reconcile re-raises this resolution.
      log.warn("conflict resolution deferred: the path is still committing", { path });
      return;
    }
    try {
      await this.resolveLocked(path, head, keys, state);
    } finally {
      lock();
    }
  }

  private async resolveLocked(
    path: string,
    head: { path_hash: string; version: number },
    keys: VaultKeys,
    state: StateDB,
  ): Promise<void> {
    const retries = (this.conflictRetries.get(path) ?? 0) + 1;
    if (retries > MAX_RETRIES) {
      log.warn("merge retry limit exceeded, writing conflict file", { path, retries });
      this.conflictRetries.delete(path);
      await this.surfaceConflictFile(path, head, keys, state);
      return;
    }
    this.conflictRetries.set(path, retries);

    const serverVersion = await this.resolveServerVersion(head);
    if (!serverVersion) return;
    // A resolution whose head the row already tracks is stale: a newer resolution (or
    // its commit) owns this path, and merging the older server copy here would write it
    // over the bytes that one just kept (#589/#590: two concurrent resolutions of one
    // path, e.g. an apply and a rejected commit).
    const tracked = state.getLocalFile(path)?.last_seen_version;
    if (tracked !== undefined && tracked >= serverVersion.version) {
      this.conflictRetries.delete(path);
      log.info("conflict resolution stale", {
        path,
        head: serverVersion.version,
        tracked,
      });
      return;
    }
    // #583 / #361: the server closed this name. A marker moves this device's
    // local edit to the note's path (decision 2) instead of resurrecting the old
    // one; a tombstone means nothing is left to merge when the file is gone too.
    // A tombstone with the file still on disk keeps "local wins" (#361).
    if (
      serverVersion.deleted &&
      (serverVersion.rename_mark === RENAME_MARKER ||
        await isGoneFromDisk(path, this.deps.vault.adapter))
    ) {
      this.conflictRetries.delete(path);
      await this.resolveRemoteClose(serverVersion, keys, state);
      return;
    }
    // #583: this device already renamed the file away: the pending marker carries
    // the incoming edit to the new name (commit.ts), so never merge into the old one.
    if (this.deps.pendingRenameTarget(path)) {
      this.deps.localEditPaths.delete(path);
      return;
    }
    const mergeResult = await this.runMerge(path, serverVersion, keys, state);
    // Conflict resolved: clear the retry counter. It exists only to cap a
    // runaway merge->commit->conflict recursion (MAX_RETRIES); it must NOT
    // accumulate across independent conflicts on the same path, or the Nth
    // successive concurrent edit would spuriously hit the cap and take the
    // fallback branch that leaves the local edit on disk to be re-committed,
    // linearizing two concurrent edits and dropping one side on the peer (#124).
    this.conflictRetries.delete(path);
    this.recordConflict(mergeResult);
    // Clear localEditPaths: the local edit has been committed (merged) or
    // surfaced (conflict file). The path is no longer in a "pending commit"
    // state. Without this, the promotion path's markLocalEdit would persist
    // indefinitely, causing every subsequent version for this path to trigger
    // the conflict handler: leading to independent 3-way merges that produce
    // different content on different devices (#127).
    this.deps.localEditPaths.delete(path);
  }

  /** #583: apply the server's close of this name: carry a local edit to the new
   * path first when the version is a rename marker, then mark the row deleted. */
  private async resolveRemoteClose(
    serverVersion: ServerVersion,
    keys: VaultKeys,
    state: StateDB,
  ): Promise<void> {
    const meta = await decryptMetadata(
      b64decode(serverVersion.enc_metadata),
      keys,
      serverVersion.path_hash,
    );
    const carried = await carryLocalEdit(
      { path: meta.path, renamedTo: meta.renamed_to, pendingEdit: true },
      {
        vault: this.deps.vault,
        state,
        keys,
        suppressSelfWrite: this.deps.suppressSelfWrite,
        suppressSelfRename: this.deps.suppressSelfRename,
        deviceName: this.deps.getDeviceName(),
        renameHeadOf: (pathHash) => renameHeadOf(this.deps.transport, pathHash),
        pendingRenameTarget: this.deps.pendingRenameTarget,
      },
    );
    state.closeLocalRow(meta.path, serverVersion.path_hash, serverVersion.version);
    this.deps.localEditPaths.delete(meta.path);
    if (carried.kind !== "moved") return;
    this.deps.localEditPaths.add(carried.to);
    await this.resolveNested(carried.to, {
      path_hash: hashPathHex(keys.mac_key, carried.to),
      version: 0,
    });
  }

  /** A resolution started from inside another one: the carry follows a rename to a name
   * whose own marker may walk the edit straight back. If that name is already resolving,
   * queueing behind it would wait on itself: skip and let the outer resolution (or the
   * next reconcile) settle it (#583). */
  private async resolveNested(
    path: string,
    head: { path_hash: string; version: number },
  ): Promise<void> {
    if (this.inFlight.has(path)) {
      log.info("conflict resolution cycle skipped", { path });
      return;
    }
    await this.handleConflict(path, head);
  }

  // Same conflict-surfacing as orchestrateMerge: path gets the SERVER copy,
  // the conflict file gets the LOCAL copy, state records the server version.
  // Otherwise the next reconcile re-commits local over the server head (#367).
  private async surfaceConflictFile(
    path: string,
    head: { path_hash: string; version: number },
    keys: VaultKeys,
    state: StateDB,
  ): Promise<void> {
    const serverVersion = await this.fetchHead(head.path_hash);
    if (!serverVersion) return;
    const serverMeta = await decryptMetadata(
      b64decode(serverVersion.enc_metadata),
      keys,
      head.path_hash,
    );
    const serverBody = await reassemble(
      serverVersion.chunk_hashes,
      keys,
      (hash: string) => this.deps.transport.getBlob(hash),
      serverMeta.plaintext_hash,
    );
    const localBody = await this.deps.vault.adapter.readBinary(path).then(toUint8Array).catch(() =>
      new Uint8Array(0)
    );
    await surfaceConflict(
      {
        path,
        pathHash: head.path_hash,
        serverContent: serverBody,
        localContent: localBody,
        serverVersion: head.version,
        chunkHashes: serverVersion.chunk_hashes,
        reason: "retry_limit",
      },
      { vault: this.deps.vault, state, deviceName: this.deps.getDeviceName() },
    );
    this.deps.recordActivity?.({ path, kind: "conflict", deviceId: serverVersion.device_id });
    this.deps.onStatusUpdate?.("conflict", this.getConflictCount());
    // Clear localEditPaths: the conflict has been surfaced, the path is no longer
    // in a "pending commit" state. Subsequent versions should apply normally.
    this.deps.localEditPaths.delete(path);
  }

  private async resolveServerVersion(
    head: { path_hash: string; version: number },
  ): Promise<ServerVersion | null> {
    const cached = this.deps.versionCache.get(`${head.path_hash}:${head.version}`) ?? null;
    if (cached) return cached;
    return await this.fetchHead(head.path_hash);
  }

  private async runMerge(
    path: string,
    serverVersion: ServerVersion,
    keys: VaultKeys,
    state: StateDB,
  ): Promise<MergeResult> {
    const local = state.getLocalFile(path);
    // For a delete/modify conflict the local file is already gone from disk, so
    // readBinary throws (#110). Treat a missing local file as empty and let the
    // merge resolve it (server content wins / conflict file) instead of crashing.
    const body = await this.deps.vault.adapter.readBinary(path).then(toUint8Array).catch(() =>
      new Uint8Array(0)
    );
    const mime = detectMime(path);
    return orchestrateMerge(
      {
        pathHash: local?.path_hash ?? hashPathHex(keys.mac_key, path),
        path,
        mime,
        local: body,
        localVersion: local?.last_seen_version ?? null,
        // #583: a carried row (version 0) has no version on this path: it must go
        // straight to the base-hash rule, not the #549 device-authored fallback.
        carried: local?.last_seen_version === 0,
        serverVersion,
      },
      {
        vault: this.deps.vault,
        transport: this.deps.transport,
        keys,
        state,
        deviceName: this.deps.getDeviceName(),
        deviceId: this.deps.deviceId,
        recordActivity: this.deps.recordActivity,
        commitMerged: async (p: string, merged: Uint8Array, parentVersion: number) => {
          // Update last_seen_version so commit uses the correct parent, and stop a closed
          // row claiming a delete: the merged bytes are on disk, so a resolution racing
          // this one must not read the row as a tombstone and overwrite them (#590). The
          // hash stays the row's until the commit records the accepted version.
          // A missing row (lost local-files.json, #549) is created from the merge input,
          // committing without it would send parent_version 0.
          const local = state.getLocalFile(p);
          if (local) {
            state.upsertLocalFile({ ...local, deleted: false, last_seen_version: parentVersion });
          } else {
            // Record the file's real disk mtime: the reconciler compares it
            // against the row, and a Date.now() here would look like a drift
            // and re-commit the just-merged content (#549).
            const stat = await this.deps.vault.adapter.stat(p);
            state.upsertLocalFile({
              path: p,
              path_hash: hashPathHex(keys.mac_key, p),
              size: merged.length,
              mtime: stat?.mtime ?? Date.now(),
              plaintext_hash: blake3Hex(normalizeForHash(p, merged)),
              last_seen_version: parentVersion,
              chunk_hashes: [],
            });
          }
          await commitFileBytes(p, merged, Date.now(), {
            vault: this.deps.vault,
            state,
            keys,
            transport: this.deps.transport,
            // This resolution owns the path: a rejected merge-commit must not start a
            // second one from inside it. The merged bytes are on disk with the row's old
            // hash, so the next reconcile re-commits them and resolves then if needed.
            onConflict: (conflictPath: string) =>
              log.info("merged commit rejected, retrying on the next reconcile", {
                path: conflictPath,
              }),
            pendingRenameTarget: this.deps.pendingRenameTarget,
          }, { force: true });
        },
      },
    );
  }

  private recordConflict(mergeResult: MergeResult): void {
    if (mergeResult.kind === "conflict_file" && mergeResult.conflictPath) {
      this.deps.onStatusUpdate?.("conflict", this.getConflictCount());
    }
  }

  private async fetchHead(pathHash: string): Promise<ServerVersion | null> {
    for await (const head of this.deps.transport.getHeads(0)) {
      if (head.path_hash === pathHash) {
        return headToServerVersion(head, this.deps.vaultId);
      }
    }
    return null;
  }
}
