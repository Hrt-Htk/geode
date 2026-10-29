import { assertEquals } from "@std/assert";
import { Transport } from "../../../plugin/sync/transport.ts";
import { PROTOCOL_VERSION } from "../../../core/protocol.ts";
import { serveOnPortZero } from "../../helpers/port.ts";

// #433: the device reports its applied seq over the live WS after applying a
// catch-up. reportAppliedSeq must send an additive `client_progress` message and
// no-op when the socket is closed.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startCaptureServer(): {
  stop: () => Promise<void>;
  port: number;
  captured: Array<Record<string, unknown>>;
} {
  const captured: Array<Record<string, unknown>> = [];
  const { port, shutdown } = serveOnPortZero((req: Request) => {
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const { response, socket } = Deno.upgradeWebSocket(req);
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({
          type: "server_hello_ack",
          vault_id: "test-vault",
          seq: 0,
          server_version: "0.24.3",
        }));
      });
      socket.addEventListener("message", (e: MessageEvent) => {
        const data = typeof e.data === "string" ? e.data : "";
        try {
          captured.push(JSON.parse(data) as Record<string, unknown>);
        } catch {
          captured.push({ raw: data });
        }
      });
      return response;
    }
    return new Response("ok", { status: 200 });
  }, { hostname: "127.0.0.1" });
  return { stop: shutdown, port, captured };
}

Deno.test({
  name: "transport-report-progress - sends client_progress over the live socket",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { stop, port, captured } = await startCaptureServer();
    await sleep(50);

    const transport = new Transport();
    transport.start(`http://127.0.0.1:${port}`, "test-vault", "me", "token", 0, "0.0.0-test");
    await sleep(150);

    transport.reportAppliedSeq(42);
    await sleep(100);

    const progress = captured.find((m) => m.type === "client_progress");
    assertEquals(progress !== undefined, true, "expected a client_progress message");
    assertEquals(progress!.applied_seq, 42);
    const hello = captured.find((m) => m.type === "client_hello") as
      | { protocol_version: number }
      | undefined;
    assertEquals(hello?.protocol_version, PROTOCOL_VERSION, "hello unchanged (additive)");

    transport.stop();
    await stop();
  },
});

Deno.test({
  name: "transport-report-progress - no-op while the socket is closed",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { stop, port, captured } = await startCaptureServer();
    await sleep(50);

    const transport = new Transport();
    transport.start(`http://127.0.0.1:${port}`, "test-vault", "me", "token", 0, "0.0.0-test");
    await sleep(150);
    transport.stop();
    await sleep(50);

    transport.reportAppliedSeq(7);
    await sleep(100);

    const progress = captured.filter((m) => m.type === "client_progress");
    assertEquals(progress.length, 0, "no client_progress may be sent when closed");
    await stop();
  },
});
