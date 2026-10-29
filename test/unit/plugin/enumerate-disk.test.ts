import { enumerateDisk } from "../../../plugin/sync/enumerate-disk.ts";
import { assert } from "@std/assert";

/** Minimal fake vault for enumerateDisk tests: obsidian-free. */
interface FakeVault {
  adapter: {
    list?: (path: string) => Promise<{ files: string[]; folders: string[] }>;
  };
  getAllLoadedFiles: () => Array<{ path: string; children?: unknown }>;
  _files: Set<string>;
  _folders: Set<string>;
}

function makeFakeVault(
  files: string[],
  folders: string[],
  loadedFiles: string[],
): FakeVault {
  return {
    adapter: {
      list: (dir: string) => {
        const prefix = dir === "" ? "" : (dir.endsWith("/") ? dir : dir + "/");
        const resultFiles = new Set<string>();
        const resultFolders = new Set<string>();

        for (const f of files) {
          if (prefix && !f.startsWith(prefix)) continue;
          const relative = prefix ? f.slice(prefix.length) : f;
          if (!relative) continue;
          const parts = relative.split("/");
          if (parts.length === 1) {
            resultFiles.add(prefix ? prefix + parts[0] : parts[0]);
          } else {
            resultFolders.add(prefix ? prefix + parts[0] : parts[0]);
          }
        }

        return Promise.resolve({ files: [...resultFiles], folders: [...resultFolders] });
      },
    },
    getAllLoadedFiles: () => loadedFiles.map((p) => ({ path: p })),
    _files: new Set(files),
    _folders: new Set(folders),
  };
}

Deno.test("enumerateDisk skipDir excludes the config subtree", async () => {
  const vault = makeFakeVault(
    ["notes/hello.md", ".obsidian/app.json", ".obsidian/plugins/foo/data.json"],
    [".obsidian", ".obsidian/plugins", "notes"],
    ["notes/hello.md"],
  );

  const result = new Set<string>();
  await enumerateDisk(vault as any, "", result, { skipDir: ".obsidian" });

  assert(result.has("notes/hello.md"), "should include normal files");
  assert(!result.has(".obsidian/app.json"), "should exclude .obsidian/app.json");
  assert(!result.has(".obsidian/plugins/foo/data.json"), "should exclude nested .obsidian files");
});

Deno.test("enumerateDisk no skipDir includes .obsidian files", async () => {
  const vault = makeFakeVault(
    ["notes/hello.md", ".obsidian/app.json", ".obsidian/plugins/foo/data.json"],
    [".obsidian", ".obsidian/plugins", "notes"],
    ["notes/hello.md", ".obsidian/app.json", ".obsidian/plugins/foo/data.json"],
  );

  const result = new Set<string>();
  await enumerateDisk(vault as any, "", result, {});

  assert(result.has("notes/hello.md"), "should include normal files");
  assert(result.has(".obsidian/app.json"), "should include .obsidian/app.json");
  assert(result.has(".obsidian/plugins/foo/data.json"), "should include nested .obsidian files");
});

Deno.test("enumerateDisk fallback to getAllLoadedFiles when adapter.list is missing", async () => {
  const vault: FakeVault = {
    adapter: {}, // no list method
    getAllLoadedFiles: () => [
      { path: "notes/hello.md" },
      { path: ".obsidian/app.json" },
    ],
    _files: new Set(),
    _folders: new Set(),
  };

  const result = new Set<string>();
  await enumerateDisk(vault as any, "", result, {});

  // Fallback path doesn't apply skipDir: it just dumps getAllLoadedFiles
  assert(result.has("notes/hello.md"), "should include from getAllLoadedFiles");
  assert(result.has(".obsidian/app.json"), "fallback includes .obsidian (no skip in fallback)");
});
