import { assertEquals } from "@std/assert";
import { pair, restartPlugin, TestPlugin, waitFor } from "../../two-vault-driver.ts";
import { blake3Hex } from "../../../core/hash.ts";
import { isConflictPath } from "../../../plugin/sync/conflicts.ts";

const read = (pl: TestPlugin, p: string) => {
  const d = pl.fakeVault.files.get(p);
  return d ? new TextDecoder().decode(d) : "<MISSING>";
};

const notesOn = (pl: TestPlugin) =>
  [...pl.fakeVault.files.keys()].filter((p) => /^notes\/f\d+\.md$/.test(p)).length;

Deno.test({
  name: "restart-data-integrity - clean restart: no reverts, no spurious deletes",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const p = await pair();
    let A = p.A;
    let B = p.B;
    try {
      // A authors 10 files
      for (let i = 0; i < 10; i++) {
        A.fakeVault.write(`notes/f${i}.md`, `# ${i}\r\nbody ${i}\r\n`);
      }
      await A.flushPending();
      await waitFor(() => notesOn(B) === 10, "B to receive all 10 files");

      // Snapshot B's file paths + content hashes
      const snapshot = new Map<string, string>();
      for (const [path, data] of B.fakeVault.files) {
        if (/^notes\/f\d+\.md$/.test(path)) {
          snapshot.set(path, blake3Hex(data));
        }
      }
      assertEquals(snapshot.size, 10, "B should have all 10 files after sync");

      // Restart A then B
      A = await restartPlugin(A, p.server);
      await waitFor(() => A.isLive(), "A to reconnect after restart");
      B = await restartPlugin(B, p.server);
      await waitFor(() => B.isLive(), "B to reconnect after restart");

      // Reconcile
      await A.reconcileNow();
      await B.reconcileNow();
      await waitFor(
        () => A.syncManager.getConflictCount() === 0 && B.syncManager.getConflictCount() === 0,
        "clean reconcile with no conflicts",
      );

      // No conflicts on clean restart
      assertEquals(A.syncManager.getConflictCount(), 0, "no conflicts on clean restart (A)");
      assertEquals(B.syncManager.getConflictCount(), 0, "no conflicts on clean restart (B)");

      // Assert B still has all 10 files with identical content hashes
      assertEquals(B.fakeVault.files.size, snapshot.size, "B should still have exactly 10 files");
      for (const [path, expectedHash] of snapshot) {
        const data = B.fakeVault.files.get(path);
        assertEquals(data === undefined, false, `File ${path} should exist`);
        const actualHash = blake3Hex(data!);
        assertEquals(actualHash, expectedHash, `Content of ${path} must be unchanged`);
      }

      // No conflict files
      assertEquals(
        [...B.fakeVault.files.keys()].filter((k) => isConflictPath(k)).length,
        0,
        "No conflict files should exist",
      );
    } finally {
      try {
        A.stop();
      } catch { /* teardown is best-effort */ }
      try {
        B.stop();
      } catch { /* teardown is best-effort */ }
      await p.server.stop();
    }
  },
});

// KNOWN BUG (data loss): replay overwrites untracked local edits. Un-ignore when fixed.
Deno.test({
  name: "restart-data-integrity - offline divergent edit is NOT silently lost across restart",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const p = await pair();
    let A = p.A;
    let B = p.B;
    try {
      // A authors doc.md
      A.fakeVault.write("doc.md", "line1\nline2\nline3\n");
      await A.flushPending();
      await waitFor(() => B.fakeVault.files.has("doc.md"), "B to receive doc.md");

      // Simulate offline divergent edits (bypassing events)
      A.fakeVault.files.set("doc.md", new TextEncoder().encode("AHEAD\nline1\nline2\nline3\n"));
      B.fakeVault.files.set("doc.md", new TextEncoder().encode("line1\nline2\nline3\nBTAIL\n"));

      // Restart A then B
      A = await restartPlugin(A, p.server);
      await waitFor(() => A.isLive(), "A to reconnect after restart");
      B = await restartPlugin(B, p.server);
      await waitFor(() => B.isLive(), "B to reconnect after restart");

      // Reconcile until both divergent edits surface somewhere
      const bothPreserved = () => {
        const aDoc = read(A, "doc.md");
        const bDoc = read(B, "doc.md");
        const conflicts = [...A.fakeVault.files.keys()]
          .filter((k) => isConflictPath(k))
          .map((k) => read(A, k));
        const all = [aDoc, bDoc, ...conflicts].join("\n");
        return all.includes("AHEAD") && all.includes("BTAIL");
      };
      await A.reconcileNow();
      await B.reconcileNow();
      await waitFor(bothPreserved, "both divergent edits preserved", 20_000);

      // Assert both edits survive somewhere
      const aDoc = read(A, "doc.md");
      const bDoc = read(B, "doc.md");
      const conflictFiles = [...A.fakeVault.files.keys()]
        .filter((k) => isConflictPath(k))
        .map((k) => read(A, k));
      const all = [aDoc, bDoc, ...conflictFiles].join("\n");
      assertEquals(
        all.includes("AHEAD") && all.includes("BTAIL"),
        true,
        "both edits must be preserved",
      );
    } finally {
      try {
        A.stop();
      } catch { /* teardown is best-effort */ }
      try {
        B.stop();
      } catch { /* teardown is best-effort */ }
      await p.server.stop();
    }
  },
});

Deno.test({
  name: "restart-data-integrity - delete propagates across restart",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const p = await pair();
    let A = p.A;
    let B = p.B;
    try {
      // A authors keep.md and gone.md
      A.fakeVault.write("keep.md", "keep this");
      A.fakeVault.write("gone.md", "delete this");
      await A.flushPending();
      await waitFor(() => B.fakeVault.files.has("gone.md"), "B to receive gone.md");

      // Confirm B has gone.md
      assertEquals(
        B.fakeVault.files.has("gone.md"),
        true,
        "B should have gone.md after initial sync",
      );

      // A deletes gone.md
      await A.fakeVault.delete("gone.md");
      await A.flushPending();
      await waitFor(() => !B.fakeVault.files.has("gone.md"), "B to receive the delete");

      // Restart A then B
      A = await restartPlugin(A, p.server);
      await waitFor(() => A.isLive(), "A to reconnect after restart");
      B = await restartPlugin(B, p.server);
      await waitFor(() => B.isLive(), "B to reconnect after restart");

      // Reconcile
      await A.reconcileNow();
      await B.reconcileNow();
      await waitFor(
        () =>
          !A.fakeVault.files.has("gone.md") &&
          !B.fakeVault.files.has("gone.md") &&
          A.fakeVault.files.has("keep.md") &&
          B.fakeVault.files.has("keep.md"),
        "delete to propagate and keep.md to survive on both",
      );

      // Assert gone.md absent on both, keep.md present on both
      assertEquals(A.fakeVault.files.has("gone.md"), false, "A should not have gone.md");
      assertEquals(B.fakeVault.files.has("gone.md"), false, "B should not have gone.md");
      assertEquals(A.fakeVault.files.has("keep.md"), true, "A should have keep.md");
      assertEquals(B.fakeVault.files.has("keep.md"), true, "B should have keep.md");
    } finally {
      try {
        A.stop();
      } catch { /* teardown is best-effort */ }
      try {
        B.stop();
      } catch { /* teardown is best-effort */ }
      await p.server.stop();
    }
  },
});
