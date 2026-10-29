import { assert, assertEquals } from "@std/assert";
import { Transport } from "../../../plugin/sync/transport.ts";
import { PROTOCOL_VERSION } from "../../../core/protocol.ts";
import { serveOnPortZero } from "../../helpers/port.ts";

// #359: commit acks carry no commit id, so the transport must never correlate
// a result to the wrong commit. Three regressions:
//   (a) a timed-out commit A must close its socket so a late ack can't reach
//       the connection the next commit B is sent over;
//   (b) a result with no commit in flight must not resolve a queued, unsent commit;
//   (c) a socket close with a commit in flight must settle it immediately,
//       not after the commit timeout.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  fn: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await sleep(20);
  }
  throw new Error(`timeout waiting for ${what}`);
}

interface ScriptedConn {
  commits: Array<Record<string, unknown>>;
  closed: boolean;
  ack: (seq: number, version: number) => void;
  close: () => void;
}

function startScriptedServer(
  opts: { sendVersion?: boolean } = {},
): { stop: () => Promise<void>; port: number; conns: ScriptedConn[] } {
  const conns: ScriptedConn[] = [];
  const sendVersion = opts.sendVersion ?? true;
  const { port, shutdown } = serveOnPortZero((req: Request) => {
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const { response, socket } = Deno.upgradeWebSocket(req);
      const conn: ScriptedConn = {
        commits: [],
        closed: false,
        ack: () => {},
        close: () => {},
      };
      conns.push(conn);
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({
          type: "server_hello_ack",
          seq: 1,
          protocol_version: PROTOCOL_VERSION,
        }));
        if (sendVersion) {
          setTimeout(() => {
            socket.send(JSON.stringify({
              type: "server_version",
              seq: 1,
              path_hash: "t",
              version: 1,
              parent_version: null,
              chunk_hashes: [],
              enc_metadata: "",
              deleted: false,
              device_id: "o",
            }));
          }, 10);
        }
      });
      socket.addEventListener("message", (event: MessageEvent) => {
        if (typeof event.data !== "string") return;
        const msg = JSON.parse(event.data);
        if (msg.type === "client_commit") conn.commits.push(msg);
      });
      socket.addEventListener("close", () => {
        conn.closed = true;
      });
      conn.ack = (seq, version) =>
        socket.send(JSON.stringify({ type: "server_commit_ack", seq, version }));
      conn.close = () => socket.close(1000, "bye");
      return response;
    }
    return new Response("ok", { status: 200 });
  }, { hostname: "127.0.0.1" });
  return { stop: shutdown, port, conns };
}

function commitReq(pathHash: string) {
  return {
    path_hash: pathHash,
    parent_version: null,
    enc_metadata: "m",
    chunk_hashes: [],
    deleted: false,
  };
}

Deno.test({
  name: "transport-ack-correlation - (a) timeout closes socket so late ack can't resolve B",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const s = await startScriptedServer();
    await sleep(50);

    const transport = new Transport();
    (transport as unknown as Record<string, unknown>)._commitTimeoutMs = 300;
    transport.start(`http://127.0.0.1:${s.port}`, "test-vault", "me", "token", 0);
    await waitFor(() => transport.getState() === "live", 2000, "initial live");

    // A is sent on conn0; the server holds it (no ack) so A times out.
    const pA = transport.commit(commitReq("A"));
    await waitFor(() => s.conns[0].commits.length === 1, 1000, "A sent on conn0");

    const rA = await pA;
    assertEquals(rA.kind, "error");
    if (rA.kind === "error") assertEquals(rA.message, "commit timeout");

    // The transport must close conn0 so A's late ack can't reach B's connection.
    await waitFor(() => s.conns[0].closed, 2000, "conn0 closed after timeout");

    // Reconnect on conn1; B is sent there and resolves via its own ack.
    await waitFor(() => s.conns.length >= 2, 3000, "reconnect (conn1)");
    await waitFor(() => transport.getState() === "live", 3000, "live after reconnect");

    const pB = transport.commit(commitReq("B"));
    await waitFor(() => s.conns[1].commits.length === 1, 1000, "B sent on conn1");
    s.conns[1].ack(2, 2);
    const rB = await pB;
    assertEquals(rB.kind, "ack");

    // B was never sent on the first (closed) connection.
    assertEquals(s.conns[0].commits.length, 1);

    transport.stop();
    await s.stop();
  },
});

Deno.test({
  name:
    "transport-ack-correlation - (b) ack with no commit in flight doesn't resolve a queued unsent commit",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // No server_version -> transport stays "syncing", so queued commits are never sent.
    const s = await startScriptedServer({ sendVersion: false });
    await sleep(50);

    const transport = new Transport();
    transport.start(`http://127.0.0.1:${s.port}`, "test-vault", "me", "token", 0);
    await waitFor(() => transport.getState() === "syncing", 2000, "syncing");

    const pB = transport.commit(commitReq("B")); // queued but unsent (not live)
    assertEquals(s.conns[0].commits.length, 0);

    // A late ack arrives with no commit in flight: must NOT resolve the queued B.
    s.conns[0].ack(2, 2);

    const settled = await Promise.race([
      pB.then(() => true),
      sleep(200).then(() => false),
    ]);
    assertEquals(settled, false); // B stays pending, unresolved

    transport.stop();
    await s.stop();
  },
});

Deno.test({
  name: "transport-ack-correlation - (c) socket close with commit in flight settles it immediately",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const s = await startScriptedServer();
    await sleep(50);

    const transport = new Transport();
    // Large commit timeout: proves the close handler, not the timeout, settles A.
    (transport as unknown as Record<string, unknown>)._commitTimeoutMs = 10000;
    transport.start(`http://127.0.0.1:${s.port}`, "test-vault", "me", "token", 0);
    await waitFor(() => transport.getState() === "live", 2000, "live");

    const pA = transport.commit(commitReq("A"));
    await waitFor(() => s.conns[0].commits.length === 1, 1000, "A sent");

    const started = Date.now();
    s.conns[0].close(); // server closes the socket with A in flight
    const rA = await pA;
    const elapsed = Date.now() - started;

    assertEquals(rA.kind, "error");
    if (rA.kind === "error") assertEquals(rA.message, "socket closed");
    assert(
      elapsed < 8_000,
      `close handler must settle the in-flight commit well below the 10s timeout: took ${elapsed} ms`,
    );

    transport.stop();
    await s.stop();
  },
});
