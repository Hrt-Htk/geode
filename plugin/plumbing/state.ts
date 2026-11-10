import { withTimeout } from "./timeout.ts";
import { windowGlobal } from "./window.ts";

export interface LocalFileRow {
  path: string;
  path_hash: string;
  size: number;
  mtime: number;
  plaintext_hash: string;
  last_seen_version: number;
  chunk_hashes: string[];
  deleted: boolean;
}

function parseLocalFileRow(obj: Record<string, unknown>): LocalFileRow {
  return {
    path: obj.path as string,
    path_hash: obj.path_hash as string,
    size: obj.size as number,
    mtime: obj.mtime as number,
    plaintext_hash: obj.plaintext_hash as string,
    last_seen_version: obj.last_seen_version as number,
    chunk_hashes: obj.chunk_hashes as string[],
    deleted: obj.deleted as boolean,
  };
}

/** #59: one write of bytes this device did not type (a download, a merge result, a restore,
 * a kept sibling, a backup copy), recorded immediately before the write starts. */
export interface InFlightWrite {
  path: string;
  path_hash: string;
  /** The identity hash the file's bytes have once the write lands (or not at all when the
   * disk still holds a torn prefix). */
  expected_plaintext_hash: string;
}

export function openStateDB(
  persistedRows?: LocalFileRow[] | null,
  persistedCursor?: number | null,
  persistedLastBackupAt?: number | null,
  interruptedWrites?: InFlightWrite[] | null,
): StateDB {
  const state = new StateDB(interruptedWrites ?? undefined);
  if (persistedRows && Array.isArray(persistedRows)) {
    for (const row of persistedRows) {
      state.upsertLocalFile(parseLocalFileRow(row as unknown as Record<string, unknown>));
    }
  }
  if (typeof persistedCursor === "number" && persistedCursor > 0) {
    state.updateSyncCursor(persistedCursor);
  }
  if (typeof persistedLastBackupAt === "number" && persistedLastBackupAt > 0) {
    // Seed via the public record path (no persist hook is wired at open, so
    // no write fires); applies the same max rule as live backups.
    state.recordBackup(persistedLastBackupAt);
  }
  return state;
}

export class StateDB {
  private localFiles = new Map<string, LocalFileRow>();
  private localFilesByHash = new Map<string, LocalFileRow>();
  private syncCursor = 0;
  private pendingSeqs = new Set<number>();
  private receivedSeqs = new Set<number>();
  private replayEnd = 0;
  private replayComplete = false;
  private lastBackupAt = 0;
  private lastStampWriteAt = 0;

  private persist: ((json: string) => void) | null = null;
  private syncCursorPersist: ((json: string) => void | Promise<void>) | null = null;
  private persistTimer: number | null = null;
  /** #59: the writes of this session that have started and not returned, per path: their
   * bytes may be a fragment, so no pass may commit them and the apply must not read them as
   * an edit. Counted, because two writers can overlap on one path (an apply's download and a
   * commit-side merge write): the first to finish must not clear the other's record. */
  private readonly writing = new Map<string, { entry: InFlightWrite; writers: number }>();
  /** #59: what a killed session left: the start pass resolves each entry and then clears
   * them all, so no path is ever frozen by a record. */
  private readonly interrupted: Map<string, InFlightWrite>;
  /** Set by close(): a queued write that lands afterwards must not touch the state files
   * the next session (or a leave) owns. Re-attaching a state clears it again. */
  private closed = false;
  /** Set when a strict write timed out: the chain is wedged, so later callers fail at once
   * instead of each waiting out CURSOR_WAIT_MS (a drain of 45 files would spend 7 minutes
   * doing nothing). Cleared by the next write that lands. */
  private cursorStuck = false;
  /** Cursor writes run one at a time, in order: a slow one can never land after a newer
   * one and put a cleared record back. */
  private cursorWrites: Promise<void> = Promise.resolve();

  constructor(interruptedWrites: InFlightWrite[] = []) {
    this.interrupted = new Map(interruptedWrites.map((entry) => [entry.path_hash, entry]));
  }

