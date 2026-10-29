import { assertEquals } from "@std/assert";
import { type PendingOp, type ScopeMoves, VaultEventHandler } from "../../../plugin/sync/events.ts";

// Moves across the sync-scope boundary (#342) and the parked-move link (#584):
//  - synced -> excluded: no server delete, the sync layer parks the move
//  - excluded -> synced: a commit for the new path, unless a parked move was resolved
//  - excluded -> excluded: a parked destination follows the file
//  - a delete out of scope: the parked file is gone for sync
//  - in-scope renames are unchanged (delete + commit)

function makeVault() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    on: (name: string, cb: (...args: unknown[]) => void) => {
      listeners.set(name, [...(listeners.get(name) ?? []), cb]);
    },
    off: () => {},
    adapter: { exists: (_p: string) => Promise.resolve(false) },
    trigger: (name: string, ...args: unknown[]) => {
      for (const cb of listeners.get(name) ?? []) cb(...args);
    },
  };
}

function newHandler(
  isSyncable: (p: string) => boolean,
  scopeMoves?: ScopeMoves,
) {
  const vault = makeVault();
  const flushes: PendingOp[][] = [];
  const handler = new VaultEventHandler(
    vault as never,
    (ops) => flushes.push(ops),
    isSyncable,
    undefined,
    scopeMoves,
  );
  return { vault, handler, flushes };
}

function recorder(parkedBack = false): { moves: ScopeMoves; seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    moves: {
      movedOut: (from, to) => seen.push(`out:${from}->${to}`),
      movedInside: (from, to) => seen.push(`inside:${from}->${to}`),
      movedBack: (from, to) => {
        seen.push(`back:${from}->${to}`);
        return parkedBack;
      },
      deleted: (path) => seen.push(`deleted:${path}`),
    },
  };
}

const inScope = (p: string) => !p.startsWith("excluded/");

Deno.test("events - rename synced to excluded: no ops, the move is parked", () => {
  const { moves, seen } = recorder();
  const { vault, handler, flushes } = newHandler(inScope, moves);
  handler.start();
  vault.trigger("rename", { path: "excluded/a.md" }, "notes/a.md");
  handler.flushNow();
  assertEquals(flushes.flat(), [], "no commit and no delete may be enqueued");
  assertEquals(seen, ["out:notes/a.md->excluded/a.md"]);
  handler.stop();
});

Deno.test("events - rename excluded to synced: commit for the new path", () => {
  const { moves, seen } = recorder();
  const { vault, handler, flushes } = newHandler(inScope, moves);
  handler.start();
  vault.trigger("rename", { path: "notes/a.md" }, "excluded/a.md");
  handler.flushNow();
  assertEquals(flushes.flat().map((o) => `${o.kind}:${o.path}`), ["commit:notes/a.md"]);
  assertEquals(seen, ["back:excluded/a.md->notes/a.md"]);
  handler.stop();
});

Deno.test("events - rename excluded to synced over a parked move: the link replaces the commit", () => {
  const { moves } = recorder(true);
  const { vault, handler, flushes } = newHandler(inScope, moves);
  handler.start();
  vault.trigger("rename", { path: "notes/b.md" }, "excluded/a.md");
  handler.flushNow();
  assertEquals(flushes.flat(), [], "the parked move's own ops carry the commit");
  handler.stop();
});

Deno.test("events - in-scope rename unchanged: delete + commit", () => {
  const { moves } = recorder();
  const { vault, handler, flushes } = newHandler(inScope, moves);
  handler.start();
  vault.trigger("rename", { path: "notes/b.md" }, "notes/a.md");
  handler.flushNow();
  assertEquals(flushes.flat().map((o) => `${o.kind}:${o.path}`), [
    "delete:notes/a.md",
    "commit:notes/b.md",
  ]);
  handler.stop();
});

Deno.test("events - rename excluded to excluded: the parked destination follows the file", () => {
  const { moves, seen } = recorder();
  const { vault, handler, flushes } = newHandler(inScope, moves);
  handler.start();
  vault.trigger("rename", { path: "excluded/b.md" }, "excluded/a.md");
  handler.flushNow();
  assertEquals(flushes.flat(), []);
  assertEquals(seen, ["inside:excluded/a.md->excluded/b.md"]);
  handler.stop();
});

Deno.test("events - delete out of scope: reported, never a synced delete", () => {
  const { moves, seen } = recorder();
  const { vault, handler, flushes } = newHandler(inScope, moves);
  handler.start();
  vault.trigger("delete", { path: "excluded/a.md" });
  handler.flushNow();
  assertEquals(flushes.flat(), [], "an excluded path is never a server delete");
  assertEquals(seen, ["deleted:excluded/a.md"]);
  handler.stop();
});

Deno.test("events - delete in scope still enqueues the delete", () => {
  const { moves, seen } = recorder();
  const { vault, handler, flushes } = newHandler(inScope, moves);
  handler.start();
  vault.trigger("delete", { path: "notes/a.md" });
  handler.flushNow();
  assertEquals(flushes.flat().map((o) => `${o.kind}:${o.path}`), ["delete:notes/a.md"]);
  assertEquals(seen, []);
  handler.stop();
});
