// #697: applying a rename moves the file with the vault's own rename instead of writing
// the note at the new name and removing the old one, so an editor open on it follows the
// note rather than being torn down with the old name. The desktop E2E owns the editor
// assertion; these own what the sync layer must still get right: the carried edit and its
// merge, the taken destination, a clean note following, and no echoed marker/note.

import { assert, assertEquals } from "@std/assert";
import { pair, type TestPlugin, type TestServer, waitFor } from "../../two-vault-driver.ts";
import { hashPathHex } from "../../../core/hash.ts";
import { isConflictPath } from "../../../plugin/sync/conflicts.ts";

const TOKEN = "typed-through-the-rename";
const BASE = "# head\n\nbody\n";

function userPaths(device: TestPlugin): string[] {
  return [...device.fakeVault.files.keys()].filter((p) => !p.startsWith(".obsidian/")).sort();
}

function content(device: TestPlugin, path: string): string {
  const body = device.fakeVault.files.get(path);
  return body ? new TextDecoder().decode(body) : "";
}

function holders(device: TestPlugin, token: string): string[] {
  return userPaths(device).filter((path) => content(device, path).includes(token));
}

function serverChain(
  server: TestServer,
  vaultId: string,
  device: TestPlugin,
  path: string,
): Array<{ version: number; deleted: number; rename_mark: number }> {
  return server.db
    .prepare(
      "SELECT version, deleted, rename_mark FROM file_versions WHERE vault_id = ? AND path_hash = ? ORDER BY version",
    )
    .all(vaultId, hashPathHex(device.keys!.mac_key, path)) as Array<{
      version: number;
      deleted: number;
      rename_mark: number;
    }>;
}

function maxServerSeq(server: TestServer, vaultId: string): number {
  const row = server.db
    .prepare("SELECT MAX(seq) AS seq FROM file_versions WHERE vault_id = ?")
    .get(vaultId) as { seq: number } | undefined;
  return row?.seq ?? 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Let both devices reconcile until the server stops moving. */
async function settle(A: TestPlugin, B: TestPlugin): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await A.reconcileNow();
    await B.reconcileNow();
    await sleep(30);
  }
  await A.waitForIdle();
  await B.waitForIdle();
}

