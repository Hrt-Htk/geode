import { isMarkdownPath, normalizeForHash } from "../../core/normalize.ts";
import { blake3Hex } from "../../core/hash.ts";
import { mapWithConcurrency } from "../../core/concurrency.ts";
import { RENAME_MARKER } from "../../core/protocol.ts";
import { toUint8Array } from "../plumbing/bytes.ts";
import { log } from "../plumbing/log.ts";
import { type LocalFileRow, StateDB } from "../plumbing/state.ts";
import { enumerateDisk } from "./enumerate-disk.ts";
import { existsOnDisk, nextRenameId, type RenameLink } from "./commit.ts";
import { type MassDeleteGuard, shouldHoldMassDelete } from "./mass-delete-hold.ts";

const RECONCILE_INTERVAL = 5 * 60 * 1000;
/** Head lookups one delete pass may have in flight: each is a server round trip. */
const HEAD_LOOKUP_LIMIT = 8;

type Vault = {
  getFiles?: () => Array<{ path: string; children?: unknown[] }>;
  getAllLoadedFiles: () => Array<{ path: string; children?: unknown[] }>;
  adapter: {
    // Real Obsidian resolves null for a missing path (verified desktop +
    // Android, #505); a throw also means absent.
    stat: (path: string) => Promise<{ size: number; mtime: number } | null>;
    readBinary: (path: string) => Promise<Uint8Array>;
    list?: (path: string) => Promise<{ files: string[]; folders: string[] }>;
  };
};

export type ReconcileOp = RenameLink & {
  kind: "create" | "modify" | "delete";
  path: string;
};

