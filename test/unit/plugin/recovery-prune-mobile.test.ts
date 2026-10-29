import { pruneExtraneousFiles, type ResyncDeps } from "../../../plugin/sync/recovery.ts";
import { openStateDB } from "../../../plugin/plumbing/state.ts";
import { FakeVault } from "../../two-vault-driver.ts";
import { assert } from "@std/assert";

Deno.test("pruneExtraneousFiles prunes a file the server closed and keeps one it never saw", async () => {
  const vault = new FakeVault();
  const state = openStateDB();

  // Build disk: three files: one tracked live, one the server closed, one the server
  // never saw (held by the mass-delete guard before its first upload, #583).
  vault.write("keep.md", "this file is tracked in state");
  vault.write("extra1.md", "server deleted this one (#455)");
  vault.write("sub/extra2.md", "created while the mass-delete guard held the pass");

  state.upsertLocalFile({
    path: "keep.md",
    path_hash: "",
    size: 30,
    mtime: Date.now(),
    plaintext_hash: "abc",
    last_seen_version: 1,
    chunk_hashes: [],
    deleted: false,
  });
  // A closed row is what applying the server's delete/marker head leaves behind.
  state.upsertLocalFile({
    path: "extra1.md",
    path_hash: "",
    size: 0,
    mtime: Date.now(),
    plaintext_hash: "",
    last_seen_version: 2,
    chunk_hashes: [],
    deleted: true,
  });

  // Simulate Android incompleteness: getAllLoadedFiles returns only "keep.md",
  // hiding extra1.md and sub/extra2.md. adapter.list still sees everything.
  vault.getAllLoadedFiles = () => [{ path: "keep.md" }];

  const deps: ResyncDeps = {
    vault: vault as any,
    state,
    keys: {} as any,
    transport: {} as any,
    vaultId: "test",
    isSyncable: (p: string) => !p.startsWith(".obsidian/") && !p.startsWith("/"),
  };

  await pruneExtraneousFiles(deps);

  // "keep.md" is in state (deleted:false) → must survive.
  assert(vault.fileExists("keep.md"), "keep.md should still exist");

  // "extra1.md" has a closed row → the server closed it → pruned, even though the
  // loaded-files list never showed it.
  assert(!vault.fileExists("extra1.md"), "extra1.md should have been pruned");

  // "sub/extra2.md" has no row at all → never uploaded → keeping it is the only
  // outcome that cannot lose the user's note.
  assert(vault.fileExists("sub/extra2.md"), "a never-synced file must never be pruned");

  state.close();
});