  getLocalFile(path: string): LocalFileRow | null {
    return this.localFiles.get(path) ?? null;
  }

  getLocalFileByHash(pathHash: string): LocalFileRow | null {
    return this.localFilesByHash.get(pathHash) ?? null;
  }

  getAllLocalFiles(): Map<string, LocalFileRow> {
    return new Map(this.localFiles);
  }

  upsertLocalFile(row: Omit<LocalFileRow, "deleted"> & { deleted?: boolean }): void {
    const deleted = row.deleted ?? false;
    const fullRow: LocalFileRow = {
      path: row.path,
      path_hash: row.path_hash,
      size: row.size,
      mtime: row.mtime,
      plaintext_hash: row.plaintext_hash,
      last_seen_version: row.last_seen_version,
      chunk_hashes: row.chunk_hashes ?? [],
      deleted,
    };
    const existing = this.localFiles.get(row.path);
    if (existing && existing.path_hash !== row.path_hash) {
      this.localFilesByHash.delete(existing.path_hash);
    }
    this.localFiles.set(row.path, fullRow);
    this.localFilesByHash.set(row.path_hash, fullRow);
    this.schedulePersist();
  }

  /** A name the server closed at `version` (a delete or a rename marker): the row is
   * deleted, so nothing resurrects it. Plain upsert: no temp-file dance (#181). */
  closeLocalRow(path: string, pathHash: string, version: number): void {
    this.upsertLocalFile({
      path,
      path_hash: pathHash,
      size: 0,
      mtime: Date.now(),
      plaintext_hash: "",
      last_seen_version: version,
      chunk_hashes: [],
      deleted: true,
    });
  }

  updateSyncCursor(seq: number): void {
    // Absolute setter (load / recovery jump). A jump invalidates any parked
    // pending fragments: they refer to an older, now-irrelevant prefix.
    this.syncCursor = seq;
    this.pendingSeqs.clear();
    this.receivedSeqs.clear();
    this.replayEnd = seq;
    this.replayComplete = true;
    void this.flushCursor({});
  }

  // Start a new connection's replay. current_seq is the vault's max seq at
  // handshake (hello_ack.seq); heads are never compacted, so it always exists and
  // the server replays every existing seq ≤ it. Reset the per-connection received
  // set and completion marker so stale state from the previous connection can't
  // cause a skip. If there is nothing to replay (current_seq ≤ cursor), the
  // replay is already complete.
  beginReplay(currentSeq: number): void {
    this.receivedSeqs.clear();
    this.replayEnd = currentSeq;
    this.replayComplete = currentSeq <= this.syncCursor;
  }

  // Record that the server actually streamed this seq (handleVersion). The
  // server replays ascending and sends every EXISTING seq, so once a higher seq
  // is received, a never-received seq below it is a permanent compaction gap. The
  // replay is complete only once the replay end (current_seq) is itself received,
  // so at that moment any seq ≤ current_seq never received is a genuine gap.
  noteReceived(seq: number): void {
    if (seq > this.syncCursor) this.receivedSeqs.add(seq);
    if (seq === this.replayEnd) this.replayComplete = true;
  }

  // Record a durably-accounted seq (applied / skipped / our own commit). The
  // persisted cursor is the TOP of the contiguous run from syncCursor; an
  // un-accounted seq halts the prefix no matter what completes later, so a
  // transient apply failure can never be leap-frogged and lost on reconnect.
  // A seq that was NEVER received and is below the replay end is a compaction gap
  // the server will never resend (#369): but ONLY once the replay is complete
  // (current_seq received); before that, a never-received seq is just an
  // in-flight replay tail that must not be skipped. Never skip beyond the replay
  // end. A received but un-applied seq stays in receivedSeqs and halts the run.
  /** Keep the cursor behind `seq`: a version was received but deliberately not applied
   * (a pending rename deferred it), so no later version may advance past it and a
   * reconnect (or a restart) re-delivers it (#583). */
  holdSyncCursor(seq: number): void {
    this.receivedSeqs.delete(seq);
  }

