import { assertEquals } from "@std/assert";
import { blake3Hex } from "../../../core/hash.ts";
import { normalizeForHash } from "../../../core/normalize.ts";
import { surfaceConflict } from "../../../plugin/sync/merger.ts";
import type { StateDB } from "../../../plugin/plumbing/state.ts";

// The shared conflict-surfacing helper (used by both orchestrateMerge and the
// merge-retry fallback) writes the LOCAL copy to the conflict file BEFORE the
// SERVER copy overwrites the path. If the path write fails (e.g. a crash between
// the two writes), the local content must already be recoverable from the
// conflict file: never lost.
Deno.test({
  name: "surfaceConflict - conflict file written before path overwrite (local recoverable)",
  async fn() {
    const writes: Array<{ path: string; data: Uint8Array }> = [];
    const vault = {
      adapter: {
        writeBinary: (path: string, data: Uint8Array) => {
          writes.push({ path, data: new Uint8Array(data) });
          // The SECOND write (the path) crashes: surfaceConflict must already
          // have written the conflict file on the first write.
          if (writes.length === 2) throw new Error("crash after conflict-file write");
        },
        remove: async () => {},
        readBinary: () => Promise.resolve(new Uint8Array()),
        exists: () => false,
      },
    } as never;
    let upserted: unknown = null;
    const state = {
      upsertLocalFile: (f: unknown) => {
        upserted = f;
      },
    } as unknown as StateDB;

    let threw = false;
    try {
      await surfaceConflict(
        {
          path: "note.md",
          pathHash: "h",
          serverContent: new TextEncoder().encode("SERVER"),
          localContent: new TextEncoder().encode("LOCAL"),
          serverVersion: 5,
          chunkHashes: ["c1"],
          reason: "test",
        },
        { vault, state, deviceName: "Laptop" },
      );
    } catch {
      threw = true;
    }

    assertEquals(threw, true, "path write crash propagates");
    assertEquals(writes.length, 2, "two writes attempted");
    assertEquals(
      writes[0].path.startsWith("note (conflict Laptop "),
      true,
      "conflict file written first, named with the device",
    );
    assertEquals(
      new TextDecoder().decode(writes[0].data),
      "LOCAL",
      "conflict file holds the local copy (recoverable)",
    );
    assertEquals(writes[1].path, "note.md", "path overwritten second");
    // State is not marked as the server version because the path write crashed,
    // the local file must stay recoverable, not silently recorded as synced.
    assertEquals(upserted, null, "no state upsert after failed path write");
  },
});

Deno.test({
  name: "surfaceConflict - records the normalized identity hash for CRLF markdown",
  async fn() {
    const vault = {
      adapter: {
        writeBinary: () => Promise.resolve(),
        readBinary: () => Promise.resolve(new Uint8Array()),
        exists: () => false,
      },
    } as never;
    let upserted: { plaintext_hash: string } | null = null;
    const state = {
      upsertLocalFile: (f: { plaintext_hash: string }) => {
        upserted = f;
      },
    } as unknown as StateDB;
    const serverContent = new TextEncoder().encode("a\r\nb\r\n");

    await surfaceConflict({
      path: "note.md",
      pathHash: "h",
      serverContent,
      localContent: new TextEncoder().encode("local"),
      serverVersion: 2,
      chunkHashes: [],
      reason: "test",
    }, { vault, state, deviceName: "Laptop" });

    assertEquals(upserted!.plaintext_hash, blake3Hex(normalizeForHash("note.md", serverContent)));
  },
});

Deno.test({
  name: "surfaceConflict - never overwrites an existing conflict file (uniqueness suffix)",
  async fn() {
    const writes: Array<{ path: string }> = [];
    let existsCalls = 0;
    const vault = {
      adapter: {
        writeBinary: (path: string) => {
          writes.push({ path });
          return Promise.resolve();
        },
        remove: async () => {},
        readBinary: () => Promise.resolve(new TextEncoder().encode("DIFFERENT")),
        // The first candidate already exists with a DIFFERENT edit (a genuine
        // same-second collision): the loop must pick a suffixed path instead of
        // overwriting the first edit.
        exists: () => {
          existsCalls++;
          return existsCalls === 1;
        },
      },
    } as never;
    const state = { upsertLocalFile: () => {} } as unknown as StateDB;

    await surfaceConflict({
      path: "note.md",
      pathHash: "h",
      serverContent: new TextEncoder().encode("SERVER"),
      localContent: new TextEncoder().encode("LOCAL"),
      serverVersion: 5,
      chunkHashes: ["c1"],
      reason: "test",
    }, { vault, state, deviceName: "Laptop" });

    assertEquals(
      /^note \(conflict Laptop \d{4}-\d{2}-\d{2} \d{4,6} 2\)\.md$/.test(writes[0].path),
      true,
      `conflict file gets the uniqueness suffix when the base name exists (got ${writes[0].path})`,
    );
    assertEquals(writes[1].path, "note.md", "path overwritten second");
  },
});

