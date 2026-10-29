import { ensureParentDirs, type Vault, writeVaultBinary } from "../../../plugin/sync/vault-io.ts";
import { assert, assertEquals } from "@std/assert";

/**
 * #328: the phone's cold-sync drain pays ~1 file/sec because every vault write
 * hits the Capacitor FS bridge per call (~166 ms adapter.exists, ~255 ms
 * createBinary). These tests pin the write path to avoid bridge round-trips the
 * in-memory index can answer:
 *   1. ensureParentDirs must not bridge-exists a folder the index already knows.
 *   2. a cold create must not bridge-exists(path) before createBinary.
 *   3. createBinary "already exists" still lands the bytes via adapter.writeBinary.
 */

type CallLog = {
  exists: string[];
  mkdir: string[];
  writeBinary: string[];
  createBinary: string[];
};

// Fake vault backed by an in-memory index; every adapter call is recorded so a
// test can assert exactly which bridge round-trips happened. getAbstractFileByPath
// mirrors Obsidian: returns the indexed file/folder or null (dot-folders like
// .obsidian are not indexed).
function makeCountingVault(): { vault: Vault; calls: CallLog; index: Map<string, unknown> } {
  const calls: CallLog = { exists: [], mkdir: [], writeBinary: [], createBinary: [] };
  const index = new Map<string, unknown>();
  const vault: Vault = {
    getAllLoadedFiles: () => [],
    getAbstractFileByPath: (p: string) => index.get(p) ?? null,
    createBinary: (path: string) => {
      calls.createBinary.push(path);
      index.set(path, { path });
      return Promise.resolve();
    },
    modifyBinary: async () => {},
    adapter: {
      exists: (p: string) => {
        calls.exists.push(p);
        return Promise.resolve(index.has(p));
      },
      mkdir: (p: string) => {
        calls.mkdir.push(p);
        index.set(p, { path: p, children: [] });
        return Promise.resolve();
      },
      writeBinary: (p: string) => {
        calls.writeBinary.push(p);
        index.set(p, { path: p });
        return Promise.resolve();
      },
      remove: async () => {},
    },
  };
  return { vault, calls, index };
}

Deno.test({
  name:
    "ensureParentDirs makes zero adapter.exists calls when the parent folder is already indexed",
  async fn() {
    const { vault, calls, index } = makeCountingVault();
    index.set("notes", { path: "notes", children: [] });
    index.set("notes/2026", { path: "notes/2026", children: [] });
    for (let i = 0; i < 5; i++) {
      await ensureParentDirs(`notes/2026/note${i}.md`, vault);
    }
    assertEquals(calls.exists, [], "index knows the parents: no bridge exists round-trip");
    assertEquals(calls.mkdir, [], "no mkdir needed for indexed folders");
  },
});

Deno.test({
  name: "ensureParentDirs still bridge-exists + mkdirs an unindexed dot-folder",
  async fn() {
    const { vault, calls } = makeCountingVault();
    await ensureParentDirs(".obsidian/plugins/geode/main.js", vault);
    assert(calls.exists.includes(".obsidian"), "dot-folder not indexed: must bridge-exists");
    assert(calls.mkdir.includes(".obsidian"), "missing dot-folder must be mkdir'd");
    assert(calls.mkdir.includes(".obsidian/plugins"), "nested unindexed parents mkdir'd too");
  },
});

Deno.test({
  name: "writeVaultBinary cold create makes zero adapter.exists(path) calls",
  async fn() {
    const { vault, calls } = makeCountingVault();
    await writeVaultBinary("note.md", new Uint8Array([1, 2, 3]), 123, vault);
    assert(calls.createBinary.includes("note.md"), "created via createBinary");
    assertEquals(calls.exists, [], "cold create must not bridge-exists(path) first");
  },
});

Deno.test({
  name:
    "writeVaultBinary on createBinary already-exists lands bytes via adapter.writeBinary, no exists probe",
  async fn() {
    const { vault, calls } = makeCountingVault();
    vault.createBinary = (path: string) => {
      calls.createBinary.push(path);
      throw new Error("already exists");
    };
    await writeVaultBinary("note.md", new Uint8Array([1, 2, 3]), 123, vault);
    assert(calls.createBinary.includes("note.md"), "createBinary attempted first");
    assert(calls.writeBinary.includes("note.md"), "bytes written via adapter.writeBinary");
    assertEquals(
      calls.exists,
      [],
      "fallback drops the dead adapter.exists probe: both outcomes write via adapter",
    );
  },
});

Deno.test({
  name: "writeVaultBinary uses modifyBinary when the file is already indexed (unchanged)",
  async fn() {
    const { vault, calls, index } = makeCountingVault();
    index.set("note.md", { path: "note.md" });
    const modified: string[] = [];
    vault.modifyBinary = (file: unknown) => {
      modified.push(String((file as { path: string }).path));
      return Promise.resolve();
    };
    await writeVaultBinary("note.md", new Uint8Array([1, 2, 3]), 123, vault);
    assertEquals(modified, ["note.md"]);
    assertEquals(calls.exists, [], "indexed file: no bridge exists");
  },
});
