import { assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { type PendingOp, VaultEventHandler } from "../../../plugin/sync/events.ts";

// #420: between flush and ack the status bar must never see "nothing to do"
// (the green "synced" flash mid-upload): the queue's count report lands first.

function makeMockVaultWithEvents() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    on: (name: string, cb: (...args: unknown[]) => void) => {
      listeners.set(name, [...(listeners.get(name) ?? []), cb]);
    },
    off: (name: string, cb: (...args: unknown[]) => void) => {
      listeners.set(name, (listeners.get(name) ?? []).filter((f) => f !== cb));
    },
    adapter: { exists: (_p: string) => Promise.resolve(false) },
    trigger: (name: string, ...args: unknown[]) => {
      for (const cb of listeners.get(name) ?? []) cb(...args);
    },
  };
}

Deno.test("events - the queue's count is reported before the flush drops the handler count to 0 (#420)", () => {
  const time = new FakeTime();
  try {
    const reports: string[] = [];
    const flushes: PendingOp[][] = [];
    const vault = makeMockVaultWithEvents();
    const handler = new VaultEventHandler(
      vault as never,
      (ops) => {
        flushes.push(ops);
        // CommitQueue.enqueue reports its count synchronously before the first
        // await: model that here.
        reports.push(`pending:${ops.length}`);
      },
      () => true,
      (n) => reports.push(`dirty:${n}`),
    );
    handler.start();

    vault.trigger("modify", { path: "a.md" });
    assertEquals(reports, ["dirty:1"], "first save reports dirty 1");

    time.tick(2000);
    assertEquals(flushes.length, 1, "window elapses and the op flushes");

    // The green-flash window is open exactly when dirty:0 lands before the
    // queue's pending:1: the order must be pending:1 → dirty:0.
    const queueReport = reports.indexOf("pending:1");
    const dirtyZero = reports.indexOf("dirty:0");
    assertEquals(
      queueReport >= 0,
      true,
      `queue never reported its count: ${JSON.stringify(reports)}`,
    );
    assertEquals(
      queueReport < dirtyZero,
      true,
      `dirty:0 reported before the queue's pending:1 (green flash window): ${
        JSON.stringify(reports)
      }`,
    );

    handler.stop();
  } finally {
    time.restore();
  }
});
