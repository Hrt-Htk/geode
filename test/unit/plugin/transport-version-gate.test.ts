import { assertEquals } from "@std/assert";
import { Transport } from "../../../plugin/sync/transport.ts";
import { PROTOCOL_VERSION } from "../../../core/protocol.ts";
import { serveOnPortZero } from "../../helpers/port.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Server that acks the hello with a DIFFERENT but compatible server version and
 * keeps the socket open: the new #529 behaviour: a plain version difference
 * must NOT block, only a protocol or minimum-version mismatch does.
 */
function startCompatibleServer(): { stop: () => Promise<void>; port: number } {
  const { port, shutdown } = serveOnPortZero((req: Request) => {
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return handleCompatibleWs(req);
    }
    return new Response("ok", { status: 200 });
  }, { hostname: "127.0.0.1" });
  return { stop: shutdown, port };
}

function handleCompatibleWs(req: Request): Response {
  const { response, socket } = Deno.upgradeWebSocket(req);

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({
      type: "server_hello_ack",
      seq: 0,
      protocol_version: PROTOCOL_VERSION,
      server_version: "9.9.9",
    }));
  });

  return response;
}

/**
 * Server that acks the hello, sends server_version_mismatch, then closes with 1008,
 * the exact "mismatched plugin version" flow the client must react to.
 */
function startBlockingServer(): { stop: () => Promise<void>; port: number } {
  const { port, shutdown } = serveOnPortZero((req: Request) => {
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return handleBlockingWs(req);
    }
    return new Response("ok", { status: 200 });
  }, { hostname: "127.0.0.1" });
  return { stop: shutdown, port };
}

function handleBlockingWs(req: Request): Response {
  const { response, socket } = Deno.upgradeWebSocket(req);

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({
      type: "server_hello_ack",
      seq: 0,
      protocol_version: PROTOCOL_VERSION,
      server_version: "0.9.2",
    }));
    socket.send(JSON.stringify({
      type: "server_version_mismatch",
      server_version: "0.9.2",
      client_version: "0.8.0",
    }));
    // #625: the real server's reason; it must not produce a second blocked event.
    socket.close(1008, "protocol version mismatch: server 5, client 4: update required");
  });

  return response;
}

/**
 * Server that refuses the client without the `server_version_mismatch` message,
 * a bare 1008 whose reason says "update required" (#625 fallback path).
 */
function startUpdateRequiredServer(
  reason: string,
): { stop: () => Promise<void>; port: number } {
  const { port, shutdown } = serveOnPortZero((req: Request) => {
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const { response, socket } = Deno.upgradeWebSocket(req);
      socket.addEventListener("open", () => socket.close(1008, reason));
      return response;
    }
    return new Response("ok", { status: 200 });
  }, { hostname: "127.0.0.1" });
  return { stop: shutdown, port };
}

Deno.test({
  name: "transport-version-gate - hello_ack stores server_version",
  async fn() {
    const { stop, port } = await startBlockingServer();
    await sleep(50);

    const transport = new Transport();
    transport.start(
      `http://127.0.0.1:${port}`,
      "test-vault",
      "test-device",
      "test-token",
      0,
      "0.8.0",
    );
    await sleep(200);

    assertEquals(transport.getServerVersion(), "0.9.2");

    transport.stop();
    await stop();
  },
});

Deno.test({
  name: "transport-version-gate - mismatch sets blocked state, fires event, stops reconnect",
  async fn() {
    const { stop, port } = await startBlockingServer();
    await sleep(50);

    const transport = new Transport();
    const blockedDetails: Array<
      { server_version: string; client_version: string; reason: string }
    > = [];
    transport.addEventListener("blocked", (event: Event) => {
      blockedDetails.push((event as CustomEvent).detail);
    });
    const reconnectEvents: string[] = [];
    transport.addEventListener("reconnect", () => reconnectEvents.push("reconnect"));

    transport.start(
      `http://127.0.0.1:${port}`,
      "test-vault",
      "test-device",
      "test-token",
      0,
      "0.8.0",
    );

    // Wait for hello_ack + mismatch + close to all be processed.
    await sleep(200);

    assertEquals(transport.getState(), "blocked");
    assertEquals(transport.isBlocked(), true);

    assertEquals(blockedDetails.length, 1);
    assertEquals(blockedDetails[0].server_version, "0.9.2");
    assertEquals(blockedDetails[0].client_version, "0.8.0");
    // #625: the reason travels with the event so the host can pick the side.
    assertEquals(blockedDetails[0].reason, "");

    // Socket closed after the mismatch, but blocked must NOT schedule a reconnect.
    assertEquals(reconnectEvents.length, 0);

    // Give a second window to catch any delayed reconnect attempt.
    await sleep(200);
    assertEquals(reconnectEvents.length, 0);
    assertEquals(transport.getState(), "blocked");

    transport.stop();
    await stop();
  },
});

