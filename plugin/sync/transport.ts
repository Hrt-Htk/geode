import {
  ClientCommit,
  ClientHello,
  HeadRecord,
  PROTOCOL_VERSION,
  ServerMessage,
  UPDATE_REQUIRED,
  VersionRecord,
} from "../../core/protocol.ts";
import { log } from "../plumbing/log.ts";
import { wsBase } from "../plumbing/scheme.ts";
import {
  COMMIT_TIMEOUT,
  CommitChannel,
  type CommitRequest,
  type CommitResult,
} from "./commit-channel.ts";
import { HttpClient } from "./http-client.ts";

export type { CommitRequest, CommitResult };

const MAX_RECONNECT_DELAY = 60_000;
const INITIAL_RECONNECT_DELAY = 1_000;
const LIVE_REPLAY_TIMEOUT = 10_000;

export type TransportState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "syncing"
  | "live"
  | "blocked";

export class Transport extends EventTarget {
  private ws: WebSocket | null = null;
  private state: TransportState = "disconnected";
  private serverUrl = "";
  private vaultId = "";
  private deviceId = "";
  private deviceToken = "";
  private lastSeenSeq = 0;
  private cursorSink: ((seq: number) => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = INITIAL_RECONNECT_DELAY;
  private liveTargetSeq = 0;
  private liveTimer: ReturnType<typeof setTimeout> | null = null;
  private http!: HttpClient;
  private reconnectEnabled = false;
  private _commitTimeoutMs = COMMIT_TIMEOUT;
  private pluginVersion = "";
  private blocked = false;
  private serverVersion = "";
  private commitChannel = new CommitChannel({
    sendCommit: (req) => this.sendCommit(req),
    isLive: () => this.isLive(),
    getCommitTimeoutMs: () => this._commitTimeoutMs,
    closeSocket: () => this.ws?.close(),
  });

  start(
    serverUrl: string,
    vaultId: string,
    deviceId: string,
    deviceToken: string,
    lastSeenSeq: number,
    pluginVersion: string,
  ): void {
    this.reconnectEnabled = true;
    this.blocked = false;
    this.serverVersion = "";
    // Keep the raw serverUrl (wsBase/httpBase normalize and honor an explicit
    // scheme internally) so the transport connects with the scheme the user
    // picked, not the host heuristic's guess.
    this.serverUrl = serverUrl;
    this.vaultId = vaultId;
    this.deviceId = deviceId;
    this.deviceToken = deviceToken;
    this.lastSeenSeq = lastSeenSeq;
    this.pluginVersion = pluginVersion;
    this.http = new HttpClient(this.serverUrl, this.vaultId, this.deviceToken);
    this.setState("connecting");
    this.connect();
  }

  stop(): void {
    this.reconnectEnabled = false;
    this.cancelLiveTimeout();
    this.commitChannel.stop();
    this.cancelReconnect();
    this.ws?.close();
    this.ws = null;
    this.setState("disconnected");
  }

  retryNow(): void {
    if (this.state !== "disconnected" || !this.reconnectEnabled) return;
    this.cancelReconnect();
    this.reconnectDelay = INITIAL_RECONNECT_DELAY;
    this.setState("connecting");
    this.connect();
  }

  isLive(): boolean {
    return this.state === "live";
  }
  getState(): TransportState {
    return this.state;
  }
  getLastSeenSeq(): number {
    return this.lastSeenSeq;
  }

  // Rewind the in-memory cursor (used when a replay is interrupted before its
  // buffered versions are applied & flushed) so a reconnect re-replays the
  // un-applied tail from the persisted cursor instead of skipping past it.
  rewindLastSeen(seq: number): void {
    if (seq < this.lastSeenSeq) {
      this.lastSeenSeq = seq;
    }
  }

  setCursorSink(fn: (seq: number) => void): void {
    this.cursorSink = fn;
  }

  private bumpLastSeen(seq: number): void {
    // In-memory only: used by server_version, whose apply runs async and may
    // throw: we must NOT persist (sink) on receipt, or a failed apply would be
    // skipped past and permanently lost (#212). lastSeenSeq still drives the
    // go-live decision.
    if (seq > this.lastSeenSeq) {
      this.lastSeenSeq = seq;
    }
  }

  private bumpLastSeenAndSink(seq: number): void {
    if (seq > this.lastSeenSeq) {
      this.lastSeenSeq = seq;
      this.cursorSink?.(this.lastSeenSeq);
    }
  }

  private setState(next: TransportState): void {
    const prev = this.state;
    if (next !== prev) {
      log.debug("transport state transition", { from: prev, to: next });
    }
    if (next !== this.state && (next === "connected" || next === "live")) {
      log.info(next === "connected" ? "connected" : "sync live");
    }
    this.state = next;
    this.dispatchEvent(new CustomEvent("status", { detail: next }));
  }

  private connect(): void {
    this.cancelLiveTimeout();
    this.cancelReconnect();
    const wsUrl = `${wsBase(this.serverUrl)}/vaults/${this.vaultId}/sync`;
    const ws = new WebSocket(wsUrl, `bearer.${this.deviceToken}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.reconnectDelay = INITIAL_RECONNECT_DELAY;
      const hello: ClientHello = {
        type: "client_hello",
        protocol_version: PROTOCOL_VERSION,
        device_id: this.deviceId,
        last_seen_seq: this.lastSeenSeq,
      };
      if (this.pluginVersion) {
        hello.plugin_version = this.pluginVersion;
      }
      ws.send(JSON.stringify(hello));
      this.setState("connected");
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data) as ServerMessage;
      } catch {
        // #680 L-3: a frame the client cannot parse is dropped, not thrown out of the
        // listener. Nothing catches that throw, and the frame is lost either way.
        log.warn("undecodable server message", { bytes: event.data.length });
        return;
      }
      this.handleMessage(msg);
    });

    ws.addEventListener("close", (event: CloseEvent) => {
      if (this.ws !== ws) return; // stale superseded socket: don't clobber the live one
      this.ws = null;
      this.commitChannel.onSocketClosed();
      // #625: a server that refuses this protocol/plugin version closes 1008 with
      // the shared marker. Block (update prompt) instead of looping the reconnect.
      if (event.code === 1008 && event.reason.includes(UPDATE_REQUIRED)) {
        this.enterBlocked(this.serverVersion, this.pluginVersion, event.reason);
        return;
      }
      if (this.reconnectEnabled && !this.blocked) {
        this.scheduleReconnect();
      }
    });
    ws.addEventListener("error", () => {
      if (this.ws !== ws) return; // stale superseded socket: don't clobber the live one
      this.ws = null;
      this.commitChannel.onSocketClosed();
      if (this.reconnectEnabled && !this.blocked) {
        this.scheduleReconnect();
      }
    });
  }

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "server_hello_ack":
        this.serverVersion = msg.server_version ?? "";
        this.dispatchEvent(new CustomEvent("hello_ack", { detail: msg }));
        // #560: the listener may have stopped the transport (passphrase
        // changed elsewhere); never drive a dead socket toward live.
        if (this.ws === null) return;
        this.liveTargetSeq = msg.seq;
        log.info("server_hello_ack", {
          liveTargetSeq: msg.seq,
          lastSeenSeq: this.lastSeenSeq,
          caughtUp: this.lastSeenSeq >= msg.seq,
        });
        this.setState("syncing");
        if (this.lastSeenSeq >= this.liveTargetSeq) {
          this.goLive();
        } else {
          this.armLiveTimeout();
        }
        break;
      case "server_version":
        this.bumpLastSeen(msg.seq);
        this.dispatchEvent(new CustomEvent("version", { detail: msg }));
        if (this.state === "syncing") {
          if (this.lastSeenSeq >= this.liveTargetSeq) {
            this.goLive();
          } else {
            this.armLiveTimeout(); // heartbeat: reset stall timer on each replayed version
          }
        }
        break;
      case "server_commit_ack":
        // Our own commit is durably local, so route it through the cursor sink
        // (which now records a contiguous prefix, see advanceSyncCursor).
        this.bumpLastSeenAndSink(msg.seq);
        this.commitChannel.onResult({ kind: "ack", seq: msg.seq, version: msg.version });
        this.commitChannel.drain();
        break;
      case "server_conflict":
        this.commitChannel.onResult({
          kind: "conflict",
          path_hash: msg.path_hash,
          parent_version: msg.parent_version,
          reason: msg.reason,
        });
        this.commitChannel.drain();
        break;
      case "server_error":
        log.warn("server_error", { code: msg.code, message: msg.message });
        this.commitChannel.onResult({ kind: "error", message: msg.message });
        this.commitChannel.drain();
        break;
      case "server_version_mismatch":
        this.enterBlocked(msg.server_version, msg.client_version, "");
        break;
    }
  }

  // #625: the only exit from blocked is updating the side that is behind, then reloading.
  private enterBlocked(serverVersion: string, clientVersion: string, reason: string): void {
    if (this.blocked) return;
    this.cancelLiveTimeout(); // a leftover replay timer must not flip blocked back to live
    this.blocked = true;
    this.serverVersion = serverVersion;
    log.warn("sync blocked: server refused this client version", {
      server_version: serverVersion,
      client_version: clientVersion,
    });
    this.setState("blocked");
    this.dispatchEvent(
      new CustomEvent("blocked", {
        detail: { server_version: serverVersion, client_version: clientVersion, reason },
      }),
    );
  }

  getServerVersion(): string {
    return this.serverVersion;
  }
  isBlocked(): boolean {
    return this.blocked;
  }

  // #433: best-effort per-device applied-position report, additive
  // `client_progress` message. No-op unless the socket is open (fire-and-forget).
  reportAppliedSeq(seq: number): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "client_progress", applied_seq: seq }));
  }

  private sendCommit(req: CommitRequest): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({
      type: "client_commit",
      vault_id: this.vaultId,
      path_hash: req.path_hash,
      parent_version: req.parent_version ?? 0,
      enc_metadata: req.enc_metadata,
      chunk_hashes: req.chunk_hashes,
      deleted: req.deleted,
      path_ciphertext: req.path_ciphertext,
      rename_mark: req.rename_mark,
    } as ClientCommit));
    return true;
  }

  private goLive(): void {
    this.cancelLiveTimeout();
    if (this.state === "live") return;
    log.info("going live", {
      lastSeenSeq: this.lastSeenSeq,
      liveTargetSeq: this.liveTargetSeq,
      pendingCommits: this.commitChannel.pendingCount,
    });
    this.setState("live");
    this.dispatchEvent(new CustomEvent("live"));
    this.commitChannel.drain();
  }

  private armLiveTimeout(): void {
    this.cancelLiveTimeout();
    this.liveTimer = setTimeout(() => {
      log.info("replay drain timeout; going live", {
        lastSeenSeq: this.lastSeenSeq,
        target: this.liveTargetSeq,
      });
      this.goLive();
    }, LIVE_REPLAY_TIMEOUT);
    log.debug("armed live timeout", {
      lastSeenSeq: this.lastSeenSeq,
      liveTargetSeq: this.liveTargetSeq,
      timeoutMs: LIVE_REPLAY_TIMEOUT,
    });
  }

  private cancelLiveTimeout(): void {
    if (this.liveTimer) {
      clearTimeout(this.liveTimer);
      this.liveTimer = null;
    }
  }

  commit(req: CommitRequest): Promise<CommitResult> {
    return this.commitChannel.commit(req);
  }

  private scheduleReconnect(): void {
    this.cancelReconnect();
    this.setState("disconnected");
    this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
    this.dispatchEvent(new CustomEvent("reconnect", { detail: this.reconnectDelay / 2 }));
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  getBlob(hash: string): Promise<Uint8Array> {
    return this.http.getBlob(hash);
  }

  putBlob(hash: string, body: Uint8Array): Promise<void> {
    return this.http.putBlob(hash, body);
  }

  headBlob(hash: string): Promise<boolean> {
    return this.http.headBlob(hash);
  }

  async *getHeads(afterSeq: number): AsyncGenerator<HeadRecord> {
    yield* this.http.getHeads(afterSeq);
  }

  getVersionChain(pathHash: string, upTo?: number): Promise<VersionRecord[]> {
    return this.http.getVersionChain(pathHash, upTo);
  }
}