  advanceSyncCursor(seq: number): void {
    if (seq <= this.syncCursor) return;
    this.pendingSeqs.add(seq);
    let changed = false;
    for (;;) {
      const next = this.syncCursor + 1;
      if (this.pendingSeqs.has(next)) {
        this.syncCursor++;
        this.pendingSeqs.delete(next);
        this.receivedSeqs.delete(next);
        changed = true;
      } else if (
        !this.receivedSeqs.has(next) && this.replayComplete && next <= this.replayEnd
      ) {
        this.syncCursor++;
        this.receivedSeqs.delete(next);
        changed = true;
      } else {
        break;
      }
    }
    if (changed) void this.flushCursor({});
  }

  getSyncCursor(): number {
    return this.syncCursor;
  }

  recordBackup(at: number): number {
    const next = Math.max(this.lastBackupAt, at);
    if (next !== this.lastBackupAt) {
      this.lastBackupAt = next;
      const now = Date.now();
      if (now - this.lastStampWriteAt >= LAST_BACKUP_STAMP_THROTTLE_MS) {
        this.lastStampWriteAt = now;
        void this.flushCursor({});
      }
    }
    return next;
  }

  serializeLocalFiles(): string {
    return JSON.stringify([...this.localFiles.values()]);
  }

  serializeSyncCursor(): string {
    const cursor: {
      vault_id: string;
      last_seen_seq: number;
      last_backup_at: number;
      in_flight_apply?: InFlightWrite[];
    } = {
      vault_id: "default",
      last_seen_seq: this.syncCursor,
      last_backup_at: this.lastBackupAt,
    };
    // Only while something is writing: an idle cursor file keeps its three keys.
    const inFlight = this.inFlightWrites();
    if (inFlight.length > 0) cursor.in_flight_apply = inFlight;
    return JSON.stringify(cursor);
  }

  setPersist(fn: (json: string) => void): void {
    this.persist = fn;
    this.closed = false;
  }

  setSyncCursorPersist(fn: (json: string) => void | Promise<void>): void {
    this.syncCursorPersist = fn;
    this.closed = false;
  }

  /** #59: record a write immediately before it starts, awaited. Rejects when the record
   * could not be written: bytes must not be written that nothing could finish. */
  async beginWrite(entry: InFlightWrite): Promise<void> {
    if (this.cursorStuck) {
      throw new Error("state write: the cursor chain is wedged, nothing can be recorded");
    }
    const pathHash = entry.path_hash;
    const existing = this.writing.get(pathHash);
    if (existing) existing.writers++;
    else this.writing.set(pathHash, { entry, writers: 1 });
    try {
      await this.flushCursor({ strict: true });
    } catch (error) {
      if (existing) existing.writers--;
      else this.writing.delete(pathHash);
      throw error;
    }
  }

  /** #59: this writer returned. The record goes when the last writer on the path does. */
  async endWrite(pathHash: string): Promise<void> {
    const existing = this.writing.get(pathHash);
    if (existing === undefined) return;
    if (existing.writers > 1) {
      existing.writers--;
      return;
    }
    this.writing.delete(pathHash);
    await this.flushCursor({});
  }

  /** #59: what a killed session left, as the start pass reads it (once, at open). */
  getInterruptedWrites(): InFlightWrite[] {
    return [...this.interrupted.values()];
  }

  /** #59: these entries are resolved (any of the five outcomes). One the server could not
   * answer for stays recorded, and with it gated, until a later connection resolves it. */
  async clearInterruptedWrites(resolved: InFlightWrite[]): Promise<void> {
    let cleared = false;
    for (const entry of resolved) {
      if (this.interrupted.delete(entry.path_hash)) cleared = true;
    }
    if (cleared) await this.flushCursor({});
  }

  /** #59: may this path's disk bytes be a fragment right now? One predicate for the apply
   * and the reconciler gate: a write of this session that has not returned, or an entry the
   * current start has not resolved yet. */
  isTorn(pathHash: string): boolean {
    return this.writing.has(pathHash) || this.interrupted.has(pathHash);
  }

