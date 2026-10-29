import { log } from "../plumbing/log.ts";

export const COMMIT_TIMEOUT = 30_000;

export interface CommitRequest {
  path_hash: string;
  parent_version: number | null;
  enc_metadata: string;
  chunk_hashes: string[];
  deleted: boolean;
  path_ciphertext?: string;
  /** #583: RENAME_MARKER | RENAME_NOTE; absent = 0. */
  rename_mark?: number;
}

export type CommitResult =
  | { kind: "ack"; seq: number; version: number }
  | { kind: "conflict"; path_hash: string; parent_version: number; reason: string }
  | { kind: "error"; message: string };

type PendingCommit = { req: CommitRequest; resolve: (r: CommitResult) => void };

export interface CommitChannelEnv {
  // Send one client_commit on the live socket; false when the socket is not
  // open (the channel requeues the commit at the front of the queue).
  sendCommit: (req: CommitRequest) => boolean;
  isLive: () => boolean;
  getCommitTimeoutMs: () => number;
  // Timeout path: drop the current socket so a late ack for the timed-out
  // commit can never reach the connection the next commit is sent on; the
  // socket's close handler reconnects.
  closeSocket: () => void;
}

/**
 * The serial commit channel: an ordered queue drained one commit at a time,
 * with ack correlation to the single in-flight commit and a timeout that
 * forces a reconnect. Acks carry no commit id (#359), so a result must only
 * ever settle the in-flight commit, never a queued, unsent one.
 */
export class CommitChannel {
  private pendingCommits: PendingCommit[] = [];
  private commitInFlight: PendingCommit | null = null;
  private commitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private env: CommitChannelEnv) {}

  get pendingCount(): number {
    return this.pendingCommits.length;
  }

  commit(req: CommitRequest): Promise<CommitResult> {
    return new Promise((resolve) => {
      this.pendingCommits.push({ req, resolve });
      log.debug("commit queued", {
        path_hash: req.path_hash,
        pending: this.pendingCommits.length,
      });
      this.drain();
    });
  }

  // Server result (ack/conflict/error) for the in-flight commit.
  onResult(result: CommitResult): void {
    if (!this.settle(result)) log.debug("commit result with no commit in flight", { result });
  }

  // A socket close settles the in-flight commit immediately, not after the
  // commit timeout (#359).
  onSocketClosed(): void {
    this.settle({ kind: "error", message: "socket closed" });
  }

  drain(): void {
    if (this.commitInFlight) {
      log.debug("drainCommits skipped: commit in flight", {
        pending: this.pendingCommits.length,
      });
      return;
    }
    if (this.pendingCommits.length === 0) return;
    if (!this.env.isLive()) {
      log.debug("drainCommits skipped: not live", {
        pending: this.pendingCommits.length,
      });
      return;
    }
    const pending = this.pendingCommits.shift()!;
    if (!this.env.sendCommit(pending.req)) {
      this.pendingCommits.unshift(pending);
      this.cancelCommitTimeout();
      log.warn("drainCommits: ws not open, requeued", {
        pending: this.pendingCommits.length,
      });
      return;
    }
    this.commitInFlight = pending;
    this.armCommitTimeout();
  }

  // #616: a commit left in flight here is never acked; settle it so the queue retries.
  stop(): void {
    this.settle({ kind: "error", message: "socket closed" });
  }

  private settle(result: CommitResult): boolean {
    this.cancelCommitTimeout();
    if (!this.commitInFlight) return false;
    this.commitInFlight.resolve(result);
    this.commitInFlight = null;
    return true;
  }

  private armCommitTimeout(): void {
    this.cancelCommitTimeout();
    this.commitTimer = setTimeout(() => {
      log.warn("commit timeout", { path_hash: this.commitInFlight?.req.path_hash });
      this.settle({ kind: "error", message: "commit timeout" });
      this.env.closeSocket();
    }, this.env.getCommitTimeoutMs());
  }

  private cancelCommitTimeout(): void {
    if (this.commitTimer) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
    }
  }
}
