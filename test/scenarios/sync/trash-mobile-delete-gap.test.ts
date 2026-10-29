import { assert, assertEquals } from "@std/assert";
import { type PendingOp, VaultEventHandler } from "../../../plugin/sync/events.ts";

const TRASH_CHECK_MS = 500;

Deno.test({
  name: "trash-mobile-delete-gap: delete triggers .trash/ commit op",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const flushedOps: PendingOp[] = [];
    const eventCallbacks: Record<string, (...args: unknown[]) => void> = {};

    const vault = {
      on: (name: string, callback: (...args: unknown[]) => void) => {
        eventCallbacks[name] = callback;
      },
      off: (_name: string, _callback: (...args: unknown[]) => void) => {},
      adapter: {
        readJSON: () => ({}),
        writeJSON: async () => {},
        exists: (path: string) => {
          return path === ".trash/foo.md";
        },
      },
    };

    const handler = new VaultEventHandler(
      vault as never,
      (ops) => {
        flushedOps.push(...ops);
      },
      () => true,
    );

    handler.start();

    // Simulate mobile vault.trash(): fires only a delete event
    const deleteCallback = eventCallbacks["delete"];
    assert(deleteCallback, "delete callback should be registered");
    deleteCallback({ path: "foo.md" });

    // Wait for the trash check timeout to fire
    await new Promise((r) => setTimeout(r, TRASH_CHECK_MS + 200));

    handler.flushNow();
    handler.stop();

    const paths = flushedOps.map((op) => op.path);
    const kinds = flushedOps.map((op) => op.kind);

    assert(
      paths.includes("foo.md") && kinds[kinds.indexOf("delete")] === "delete",
      "should have delete op for foo.md",
    );

    const deleteOp = flushedOps.find((op) => op.path === "foo.md");
    assertEquals(deleteOp?.kind, "delete", "foo.md should be a delete");

    const trashOp = flushedOps.find((op) => op.path === ".trash/foo.md");
    assertEquals(
      trashOp?.kind,
      "commit",
      "should have commit op for .trash/foo.md (trash check discovered it)",
    );
  },
});

Deno.test({
  name: "trash-mobile-delete-gap: no trash file → no commit op",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const flushedOps: PendingOp[] = [];
    const eventCallbacks: Record<string, (...args: unknown[]) => void> = {};

    const vault = {
      on: (name: string, callback: (...args: unknown[]) => void) => {
        eventCallbacks[name] = callback;
      },
      off: (_name: string, _callback: (...args: unknown[]) => void) => {},
      adapter: {
        readJSON: () => ({}),
        writeJSON: async () => {},
        exists: () => false, // no trash file
      },
    };

    const handler = new VaultEventHandler(
      vault as never,
      (ops) => {
        flushedOps.push(...ops);
      },
      () => true,
    );

    handler.start();

    const deleteCallback = eventCallbacks["delete"];
    assert(deleteCallback, "delete callback should be registered");
    deleteCallback({ path: "bar.md" });

    await new Promise((r) => setTimeout(r, TRASH_CHECK_MS + 200));

    handler.flushNow();
    handler.stop();

    const deleteOp = flushedOps.find((op) => op.path === "bar.md");
    assertEquals(deleteOp?.kind, "delete", "bar.md should be a delete");

    const trashOp = flushedOps.find((op) => op.path === ".trash/bar.md");
    assert(
      trashOp === undefined,
      "should NOT have commit op when .trash/ file does not exist",
    );
  },
});

Deno.test({
  name: "trash-mobile-delete-gap: non-syncable trash path → no commit op",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const flushedOps: PendingOp[] = [];
    const eventCallbacks: Record<string, (...args: unknown[]) => void> = {};

    const vault = {
      on: (name: string, callback: (...args: unknown[]) => void) => {
        eventCallbacks[name] = callback;
      },
      off: (_name: string, _callback: (...args: unknown[]) => void) => {},
      adapter: {
        readJSON: () => ({}),
        writeJSON: async () => {},
        exists: () => true,
      },
    };

    const handler = new VaultEventHandler(
      vault as never,
      (ops) => {
        flushedOps.push(...ops);
      },
      (path: string) => !path.startsWith(".trash/"), // .trash/ is NOT syncable
    );

    handler.start();

    const deleteCallback = eventCallbacks["delete"];
    assert(deleteCallback, "delete callback should be registered");
    deleteCallback({ path: "baz.md" });

    await new Promise((r) => setTimeout(r, TRASH_CHECK_MS + 200));

    handler.flushNow();
    handler.stop();

    const trashOp = flushedOps.find((op) => op.path === ".trash/baz.md");
    assert(
      trashOp === undefined,
      "should NOT commit when trash path is not syncable",
    );
  },
});
