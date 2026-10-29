// #680 L-3 - the socket handler parsed every frame straight into handleMessage, so a
// frame that is not JSON threw out of the "message" listener: nothing caught it and
// the frame was lost. It is now logged and dropped, and the socket stays usable.
import { assert, assertEquals } from "@std/assert";
import { Transport } from "../../../plugin/sync/transport.ts";

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
  receiveRaw(data: string): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  receive(msg: unknown): void {
    this.receiveRaw(JSON.stringify(msg));
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
  name: "transport: an unparseable server frame is dropped and the socket keeps working",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    const transport = new Transport();
    const uncaught: unknown[] = [];
    const onError = (e: ErrorEvent): void => {
      uncaught.push(e.error ?? e.message);
      e.preventDefault();
    };
    globalThis.addEventListener("error", onError);

    try {
      transport.start("http://127.0.0.1:1", "test-vault", "me", "token", 0);
      await waitFor(() => transport.getState() === "connected", 2000, "connected");

      // Thrown inside the listener, an exception surfaces as an uncaught error and the
      // transport never reaches syncing.
      FakeWebSocket.instances[0].receiveRaw("{not json");
      FakeWebSocket.instances[0].receive({
        type: "server_hello_ack",
        seq: 0,
        server_version: "1.0.0",
      });

      await waitFor(() => transport.getState() === "live", 2000, "live after a bad frame");
      assertEquals(uncaught, [], "a bad frame must not surface as an uncaught error");
      assert(FakeWebSocket.instances[0].readyState !== 3, "the socket must stay open");
    } finally {
      globalThis.removeEventListener("error", onError);
      globalThis.WebSocket = realWebSocket;
      transport.stop();
    }
  },
});
