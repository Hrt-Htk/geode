import { assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { type PendingOp, VaultEventHandler } from "../../../plugin/sync/events.ts";

function makeMockVaultWithEvents() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    on: (name: string, cb: (...args: unknown[]) => void) => {
      listeners.set(name, [...(listeners.get(name) ?? []), cb]);
    },
    off: (name: string, cb: (...args: unknown[]) => void) => {
      listeners.set(name, (listeners.get(name) ?? []).filter((f) => f !== cb));
    },
    adapter: {
      exists: (_p: string) => Promise.resolve(false),
    },
    trigger: (name: string, ...args: unknown[]) => {
      for (const cb of listeners.get(name) ?? []) cb(...args);
    },
  };
}

function newHandler(flushes: PendingOp[][]) {
  const vault = makeMockVaultWithEvents();
  const handler = new VaultEventHandler(
    vault as never,
    (ops) => flushes.push(ops),
    () => true,
  );
  return { vault, handler };
}

Deno.test("events - a stale self-write suppression does not swallow a later genuine edit", () => {
  const time = new FakeTime();
  try {
    const flushes: PendingOp[][] = [];
    const { vault, handler } = newHandler(flushes);
    handler.start();

    // The plugin writes note.md, but the write emits no event (e.g. it was a
    // no-op write whose content matched disk, or the file was removed). The
    // suppression entry therefore has nothing to consume it.
    handler.suppressSelfWrite("note.md");

    // Later the user genuinely edits note.md.
    time.tick(10_000);
    vault.trigger("modify", { path: "note.md" });

    // The genuine edit must be enqueued as a commit, not swallowed.
    time.tick(2_000);
    assertEquals(
      flushes.flat().map((o) => o.path),
      ["note.md"],
      "a genuine edit after a stale suppression must still commit",
    );

    handler.stop();
  } finally {
    time.restore();
  }
});
