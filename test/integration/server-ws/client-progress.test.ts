import { PROTOCOL_VERSION } from "../../../core/protocol.ts";
import { SERVER_VERSION } from "../../../server/version-gate.ts";
import { assertEquals } from "@std/assert";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";
import { startServer } from "./ws-helpers.ts";
import type { Database } from "@db/sqlite";

const DEVICES = ["prog1"];

interface BufferedClient {
  ws: WebSocket;
  opened: Promise<void>;
  deviceId: string;
  recv(timeoutMs?: number): Promise<string>;
}

function connectWS(port: number, vaultId: string): BufferedClient {
  const ws = new WebSocket(`ws://localhost:${port}/vaults/${vaultId}/sync`, `bearer.${DEVICES[0]}`);
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

  return { ws, opened, deviceId: DEVICES[0], recv };
}

function send(ws: WebSocket, msg: unknown): void {
  ws.send(JSON.stringify(msg));
}

Deno.test({
  name: "client-progress - applied_seq is recorded over the WS",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dataDir = makeTempDataDir();
    const srv = await startServer(dataDir, DEVICES);
    try {
      const client = connectWS(srv.port, "test-vault");
      await client.opened;

      send(client.ws, {
        type: "client_hello",
        protocol_version: PROTOCOL_VERSION,
        plugin_version: SERVER_VERSION,
        device_id: client.deviceId,
        last_seen_seq: 0,
      });
      const ackRaw = await client.recv();
      assertEquals((JSON.parse(ackRaw) as { type: string }).type, "server_hello_ack");

      // Best-effort report, no ack: the server records it and sends nothing back.
      send(client.ws, { type: "client_progress", applied_seq: 7 });
      assertEquals(await pollAppliedSeq(srv.db, client.deviceId, 7), 7);

      // A malformed applied_seq must not corrupt the stored value.
      send(client.ws, { type: "client_progress", applied_seq: -3 });
      assertEquals(await pollAppliedSeq(srv.db, client.deviceId, 7), 7);

      client.ws.close();
    } finally {
      try {
        await srv.stop();
      } catch { /* ignore */ }
      removeTempDir(dataDir);
    }
  },
});

async function pollAppliedSeq(
  db: Database,
  deviceId: string,
  expected: number,
): Promise<number> {
  const startedAt = Date.now();
  let row: number | null = null;
  while (Date.now() - startedAt < 3000) {
    row = (db.prepare("SELECT applied_seq FROM devices WHERE id = ?").get(deviceId) as {
      applied_seq: number;
    }).applied_seq;
    if (row === expected) return row;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`applied_seq never reached ${expected}, last ${row}`);
}
