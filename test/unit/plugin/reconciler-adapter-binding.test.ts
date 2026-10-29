import { type ReconcileOp, Reconciler } from "../../../plugin/sync/reconciler.ts";
import { openStateDB } from "../../../plugin/plumbing/state.ts";
import { assert } from "@std/assert";
import { massDeleteGuard } from "../../helpers/bytes.ts";

/**
 * isSyncable that mirrors plugin/plumbing/settings-types.ts behavior.
 */
function makeIsSyncable(syncObsidianConfig: boolean): (path: string) => boolean {
  return (path: string) => {
    if (path.startsWith(".obsidian/")) {
      if (!syncObsidianConfig) return false;
      const excluded = ["workspace.json", "graph.json"];
      const fileName = path.split("/").pop();
      if (excluded.includes(fileName ?? "")) return false;
      return true;
    }
    return !path.startsWith("/");
  };
}

/**
 * Adapter whose `list` is a regular (non-arrow) method reading `this._store`.
 * When extracted and called unbound, `this` is undefined → throws.
 * Mirrors Android Obsidian's real CapacitorAdapter.list behavior.
 */
class BoundAdapter {
  _store: Record<string, string> = {};

  list(dir: string): Promise<{ files: string[]; folders: string[] }> {
    // Regular method: `this` must be the BoundAdapter instance.
    // Extracting and calling unbound (e.g. `const fn = adapter.list; fn()`) loses `this`.
    const store = this._store;
    const prefix = dir === "" ? "" : (dir.endsWith("/") ? dir : dir + "/");
    const files: string[] = [];
    const folders: string[] = [];
    for (const key of Object.keys(store)) {
      if (prefix && !key.startsWith(prefix)) continue;
      const relative = prefix ? key.slice(prefix.length) : key;
      if (!relative) continue;
      const parts = relative.split("/");
      if (parts.length === 1) {
        files.push(prefix ? prefix + parts[0] : parts[0]);
      } else {
        folders.push(prefix ? prefix + parts[0] : parts[0]);
      }
    }
    return Promise.resolve({ files, folders });
  }

  // Real Obsidian's adapter.stat resolves null for a missing path (#505).
  stat(path: string): Promise<{ size: number; mtime: number } | null> {
    if (!(path in this._store)) return Promise.resolve(null);
    return Promise.resolve({ size: this._store[path].length, mtime: Date.now() });
  }

  readBinary(path: string): Promise<Uint8Array> {
    if (!(path in this._store)) return Promise.reject(new Error(`read not found: ${path}`));
    return Promise.resolve(new TextEncoder().encode(this._store[path]));
  }
}

/**
 * A vault wrapping a BoundAdapter: adapter.list is a regular method, not an arrow.
 */
class BoundAdapterVault {
  adapter = new BoundAdapter();

  getAllLoadedFiles(): Array<{ path: string }> {
    return Object.keys(this.adapter._store).map((path) => ({ path }));
  }

  write(path: string, content: string): void {
    this.adapter._store[path] = content;
  }
}

Deno.test("reconciler calls adapter.list bound (mobile crash regression)", async () => {
  const vault = new BoundAdapterVault();
  vault.write("a.md", "# Hello");
  vault.write("sub/b.md", "world");

  const state = openStateDB();

  let capturedOps: ReconcileOp[] = [];
  const onOps = (ops: ReconcileOp[]) => {
    capturedOps = ops;
  };

  const reconciler = new Reconciler(
    vault as any,
    state,
    onOps,
    makeIsSyncable(false),
    false,
    massDeleteGuard(),
  );

  // Before the fix this throws:
  //   TypeError: Cannot read properties of undefined (reading '_store')
  // because adapter.list was extracted to a local variable and called unbound.
  reconciler.start();
  await reconciler.run(true);
  reconciler.stop();
  state.close();

  const createdPaths = capturedOps
    .filter((op) => op.kind === "create")
    .map((op) => op.path);

  assert(createdPaths.includes("a.md"), "should discover root file via bound list call");
  assert(createdPaths.includes("sub/b.md"), "should discover nested file via bound list call");
});
