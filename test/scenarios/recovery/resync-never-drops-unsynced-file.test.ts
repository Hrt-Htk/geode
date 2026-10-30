import { assert, assertEquals } from "@std/assert";
import { pair, restartPlugin, type TestPlugin, type TestServer } from "../../two-vault-driver.ts";
import { openSessionState } from "../../../plugin/session.ts";
import { rebuildFromScratch } from "../../../plugin/sync/recovery.ts";
import { isSyncable } from "../../../plugin/plumbing/settings-types.ts";
import { hashPathHex } from "../../../core/hash.ts";

// #583 review blocker: the mass-delete guard holds the WHOLE pass (decision 10),
// creates included, so a file created in the same window as a mass deletion has no
// server version and no local row. The notice's remedy ("Resync from scratch") must
// then keep it: prune exists to remove files the SERVER closed, never a file that was
// never uploaded, and the rebuild must restore the notes the server still holds.

const DELETED = Array.from({ length: 10 }, (_, i) => `gone/n${i}.md`);
const CREATED = "new.md";
const CREATED_BODY = "created while the guard was holding the pass\n";

function headOf(server: TestServer, vaultId: string, pathHash: string) {
  return (server.db
    .prepare(
      "SELECT version, deleted FROM file_versions WHERE vault_id = ? AND path_hash = ? ORDER BY version DESC LIMIT 1",
    )
    .get(vaultId, pathHash) ?? null) as { version: number; deleted: number } | null;
}

/** The state file a resync starts from is written on a 2s throttle (#328): wait until
 * the row under test is durable, or the scenario begins from a state that never had it. */
async function waitForPersistedRow(
  plugin: TestPlugin,
  path: string,
  deleted: boolean,
): Promise<void> {
  const statePath = plugin.pluginDataPath("local-files.json");
  for (let i = 0; i < 100; i++) {
    const bytes = plugin.fakeVault.pluginData.get(statePath);
    const rows = bytes
      ? JSON.parse(new TextDecoder().decode(bytes)) as Array<{ path: string; deleted: boolean }>
      : [];
    const row = rows.find((r) => r.path === path);
    if (row && row.deleted === deleted) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`row ${path} (deleted=${deleted}) was never persisted`);
}

/** The notice's remedy, exactly as `GeodePlugin.resyncFromScratch` runs it: a state
 * loaded from the persisted files, the runtime disposed, the heads re-applied. */
async function resyncLikeThePlugin(plugin: TestPlugin) {
  const state = await openSessionState(plugin);
  const transport = plugin.transport!;
  const keys = plugin.keys!;
  plugin.stop();
  const result = await rebuildFromScratch({
    vault: plugin.fakeVault as never,
    transport,
    state,
    keys,
    vaultId: plugin.pluginSettings.vaultId,
    isSyncable: (p) => isSyncable(p, plugin.fakeVault.configDir, plugin.pluginSettings),
  });
  await plugin.restartUnlockedSession(state);
  return result;
}

Deno.test({
  name: "resync never drops a file the guard held before it was uploaded",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, server, vaultId, stop } = await pair();
    try {
      for (const [i, path] of DELETED.entries()) A.fakeVault.write(path, `note ${i}`);
      await A.flushPending();
      await A.waitForVersion(DELETED[0]);

      // The app is closed; 10 tracked notes are gone from disk and one new file appears
      // in the same window, so the guard holds the pass and `new.md` is never uploaded.
      const fresh = await restartPlugin(A, server);
      for (const path of DELETED) {
        fresh.fakeVault.files.delete(path);
        fresh.fakeVault.mtimes.delete(path);
      }
      fresh.fakeVault.write(CREATED, CREATED_BODY);
      await fresh.reconcileNow();
      assert(fresh.fakeVault.fileExists(CREATED), "precondition: the create is still on disk");
      assertEquals(
        headOf(server, vaultId, fresh.state!.getLocalFile(CREATED)?.path_hash ?? ""),
        null,
        "precondition: the held create never reached the server",
      );

      // The user follows the notice: resync from scratch.
      const result = await resyncLikeThePlugin(fresh);
      assertEquals(result.appliedFiles, DELETED.length, "every held note was rebuilt");

      for (const path of DELETED) {
        assert(fresh.fakeVault.fileExists(path), `${path} was restored from the server`);
      }
      assert(
        fresh.fakeVault.fileExists(CREATED),
        "a never-uploaded file is never pruned by a resync",
      );
      assertEquals(
        new TextDecoder().decode(fresh.fakeVault.files.get(CREATED)),
        CREATED_BODY,
        "its content is untouched",
      );

      // And it is committed afterwards, so nothing the guard held is lost.
      await fresh.reconcileNow();
      await fresh.waitForVersion(CREATED);
      const row = fresh.state!.getLocalFile(CREATED)!;
      assertEquals(headOf(server, vaultId, row.path_hash)?.deleted, 0, "the create landed");
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "resync keeps a note re-created under a name the server closed",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("X.md", "original\n");
      await A.flushPending();
      await B.waitForVersion("X.md");
      const pathHash = hashPathHex(A.keys!.mac_key, "X.md");

      // B deletes the note; A applies the delete, so A's row for the name is closed.
      await B.fakeVault.delete("X.md");
      await B.flushPending();
      await A.waitForDeleted("X.md");
      assertEquals(A.state!.getLocalFile("X.md")?.deleted, true, "precondition: A's row closed");
      await waitForPersistedRow(A, "X.md", true);

      // A goes offline and the user writes the note again, then follows the notice.
      A.disconnect();
      A.fakeVault.write("X.md", "re-created while offline\n");
      assertEquals(headOf(server, vaultId, pathHash)?.deleted, 1, "the re-create is local only");

      const result = await resyncLikeThePlugin(A);
      assertEquals(result.deletedFiles, 1, "the delete head was applied");

      assertEquals(
        new TextDecoder().decode(A.fakeVault.files.get("X.md")),
        "re-created while offline\n",
        "the only copy of a re-created note is never pruned by a resync",
      );

      // The restarted session commits it as a new generation on the name's own chain.
      await A.reconcileNow();
      await A.waitForVersion("X.md");
      const head = headOf(server, vaultId, pathHash);
      assertEquals(head?.deleted, 0, "the re-created note is uploaded");
      assertEquals(head?.version, 3, "as the next version, not a resurrected old one");
    } finally {
      await stop();
    }
  },
});
