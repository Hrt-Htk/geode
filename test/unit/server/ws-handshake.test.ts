import { type Database, openDb } from "../../../server/db.ts";
import { runHandshake } from "../../../server/ws-handshake.ts";
import { SERVER_VERSION } from "../../../server/version-gate.ts";
import { b64encode, PROTOCOL_VERSION } from "../../../core/protocol.ts";
import type {
  ClientMessage,
  ServerHelloAck,
  ServerMessage,
  ServerVersionMismatch,
} from "../../../core/protocol.ts";
import { blake3Hex } from "../../../core/hash.ts";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";
import { assert, assertEquals } from "@std/assert";

class FakeWs {
  closeCode: number | null = null;
  closed = false;
  /** Raw frames written straight to the socket (pre-registration, e.g. #625's mismatch notice). */
  rawSent: string[] = [];
  send(data: string): void {
    this.rawSent.push(data);
  }
  close(code?: number): void {
    this.closeCode = code;
    this.closed = true;
  }
}

function helloWithProtocol(protocolVersion: number, pluginVersion: string): string {
  return JSON.stringify(
    {
      type: "client_hello",
      protocol_version: protocolVersion,
      device_id: "dev1",
      last_seen_seq: 0,
      plugin_version: pluginVersion,
    } satisfies ClientMessage,
  );
}

function makeDb(): { db: Database; dataDir: string } {
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
  return { db, dataDir };
}

function hello(pluginVersion: string): string {
  return JSON.stringify(
    {
      type: "client_hello",
      protocol_version: PROTOCOL_VERSION,
      device_id: "dev1",
      last_seen_seq: 0,
      plugin_version: pluginVersion,
    } satisfies ClientMessage,
  );
}

function makeCtx(ws: FakeWs, db: Database, recv: () => Promise<string | null>) {
  const sent: ServerMessage[] = [];
  let registered: { ws: WebSocket; deviceId: string } | null = null;
  return {
    sent,
    get registered() {
      return registered;
    },
    ctx: {
      ws: ws as unknown as WebSocket,
      db,
      vaultId: "test-vault",
      deviceId: "dev1",
      recv,
      isClosed: () => ws.closed,
      register: (w: WebSocket, d: string) => {
        registered = { ws: w, deviceId: d };
        return registered;
      },
      send: (_conn: { ws: WebSocket; deviceId: string }, m: ServerMessage) => sent.push(m),
    },
  };
}

Deno.test({
  name: "ws-handshake - no hello within 5s closes 1002 and returns null",
  async fn() {
    const { db, dataDir } = makeDb();
    try {
      const ws = new FakeWs();
      const { ctx } = makeCtx(ws, db, () => new Promise<string | null>(() => {}));
      const t0 = Date.now();
      const result = await runHandshake(ctx);
      const elapsed = Date.now() - t0;
      assertEquals(result, null);
      assertEquals(ws.closeCode, 1002);
      assert(elapsed >= 4_500, `timed out too early: ${elapsed}ms`);
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "ws-handshake - plugin_version over 64 chars closes 1008",
  async fn() {
    const { db, dataDir } = makeDb();
    try {
      const ws = new FakeWs();
      const h = makeCtx(ws, db, () => Promise.resolve(hello("x".repeat(65))));
      const result = await runHandshake(h.ctx);
      assertEquals(result, null);
      assertEquals(ws.closeCode, 1008);
      assertEquals(h.registered, null);
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

// #625: a refused client must learn WHY before the socket dies, so the plugin
// enters `blocked` (update prompt) instead of reconnect-looping.
Deno.test({
  name: "ws-handshake - protocol mismatch sends server_version_mismatch before closing 1008",
  async fn() {
    const { db, dataDir } = makeDb();
    try {
      const ws = new FakeWs();
      const h = makeCtx(
        ws,
        db,
        () => Promise.resolve(helloWithProtocol(PROTOCOL_VERSION + 1, "0.1.0")),
      );
      const result = await runHandshake(h.ctx);
      assertEquals(result, null);
      assertEquals(h.registered, null);
      assertEquals(ws.rawSent.length, 1, "exactly one pre-close frame");
      const mismatch = JSON.parse(ws.rawSent[0]) as ServerVersionMismatch;
      assertEquals(mismatch.type, "server_version_mismatch");
      assertEquals(mismatch.server_version, SERVER_VERSION);
      assertEquals(mismatch.client_version, "0.1.0");
      assertEquals(ws.closeCode, 1008);
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name:
    "ws-handshake - below-minimum plugin version sends server_version_mismatch before closing 1008",
  async fn() {
    const { db, dataDir } = makeDb();
    Deno.env.set("GEODE_MIN_PLUGIN_VERSION", "99.0.0");
    try {
      const ws = new FakeWs();
      const h = makeCtx(ws, db, () => Promise.resolve(hello("0.1.0")));
      const result = await runHandshake(h.ctx);
      assertEquals(result, null);
      assertEquals(h.registered, null);
      assertEquals(ws.rawSent.length, 1, "exactly one pre-close frame");
      const mismatch = JSON.parse(ws.rawSent[0]) as ServerVersionMismatch;
      assertEquals(mismatch.type, "server_version_mismatch");
      assertEquals(mismatch.server_version, SERVER_VERSION);
      assertEquals(mismatch.client_version, "0.1.0");
      assertEquals(ws.closeCode, 1008);
    } finally {
      Deno.env.delete("GEODE_MIN_PLUGIN_VERSION");
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "ws-handshake - valid hello registers and sends hello_ack",
  async fn() {
    const { db, dataDir } = makeDb();
    try {
      const ws = new FakeWs();
      const h = makeCtx(ws, db, () => Promise.resolve(hello(SERVER_VERSION)));
      const result = await runHandshake(h.ctx);
      assert(result !== null);
      assert(h.registered !== null);
      const sent = h.sent;
      assertEquals(sent[0]?.type, "server_hello_ack");
      assertEquals(ws.closeCode, null);
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "ws-handshake - hello_ack carries the vault verifier hash (#560)",
  async fn() {
    const { db, dataDir } = makeDb();
    try {
      const verifier = new Uint8Array([9, 8, 7, 6]);
      db.run("UPDATE vaults SET verifier = ? WHERE id = ?", b64encode(verifier), "test-vault");
      const ws = new FakeWs();
      const h = makeCtx(ws, db, () => Promise.resolve(hello(SERVER_VERSION)));
      await runHandshake(h.ctx);
      const ack = h.sent[0] as ServerHelloAck;
      assertEquals(ack.type, "server_hello_ack");
      assertEquals(ack.verifier_hash, blake3Hex(verifier));
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "ws-handshake - no verifier means no verifier_hash in hello_ack",
  async fn() {
    const { db, dataDir } = makeDb();
    try {
      const ws = new FakeWs();
      const h = makeCtx(ws, db, () => Promise.resolve(hello(SERVER_VERSION)));
      await runHandshake(h.ctx);
      const ack = h.sent[0] as ServerHelloAck;
      assertEquals(ack.verifier_hash, undefined);
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});
