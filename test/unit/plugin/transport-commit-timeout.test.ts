import { assertEquals } from "@std/assert";
import { Transport } from "../../../plugin/sync/transport.ts";
import { PROTOCOL_VERSION } from "../../../core/protocol.ts";
import { serveOnPortZero } from "../../helpers/port.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Use Deno.serve with WebSocket upgrade for a proper test server.
 * Silent server: gets client to "live" but never responds to commits.
 */
function startSilentServer(): { stop: () => Promise<void>; port: number } {
  const { port, shutdown } = serveOnPortZero((req: Request) => {
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return handleSilentWs(req);
    }
    return new Response("ok", { status: 200 });
  }, { hostname: "127.0.0.1" });
  return { stop: shutdown, port };
}

function handleSilentWs(req: Request): Response {
  const { response, socket } = Deno.upgradeWebSocket(req);

  socket.addEventListener("open", () => {
    // Immediately send hello_ack and a version to get client to "live"
    socket.send(JSON.stringify({
      type: "server_hello_ack",
      seq: 1,
      protocol_version: PROTOCOL_VERSION,
    }));
    // Small delay then send version
    setTimeout(() => {
      socket.send(JSON.stringify({
        type: "server_version",
        seq: 1,
        path_hash: "test",
        version: 1,
        parent_version: null,
        chunk_hashes: [],
        enc_metadata: "",
        deleted: false,
        device_id: "other",
      }));
    }, 10);
  });

  // Consume all incoming messages but never respond
  socket.addEventListener("message", () => {
    // Silently discard: this is the "hung server" behavior
  });

  return response;
}

/**
 * Server that responds to client_commit with an ack.
 */
function startRespondingServer(): { stop: () => Promise<void>; port: number } {
  const { port, shutdown } = serveOnPortZero((req: Request) => {
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return handleRespondingWs(req);
    }
    return new Response("ok", { status: 200 });
  }, { hostname: "127.0.0.1" });
  return { stop: shutdown, port };
}

function handleRespondingWs(req: Request): Response {
  const { response, socket } = Deno.upgradeWebSocket(req);

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({
      type: "server_hello_ack",
      seq: 1,
      protocol_version: PROTOCOL_VERSION,
    }));
    setTimeout(() => {
      socket.send(JSON.stringify({
        type: "server_version",
        seq: 1,
        path_hash: "test",
        version: 1,
        parent_version: null,
        chunk_hashes: [],
        enc_metadata: "",
        deleted: false,
        device_id: "other",
      }));
    }, 10);
  });

  socket.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    const msg = JSON.parse(event.data);
    if (msg.type === "client_commit") {
      // Respond immediately with ack
      socket.send(JSON.stringify({
        type: "server_commit_ack",
        seq: 2,
        version: 2,
      }));
    }
  });

  return response;
}

Deno.test({
  name: "transport-commit-timeout - commit resolves as error when server never replies",
  async fn() {
    const { stop, port } = await startSilentServer();
    await sleep(50);

    const transport = new Transport();
    // Override commit timeout for fast test
    (transport as unknown as Record<string, unknown>)._commitTimeoutMs = 50;

    transport.start(
      `http://127.0.0.1:${port}`,
      "test-vault",
      "test-device",
      "test-token",
      0,
    );

    // Wait for live state
    const livePromise = new Promise<void>((resolve) => {
      transport.addEventListener("live", () => resolve());
    });
    await livePromise;

    // Queue a commit: the server will never reply
    const result = await transport.commit({
      path_hash: "abc123",
      parent_version: null,
      enc_metadata: "meta",
      chunk_hashes: ["chunk1"],
      deleted: false,
    });

    assertEquals(result.kind, "error");
    if (result.kind === "error") {
      assertEquals(result.message, "commit timeout");
    }

    transport.stop();
    await stop();
  },
});

Deno.test({
  name: "transport-commit-timeout - queue unblocks after timeout (second commit can drain)",
  async fn() {
    const { stop, port } = await startSilentServer();
    await sleep(50);

    const transport = new Transport();
    (transport as unknown as Record<string, unknown>)._commitTimeoutMs = 50;

    transport.start(
      `http://127.0.0.1:${port}`,
      "test-vault",
      "test-device",
      "test-token",
      0,
    );

    const livePromise = new Promise<void>((resolve) => {
      transport.addEventListener("live", () => resolve());
    });
    await livePromise;

    // Queue two commits: first times out, second should also time out (not hang forever)
    const p1 = transport.commit({
      path_hash: "hash1",
      parent_version: null,
      enc_metadata: "m1",
      chunk_hashes: ["c1"],
      deleted: false,
    });
    const p2 = transport.commit({
      path_hash: "hash2",
      parent_version: null,
      enc_metadata: "m2",
      chunk_hashes: ["c2"],
      deleted: false,
    });

    const r1 = await p1;
    assertEquals(r1.kind, "error");

    // Second commit should also resolve (not hang)
    const r2 = await p2;
    assertEquals(r2.kind, "error");

    transport.stop();
    await stop();
  },
});

Deno.test({
  name: "transport-commit-timeout - timeout cancelled on normal server response",
  async fn() {
    const { stop, port } = await startRespondingServer();
    await sleep(50);

    const transport = new Transport();
    (transport as unknown as Record<string, unknown>)._commitTimeoutMs = 5000; // long timeout

    transport.start(
      `http://127.0.0.1:${port}`,
      "test-vault",
      "test-device",
      "test-token",
      0,
    );

    const livePromise = new Promise<void>((resolve) => {
      transport.addEventListener("live", () => resolve());
    });
    await livePromise;

    const result = await transport.commit({
      path_hash: "abc123",
      parent_version: null,
      enc_metadata: "meta",
      chunk_hashes: ["chunk1"],
      deleted: false,
    });

    assertEquals(result.kind, "ack");
    if (result.kind === "ack") {
      assertEquals(result.seq, 2);
      assertEquals(result.version, 2);
    }

    transport.stop();
    await stop();
  },
});
