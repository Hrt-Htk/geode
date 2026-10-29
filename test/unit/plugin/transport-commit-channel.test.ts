import { assert, assertEquals } from "@std/assert";
import { Transport } from "../../../plugin/sync/transport.ts";
import { PROTOCOL_VERSION } from "../../../core/protocol.ts";
import { serveOnPortZero } from "../../helpers/port.ts";

// Characterization tests for the commit channel (the queue/drain/in-flight/
// settle/ack-correlation surface), for the refactor into
// plugin/sync/commit-channel.ts (#387 step 7). Covers the paths the ack-
// correlation and timeout tests don't: FIFO ordering, one-in-flight, the
// server_conflict and server_error result paths, and the drain-after-goLive
// (reconnect) path.

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
  ack: (seq: number, version: number) => void;
  conflict: (opts: { path_hash: string; parent_version: number; reason: string }) => void;
  serverError: (code: string, message: string) => void;
  sendVersion: (seq: number) => void;
}

function startScriptedServer(
  opts: { helloAckSeq?: number; autoVersion?: boolean } = {},
): { stop: () => Promise<void>; port: number; conns: ScriptedConn[] } {
  const conns: ScriptedConn[] = [];
  const helloAckSeq = opts.helloAckSeq ?? 1;
  const autoVersion = opts.autoVersion ?? true;
  const { port, shutdown } = serveOnPortZero((req: Request) => {
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const { response, socket } = Deno.upgradeWebSocket(req);
      const conn: ScriptedConn = {
        commits: [],
        ack: () => {},
        conflict: () => {},
        serverError: () => {},
        sendVersion: () => {},
      };
      conns.push(conn);
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({
          type: "server_hello_ack",
          seq: helloAckSeq,
          protocol_version: PROTOCOL_VERSION,
        }));
        if (autoVersion) {
          setTimeout(() => {
            socket.send(JSON.stringify({
              type: "server_version",
              seq: helloAckSeq,
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
      conn.ack = (seq, version) =>
        socket.send(JSON.stringify({ type: "server_commit_ack", seq, version }));
      conn.conflict = ({ path_hash, parent_version, reason }) =>
        socket.send(JSON.stringify({
          type: "server_conflict",
          vault_id: "test-vault",
          path_hash,
          parent_version,
          reason,
        }));
      conn.serverError = (code, message) =>
        socket.send(JSON.stringify({ type: "server_error", code, message }));
      conn.sendVersion = (seq) =>
        socket.send(JSON.stringify({
          type: "server_version",
          seq,
          path_hash: "t",
          version: 1,
          parent_version: null,
          chunk_hashes: [],
          enc_metadata: "",
          deleted: false,
          device_id: "o",
        }));
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
  name: "transport-commit-channel - one in flight at a time, FIFO send + resolve",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const s = await startScriptedServer();
    await sleep(50);

    const transport = new Transport();
    transport.start(`http://127.0.0.1:${s.port}`, "test-vault", "me", "token", 0);
    await waitFor(() => transport.getState() === "live", 2000, "initial live");

    // A is sent immediately; B must wait for A's ack (one in flight).
    const pA = transport.commit(commitReq("A"));
    await waitFor(() => s.conns[0].commits.length === 1, 1000, "A sent");
    const pB = transport.commit(commitReq("B"));
    await sleep(100);
    assertEquals(s.conns[0].commits.length, 1, "B must not be sent while A is in flight");

    // Ack A -> B drains and is sent on the same connection.
    s.conns[0].ack(2, 2);
    const rA = await pA;
    assertEquals(rA.kind, "ack");
    if (rA.kind === "ack") {
      assertEquals(rA.seq, 2);
      assertEquals(rA.version, 2);
    }
    await waitFor(() => s.conns[0].commits.length === 2, 1000, "B sent after A acked");
    assertEquals(s.conns[0].commits[0].path_hash, "A");
    assertEquals(s.conns[0].commits[1].path_hash, "B");

    s.conns[0].ack(3, 3);
    const rB = await pB;
    assertEquals(rB.kind, "ack");
    if (rB.kind === "ack") {
      assertEquals(rB.seq, 3);
      assertEquals(rB.version, 3);
    }

    transport.stop();
    await s.stop();
  },
});

Deno.test({
  name: "transport-commit-channel - server_conflict resolves the in-flight commit, then drains",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const s = await startScriptedServer();
    await sleep(50);

    const transport = new Transport();
    transport.start(`http://127.0.0.1:${s.port}`, "test-vault", "me", "token", 0);
    await waitFor(() => transport.getState() === "live", 2000, "initial live");

    const pA = transport.commit(commitReq("A"));
    await waitFor(() => s.conns[0].commits.length === 1, 1000, "A sent");
    s.conns[0].conflict({ path_hash: "A", parent_version: 7, reason: "ancestor changed" });

    const rA = await pA;
    assertEquals(rA.kind, "conflict");
    if (rA.kind === "conflict") {
      assertEquals(rA.path_hash, "A");
      assertEquals(rA.parent_version, 7);
      assertEquals(rA.reason, "ancestor changed");
    }

    // A's conflict settles it -> the next queued commit drains.
    const pB = transport.commit(commitReq("B"));
    await waitFor(() => s.conns[0].commits.length === 2, 1000, "B sent after conflict");
    s.conns[0].ack(2, 2);
    const rB = await pB;
    assertEquals(rB.kind, "ack");

    transport.stop();
    await s.stop();
  },
});

Deno.test({
  name:
    "transport-commit-channel - server_error resolves the in-flight commit with the server message",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const s = await startScriptedServer();
    await sleep(50);

    const transport = new Transport();
    transport.start(`http://127.0.0.1:${s.port}`, "test-vault", "me", "token", 0);
    await waitFor(() => transport.getState() === "live", 2000, "initial live");

    const pA = transport.commit(commitReq("A"));
    await waitFor(() => s.conns[0].commits.length === 1, 1000, "A sent");
    s.conns[0].serverError("internal", "boom");

    const rA = await pA;
    assertEquals(rA.kind, "error");
    if (rA.kind === "error") assertEquals(rA.message, "boom");

    // server_error settles it -> the next queued commit drains.
    const pB = transport.commit(commitReq("B"));
    await waitFor(() => s.conns[0].commits.length === 2, 1000, "B sent after server_error");
    s.conns[0].ack(2, 2);
    const rB = await pB;
    assertEquals(rB.kind, "ack");

    transport.stop();
    await s.stop();
  },
});

Deno.test({
  name:
    "transport-commit-channel - a stop with a commit in flight settles it and the channel keeps draining",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const s = await startScriptedServer();
    await sleep(50);

    const transport = new Transport();
    transport.start(`http://127.0.0.1:${s.port}`, "test-vault", "me", "token", 0);
    await waitFor(() => transport.getState() === "live", 2000, "initial live");

    // #616: the socket goes away with the ack in flight (a drop, or the user
    // pausing sync): the commit can never be acked on this connection, so it
    // must settle instead of holding the channel forever.
    const pA = transport.commit(commitReq("A"));
    await waitFor(() => s.conns[0].commits.length === 1, 1000, "A sent");
    transport.stop();
    const settledA = await Promise.race([pA, sleep(1000).then(() => "hung" as const)]);
    assert(settledA !== "hung", "the in-flight commit must settle when the socket goes away");
    assertEquals(settledA.kind, "error");

    // Reconnect: the channel must accept work again (a wedged in-flight commit
    // used to make every later drain a no-op, so nothing was ever sent again).
    transport.start(`http://127.0.0.1:${s.port}`, "test-vault", "me", "token", 0);
    await waitFor(() => transport.getState() === "live", 2000, "live after restart");
    const pB = transport.commit(commitReq("B"));
    await waitFor(
      () => s.conns.at(-1)!.commits.length === 1,
      1000,
      "B sent after the reconnect",
    );
    s.conns.at(-1)!.ack(3, 3);
    const rB = await pB;
    assertEquals(rB.kind, "ack");

    transport.stop();
    await s.stop();
  },
});

Deno.test({
  name: "transport-commit-channel - commit queued while syncing drains after goLive",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // hello_ack seq 2 but no auto version: the client stays "syncing"
    // (lastSeenSeq 0 < liveTarget 2), so a queued commit is never sent.
    const s = await startScriptedServer({ helloAckSeq: 2, autoVersion: false });
    await sleep(50);

    const transport = new Transport();
    transport.start(`http://127.0.0.1:${s.port}`, "test-vault", "me", "token", 0);
    await waitFor(() => transport.getState() === "syncing", 2000, "syncing");

    const pB = transport.commit(commitReq("B"));
    await sleep(100);
    assertEquals(s.conns[0].commits.length, 0, "B must stay queued while not live");

    // Replaying the tail pushes lastSeenSeq to liveTarget -> goLive -> drain.
    s.conns[0].sendVersion(2);
    await waitFor(() => s.conns[0].commits.length === 1, 1000, "B sent after goLive");
    s.conns[0].ack(2, 2);
    const rB = await pB;
    assertEquals(rB.kind, "ack");

    transport.stop();
    await s.stop();
  },
});
