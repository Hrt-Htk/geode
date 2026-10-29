import { assertEquals } from "@std/assert";
import { Transport } from "../../../plugin/sync/transport.ts";

// #339: [Retry] on the settings error banner: from a disconnected backoff the
// user's retry must connect immediately with a fresh (initial) backoff, and be
// a no-op while connecting or live. Scripted WebSocket so failures are
// deterministic (same pattern as transport-reconnect-single.test.ts).

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
  name: "transport-retry-now - disconnected backoff: connects immediately and resets the delay",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    const transport = new Transport();
    const reconnectDelays: number[] = [];
    transport.addEventListener(
      "reconnect",
      (e) => reconnectDelays.push((e as CustomEvent<number>).detail),
    );

    try {
      transport.start("http://127.0.0.1:1", "test-vault", "me", "token", 0);
      await waitFor(() => transport.getState() === "connected", 2000, "connected");

      const ws1 = FakeWebSocket.instances[0];
      ws1.fire("error");
      ws1.fire("close");
      assertEquals(transport.getState(), "disconnected");
      assertEquals(reconnectDelays, [1000], "first failure schedules the initial delay");

      // Before the 1 s backoff elapses, no new socket is opened.
      await sleep(300);
      assertEquals(FakeWebSocket.instances.length, 1);

      transport.retryNow();
      assertEquals(FakeWebSocket.instances.length, 2, "retryNow must connect immediately");
      assertEquals(transport.getState(), "connecting");

      // The manual attempt resets the backoff: the next failure schedules the
      // initial delay again, not the doubled one.
      const ws2 = FakeWebSocket.instances[1];
      ws2.fire("error");
      ws2.fire("close");
      assertEquals(reconnectDelays, [1000, 1000], "backoff must be reset to the initial delay");
    } finally {
      globalThis.WebSocket = realWebSocket;
      transport.stop();
    }
  },
});

Deno.test({
  name: "transport-retry-now - no-op while connecting",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    const transport = new Transport();
    try {
      transport.start("http://127.0.0.1:1", "test-vault", "me", "token", 0);
      assertEquals(transport.getState(), "connecting");
      const before = FakeWebSocket.instances.length;

      transport.retryNow();
      assertEquals(FakeWebSocket.instances.length, before, "no new socket while connecting");

      await sleep(50); // let the scripted open fire
      assertEquals(transport.getState(), "connected");
    } finally {
      globalThis.WebSocket = realWebSocket;
      transport.stop();
    }
  },
});

Deno.test({
  name: "transport-retry-now - no-op when live",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    const transport = new Transport();
    try {
      transport.start("http://127.0.0.1:1", "test-vault", "me", "token", 0);
      await waitFor(() => transport.getState() === "connected", 2000, "connected");
      FakeWebSocket.instances[0].receive({
        type: "server_hello_ack",
        seq: 0,
        server_version: "1.0.0",
      });
      assertEquals(transport.getState(), "live");
      const before = FakeWebSocket.instances.length;

      transport.retryNow();
      assertEquals(FakeWebSocket.instances.length, before, "no new socket when live");
      assertEquals(transport.getState(), "live");
    } finally {
      globalThis.WebSocket = realWebSocket;
      transport.stop();
    }
  },
});

Deno.test({
  name: "transport-retry-now - no-op after stop()",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    const transport = new Transport();
    try {
      transport.start("http://127.0.0.1:1", "test-vault", "me", "token", 0);
      transport.stop();
      assertEquals(transport.getState(), "disconnected");
      const before = FakeWebSocket.instances.length;
      transport.retryNow();
      assertEquals(FakeWebSocket.instances.length, before, "a stopped transport stays stopped");
    } finally {
      globalThis.WebSocket = realWebSocket;
      transport.stop();
    }
  },
});
