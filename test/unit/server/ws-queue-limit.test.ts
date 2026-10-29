import { openDb } from "../../../server/db.ts";
import { VaultHub } from "../../../server/ws.ts";
import { MAX_QUEUE_BYTES, MAX_QUEUE_MESSAGES } from "../../../server/ws-types.ts";
import { PROTOCOL_VERSION } from "../../../core/protocol.ts";
import { SERVER_VERSION } from "../../../server/version-gate.ts";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";
import { assertEquals } from "@std/assert";

class FakeWs {
  closeCode: number | null = null;
  closed = false;
  bufferedAmount = 0;
  private listeners: Record<string, ((e: unknown) => void)[]> = {};

  addEventListener(type: string, fn: (e: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }

  removeEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
  }

  send(): void {}

  close(code?: number): void {
    if (this.closed) return;
    this.closeCode = code;
    this.closed = true;
    for (const fn of this.listeners.close ?? []) fn({});
  }

  emit(data: string): void {
    for (const fn of this.listeners.message ?? []) fn({ data });
  }
}

function makeHub(): { hub: VaultHub; dataDir: string; db: ReturnType<typeof openDb> } {
  const dataDir = makeTempDataDir();
  const db = openDb(dataDir);
  db.run(
    `INSERT OR IGNORE INTO vaults(id, name, salt, created_at) VALUES(?,?,?,?)`,
    "test-vault",
    "test",
    new Uint8Array(16),
    Date.now(),
  );
  db.run(
    `INSERT OR IGNORE INTO devices(id, vault_id, name, token) VALUES(?,?,?,?)`,
    "dev1",
    "test-vault",
    "test-device",
    "test-token",
  );
  const hub = new VaultHub(db, dataDir, "test-vault", () => {});
  return { hub, dataDir, db };
}

const HELLO = JSON.stringify({
  type: "client_hello",
  protocol_version: PROTOCOL_VERSION,
  device_id: "dev1",
  last_seen_seq: 0,
  plugin_version: SERVER_VERSION,
});

function commitMsg(encMetadata: string): string {
  return JSON.stringify({
    type: "client_commit",
    vault_id: "test-vault",
    path_hash: "a".repeat(64),
    parent_version: 0,
    enc_metadata: encMetadata,
    chunk_hashes: [],
    deleted: false,
  });
}

// Push hello + N commits synchronously so the whole flood lands in the queue
// before the consumer loop gets a microtask to drain it.
function flood(ws: FakeWs, hub: VaultHub, n: number, encMetadata = "aGk="): Promise<void> {
  const p = hub.handleConnection(ws as unknown as WebSocket, "dev1");
  ws.emit(HELLO);
  for (let i = 0; i < n; i++) ws.emit(commitMsg(encMetadata));
  return p;
}

Deno.test({
  name: "ws queue - message-count overflow closes 1011",
  async fn() {
    const { hub, dataDir, db } = makeHub();
    try {
      const ws = new FakeWs();
      await flood(ws, hub, MAX_QUEUE_MESSAGES + 1);
      assertEquals(ws.closeCode, 1011);
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "ws queue - byte overflow closes 1011 under the message cap",
  async fn() {
    const { hub, dataDir, db } = makeHub();
    try {
      const ws = new FakeWs();
      const perMsg = Math.ceil(MAX_QUEUE_BYTES / 100) + 1; // 100 msgs > cap
      await flood(ws, hub, 100, "a".repeat(perMsg));
      assertEquals(ws.closeCode, 1011);
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "ws queue - traffic under both caps stays open",
  async fn() {
    const { hub, dataDir, db } = makeHub();
    try {
      const ws = new FakeWs();
      const p = flood(ws, hub, 100);
      await new Promise((r) => setTimeout(r, 50)); // let the consumer drain
      assertEquals(ws.closeCode, null);
      ws.close(1000);
      await p;
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});
