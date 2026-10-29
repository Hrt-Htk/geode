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
      readJSON: (_p: string) => Promise.reject(new Error("ENOENT")),
      writeJSON: (_p: string, _d: unknown) => {},
      remove: (_p: string) => Promise.resolve(),
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

Deno.test("events - single edit then silence commits at 2s (idle subsumed)", () => {
  const time = new FakeTime();
  try {
    const flushes: PendingOp[][] = [];
    const { vault, handler } = newHandler(flushes);
    handler.start();

    vault.trigger("modify", { path: "a.md" });
    time.tick(1999);
    assertEquals(flushes.length, 0, "must not commit before the 2s window elapses");

    time.tick(1);
    assertEquals(flushes.flat().map((o) => o.path), ["a.md"], "commits at exactly 2s");

    handler.stop();
  } finally {
    time.restore();
  }
});

Deno.test("events - edits during the window do NOT reset the 2s timer", () => {
  const time = new FakeTime();
  try {
    const flushes: PendingOp[][] = [];
    const { vault, handler } = newHandler(flushes);
    handler.start();

    vault.trigger("modify", { path: "a.md" }); // window opens at t=0
    time.tick(1500);
    vault.trigger("modify", { path: "a.md" }); // must NOT reset the window
    time.tick(500); // t=2000 from the FIRST edit
    assertEquals(
      flushes.flat().map((o) => o.path),
      ["a.md"],
      "fixed window measured from the first edit: commit lands at 2s, not 3.5s",
    );

    // coalescing: all in-window edits collapse to one commit
    time.tick(2000);
    assertEquals(flushes.length, 1, "in-window edits coalesce into a single commit");

    handler.stop();
  } finally {
    time.restore();
  }
});

Deno.test("events - a fresh edit after a commit opens a new window", () => {
  const time = new FakeTime();
  try {
    const flushes: PendingOp[][] = [];
    const { vault, handler } = newHandler(flushes);
    handler.start();

    vault.trigger("modify", { path: "a.md" });
    time.tick(2000);
    assertEquals(flushes.length, 1, "first window commits");

    vault.trigger("modify", { path: "a.md" });
    time.tick(2000);
    assertEquals(flushes.length, 2, "next edit opens a fresh window and commits");

    handler.stop();
  } finally {
    time.restore();
  }
});
