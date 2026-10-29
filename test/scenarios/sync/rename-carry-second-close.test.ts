// #613: an edit carried to a rename destination is stranded when that name is
// closed again while the editing device was away: the carried row has no version of
// its own, so nothing commits it and one device keeps a file the server and the other
// device never see. Permanent: neither another flush nor a restart repairs it.

import { assert, assertEquals } from "@std/assert";
import { pair, type TestPlugin, type TestServer, waitFor } from "../../two-vault-driver.ts";
import { hashPathHex } from "../../../core/hash.ts";
import { isConflictPath } from "../../../plugin/sync/conflicts.ts";

const TOKEN = "EDIT-613";

function paths(plugin: TestPlugin): string[] {
  return [...plugin.fakeVault.files.keys()].filter((p) => !p.startsWith(".obsidian/")).sort();
}

function content(plugin: TestPlugin, path: string): string {
  const body = plugin.fakeVault.files.get(path);
  return body ? new TextDecoder().decode(body) : "";
}

function vaultText(plugin: TestPlugin): string {
  return paths(plugin).map((path) => content(plugin, path)).join("\n");
}

/** Server versions behind a path this device holds. */
function serverVersions(
  server: TestServer,
  vaultId: string,
  plugin: TestPlugin,
  path: string,
): number {
  const row = server.db
    .prepare(
      "SELECT COUNT(*) AS n FROM file_versions WHERE vault_id = ? AND path_hash = ?",
    )
    .get(vaultId, hashPathHex(plugin.keys!.mac_key, path)) as { n: number };
  return row.n;
}

/** Every file a device holds must be one the server knows: a file the server has no
 * row for is invisible to every other device (the strand in #613). */
function assertNoOrphanFiles(
  server: TestServer,
  vaultId: string,
  plugin: TestPlugin,
  label: string,
): void {
  const orphans = paths(plugin).filter((path) =>
    serverVersions(server, vaultId, plugin, path) === 0
  );
  assertEquals(orphans, [], `${label} holds file(s) the server has no version of`);
}

function assertConverged(A: TestPlugin, B: TestPlugin): void {
  const a = new Map(paths(A).map((p) => [p, content(A, p)]));
  const b = new Map(paths(B).map((p) => [p, content(B, p)]));
  const diff: string[] = [];
  for (const path of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(path) !== b.get(path)) {
      diff.push(`${path} (A=${JSON.stringify(a.get(path))} B=${JSON.stringify(b.get(path))})`);
    }
  }
  assertEquals(diff, [], "the two devices did not converge on disk");
}

/** The edit is visibly on `path` itself or in a conflict sibling next to it. */
function pathHolding(plugin: TestPlugin, token: string): string[] {
  return paths(plugin).filter((path) => content(plugin, path).includes(token));
}

/** Let both devices flush and resolve until the server stops moving. */
async function settle(A: TestPlugin, B: TestPlugin): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await A.reconcileNow();
    await B.reconcileNow();
    await new Promise((r) => setTimeout(r, 30));
  }
  await A.waitForIdle();
  await B.waitForIdle();
}

Deno.test({
  name: "rename-carry - an edit follows a second rename instead of stranding (#613)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("x.md", "# head\n\nbody\n");
      await A.flushPending();
      await B.waitForVersion("x.md");

      // B goes away with an unsent edit of x.md.
      B.pause();
      B.fakeVault.write("x.md", `# head\n\nbody\n${TOKEN}\n`);
      await new Promise((r) => setTimeout(r, 200));

      // A renames the note twice while B is away. Both renames land in one window, so
      // the server sees x.md's marker pointing at y.md and y.md's note at z.md: no
      // version at y.md at all, which is where B's carried edit is waiting.
      A.fakeVault.rename("x.md", "y.md");
      A.fakeVault.rename("y.md", "z.md");
      await A.flushPending();

      await B.resume();
      await B.pushNow();
      await waitFor(
        () => vaultText(A).includes(TOKEN),
        "the edit to reach the other device",
        15_000,
      );
      await settle(A, B);
      await waitFor(
        () => vaultText(A).includes(TOKEN),
        "the edit to stay on the other device",
        15_000,
      );

      assert(vaultText(B).includes(TOKEN), "B lost the edit");
      assertConverged(A, B);
      assertEquals(B.fakeVault.fileExists("y.md"), false, "the intermediate name came back");
      assertEquals(
        A.fakeVault.fileExists("y.md"),
        false,
        "the intermediate name reached the other device",
      );
      for (const device of [A, B]) {
        const holders = pathHolding(device, TOKEN);
        assertEquals(
          holders.length,
          1,
          `the edit should live in one file, got ${holders.join(", ")}`,
        );
        const holder = holders[0];
        assert(
          holder === "z.md" || (isConflictPath(holder) && holder.startsWith("z")),
          `the edit belongs at the final name, got ${holder}`,
        );
      }
      assertNoOrphanFiles(server, vaultId, B, "B");
      assertNoOrphanFiles(server, vaultId, A, "A");
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rename-carry - an edit survives a rename whose destination is deleted (#613)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("x.md", "# head\n\nbody\n");
      await A.flushPending();
      await B.waitForVersion("x.md");

      // B goes away with an unsent edit; A renames x.md onto y.md and deletes y.md, so
      // the moved name is closed without ever being committed.
      B.pause();
      B.fakeVault.write("x.md", `# head\n\nbody\n${TOKEN}\n`);
      await new Promise((r) => setTimeout(r, 200));

      A.fakeVault.rename("x.md", "y.md");
      await A.fakeVault.delete("y.md");
      await A.flushPending();

      await B.resume();
      await B.pushNow();
      await waitFor(
        () => vaultText(A).includes(TOKEN),
        "the edit to reach the other device",
        15_000,
      );
      await settle(A, B);
      await waitFor(
        () => vaultText(A).includes(TOKEN),
        "the edit to stay on the other device",
        15_000,
      );

      assert(vaultText(B).includes(TOKEN), "B lost the edit");
      assertConverged(A, B);
      assertNoOrphanFiles(server, vaultId, B, "B");
      assertNoOrphanFiles(server, vaultId, A, "A");
    } finally {
      await stop();
    }
  },
});
