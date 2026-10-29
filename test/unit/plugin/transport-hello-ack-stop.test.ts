import { assertEquals } from "@std/assert";
import { Transport } from "../../../plugin/sync/transport.ts";

// #560: a hello_ack listener that stops the transport (passphrase changed
// elsewhere) must leave it disconnected: the guard after the hello_ack
// dispatch must never drive a dead socket toward live. Scripted WebSocket so
// the handshake is deterministic (same pattern as transport-retry-now.test.ts).

const realWebSocket = globalThis.WebSocket;

class FakeWebSocket extends EventTarget {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  binaryType: string = "arraybuffer";
  constructor(public url: string, _protocols?: string | string[]) {
    super();
    FakeWebSocket.instances.push(this);
    setTimeout(() => {
      if (this.readyState !== 3) {
        this.readyState = FakeWebSocket.OPEN;
        this.dispatchEvent(new Event("open"));
      }
    }, 0);
  }
  send(_data: string | ArrayBufferLike): void {}
  close(): void {
    this.readyState = 3;
  }
  receive(msg: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(msg) }));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await sleep(10);
  }
  throw new Error(`timeout waiting for ${what}`);
}

Deno.test({
  name: "transport: a hello_ack listener that calls stop() leaves the state disconnected",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    const transport = new Transport();
    const stopping = () => transport.stop();
    try {
      transport.addEventListener("hello_ack", stopping);
      transport.start("http://127.0.0.1:1", "test-vault", "me", "token", 0);
      await waitFor(() => transport.getState() === "connected", 2000, "connected");

      // Caught up (seq 0), so without the guard the handler would goLive
      // immediately after the listener stops the socket.
      FakeWebSocket.instances[0].receive({
        type: "server_hello_ack",
        seq: 0,
        server_version: "1.0.0",
      });
      assertEquals(
        transport.getState(),
        "disconnected",
        "a stopping hello_ack listener must leave the transport disconnected",
      );
    } finally {
      globalThis.WebSocket = realWebSocket;
      transport.stop();
    }
  },
});
