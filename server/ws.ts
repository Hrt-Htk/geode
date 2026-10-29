import type { Database } from "@db/sqlite";
import type { ClientCommit, ClientMessage, ServerMessage } from "../core/protocol.ts";
import { RENAME_MARKER } from "../core/protocol.ts";
import { log } from "./log.ts";
import { insertVersion, rekeyMode, setDeviceAppliedSeq, type VersionRow } from "./db.ts";
import { deleteTrashedHead, trashHead } from "./trash-db.ts";
import { maybeScheduleCompaction } from "./compaction.ts";
import { runHandshake } from "./ws-handshake.ts";
import { decodeCommitBase64, validateCommit } from "./ws-commit.ts";
import { addVaultBytes, overBudgetRefusal, rowBytes } from "./vault-budget.ts";
import { type HubConnection, MAX_BUFFERED_BYTES, rowToVersion } from "./ws-types.ts";
import { makeReceiver } from "./ws-receive.ts";

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export class VaultHub {
  private connections = new Map<string, HubConnection>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly inflight = new Set<Promise<void>>();
  private _closed = false;
  get closed(): boolean {
    return this._closed;
  }

  constructor(
    private db: Database,
    private dataDir: string,
    private vaultId: string,
    private onIdle: () => void,
  ) {}

  register(ws: WebSocket, deviceId: string): HubConnection {
    const existing = this.connections.get(deviceId);
    if (existing) {
      existing.ws.close(1011, "duplicate device");
    }

    const conn: HubConnection = { ws, deviceId };
    this.connections.set(deviceId, conn);
    this.resetIdleTimer();
    return conn;
  }

  unregister(conn: HubConnection): void {
    if (this.connections.get(conn.deviceId) !== conn) return;
    this.connections.delete(conn.deviceId);
    if (this.connections.size === 0) {
      this.scheduleIdle();
    }
  }

  disconnectDevice(deviceId: string): void {
    const conn = this.connections.get(deviceId);
    if (conn) conn.ws.close(1008, "revoked");
  }

  // #560: a re-key invalidates every connected device's keys: close them all
  // so each reconnects and reads the new hello_ack (rekey flag / verifier hash).
  closeAllRekeyed(): void {
    for (const conn of this.connections.values()) {
      conn.ws.close(1000, "rekeyed");
    }
  }

  broadcast(msg: ServerMessage, excludeDeviceId?: string): void {
    const data = JSON.stringify(msg);
    for (const [id, conn] of this.connections) {
      if (id === excludeDeviceId) continue;
      this.enqueue(conn, data);
    }
  }

  send(conn: HubConnection, msg: ServerMessage): void {
    this.enqueue(conn, JSON.stringify(msg));
  }

  private enqueue(conn: HubConnection, data: string): void {
    if (conn.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      conn.ws.close(1011, "backpressure");
      return;
    }
    conn.ws.send(data);
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private scheduleIdle(): void {
    if (this._closed || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this._closed = true;
      this.onIdle();
    }, IDLE_TIMEOUT_MS);
  }

  async close(): Promise<void> {
    this._closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const conn of this.connections.values()) {
      conn.ws.close(1001, "server shutdown");
    }
    await Promise.allSettled(this.inflight);
  }

  handleConnection(ws: WebSocket, deviceId: string): Promise<void> {
    const p = this.runConnection(ws, deviceId).finally(() => this.inflight.delete(p));
    this.inflight.add(p);
    return p;
  }

  private async runConnection(ws: WebSocket, deviceId: string): Promise<void> {
    log.info("ws handleConnection", { vault_id: this.vaultId, device_id: deviceId });

    const rx = makeReceiver(ws);
    let registered: HubConnection | null = null;
    try {
      registered = await runHandshake({
        ws,
        db: this.db,
        vaultId: this.vaultId,
        deviceId,
        recv: rx.recv,
        isClosed: rx.isClosed,
        register: (w, d) => this.register(w, d),
        send: (c, m) => this.send(c, m),
      });
      if (!registered) return;
      while (!rx.isClosed()) {
        const raw = await rx.recv();
        if (raw === null) break;
        this.handleClientMessage(registered, raw);
      }
    } finally {
      rx.detach();
      if (registered) this.unregister(registered);
    }
  }

  private handleClientMessage(conn: HubConnection, raw: string): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      this.send(conn, { type: "server_error", code: "invalid_json", message: "bad JSON" });
      return;
    }
    if (msg.type === "client_progress") {
      // Additive per-device applied-position report (#433): best-effort, no ack.
      if (Number.isInteger(msg.applied_seq) && msg.applied_seq >= 0) {
        setDeviceAppliedSeq(this.db, conn.deviceId, msg.applied_seq);
      }
      return;
    }
    if (msg.type !== "client_commit") {
      this.send(conn, { type: "server_error", code: "unexpected", message: "expected commit" });
      return;
    }
    if (rekeyMode(this.db, this.vaultId) !== null) {
      this.send(conn, {
        type: "server_error",
        code: "rekey_in_progress",
        message: "re-key in progress",
      });
      return;
    }
    // #679: past the storage budget only what frees space or adds none lands.
    if (overBudgetRefusal(this.db, this.vaultId, msg)) {
      this.send(conn, {
        type: "server_error",
        code: "storage_full",
        message: "vault storage full",
      });
      return;
    }
    const validationError = validateCommit(msg);
    if (validationError) {
      this.send(conn, { type: "server_error", code: "invalid_commit", message: validationError });
      return;
    }
    const decoded = decodeCommitBase64(msg);
    if ("code" in decoded) {
      this.send(conn, { type: "server_error", code: decoded.code, message: decoded.message });
      return;
    }
    this.applyCommit(conn, msg, decoded.encMetadata, decoded.pathCiphertext);
  }

  // Apply a validated commit: insert, respond, broadcast, trash, and schedule compaction.
  private applyCommit(
    conn: HubConnection,
    msg: ClientCommit,
    encMetadata: Uint8Array,
    pathCiphertext: Uint8Array | null,
  ): void {
    try {
      const result = insertVersion(
        this.db,
        this.vaultId,
        msg.path_hash,
        msg.parent_version,
        encMetadata,
        msg.chunk_hashes,
        msg.deleted,
        conn.deviceId,
        pathCiphertext,
        msg.rename_mark ?? 0,
      );
      if ("conflict" in result) {
        // insertVersion returns the winning head version for the client to fetch
        this.send(conn, {
          type: "server_conflict",
          vault_id: this.vaultId,
          path_hash: msg.path_hash,
          parent_version: result.currentHead,
          reason: "parent_mismatch",
        });
        return;
      }
      this.send(conn, { type: "server_commit_ack", seq: result.seq, version: result.version });
      const versionMsg = rowToVersion({
        version: result.version,
        parent: msg.parent_version,
        seq: result.seq,
        path_hash: msg.path_hash,
        enc_metadata: msg.enc_metadata,
        chunk_hashes: JSON.stringify(msg.chunk_hashes),
        deleted: msg.deleted ? 1 : 0,
        device_id: conn.deviceId,
        created_at: Date.now(),
        compacted_range: null,
        path_ciphertext: pathCiphertext,
        rename_mark: msg.rename_mark ?? 0,
        restored: 0,
      }, this.vaultId);
      this.broadcast(versionMsg, conn.deviceId);
      // #583: a marker is a rename link, not a deletion: it creates no trash entry,
      // and clears the one a tombstone on this path left behind. #465: live content
      // on the name (a restored version, a recreate) means it is no longer deleted: a
      // trash row on the old tombstone would keep the file listed and refuse its own
      // restore.
      const trashed = msg.deleted && msg.rename_mark !== RENAME_MARKER;
      let trashBytes = 0;
      try {
        if (trashed) {
          trashBytes = trashHead(
            this.db,
            this.vaultId,
            msg.path_hash,
            msg.parent_version,
            conn.deviceId,
          );
        } else {
          deleteTrashedHead(this.db, this.vaultId, msg.path_hash);
        }
      } catch (e) {
        log.warn("trash bookkeeping failed", {
          vault_id: this.vaultId,
          error: (e as Error).message,
        });
      }
      // #679: the row it stored, plus the trash copy it may have written.
      const storedBytes = rowBytes(encMetadata, pathCiphertext, msg.chunk_hashes) + trashBytes;
      addVaultBytes(this.db, this.vaultId, storedBytes);
      maybeScheduleCompaction(this.db, this.dataDir, this.vaultId);
    } catch (e) {
      log.warn("ws insert failed", { vault_id: this.vaultId, error: (e as Error).message });
      this.send(conn, { type: "server_error", code: "insert_failed", message: "database error" });
    }
  }

  broadcastVersion(row: VersionRow): void {
    this.broadcast(rowToVersion(row, this.vaultId));
  }
}

export const hubStore = new Map<string, VaultHub>();
export function broadcastVersionIfLive(vaultId: string, row: VersionRow): void {
  const hub = hubStore.get(vaultId);
  if (hub && !hub.closed) hub.broadcastVersion(row);
}

export function disconnectDeviceIfLive(vaultId: string, deviceId: string): void {
  const hub = hubStore.get(vaultId);
  if (hub) hub.disconnectDevice(deviceId);
}

export function closeAllRekeyedIfLive(vaultId: string): void {
  const hub = hubStore.get(vaultId);
  if (hub && !hub.closed) hub.closeAllRekeyed();
}

export function getHub(db: Database, dataDir: string, vaultId: string): VaultHub {
  const existing = hubStore.get(vaultId);
  if (existing && !existing.closed) return existing;

  const hub = new VaultHub(db, dataDir, vaultId, () => {
    hubStore.delete(vaultId);
  });
  hubStore.set(vaultId, hub);
  return hub;
}
