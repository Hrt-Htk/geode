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
): StateDB {
  const state = new StateDB();
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
  private syncCursorPersist: ((json: string) => void) | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

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
    try {
      this.syncCursorPersist?.(this.serializeSyncCursor());
    } catch {
      // non-critical
    }
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
    if (changed) {
      try {
        this.syncCursorPersist?.(this.serializeSyncCursor());
      } catch {
        // non-critical
      }
    }
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
        try {
          this.syncCursorPersist?.(this.serializeSyncCursor());
        } catch {
          // non-critical
        }
      }
    }
    return next;
  }

  serializeLocalFiles(): string {
    return JSON.stringify([...this.localFiles.values()]);
  }

  serializeSyncCursor(): string {
    return JSON.stringify({
      vault_id: "default",
      last_seen_seq: this.syncCursor,
      last_backup_at: this.lastBackupAt,
    });
  }

  setPersist(fn: (json: string) => void): void {
    this.persist = fn;
  }

  setSyncCursorPersist(fn: (json: string) => void): void {
    this.syncCursorPersist = fn;
  }

  private schedulePersist(): void {
    if (!this.persist) return;
    // Trailing throttle (#328): the first change arms a timer; in-window changes
    // don't re-arm; the timer fires once writing the CURRENT state, then the
    // next change re-arms: O(drain-seconds) writes, not O(files). The sync
    // cursor is NOT throttled: it persists immediately so a crash can't leave a
    // stale cursor that replays past an applied edit and overwrites it.
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
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
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      try {
        this.persist?.(this.serializeLocalFiles());
      } catch {
        // non-critical
      }
    }
    try {
      this.syncCursorPersist?.(this.serializeSyncCursor());
    } catch {
      // non-critical
    }
    // Null the hooks so a drain still in flight after dispose can't re-arm a
    // timer / write stale state over the next session's files (#328).
    this.persist = null;
    this.syncCursorPersist = null;
  }
}

// local-files persistence trailing-throttle window (#328).
const STATE_PERSIST_INTERVAL_MS = 2000;

// Stamp-only cursor writes: coalesce to one per minute so a synced vault's
// every-clean-cycle backup stamp doesn't rewrite the cursor file each cycle.
const LAST_BACKUP_STAMP_THROTTLE_MS = 60_000;
