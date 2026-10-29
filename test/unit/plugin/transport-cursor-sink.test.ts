import { assertEquals } from "@std/assert";
import { Transport } from "../../../plugin/sync/transport.ts";
import { serveOnPortZero } from "../../helpers/port.ts";

/**
 * The persisted cursor must mean "durably applied", not "received". #212.
 *
 * - server_version: applies asynchronously (may throw) -> the transport must NOT
 *   persist the cursor on receipt. It only bumps the in-memory lastSeenSeq used
 *   for the go-live decision.
 * - server_commit_ack: our own commit is durably local -> it SHOULD route to the
 *   cursor sink.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startCursorServer(): { stop: () => Promise<void>; port: number } {
  const { port, shutdown } = serveOnPortZero((req: Request) => {
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const { response, socket } = Deno.upgradeWebSocket(req);
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({
          type: "server_hello_ack",
          vault_id: "test-vault",
          seq: 0,
          server_version: "0.9.2",
        }));
        // Remote version -> must NOT hit the sink (apply is async).
        socket.send(JSON.stringify({
          type: "server_version",
          vault_id: "test-vault",
          seq: 1,
          path_hash: "h1",
          parent_version: 0,
          enc_metadata: "x",
          chunk_hashes: [],
          deleted: false,
          device_id: "peer",
          version: 1,
        }));
        // Our own commit ack -> durably local, MUST hit the sink.
        socket.send(JSON.stringify({ type: "server_commit_ack", seq: 2, version: 2 }));
        setTimeout(() => socket.close(1000, "done"), 50);
      });
      return response;
    }
    return new Response("ok", { status: 200 });
  }, { hostname: "127.0.0.1" });
  return { stop: shutdown, port };
}

Deno.test({
  name: "transport-cursor-sink - server_version does not persist, commit_ack does",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { stop, port } = await startCursorServer();
    await sleep(50);

    const transport = new Transport();
    const sinkCalls: number[] = [];
    transport.setCursorSink((seq) => sinkCalls.push(seq));
    transport.start(`http://127.0.0.1:${port}`, "test-vault", "me", "token", 0);
    await sleep(200);

    // server_version seq 1 must NOT reach the sink: only the commit_ack seq 2.
    assertEquals(sinkCalls, [2]);
    // lastSeenSeq still advances on server_version for the go-live decision.
    assertEquals(transport.getLastSeenSeq(), 2);

    transport.stop();
    await stop();
  },
});
