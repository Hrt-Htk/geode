import { assertEquals } from "@std/assert";
import { Transport } from "../../../plugin/sync/transport.ts";

// #354 / #368: a socket that fires `error` then `close` (as a dead TCP
// connection does) must schedule exactly ONE reconnect, not two. Both handlers
// null `this.ws`; the guard `this.ws !== ws` makes the second event return
// early. Regression: without the guard, error+close double the reconnect backoff
// every failure (transport.ts:207-218). Use a scripted WebSocket so both events
// fire on the SAME socket deterministically.

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
  fire(type: "error" | "close"): void {
    this.dispatchEvent(new Event(type));
  }
}

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
    await sleep(10);
  }
  throw new Error(`timeout waiting for ${what}`);
}

Deno.test({
  name: "transport-reconnect-single - error then close on same socket schedules one reconnect",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    const transport = new Transport();
    const reconnectEvents: string[] = [];
    transport.addEventListener("reconnect", () => reconnectEvents.push("reconnect"));

    try {
      transport.start("http://127.0.0.1:1", "test-vault", "me", "token", 0);
      await waitFor(() => transport.getState() === "connected", 2000, "connected");

      const ws = FakeWebSocket.instances[0];
      ws.fire("error");
      ws.fire("close");

      // Both events fire synchronously; if the close handler double-scheduled,
      // reconnectEvents would already be 2 here.
      assertEquals(reconnectEvents.length, 1);

      // A second schedule would only appear after the (1000ms) reconnect delay,
      // give it a window to catch a spurious extra schedule before stopping.
      await sleep(1200);
      assertEquals(reconnectEvents.length, 1);
    } finally {
      globalThis.WebSocket = realWebSocket;
      transport.stop();
    }
  },
});
