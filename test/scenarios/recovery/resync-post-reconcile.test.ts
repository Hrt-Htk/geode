import { assertEquals } from "@std/assert";
import { arraysEqual } from "../../helpers/bytes.ts";
import { pair } from "../../two-vault-driver.ts";

/**
 * Diagnostic test for issue #153: after resyncFromScratch, verify that:
 * 1. Transport reaches "live" state
 * 2. Reconciler does NOT find spurious changes (all files should match)
 * 3. Pending ops drain to 0
 *
 * This reproduces the conditions that cause the status bar to wedge at
 * "N changes pending" in hybrid (desktop+phone) pairs.
 */
Deno.test({
  name: "resync post-reconcile diagnostic: transport goes live, reconciler finds no spurious ops",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      // 1. Seed 18 files (matching the hybrid E2E spec) on A.
      const files = buildSeedFiles();
      for (const file of files) {
        A.fakeVault.writeBinary(file.path, new Uint8Array(file.bytes));
      }
      await A.flushPending();

      // 2. Wait for B to receive all files.
      for (const file of files) {
        await B.waitForVersion(file.path, 1);
      }

      // Verify both sides have the same files.
      assertEquals(
        B.fakeVault.files.size,
        A.fakeVault.files.size,
        "file count mismatch before resync",
      );

      // 3. Clear B's local state and disk (simulate lost vault).
      B.fakeVault.files.clear();
      B.fakeVault.mtimes.clear();
      await B.resetLocalState();

      // 4. Resync B from scratch.
      const result = await B.resyncFromScratch();
      assertEquals(result.appliedFiles, files.length, `expected ${files.length} applied files`);

      // 5. Verify transport is live (not stuck in "syncing").
      // The test harness waits for the "live" event in resyncFromScratch,
      // so if we reach here, the transport went live.
      assertEquals(B.syncManager.getPendingOps().length, 0, "pending ops should be 0 after resync");

      // 6. Force a reconciler run and verify it finds no spurious changes.
      await B.reconcileNow();
      assertEquals(
        B.syncManager.getPendingOps().length,
        0,
        "reconciler should find no ops after resync",
      );

      // 7. Verify byte-for-byte match.
      for (const file of files) {
        const aData = A.fakeVault.files.get(file.path);
        const bData = B.fakeVault.files.get(file.path);
        assertEquals(bData !== null, true, `missing file on B: ${file.path}`);
        assertEquals(arraysEqual(aData!, bData!), true, `byte mismatch for ${file.path}`);
      }

      // 8. Verify local state matches for all files.
      for (const file of files) {
        const localRow = B.state.getLocalFile(file.path);
        assertEquals(localRow !== null, true, `missing local state for ${file.path}`);
        assertEquals(localRow!.deleted, false, `${file.path} should not be deleted`);
      }
    } finally {
      await stop();
    }
  },
});

/**
 * Variant: resync while the peer is actively writing.
 * Simulates the phone continuing to create versions during B's resync window.
 */
Deno.test({
  name: "resync post-reconcile diagnostic: peer writes during resync window",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      // 1. Seed initial files on A.
      const initialFiles = buildSeedFiles();
      for (const file of initialFiles) {
        A.fakeVault.writeBinary(file.path, new Uint8Array(file.bytes));
      }
      await A.flushPending();

      for (const file of initialFiles) {
        await B.waitForVersion(file.path, 1);
      }

      // 2. Clear B's state.
      B.fakeVault.files.clear();
      B.fakeVault.mtimes.clear();
      await B.resetLocalState();

      // 3. While B is resyncing, A writes a new file.
      // This simulates the phone being active during B's resync.
      const newFile = {
        path: "seed/new-during-resync.md",
        bytes: [...new TextEncoder().encode("# New\n")],
      };
      A.fakeVault.writeBinary(newFile.path, new Uint8Array(newFile.bytes));
      await A.flushPending();

      // 4. Resync B.
      await B.resyncFromScratch();

      // 5. B should have received the new file through the version stream during/after resync.
      await B.waitForVersion(newFile.path, 1);

      // 6. Verify transport is live and no spurious pending ops.
      assertEquals(
        B.syncManager.getPendingOps().length,
        0,
        "pending ops should be 0 after resync with peer activity",
      );

      // 7. Force reconciler: should still find no spurious ops.
      await B.reconcileNow();
      assertEquals(
        B.syncManager.getPendingOps().length,
        0,
        "reconciler should find no ops after resync with peer activity",
      );

      // 8. Verify all files converge.
      for (const file of [...initialFiles, newFile]) {
        const aData = A.fakeVault.files.get(file.path);
        const bData = B.fakeVault.files.get(file.path);
        assertEquals(bData !== null, true, `missing file on B: ${file.path}`);
        assertEquals(arraysEqual(aData!, bData!), true, `byte mismatch for ${file.path}`);
      }
    } finally {
      await stop();
    }
  },
});

// --- helpers ---

function buildSeedFiles(): Array<{ path: string; bytes: number[] }> {
  const files: Array<{ path: string; bytes: number[] }> = [];
  for (let index = 1; index <= 16; index++) {
    const folder = index % 4 === 0
      ? "seed/nested/deeper"
      : index % 3 === 0
      ? "seed/nested"
      : "seed";
    const fileName = `note-${String(index).padStart(2, "0")}.md`;
    const body = `# Note ${index}\nseeded line ${index}\nchecksum ${index * 17}\n`;
    files.push({
      path: `${folder}/${fileName}`,
      bytes: [...new TextEncoder().encode(body)],
    });
  }
  files.push({
    path: "seed/assets/chart.canvas",
    bytes: [...new TextEncoder().encode('{"nodes":[{"id":"gate6","x":1,"y":2}],"edges":[]}')],
  });
  files.push({
    path: "seed/assets/diagram.bin",
    bytes: [0, 255, 4, 8, 15, 16, 23, 42, 99, 7, 3, 1],
  });
  return files;
}
