import { log } from "../../../server/log.ts";
import { b64encode, PROTOCOL_VERSION } from "../../../core/protocol.ts";
import type { ServerVersionMismatch } from "../../../core/protocol.ts";
import { SERVER_VERSION } from "../../../server/version-gate.ts";
import { assert, assertEquals } from "@std/assert";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";
import { startServer } from "./ws-helpers.ts";

// device ids must cover every `client${n}` the global connectWS counter reaches,
// each committing connection's id is FK-referenced by file_versions.device_id.
const SERVER_DEVICES = [
  "client1",
  "client2",
  "client3",
  "client4",
  "client5",
  "client6",
  "client7",
  "client8",
  "client9",
  "client10",
  "dev",
];

interface BufferedClient {
  ws: WebSocket;
  opened: Promise<void>;
  deviceId: string;
  recv(timeoutMs?: number): Promise<string>;
}

let clientIdCounter = 0;
function connectWS(port: number, vaultId: string): BufferedClient {
  const clientId = `client${++clientIdCounter}`;
  const ws = new WebSocket(`ws://localhost:${port}/vaults/${vaultId}/sync`, `bearer.${clientId}`);
  ws.binaryType = "arraybuffer";

  const queue: string[] = [];
  const waiters: Array<(s: string) => void> = [];
  ws.addEventListener("message", (e) => {
    const data = typeof e.data === "string" ? e.data : "";
    const w = waiters.shift();
    if (w) w(data);
    else queue.push(data);
  });

  const opened = new Promise<void>((r) => {
    ws.addEventListener("open", () => r(), { once: true });
  });

  function recv(timeoutMs = 3000): Promise<string> {
    return new Promise((resolve, reject) => {
      const buffered = queue.shift();
      if (buffered !== undefined) {
        resolve(buffered);
        return;
      }
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(resolver);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error("timeout"));
      }, timeoutMs);
      const resolver = (s: string) => {
        clearTimeout(timer);
        resolve(s);
      };
      waiters.push(resolver);
    });
  }

  return { ws, opened, deviceId: clientId, recv };
}

function send(ws: WebSocket, msg: unknown): void {
  ws.send(JSON.stringify(msg));
}

async function drainUntil(client: BufferedClient, expectedType: string): Promise<void> {
  let msg: any;
  do {
    msg = JSON.parse(await client.recv());
  } while (msg.type !== expectedType);
}