  /** The record the cursor file carries: this session's writes over the previous one's. */
  private inFlightWrites(): InFlightWrite[] {
    const entries = new Map(this.interrupted);
    for (const [pathHash, { entry }] of this.writing) entries.set(pathHash, entry);
    return [...entries.values()];
  }

  /** Wait until every queued cursor write has landed: a leave must not delete the state
   * files under a write still in the queue. Bounded, so a dead bridge cannot hold a leave. */
  async drainCursorWrites(): Promise<void> {
    await withTimeout(this.cursorWrites, CURSOR_WAIT_MS, "state write").catch(() => {});
  }

  /** Queue a cursor write in the ONE chain, so the file always reflects the last state. The
   * chain never skips a write: the next one starts only once this one settles, which is what
   * keeps a slow write from landing after a newer one. A caller waits at most
   * CURSOR_WAIT_MS and then fails closed (`strict`) or moves on. `final` is the write
   * close() still owes after the hook is gone. */
  private flushCursor(opts: { strict?: boolean; final?: boolean }): Promise<void> {
    const hook = this.syncCursorPersist;
    if (hook === null) {
      // Nothing can be persisted, so nothing can be recorded: fail closed rather than write
      // bytes whose interruption nothing could resolve.
      return opts.strict === true
        ? Promise.reject(new Error("state write: no persistence wired"))
        : Promise.resolve();
    }
    const run = this.cursorWrites.then(() => {
      if (this.closed && opts.final !== true) return;
      return hook(this.serializeSyncCursor());
    }).then(
      (value) => {
        this.cursorStuck = false;
        return value;
      },
      (error) => {
        throw error;
      },
    );
    this.cursorWrites = run.catch(() => {});
    const waited = withTimeout(run, CURSOR_WAIT_MS, "state write").catch((error) => {
      // A write that outlived the wait wedges the chain: every later caller would wait it
      // out again for nothing.
      this.cursorStuck = true;
      throw error;
    });
    return opts.strict === true ? waited : waited.catch(() => {});
  }

  private schedulePersist(): void {
    if (!this.persist) return;
    // Trailing throttle (#328): the first change arms a timer; in-window changes
    // don't re-arm; the timer fires once writing the CURRENT state, then the
    // next change re-arms: O(drain-seconds) writes, not O(files). The sync
    // cursor is NOT throttled: it persists immediately so a crash can't leave a
    // stale cursor that replays past an applied edit and overwrites it.
    if (this.persistTimer) return;
    this.persistTimer = windowGlobal.setTimeout(() => {
      this.persistTimer = null;
      try {
        this.persist?.(this.serializeLocalFiles());
      } catch {
        // non-critical
      }
    }, STATE_PERSIST_INTERVAL_MS);
  }

  close(): void {
    if (this.persistTimer) {
      windowGlobal.clearTimeout(this.persistTimer);
      this.persistTimer = null;
      try {
        this.persist?.(this.serializeLocalFiles());
      } catch {
        // non-critical
      }
    }
    // The final cursor write still lands; every write queued before it is superseded by
    // it, and any queued or later one is dropped so nothing writes stale state over the
    // next session's files (#328).
    void this.flushCursor({ final: true });
    this.closed = true;
    this.persist = null;
    this.syncCursorPersist = null;
  }
}

/** How long a caller waits for a state write before it moves on. A small JSON through the
 * mobile FS bridge is milliseconds; a write that outlives this is a dead bridge, and the
 * sync must fail closed rather than wait on it (the write keeps its place in the chain). */
const CURSOR_WAIT_MS = 10_000;

// local-files persistence trailing-throttle window (#328).
const STATE_PERSIST_INTERVAL_MS = 2000;

// Stamp-only cursor writes: coalesce to one per minute so a synced vault's
// every-clean-cycle backup stamp doesn't rewrite the cursor file each cycle.
const LAST_BACKUP_STAMP_THROTTLE_MS = 60_000;
