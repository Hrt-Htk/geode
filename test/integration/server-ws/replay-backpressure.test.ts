// Regression test for issue #302: server replay backpressure counter never decrements.
// A join replay of N > 1000 versions must deliver ALL versions without a 1011 "backpressure" close.
//
// Root cause: enqueue() increments a monotonic sendQueueLength and closes at >1000,
// but the counter is never decremented: it's a lifetime send counter, not queue depth.

import { insertVersion } from "../../../server/db.ts";
import { log } from "../../../server/log.ts";
import { PROTOCOL_VERSION } from "../../../core/protocol.ts";
import { SERVER_VERSION } from "../../../server/version-gate.ts";
import { assert, assertEquals } from "@std/assert";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";
import { startServer } from "./ws-helpers.ts";

interface BufferedClient {
  ws: WebSocket;
  opened: Promise<void>;
  deviceId: string;
  close(): void;
  recv(timeoutMs?: number): Promise<string>;
}

function connectWS(port: number, vaultId: string): BufferedClient {
  const ws = new WebSocket(
    `ws://localhost:${port}/vaults/${vaultId}/sync`,
    "bearer.dev",
  );
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

  return {
    ws,
    opened,
    deviceId: "dev",
    close() {
      this.ws.close();
    },
    recv,
  };
}

// ── Test ──

Deno.test({
  name: "replay - 1100 versions delivered without backpressure close",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const N = 1100;
    const dataDir = makeTempDataDir();
    const srv = await startServer(dataDir, ["dev"]);
    try {
      const port = srv.port;

      // Insert N versions directly into the DB (fast; no client_commit overhead).
      // Chain: parent_version = i, so versions are 1..N, seqs are 1..N.
      const pathHash = "replay".repeat(10) + "replay";
      for (let i = 1; i <= N; i++) {
        const result = insertVersion(
          srv.db,
          "test-vault",
          pathHash,
          i - 1, // parent = previous version
          new TextEncoder().encode(JSON.stringify({ path: `replay-${i}.md` })),
          [],
          false,
          "dev",
        );
        assertEquals(result.version, i);
        assertEquals(result.seq, i);
      }

      // Connect a client with last_seen_seq=0 → should replay all N versions.
      const client = await connectWS(port, "test-vault");
      await client.opened;

      // Flag a 1011 "backpressure" close if the server kills the socket mid-replay.
      let backpressureClose: { code: number; reason: string } | null = null;
      client.ws.addEventListener("close", (e) => {
        if (e.code === 1011) backpressureClose = { code: e.code, reason: e.reason };
      });

      // Send hello
      client.ws.send(JSON.stringify({
        type: "client_hello",
        protocol_version: PROTOCOL_VERSION,
        plugin_version: SERVER_VERSION,
        device_id: "dev",
        last_seen_seq: 0,
      }));

      // Drain hello_ack
      const ackRaw = await client.recv();
      const ack = JSON.parse(ackRaw);
      assertEquals(ack.type, "server_hello_ack");

      // Drain server_version messages until all N arrive (break immediately at N) or the
      // stream stalls. Under the bug the socket is closed at ~999 and recv() times out.
      const seqs: number[] = [];
      while (seqs.length < N) {
        let raw: string;
        try {
          raw = await client.recv(3000);
        } catch {
          break; // stream stalled or socket closed early (the bug)
        }
        const msg = JSON.parse(raw);
        if (msg.type === "server_version") seqs.push(msg.seq);
        else if (msg.type !== "server_hello_ack") {
          log.warn("unexpected replay message", { type: msg.type });
        }
      }

      // ASSERT: all N versions arrived, in order, with no 1011 backpressure close.
      assert(
        !backpressureClose,
        `Backpressure close during replay (received ${seqs.length}/${N} versions)`,
      );
      assertEquals(seqs.length, N, `Expected ${N} server_version messages, got ${seqs.length}`);
      assertEquals(seqs[seqs.length - 1], N, `Last seq should be ${N}`);
    } finally {
      try {
        await srv.stop();
      } catch {
        /* ignore */
      }
      removeTempDir(dataDir);
    }
  },
});
