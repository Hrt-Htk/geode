import { assert, assertEquals } from "@std/assert";
import { insertVersion } from "../../../server/db.ts";
import { getTrashedHead } from "../../../server/trash-db.ts";
import { b64encode, PROTOCOL_VERSION } from "../../../core/protocol.ts";
import { SERVER_VERSION } from "../../../server/version-gate.ts";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";
import { startServer } from "./ws-helpers.ts";

// WS commit error paths: parse/type/validate/decode branches of the commit
// pipeline. Refactor guard: must stay green.

const DEVICES = ["err1", "err2"];

interface BufferedClient {
  ws: WebSocket;
  opened: Promise<void>;
  recv(timeoutMs?: number): Promise<string>;
}

function connectWS(port: number, vaultId: string): BufferedClient {
  const ws = new WebSocket(`ws://localhost:${port}/vaults/${vaultId}/sync`, `bearer.err1`);
  ws.binaryType = "arraybuffer";

  const queue: string[] = [];
  const waiters: Array<(s: string) => void> = [];
  ws.addEventListener("message", (e) => {
    const data = typeof e.data === "string" ? e.data : "";
    const w = waiters.shift();
    if (w) w(data);
    else queue.push(data);
  });

  const opened = new Promise<void>((r) => ws.addEventListener("open", () => r(), { once: true }));

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

  return { ws, opened, recv };
}

function send(ws: WebSocket, msg: unknown): void {
  ws.send(JSON.stringify(msg));
}

async function drainUntil(client: BufferedClient, expectedType: string): Promise<void> {
  let msg: Record<string, unknown>;
  do {
    msg = JSON.parse(await client.recv());
  } while (msg.type !== expectedType);
}

async function withServer(
  fn: (port: number, db: Awaited<ReturnType<typeof startServer>>["db"]) => Promise<void>,
): Promise<void> {
  const dataDir = makeTempDataDir();
  const srv = await startServer(dataDir, DEVICES);
  try {
    await fn(srv.port, srv.db);
  } finally {
    try {
      await srv.stop();
    } catch { /* ignore */ }
    removeTempDir(dataDir);
  }
}

function baseCommit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "client_commit",
    vault_id: "test-vault",
    path_hash: "a".repeat(64),
    parent_version: 0,
    enc_metadata: b64encode(new TextEncoder().encode("{}")),
    chunk_hashes: [],
    deleted: false,
    ...overrides,
  };
}

Deno.test({
  name: "commit errors - invalid JSON → server_error invalid_json",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withServer(async (port) => {
      const client = await connectWS(port, "test-vault");
      await client.opened;
      send(client.ws, {
        type: "client_hello",
        protocol_version: PROTOCOL_VERSION,
        plugin_version: SERVER_VERSION,
        device_id: "err1",
        last_seen_seq: 0,
      });
      await client.recv(); // hello_ack

      client.ws.send("not json");
      const msg = JSON.parse(await client.recv());
      assertEquals(msg.type, "server_error");
      assertEquals(msg.code, "invalid_json");
      client.ws.close();
    });
  },
});

Deno.test({
  name: "commit errors - wrong message type → server_error unexpected",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withServer(async (port) => {
      const client = await connectWS(port, "test-vault");
      await client.opened;
      send(client.ws, {
        type: "client_hello",
        protocol_version: PROTOCOL_VERSION,
        plugin_version: SERVER_VERSION,
        device_id: "err1",
        last_seen_seq: 0,
      });
      await client.recv();

      send(client.ws, { type: "client_foo" });
      const msg = JSON.parse(await client.recv());
      assertEquals(msg.type, "server_error");
      assertEquals(msg.code, "unexpected");
      client.ws.close();
    });
  },
});

Deno.test({
  name: "commit errors - malformed commit → server_error invalid_commit",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withServer(async (port) => {
      const client = await connectWS(port, "test-vault");
      await client.opened;
      send(client.ws, {
        type: "client_hello",
        protocol_version: PROTOCOL_VERSION,
        plugin_version: SERVER_VERSION,
        device_id: "err1",
        last_seen_seq: 0,
      });
      await client.recv();

      send(client.ws, baseCommit({ path_hash: "not-a-hash" }));
      const msg = JSON.parse(await client.recv());
      assertEquals(msg.type, "server_error");
      assertEquals(msg.code, "invalid_commit");
      client.ws.close();
    });
  },
});

Deno.test({
  name: "commit errors - bad enc_metadata base64 → server_error bad_metadata",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withServer(async (port) => {
      const client = await connectWS(port, "test-vault");
      await client.opened;
      send(client.ws, {
        type: "client_hello",
        protocol_version: PROTOCOL_VERSION,
        plugin_version: SERVER_VERSION,
        device_id: "err1",
        last_seen_seq: 0,
      });
      await client.recv();

      send(client.ws, baseCommit({ enc_metadata: "!!!" }));
      const msg = JSON.parse(await client.recv());
      assertEquals(msg.type, "server_error");
      assertEquals(msg.code, "bad_metadata");
      client.ws.close();
    });
  },
});

Deno.test({
  name: "commit errors - bad path_ciphertext base64 → server_error bad_path_ciphertext",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withServer(async (port) => {
      const client = await connectWS(port, "test-vault");
      await client.opened;
      send(client.ws, {
        type: "client_hello",
        protocol_version: PROTOCOL_VERSION,
        plugin_version: SERVER_VERSION,
        device_id: "err1",
        last_seen_seq: 0,
      });
      await client.recv();

      send(client.ws, baseCommit({ path_ciphertext: "!!!" }));
      const msg = JSON.parse(await client.recv());
      assertEquals(msg.type, "server_error");
      assertEquals(msg.code, "bad_path_ciphertext");
      client.ws.close();
    });
  },
});

Deno.test({
  name: "commit errors - deleted commit acks and trashes the content head",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withServer(async (port, db) => {
      // Seed a content version v1 for the path being deleted.
      const pathHash = "b".repeat(64);
      const r1 = insertVersion(
        db,
        "test-vault",
        pathHash,
        0,
        new Uint8Array([1]),
        [],
        false,
        "err1",
      );
      assert(!("conflict" in r1), "seed content version");

      const client = await connectWS(port, "test-vault");
      await client.opened;
      send(client.ws, {
        type: "client_hello",
        protocol_version: PROTOCOL_VERSION,
        plugin_version: SERVER_VERSION,
        device_id: "err1",
        last_seen_seq: 0,
      });
      await drainUntil(client, "server_hello_ack");
      await drainUntil(client, "server_version"); // seeded v1 replays

      // Commit the delete on top of v1.
      send(client.ws, baseCommit({ path_hash: pathHash, parent_version: 1, deleted: true }));
      const ack = JSON.parse(await client.recv());
      assertEquals(ack.type, "server_commit_ack");
      assertEquals(ack.version, 2);

      // The content head (v1) is now in trash.
      const trashed = getTrashedHead(db, "test-vault", pathHash);
      assert(trashed !== null, "content head should be trashed");
      const head = JSON.parse(trashed.head_json) as { version: number };
      assertEquals(head.version, 1);
      client.ws.close();
    });
  },
});