export class Reconciler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRun = 0;
  private isRunning = false;

  constructor(
    private vault: Vault,
    private state: StateDB,
    private onOps: (ops: ReconcileOp[]) => void | Promise<void>,
    private isSyncable: (path: string) => boolean,
    private syncObsidianConfig = false,
    /** #601: the mass-delete guard: thresholds and what to do when it trips. */
    private guard?: MassDeleteGuard,
    private configDir = ".obsidian",
    /** #583: the server's head for a path, so a name it already closed as a rename is
     * never a delete candidate. */
    private renameHead?: (
      pathHash: string,
    ) => Promise<{ rename_mark?: number } | null>,
    /** #583: the destination of a rename this device already queued for `path` (the
     * commit queue or the event debounce). */
    private pendingRenameTarget?: (path: string) => string | undefined,
    /** #609: a plain delete of `path` this device already queued (the commit queue or
     * the event debounce). */
    private pendingDelete?: (path: string) => boolean,
  ) {}

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.timer = setInterval(() => {
      void this.run();
    }, RECONCILE_INTERVAL);
    void this.run();
  }

  stop(): void {
    this.isRunning = false;
    if (this.timer) clearInterval(this.timer);
  }

  setSyncObsidianConfig(value: boolean): void {
    this.syncObsidianConfig = value;
  }

  async run(force = false): Promise<void> {
    if (this.isRunning === false) return;
    const now = Date.now();
    if (!force && now - this.lastRun < RECONCILE_INTERVAL / 2) return;
    this.lastRun = now;

    try {
      await this.reconcile();
    } catch (err) {
      log.error("reconcile failed", { error: String(err) });
    }
  }

  private async reconcile(): Promise<void> {
    const localFiles = this.state.getAllLocalFiles();
    const ops: ReconcileOp[] = [];
    const creates: string[] = [];

    // Enumerate disk via adapter.list (preferred) with fallback to getAllLoadedFiles.
    // When config sync is on, also enumerate the .obsidian subtree: Obsidian's
    // getAllLoadedFiles() hides config files from the file API.
    const diskPaths = new Set<string>();
    await enumerateDisk(this.vault, "", diskPaths, { skipDir: this.configDir });
    if (this.syncObsidianConfig) {
      try {
        await enumerateDisk(this.vault, this.configDir, diskPaths, {});
      } catch {
        // .obsidian/ directory doesn't exist or can't be read: treat as empty
      }
    }

    for (const normPath of diskPaths) {
      if (!this.isSyncable(normPath)) continue;
      await this.diffPath(normPath, localFiles, ops, creates);
    }

    const deleteCandidates = await this.collectDeleteCandidates(diskPaths, localFiles);
    // #583 (decision 5): one create and one delete of identical content in one pass is
    // a rename the event stream never saw. Paired BEFORE the guard, so a folder renamed
    // while the app was closed links file by file instead of duplicating every note.
    const pairs = await this.pairRenames(creates, deleteCandidates, localFiles);
    const unpairedDeletes = deleteCandidates.filter((path) => !pairs.has(path));

    // Mass-delete guard on the UNPAIRED deletes: a paired one is accounted for. When it
    // trips the WHOLE pass waits (decision 10): letting the creates land first is what
    // duplicated a renamed folder.
    if (
      await this.holdMassDelete(
        unpairedDeletes,
        localFiles,
        pairs.size,
        creates.length - pairs.size,
      )
    ) {
      return;
    }

    const pairedTargets = new Set(pairs.values());
    for (const [from, to] of pairs) {
      const renameId = nextRenameId();
      // Marker first: the note reads the marker's version as its link ceiling.
      ops.push({ kind: "delete", path: from, renameId, renamedTo: to });
      ops.push({ kind: "create", path: to, renameId, renamedFrom: from });
    }
    for (const path of creates) {
      if (!pairedTargets.has(path)) ops.push({ kind: "create", path });
    }
    for (const path of unpairedDeletes) {
      ops.push({ kind: "delete", path });
    }

    // #622: stopped mid-pass (reconnect, pause): the snapshot this pass read is stale
    // (a replay flush has landed since) and the next pass re-derives it.
    if (!this.isRunning) return;
    if (ops.length > 0) {
      log.info("reconciler found ops", {
        count: ops.length,
        ops: ops.map((o) => `${o.kind}:${o.path}`),
      });
    } else {
      log.debug("reconciler found no ops");
    }
    await this.onOps(ops);
  }

  /** #601: hold the whole pass when the guard trips (the held list goes with it). True =
   * the caller must stop: nothing in this pass may be emitted. */
  private async holdMassDelete(
    unpairedDeletes: string[],
    localFiles: Map<string, LocalFileRow>,
    pairedRenames: number,
    heldCreates: number,
  ): Promise<boolean> {
    const guard = this.guard;
    if (!guard) return false;
    const totalTracked = localFiles.size;
    const { minFiles, minPercent } = guard.thresholds();
    if (!shouldHoldMassDelete(unpairedDeletes.length, totalTracked, minFiles, minPercent)) {
      return false;
    }
    log.warn("reconciler blocked suspected mass-delete", {
      deleteCount: unpairedDeletes.length,
      totalTracked,
      pairedRenames,
      heldCreates,
    });
    await guard.onHold(
      unpairedDeletes.map((path) => ({ path, mtime: localFiles.get(path)?.mtime ?? 0 })),
      totalTracked,
    );
    return true;
  }

  /** #583 (decision 5): pair one create with one delete of identical content, only when
   * the match is unambiguous on both sides: exactly one delete and one create share that
   * hash this pass. Anything else (a copy then delete, a batch of identical notes) stays
   * a delete + a create. */
  private async pairRenames(
    creates: string[],
    deletes: string[],
    localFiles: Map<string, LocalFileRow>,
  ): Promise<Map<string, string>> {
    const pairs = new Map<string, string>();
    if (creates.length === 0 || deletes.length === 0) return pairs;
    const byHash = new Map<string, { created: string[]; deleted: string[] }>();
    const bucket = (hash: string) => {
      let entry = byHash.get(hash);
      if (!entry) byHash.set(hash, entry = { created: [], deleted: [] });
      return entry;
    };
    for (const path of deletes) {
      const hash = localFiles.get(path)?.plaintext_hash;
      if (hash) bucket(hash).deleted.push(path);
    }
    for (const path of creates) {
      const hash = await this.contentHash(path);
      if (hash) bucket(hash).created.push(path);
    }
    for (const { created, deleted } of byHash.values()) {
      if (created.length === 1 && deleted.length === 1) pairs.set(deleted[0], created[0]);
    }
    return pairs;
  }

  /** The identity hash a create would commit under (markdown normalized, exactly as
   * `commit` and the tracked rows compute it). Unreadable ⇒ not a rename candidate. */
  private async contentHash(path: string): Promise<string | null> {
    try {
      const raw = toUint8Array(await this.vault.adapter.readBinary(path));
      return blake3Hex(normalizeForHash(path, raw));
    } catch {
      return null;
    }
  }

  /** Tracked files missing from disk, verified gone by stat. Rows already marked
   * deleted and out-of-scope paths (#342: a local delete inside an excluded
   * folder must not propagate) are not candidates. */
  private async collectDeleteCandidates(
    diskPaths: Set<string>,
    localFiles: Map<string, LocalFileRow>,
  ): Promise<string[]> {
    const gone: { path: string; row: LocalFileRow }[] = [];
    for (const [path, row] of localFiles) {
      if (diskPaths.has(path)) continue;
      if (row.deleted) continue;
      if (!this.isSyncable(path)) continue;
      // The event layer already closes this name with its own marker: pairing the same
      // move again writes a second marker for one rename (the pass can run in the
      // window between the rename event and its queued ops landing).
      if (this.pendingRenameTarget?.(path) !== undefined) continue;
      // Its own queued plain delete already closes this name (#609): pairing it with a
      // create of the same bytes writes a second marker and steals that move's note.
      if (this.pendingDelete?.(path)) continue;

      // Stat-verify: the file might genuinely exist even if enumeration missed it.
      if (await existsOnDisk(path, this.vault.adapter)) continue;
      gone.push({ path, row });
    }
    // #583: the server already closed this name as a rename this device has not
    // applied: the move is recorded, so the name is no delete. One head per candidate
    // is a round trip, so bound them: a folder renamed elsewhere must not become N
    // serial requests on a phone.
    const checked = await mapWithConcurrency(
      gone,
      HEAD_LOOKUP_LIMIT,
      async ({ path, row }) => (await this.headIsMarker(row.path_hash)) ? null : path,
    );
    return checked.filter((path): path is string => path !== null);
  }

  private async headIsMarker(pathHash: string): Promise<boolean> {
    if (!this.renameHead) return false;
    try {
      return (await this.renameHead(pathHash))?.rename_mark === RENAME_MARKER;
    } catch {
      return false; // unreadable head: fall back to a plain delete, never to a lost one
    }
  }

  /**
   * Compare a file on disk against its tracked row; push a modify op (or an untracked
   * path onto `creates`, which the rename pairing may still claim). Shared by the vault
   * scan and the .obsidian config scan.
   */
  private async diffPath(
    normPath: string,
    localFiles: Map<string, LocalFileRow>,
    ops: ReconcileOp[],
    creates: string[],
  ): Promise<void> {
    const local = localFiles.get(normPath);
    if (!local || local.deleted) {
      // Untracked, or a name whose row closed (deleted or renamed away) with a file
      // back on it: a new generation, so a create: which a rename may claim as its
      // destination (#583 pairs a move onto a reused name too).
      creates.push(normPath);
      return;
    }

    const stat = await this.vault.adapter.stat(normPath);
    if (!stat) {
      // Vanished between enumeration and stat: it's a delete, not a modify.
      ops.push({ kind: "delete", path: normPath });
      return;
    }
    // #613: a row with no version of its own (a rename carried the edit here) is a
    // pending local edit until it commits: the mtime matches the row's own write, so
    // nothing else in this diff would ever notice the bytes. #697: unless the bytes are
    // still the ones the row was made from: a clean rename's destination, waiting for its
    // note, has nothing to commit.
    if (local.last_seen_version === 0) {
      if (await this.contentHash(normPath) !== local.plaintext_hash) {
        ops.push({ kind: "modify", path: normPath });
      }
      return;
    }

    const md = isMarkdownPath(normPath);
    const mtimeMatch = md
      ? stat.mtime === local.mtime
      : (stat.size === local.size && stat.mtime === local.mtime);
    if (mtimeMatch && !local.deleted) return;

    const raw = toUint8Array(await this.vault.adapter.readBinary(normPath));
    const body = normalizeForHash(normPath, raw);
    const hash = blake3Hex(body);
    if (hash === local.plaintext_hash && !local.deleted) {
      log.debug("reconciler mtime drift, content unchanged", {
        path: normPath,
        storedMtime: local.mtime,
        diskMtime: stat.mtime,
        mtimeDiff: stat.mtime - local.mtime,
      });
      this.state.upsertLocalFile({ ...local, mtime: stat.mtime });
      return;
    }

    ops.push({ kind: "modify", path: normPath });
  }
}