Deno.test({
  name: "rename-keeps-editor - a pending edit moves by vault rename and merges at the new name",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("x.md", BASE);
      await A.flushPending();
      await B.waitForVersion("x.md", 1);

      // B's edit is still inside the event debounce when the rename arrives.
      B.fakeVault.write("x.md", `${BASE}${TOKEN}\n`);
      B.pause();
      A.fakeVault.rename("x.md", "y.md");
      await A.flushPending();
      const renamedSeq = maxServerSeq(server, vaultId);

      await B.resume();
      await B.waitForCaughtUp(renamedSeq);
      assertEquals(
        B.eventHandler!.getPendingOps().filter((op) => op.path === "x.md" && op.kind === "commit")
          .length,
        1,
        "premise: the edit is still in the event debounce when the rename applies",
      );
      await B.pushNow();
      await waitFor(
        () => content(A, "y.md").includes(TOKEN),
        "the carried edit to reach the other device",
        15_000,
      );
      await settle(A, B);

      assertEquals(
        B.fakeVault.renames.filter((r) => r.from === "x.md").map((r) => r.to),
        ["y.md"],
        "the apply moves the file itself instead of writing it and removing the old name",
      );
      for (const device of [A, B]) {
        assertEquals(device.fakeVault.fileExists("x.md"), false, "the old name is gone");
        assertEquals(holders(device, TOKEN), ["y.md"], "the edit lives at the new name");
        assertEquals(content(device, "y.md"), `${BASE}${TOKEN}\n`, "both sides of the merge");
      }
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rename-keeps-editor - a taken destination moves the edit to the sibling by vault rename",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("x.md", BASE);
      await A.flushPending();
      await B.waitForVersion("x.md", 1);

      // B's edit is still in its debounce, and B already holds a file at the destination
      // the rename points at (written straight to disk: no op competes for that name).
      B.fakeVault.write("x.md", `${BASE}${TOKEN}\n`);
      B.fakeVault.files.set("y.md", new TextEncoder().encode("B keeps this name\n"));
      B.fakeVault.mtimes.set("y.md", Date.now() + 1_000);
      B.pause();
      A.fakeVault.rename("x.md", "y.md");
      await A.flushPending();
      const renamedSeq = maxServerSeq(server, vaultId);

      await B.resume();
      await B.waitForCaughtUp(renamedSeq);
      await B.pushNow();
      await settle(A, B);

      const moved = B.fakeVault.renames.filter((r) => r.from === "x.md").map((r) => r.to);
      assertEquals(moved.length, 1, "the old file was moved, not written and removed");
      const [sibling] = moved;
      assert(
        isConflictPath(sibling) && sibling.startsWith("y"),
        `the edit belongs in a sibling next to the destination, got ${sibling}`,
      );
      assertEquals(content(B, sibling), `${BASE}${TOKEN}\n`, "the sibling holds the edit");
      assertEquals(B.fakeVault.fileExists("x.md"), false, "the old name is gone");
      assertEquals(B.fakeVault.fileExists("y.md"), true, "B keeps the file it held at the name");
      await waitFor(
        () => content(A, sibling).includes(TOKEN),
        "the sibling to sync as its own file",
        15_000,
      );
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rename-keeps-editor - a clean note follows the rename with no local edit",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      A.fakeVault.write("x.md", BASE);
      await A.flushPending();
      await B.waitForVersion("x.md", 1);

      A.fakeVault.rename("x.md", "y.md");
      await A.flushPending();
      await B.waitForVersion("y.md", 1);

      assertEquals(
        B.fakeVault.renames.filter((r) => r.from === "x.md").map((r) => r.to),
        ["y.md"],
        "the apply moves the file itself, so an open editor keeps its note",
      );
      for (const device of [A, B]) {
        assertEquals(device.fakeVault.fileExists("x.md"), false, "the old name is gone");
        assertEquals(content(device, "y.md"), BASE, "the note is intact at its new name");
        assertEquals(userPaths(device), ["y.md"], "no stray copy is left behind");
      }
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rename-keeps-editor - an applied rename echoes no marker or note back",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("x.md", BASE);
      await A.flushPending();
      await B.waitForVersion("x.md", 1);

      A.fakeVault.rename("x.md", "y.md");
      await A.flushPending();
      await B.waitForVersion("y.md", 1);

      // The apply's own rename must not look like a local move to the event layer.
      assertEquals(
        B.eventHandler!.getPendingOps().filter((op) => op.path === "x.md" || op.path === "y.md"),
        [],
        "the applied rename is this device's own write, not a queued marker + note",
      );
      await settle(A, B);

      assertEquals(
        serverChain(server, vaultId, A, "x.md").map((row) => [row.deleted, row.rename_mark]),
        [[0, 0], [1, 1]],
        "the old name closes once, with the rename's own marker",
      );
      assertEquals(
        serverChain(server, vaultId, A, "y.md").map((row) => [row.deleted, row.rename_mark]),
        [[0, 2]],
        "the new name is opened once by the note, with no echoed second version",
      );
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rename-keeps-editor - a clean note follows a rename whose destination already moved on",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("x.md", BASE);
      await A.flushPending();
      await B.waitForVersion("x.md", 1);

      // B is away for the whole move, and A types in the new name before B comes back: the
      // destination's head is a plain content version, not the note, when the marker applies.
      B.pause();
      A.fakeVault.rename("x.md", "y.md");
      await A.flushPending();
      A.fakeVault.write("y.md", `${BASE}${TOKEN}\n`);
      await A.flushPending();
      const renamedSeq = maxServerSeq(server, vaultId);

      await B.resume();
      await B.waitForCaughtUp(renamedSeq);
      await settle(A, B);

      assertEquals(
        B.fakeVault.renames.filter((r) => r.from === "x.md").map((r) => r.to),
        ["y.md"],
        "the destination's later version must not turn the move back into a plain delete",
      );
      assertEquals(B.fakeVault.fileExists("x.md"), false, "the old name is gone");
      await waitFor(
        () => content(B, "y.md").includes(TOKEN),
        "the edit made in the new name to reach the other device",
        15_000,
      );
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name:
    "rename-keeps-editor - an echo at the destination before the rename event still suppresses it",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("x.md", BASE);
      await A.flushPending();
      await B.waitForVersion("x.md", 1);

      // An autosave or merge write at the destination can land before the rename event of
      // the apply's own move: it must not consume the pair that marks that move as ours.
      const rename = B.fakeVault.rename.bind(B.fakeVault);
      B.fakeVault.rename = (file, newPath) => {
        B.fakeVault.emit({ type: "modify", path: newPath });
        rename(file, newPath);
      };

      A.fakeVault.rename("x.md", "y.md");
      await A.flushPending();
      await B.waitForVersion("y.md", 1);

      assertEquals(
        B.eventHandler!.getPendingOps().filter((op) =>
          op.path === "x.md" || op.renamedFrom !== undefined || op.renamedTo !== undefined
        ),
        [],
        "the apply's own rename is never queued as a user's move",
      );
      await settle(A, B);
      const links = [
        ...serverChain(server, vaultId, A, "x.md"),
        ...serverChain(server, vaultId, A, "y.md"),
      ].filter((row) => row.rename_mark !== 0);
      assertEquals(
        links.map((row) => [row.deleted, row.rename_mark]),
        [[1, 1], [0, 2]],
        "one marker closes the old name and one note opens the new one, no echo follows",
      );
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rename-keeps-editor - a taken destination with no local edit closes the old name",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      A.fakeVault.write("x.md", BASE);
      await A.flushPending();
      await B.waitForVersion("x.md", 1);

      // B holds a file at the destination the peer's rename points at.
      B.fakeVault.files.set("y.md", new TextEncoder().encode("B holds this name\n"));
      B.fakeVault.mtimes.set("y.md", Date.now() + 1_000);

      A.fakeVault.rename("x.md", "y.md");
      await A.flushPending();
      await B.waitForDeleted("x.md");
      await settle(A, B);

      assertEquals(
        B.fakeVault.renames.filter((r) => r.from === "x.md"),
        [],
        "a taken destination is never moved onto",
      );
      assertEquals(B.fakeVault.fileExists("x.md"), false, "the old name still closes");
      assertEquals(B.fakeVault.fileExists("y.md"), true, "B keeps the file it held at the name");
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rename-keeps-editor - a rename the vault refuses falls back to write and remove",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      A.fakeVault.write("x.md", BASE);
      await A.flushPending();
      await B.waitForVersion("x.md", 1);

      B.fakeVault.rename = () => {
        throw new Error("vault is read-only");
      };

      A.fakeVault.rename("x.md", "y.md");
      await A.flushPending();
      await B.waitForVersion("y.md", 1);

      assertEquals(B.fakeVault.fileExists("x.md"), false, "the old name closes as before");
      assertEquals(content(B, "y.md"), BASE, "the note lands at the new name");
      assertEquals(
        B.eventHandler!.getPendingOps().filter((op) => op.path === "x.md" || op.path === "y.md"),
        [],
        "the fallback writes are this device's own, never re-queued",
      );
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rename-keeps-editor - a destination this device excludes is never written",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      A.fakeVault.write("x.md", BASE);
      await A.flushPending();
      await B.waitForVersion("x.md", 1);

      B.pluginSettings.excludedFolders = ["Archive/"];
      A.fakeVault.rename("x.md", "Archive/x.md");
      await A.flushPending();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await settle(A, B);

      assertEquals(
        B.fakeVault.renames.filter((r) => r.from === "x.md"),
        [],
        "an excluded destination has no editor worth keeping",
      );
      assertEquals(B.fakeVault.fileExists("x.md"), false, "the old name closes");
      assertEquals(B.fakeVault.fileExists("Archive/x.md"), false, "the excluded folder stays out");
    } finally {
      await stop();
    }
  },
});