Deno.test({
  name:
    "surfaceConflict - re-surfacing the same conflict reuses the existing file (no duplicate sibling)",
  async fn() {
    const writes: Array<{ path: string }> = [];
    const localContent = new TextEncoder().encode("LOCAL");
    const vault = {
      adapter: {
        writeBinary: (path: string) => {
          writes.push({ path });
        },
        remove: async () => {},
        // The base name exists and already holds the SAME losing edit (a merge
        // retry re-surfaces the same conflict): reuse it, don't stack a
        // suffixed duplicate.
        readBinary: () => Promise.resolve(new Uint8Array(localContent)),
        exists: () => true,
      },
    } as never;
    const state = { upsertLocalFile: () => {} } as unknown as StateDB;

    await surfaceConflict({
      path: "note.md",
      pathHash: "h",
      serverContent: new TextEncoder().encode("SERVER"),
      localContent,
      serverVersion: 5,
      chunkHashes: ["c1"],
      reason: "test",
    }, { vault, state, deviceName: "Laptop" });

    assertEquals(
      /^note \(conflict Laptop \d{4}-\d{2}-\d{2} \d{4,6}\)\.md$/.test(writes[0].path),
      true,
      `conflict file reuses the base name when it already holds the same edit (got ${
        writes[0].path
      })`,
    );
    assertEquals(writes.length, 2, "one conflict-file write (reused) + the path overwrite");
  },
});

Deno.test({
  name:
    "surfaceConflict - unreadable existing file falls back to the device label (same device = retry)",
  async fn() {
    const writes: Array<{ path: string }> = [];
    const vault = {
      adapter: {
        writeBinary: (path: string) => {
          writes.push({ path });
          return Promise.resolve();
        },
        remove: async () => {},
        // The file exists but is momentarily unreadable (the write just landed)
        // or a merge retry by the SAME device. Reuse the base name, not a
        // duplicate sibling.
        readBinary: () => Promise.reject(new Error("not readable yet")),
        exists: () => true,
      },
    } as never;
    const state = { upsertLocalFile: () => {} } as unknown as StateDB;

    await surfaceConflict({
      path: "note.md",
      pathHash: "h",
      serverContent: new TextEncoder().encode("SERVER"),
      localContent: new TextEncoder().encode("LOCAL"),
      serverVersion: 5,
      chunkHashes: ["c1"],
      reason: "test",
    }, { vault, state, deviceName: "Laptop" });

    assertEquals(
      /^note \(conflict Laptop \d{4}-\d{2}-\d{2} \d{4,6}\)\.md$/.test(writes[0].path),
      true,
      `unreadable same-device collision reuses the base name (got ${writes[0].path})`,
    );
    assertEquals(writes.length, 2, "one conflict-file write (reused) + the path overwrite");
  },
});

Deno.test({
  name:
    "surfaceConflict - identical edit with CRLF vs LF line endings is the same conflict (reused)",
  async fn() {
    const writes: Array<{ path: string }> = [];
    const vault = {
      adapter: {
        writeBinary: (path: string) => {
          writes.push({ path });
        },
        remove: async () => {},
        // The existing file holds the same edit but with CRLF line endings; the
        // re-surface writes LF. Normalized identity compares equal → reuse.
        readBinary: () => Promise.resolve(new TextEncoder().encode("line 1\r\nB edited\r\nline 3")),
        exists: () => true,
      },
    } as never;
    const state = { upsertLocalFile: () => {} } as unknown as StateDB;

    await surfaceConflict({
      path: "note.md",
      pathHash: "h",
      serverContent: new TextEncoder().encode("SERVER"),
      localContent: new TextEncoder().encode("line 1\nB edited\nline 3"),
      serverVersion: 5,
      chunkHashes: ["c1"],
      reason: "test",
    }, { vault, state, deviceName: "Laptop" });

    assertEquals(
      /^note \(conflict Laptop \d{4}-\d{2}-\d{2} \d{4,6}\)\.md$/.test(writes[0].path),
      true,
      `identical edit with different line endings reuses the base name (got ${writes[0].path})`,
    );
    assertEquals(writes.length, 2, "one conflict-file write (reused) + the path overwrite");
  },
});
