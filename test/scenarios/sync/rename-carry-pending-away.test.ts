// #595: a carried edit must never re-open a name this device is renaming away. The
// destination's row can already be gone and no marker is on the server yet (the
// rename-away is only queued here), so the carry may not treat the name as free.
//
// #695: the carry now runs from the apply path only: a file found at a closed name is
// gated on its content (80% of the renamed note's text) by `followClosedRename`, and a
// destination this device renamed away is no longer on disk to compare against. The
// pending rename-away is carried here by `applyRenameMarker` instead, which has no
// content gate: the marker's own target is known, so the local edit is carried as-is.

import { assert, assertEquals } from "@std/assert";
import { pair, type TestPlugin, waitFor } from "../../two-vault-driver.ts";
import { isConflictPath } from "../../../plugin/sync/conflicts.ts";

const TOKEN = "EDIT OF P";
const MOVED = "DEST BODY";

function paths(plugin: TestPlugin): string[] {
  return [...plugin.fakeVault.files.keys()].sort();
}

function content(plugin: TestPlugin, path: string): string {
  const body = plugin.fakeVault.files.get(path);
  return body ? new TextDecoder().decode(body) : "";
}

function vaultText(plugin: TestPlugin): string {
  return [...plugin.fakeVault.files.values()].map((b) => new TextDecoder().decode(b)).join("\n");
}

/** A's marker for p.md must be on the server without its note landing on B's disk: two
 * windows, so the link lands (renamed and deleted inside one window is a plain delete,
 * #629) and the destination's tombstone follows its note. */
async function closePmdOnA(A: TestPlugin): Promise<void> {
  A.fakeVault.rename("p.md", "dest.md");
  await A.flushPending();
  A.fakeVault.delete("dest.md");
  await A.flushPending();
}

/** B edits p.md and renames a file away from dest.md, then applies A's marker: the
 * carried edit must land next to the renamed-away name, never in it. */
async function assertCarryKeepsTheNameClosed(
  A: TestPlugin,
  B: TestPlugin,
): Promise<void> {
  await B.waitForDeleted("p.md");
  assertEquals(
    B.fakeVault.fileExists("dest.md"),
    false,
    "B never re-opens the name it is renaming away",
  );
  await B.pushNow();
  await A.waitForIdle();

  assertEquals(
    B.fakeVault.fileExists("dest.md"),
    false,
    "dest.md stays closed after the ops drain",
  );
  await waitFor(() => !A.fakeVault.fileExists("dest.md"), "the name to stay closed on A", 10_000);
  assertEquals(content(B, "moved.md"), MOVED, "B's own renamed file keeps its body");
  const kept = paths(B).filter(isConflictPath);
  assertEquals(kept.length, 1, `the carried edit is kept as a sibling, got ${paths(B).join(", ")}`);
  assert(content(B, kept[0]).includes(TOKEN), "the carried edit survives in the sibling");
  await waitFor(() => vaultText(A).includes(TOKEN), "the sibling to reach A", 10_000);
}

Deno.test({
  name: "rename-carry - a carried edit never reopens a name this device is renaming away (#595)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      A.fakeVault.write("p.md", "P\n");
      await A.flushPending();
      await B.waitForVersion("p.md");

      // B edits p.md and renames a file away from dest.md: both are in the event
      // layer's 2 s window, so nothing has reached the server yet.
      B.fakeVault.write("p.md", `P\n${TOKEN}\n`);
      B.fakeVault.write("dest.md", MOVED);
      B.fakeVault.rename("dest.md", "moved.md");
      assertEquals(
        B.eventHandler!.getPendingOps().some((op) =>
          op.path === "dest.md" && op.renamedTo === "moved.md"
        ),
        true,
        "premise: the rename-away is still in the event debounce",
      );

      // The marker reaches B while its own ops are still pending, so this device is
      // renaming dest.md away at the very moment the edit is carried.
      await closePmdOnA(A);
      await assertCarryKeepsTheNameClosed(A, B);
    } finally {
      await stop();
    }
  },
});

/** The same rule with the rename-away already in the commit queue: the event layer has
 * flushed, so only the queue knows the name is being closed. */
Deno.test({
  name: "rename-carry - a rename-away already queued is taken too (#595)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      A.fakeVault.write("p.md", "P\n");
      await A.flushPending();
      await B.waitForVersion("p.md");

      // Queue paused, transport live: B's own ops are queued while A's marker still
      // applies the moment it arrives.
      B.syncManager!.pause();
      B.fakeVault.write("p.md", `P\n${TOKEN}\n`);
      B.fakeVault.write("dest.md", MOVED);
      B.fakeVault.rename("dest.md", "moved.md");
      B.eventHandler!.flushNow();
      assertEquals(
        B.syncManager!.getPendingOps().some((op) => op.path === "dest.md" && op.kind === "delete"),
        true,
        "premise: the rename-away must be queued",
      );

      await closePmdOnA(A);
      await B.waitForDeleted("p.md");
      B.syncManager!.resume();
      await assertCarryKeepsTheNameClosed(A, B);
    } finally {
      await stop();
    }
  },
});