Deno.test({
  name: "two-clients - hello_ack carries vault_name",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dataDir = makeTempDataDir();
    const srv = await startServer(dataDir, SERVER_DEVICES);
    try {
      const port = srv.port;
      const client = await connectWS(port, "test-vault");
      await client.opened;

      send(client.ws, {
        type: "client_hello",
        protocol_version: PROTOCOL_VERSION,
        plugin_version: SERVER_VERSION,
        device_id: client.deviceId,
        last_seen_seq: 0,
      });

      const ackRaw = await client.recv();
      const ack = JSON.parse(ackRaw);
      assertEquals(ack.type, "server_hello_ack");
      assertEquals(ack.vault_name, "test");

      client.ws.close();
    } finally {
      try {
        await srv.stop();
      } catch { /* ignore */ }
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "two-clients - A commits → B receives version message",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dataDir = makeTempDataDir();
    const srv = await startServer(dataDir, SERVER_DEVICES);
    try {
      const port = srv.port;

      const clientA = await connectWS(port, "test-vault");
      const clientB = await connectWS(port, "test-vault");

      await clientA.opened;
      await clientB.opened;

      // Send hello from both
      send(clientA.ws, {
        type: "client_hello",
        protocol_version: PROTOCOL_VERSION,
        plugin_version: SERVER_VERSION,
        device_id: clientA.deviceId,
        last_seen_seq: 0,
      });
      send(clientB.ws, {
        type: "client_hello",
        protocol_version: PROTOCOL_VERSION,
        plugin_version: SERVER_VERSION,
        device_id: clientB.deviceId,
        last_seen_seq: 0,
      });

      // Drain hello_ack from both
      await drainUntil(clientA, "server_hello_ack");
      await drainUntil(clientB, "server_hello_ack");

      // A commits
      send(clientA.ws, {
        type: "client_commit",
        vault_id: "test-vault",
        path_hash: "a".repeat(64),
        parent_version: 0,
        enc_metadata: b64encode(new TextEncoder().encode(JSON.stringify({ path: "test.md" }))),
        chunk_hashes: [],
        deleted: false,
      });

      // A gets commit_ack (server_version broadcast echo arrives after)
      const ack: any = JSON.parse(await clientA.recv());
      assertEquals(ack.type, "server_commit_ack");

      // B receives the new version
      const bMsg: any = JSON.parse(await clientB.recv(5000));
      assertEquals(bMsg.type, "server_version");
      assertEquals(bMsg.seq, ack.seq);

      clientA.ws.close();
      clientB.ws.close();
    } finally {
      try {
        await srv.stop();
      } catch { /* ignore */ }
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "two-clients - reconnect with last_seen_seq replays only >K",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dataDir = makeTempDataDir();
    const srv = await startServer(dataDir, SERVER_DEVICES);
    try {
      const port = srv.port;

      // Connect A, make 5 commits
      const clientA = await connectWS(port, "test-vault");
      await clientA.opened;
      send(clientA.ws, {
        type: "client_hello",
        protocol_version: PROTOCOL_VERSION,
        plugin_version: SERVER_VERSION,
        device_id: clientA.deviceId,
        last_seen_seq: 0,
      });
      await drainUntil(clientA, "server_hello_ack");

      const seqs: number[] = [];
      for (let i = 0; i < 5; i++) {
        send(clientA.ws, {
          type: "client_commit",
          vault_id: "test-vault",
          path_hash: "b".repeat(64),
          parent_version: i,
          enc_metadata: b64encode(new TextEncoder().encode(JSON.stringify({ path: "replay.md" }))),
          chunk_hashes: [],
          deleted: false,
        });
        const ack = JSON.parse(await clientA.recv());
        if (ack.type === "server_commit_ack") {
          seqs.push(ack.seq);
        }
      }

      clientA.ws.close();

      // Connect B (simulates A reconnecting with last_seen_seq)
      const clientB = await connectWS(port, "test-vault");
      await clientB.opened;

      // Send hello with last_seen_seq
      send(clientB.ws, {
        type: "client_hello",
        protocol_version: PROTOCOL_VERSION,
        plugin_version: SERVER_VERSION,
        device_id: "dev",
        last_seen_seq: seqs[seqs.length - 1],
      });

      // Drain hello_ack
      await drainUntil(clientB, "server_hello_ack");

      // No more messages should arrive (all > last_seen_seq already delivered)
      try {
        const extraMsg = JSON.parse(await clientB.recv(500));
        log.warn("extra replay message", { msg: extraMsg.type });
      } catch {
        // Expected: no extra messages
      }

      clientB.ws.close();
    } finally {
      try {
        await srv.stop();
      } catch { /* ignore */ }
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "two-clients - mismatched protocol_version is rejected with 1008",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dataDir = makeTempDataDir();
    const srv = await startServer(dataDir, SERVER_DEVICES);
    try {
      const port = srv.port;

      const client = await connectWS(port, "test-vault");
      await client.opened;

      // Listen for close event
      const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
        client.ws.addEventListener("close", (e) => {
          resolve({ code: e.code, reason: e.reason });
        });
      });

      // Send hello with bad protocol version
      send(client.ws, {
        type: "client_hello",
        protocol_version: 999,
        plugin_version: "0.0.1-test",
        device_id: client.deviceId,
        last_seen_seq: 0,
      });

      // Must NOT receive hello_ack: the socket closes with 1008, but only after
      // the refusal message the client needs to block (#625).
      const refused = JSON.parse(await client.recv()) as ServerVersionMismatch;
      assertEquals(refused.type, "server_version_mismatch");
      assertEquals(refused.server_version, SERVER_VERSION);
      assertEquals(refused.client_version, "0.0.1-test");

      const close = await closePromise;
      assertEquals(close.code, 1008);
      assert(close.reason.includes("protocol version mismatch"));
    } finally {
      try {
        await srv.stop();
      } catch { /* ignore */ }
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "two-clients - simultaneous same-parent commits: first wins, second conflicts",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dataDir = makeTempDataDir();
    const srv = await startServer(dataDir, SERVER_DEVICES);
    try {
      const port = srv.port;

      const clientA = await connectWS(port, "test-vault");
      await clientA.opened;
      send(clientA.ws, {
        type: "client_hello",
        protocol_version: PROTOCOL_VERSION,
        plugin_version: SERVER_VERSION,
        device_id: clientA.deviceId,
        last_seen_seq: 0,
      });
      await drainUntil(clientA, "server_hello_ack");

      const clientB = await connectWS(port, "test-vault");
      await clientB.opened;
      send(clientB.ws, {
        type: "client_hello",
        protocol_version: PROTOCOL_VERSION,
        plugin_version: SERVER_VERSION,
        device_id: clientB.deviceId,
        last_seen_seq: 0,
      });
      await drainUntil(clientB, "server_hello_ack");

      // Both try to commit with parent_version=0 simultaneously
      const pathHash = "c".repeat(64);
      send(clientA.ws, {
        type: "client_commit",
        vault_id: "test-vault",
        path_hash: pathHash,
        parent_version: 0,
        enc_metadata: b64encode(new TextEncoder().encode(JSON.stringify({ path: "conflict.md" }))),
        chunk_hashes: [],
        deleted: false,
      });

      send(clientB.ws, {
        type: "client_commit",
        vault_id: "test-vault",
        path_hash: pathHash,
        parent_version: 0,
        enc_metadata: b64encode(new TextEncoder().encode(JSON.stringify({ path: "conflict.md" }))),
        chunk_hashes: [],
        deleted: false,
      });

      // One gets ack, the other gets conflict: read from each client
      const results: string[] = [];
      try {
        const msg = JSON.parse(await clientA.recv(2000));
        results.push(JSON.stringify(msg));
      } catch {
        /* timeout */
      }
      try {
        const msg = JSON.parse(await clientB.recv(2000));
        results.push(JSON.stringify(msg));
      } catch {
        /* timeout */
      }

      // Check: at least one conflict among the results
      const hasConflict = results.some((r) => {
        const msg = JSON.parse(r);
        return msg.type === "server_conflict";
      });
      const hasAck = results.some((r) => {
        const msg = JSON.parse(r);
        return msg.type === "server_commit_ack";
      });

      assert(hasAck || hasConflict, "should get ack or conflict");

      clientA.ws.close();
      clientB.ws.close();
    } finally {
      try {
        await srv.stop();
      } catch { /* ignore */ }
      removeTempDir(dataDir);
    }
  },
});
