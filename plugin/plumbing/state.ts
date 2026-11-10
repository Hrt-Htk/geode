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

export function openStateDB(
  persistedRows?: LocalFileRow[] | null,
  persistedCursor?: number | null,
  persistedLastBackupAt?: number | null,
  persistedInFlightApply?: string[] | null,
): StateDB {
  const state = new StateDB(persistedInFlightApply ?? undefined);
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
  /** #59: the paths whose write may have left a fragment (this session), so no pass may
   * commit them: a batch adds its paths before writing, and only a write that landed, or a
   * version that turned out not to need one, leaves the set. */
  private readonly writing = new Set<string>();
  /** #59: what the cursor file must carry for the next start: every path a batch has not
   * confirmed, whether or not it ever wrote. Separate from `writing` because a deferred or
   * out-of-scope path wrote nothing (so it must not block a pass) yet is still owed. */
  private readonly pending = new Set<string>();
  /** Set by close(): a queued write that lands afterwards must not touch the state files
   * the next session (or a leave) owns. */
  private closed = false;
  /** #59: the paths a batch of the last session was writing when the app died: their disk
   * bytes are this device's own unfinished write. Cleared only once each is resolved. */
  private readonly interrupted: Set<string>;
  /** Cursor writes run one at a time, in order: a slow one can never land after a newer
   * one and put a cleared record back. */
  private cursorWrites: Promise<void> = Promise.resolve();

  constructor(interruptedApply: string[] = []) {
    this.interrupted = new Set(interruptedApply);
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
    void this.flushCursor();
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
    if (changed) void this.flushCursor();
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
        void this.flushCursor();
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
      in_flight_apply?: string[];
    } = {
      vault_id: "default",
      last_seen_seq: this.syncCursor,
      last_backup_at: this.lastBackupAt,
    };
    // Only while a batch is writing: an idle cursor file keeps its three keys.
    const inFlight = this.getInFlightApply();
    if (inFlight.length > 0) cursor.in_flight_apply = inFlight;
    return JSON.stringify(cursor);
  }

  setPersist(fn: (json: string) => void): void {
    this.persist = fn;
  }

  setSyncCursorPersist(fn: (json: string) => void | Promise<void>): void {
    this.syncCursorPersist = fn;
  }

  /** #59: the paths a download batch is about to write, flushed BEFORE its first write so
   * a kill mid-write leaves a record instead of a fragment with no row. Rejects when the
   * record could not be written: a batch must not write bytes it could not record. */
  async beginApply(pathHashes: string[]): Promise<void> {
    if (pathHashes.length === 0) return;
    const added = pathHashes.filter((pathHash) => !this.pending.has(pathHash));
    for (const pathHash of pathHashes) {
      this.pending.add(pathHash);
      this.writing.add(pathHash);
    }
    try {
      await this.flushCursor(true);
    } catch (error) {
      for (const pathHash of added) {
        this.pending.delete(pathHash);
        this.writing.delete(pathHash);
      }
      throw error;
    }
  }

  /** #59: these paths' downloads are accounted for (written, deleted, or already tracked):
   * the only way a record is dropped. */
  async endApply(doneHashes: string[]): Promise<void> {
    let cleared = false;
    for (const pathHash of doneHashes) {
      if (this.writing.delete(pathHash)) cleared = true;
      if (this.pending.delete(pathHash)) cleared = true;
      if (this.interrupted.delete(pathHash)) cleared = true;
    }
    if (cleared) await this.flushCursor();
  }

  /** #59: this path's version was deferred or out of scope, so nothing was written: it
   * stops blocking a pass, and stays owed in the record for the next start. */
  releaseWrite(pathHash: string): void {
    this.writing.delete(pathHash);
  }

  /** #59: every path a download batch is writing or left unfinished last session. */
  getInFlightApply(): string[] {
    return [...new Set([...this.interrupted, ...this.pending])];
  }

  /** #59: paths read back from a killed session, whose disk bytes may be a fragment: the
   * apply writes their head over it instead of merging or keeping it. */
  getInterruptedApply(): string[] {
    return [...this.interrupted];
  }

  isInterrupted(pathHash: string): boolean {
    return this.interrupted.has(pathHash);
  }

  /** #59: may this path's disk bytes be a fragment? No pass may commit or close it. */
  isWriting(pathHash: string): boolean {
    return this.writing.has(pathHash) || this.interrupted.has(pathHash);
  }

  /** Wait until every queued cursor write has landed: a leave must not delete the state
   * files under a write still in the queue. */
  async drainCursorWrites(): Promise<void> {
    for (;;) {
      const pending = this.cursorWrites;
      await pending;
      if (pending === this.cursorWrites) return;
    }
  }

  /** Queue a cursor write that serializes the state as it is when it runs, so the file
   * always reflects the last state. `strict` propagates the write's failure; `final` is
   * the one write close() still owes after the hook is gone. A bounded write: a bridge that
   * stops answering must not hold the queue (and with it every later apply) forever. */
  private flushCursor(strict = false, final = false): Promise<void> {
    const hook = this.syncCursorPersist;
    if (hook === null) return Promise.resolve();
    const run = this.cursorWrites.then(() => {
      if (this.closed && !final) return;
      return withTimeout(
        Promise.resolve(hook(this.serializeSyncCursor())),
        CURSOR_WRITE_TIMEOUT_MS,
        "state write",
      );
    });
    this.cursorWrites = run.catch(() => {});
    return strict ? run : run.catch(() => {});
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
    void this.flushCursor(false, true);
    this.closed = true;
    this.persist = null;
    this.syncCursorPersist = null;
  }
}

/** How long a state write may take before the queue moves on without it. A small JSON
 * through the mobile FS bridge is milliseconds; a write that outlives this is a dead
 * bridge, and the batch must fail closed rather than freeze the sync. */
const CURSOR_WRITE_TIMEOUT_MS = 10_000;

// local-files persistence trailing-throttle window (#328).
const STATE_PERSIST_INTERVAL_MS = 2000;

// Stamp-only cursor writes: coalesce to one per minute so a synced vault's
// every-clean-cycle backup stamp doesn't rewrite the cursor file each cycle.
const LAST_BACKUP_STAMP_THROTTLE_MS = 60_000;