Deno.test({
  name:
    "transport-version-gate - 1008 update-required close blocks without a mismatch message, no reconnect (#625)",
  async fn() {
    const { stop, port } = await startUpdateRequiredServer(
      "protocol version mismatch: server 5, client 4: update required",
    );
    await sleep(50);

    const transport = new Transport();
    const blockedDetails: Array<
      { server_version: string; client_version: string; reason: string }
    > = [];
    transport.addEventListener("blocked", (event: Event) => {
      blockedDetails.push((event as CustomEvent).detail);
    });
    const reconnectEvents: string[] = [];
    transport.addEventListener("reconnect", () => reconnectEvents.push("reconnect"));

    transport.start(
      `http://127.0.0.1:${port}`,
      "test-vault",
      "test-device",
      "test-token",
      0,
      "0.8.0",
    );
    await sleep(200);

    assertEquals(transport.getState(), "blocked");
    assertEquals(transport.isBlocked(), true);
    assertEquals(blockedDetails.length, 1);
    assertEquals(blockedDetails[0].client_version, "0.8.0");
    assertEquals(
      blockedDetails[0].reason,
      "protocol version mismatch: server 5, client 4: update required",
    );

    // Past INITIAL_RECONNECT_DELAY (1s): a reconnect loop would have fired here.
    await sleep(1_500);
    assertEquals(reconnectEvents.length, 0);
    assertEquals(transport.getState(), "blocked");

    transport.stop();
    await stop();
  },
});

Deno.test({
  name: "transport-version-gate - a 1008 without update-required still reconnects",
  async fn() {
    const { stop, port } = await startUpdateRequiredServer("revoked");
    await sleep(50);

    const transport = new Transport();
    const reconnectEvents: string[] = [];
    transport.addEventListener("reconnect", () => reconnectEvents.push("reconnect"));

    transport.start(
      `http://127.0.0.1:${port}`,
      "test-vault",
      "test-device",
      "test-token",
      0,
      "0.8.0",
    );
    await sleep(1_500);

    assertEquals(transport.isBlocked(), false);
    assertEquals(reconnectEvents.length > 0, true, "a plain 1008 must keep the backoff loop");
    assertEquals(transport.getState(), "disconnected");

    transport.stop();
    await stop();
  },
});

Deno.test({
  name: "transport-version-gate - different-but-compatible version stays live, no block (#529)",
  async fn() {
    const { stop, port } = await startCompatibleServer();
    await sleep(50);

    const transport = new Transport();
    const blockedEvents: unknown[] = [];
    transport.addEventListener("blocked", () => blockedEvents.push(1));

    transport.start(
      `http://127.0.0.1:${port}`,
      "test-vault",
      "test-device",
      "test-token",
      0,
      "0.8.0",
    );
    await sleep(200);

    assertEquals(transport.getState(), "live");
    assertEquals(transport.isBlocked(), false);
    assertEquals(transport.getServerVersion(), "9.9.9");
    assertEquals(blockedEvents.length, 0);

    transport.stop();
    await stop();
  },
});

/** Server that acks (arming the replay-drain timer) and then refuses with the message. */
function startAckThenRefuseServer(): { stop: () => Promise<void>; port: number } {
  const { port, shutdown } = serveOnPortZero((req: Request) => {
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const { response, socket } = Deno.upgradeWebSocket(req);
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({
          type: "server_hello_ack",
          vault_id: "test-vault",
          vault_name: "test",
          seq: 5,
          server_version: "0.9.2",
        }));
        socket.send(JSON.stringify({
          type: "server_version_mismatch",
          server_version: "0.9.2",
          client_version: "0.8.0",
        }));
        socket.close(1008, "plugin version 0.8.0 below minimum 0.9.0: update required");
      });
      return response;
    }
    return new Response("ok", { status: 200 });
  }, { hostname: "127.0.0.1" });
  return { stop: shutdown, port };
}

Deno.test({
  name: "transport-version-gate - entering blocked cancels the armed replay timer (#625)",
  async fn() {
    const { stop, port } = await startAckThenRefuseServer();
    await sleep(50);

    const transport = new Transport();
    transport.start(
      `http://127.0.0.1:${port}`,
      "test-vault",
      "test-device",
      "test-token",
      0,
      "0.8.0",
    );
    await sleep(200);
    // hello_ack armed the 10s replay-drain timer before the refusal arrived.
    assertEquals(transport.getState(), "blocked");

    await sleep(10_500);
    assertEquals(
      transport.getState(),
      "blocked",
      "a leftover replay timer must not flip a blocked transport to live",
    );

    transport.stop();
    await stop();
  },
});

Deno.test({
  name: "transport-version-gate - start() forgets the previous connect's server version (#625)",
  async fn() {
    let upgrades = 0;
    const { port, shutdown } = serveOnPortZero((req: Request) => {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const { response, socket } = Deno.upgradeWebSocket(req);
        const first = ++upgrades === 1;
        socket.addEventListener("open", () => {
          if (first) {
            socket.send(JSON.stringify({
              type: "server_hello_ack",
              vault_id: "test-vault",
              vault_name: "test",
              seq: 0,
              server_version: "9.9.9",
            }));
            socket.close(1000, "bye");
          } else {
            socket.close(1008, "protocol version mismatch: server 4, client 5: update required");
          }
        });
        return response;
      }
      return new Response("ok", { status: 200 });
    }, { hostname: "127.0.0.1" });

    const transport = new Transport();
    const blockedDetails: Array<{ server_version: string }> = [];
    transport.addEventListener("blocked", (event: Event) => {
      blockedDetails.push((event as CustomEvent).detail);
    });

    const url = `http://127.0.0.1:${port}`;
    transport.start(url, "test-vault", "test-device", "test-token", 0, "0.8.0");
    await sleep(200);
    assertEquals(transport.getServerVersion(), "9.9.9");

    transport.stop();
    transport.start(url, "test-vault", "test-device", "test-token", 0, "0.8.0");
    await sleep(300);

    assertEquals(transport.getState(), "blocked");
    assertEquals(blockedDetails.length, 1);
    assertEquals(
      blockedDetails[0].server_version,
      "",
      "the previous connect's version must not leak",
    );

    transport.stop();
    await shutdown();
  },
});
