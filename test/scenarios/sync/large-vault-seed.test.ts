import { assertEquals } from "@std/assert";
import { seedLargeVault } from "../../two-vault-driver.ts";

/**
 * Test: seedLargeVault pre-seeds a throwaway server with N file versions, then a
 * fresh device cold-syncs (replays) the whole backlog and converges. This is the
 * #319 cold-sync path: the joiner's transport goes live before the replay buffer
 * drains, so the test polls for convergence rather than assuming it.
 */
Deno.test({
  name: "large-vault-seed - fresh joiner replays the full seeded backlog",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const COUNT = 150;
    const seeded = await seedLargeVault(COUNT);
    try {
      // 1. The server actually holds COUNT versions (poll-backed by the helper,
      //    re-asserted here against the real DB).
      const row = seeded.server.db
        .prepare("SELECT COUNT(*) AS n FROM file_versions WHERE vault_id = ?")
        .get(seeded.vaultId) as { n: number };
      assertEquals(row.n >= COUNT, true, `expected >= ${COUNT} versions, got ${row.n}`);

      // 2. A fresh device cold-syncs the backlog and converges.
      const joiner = await seeded.join();
      const samplePath = "note-0000.md";
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (joiner.fakeVault.getAllLoadedFiles().length >= COUNT) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assertEquals(
        joiner.fakeVault.getAllLoadedFiles().length >= COUNT,
        true,
        `expected joiner to load >= ${COUNT} files, got ${joiner.fakeVault.getAllLoadedFiles().length}`,
      );

      // A sampled file matches the seeder's content byte-for-byte.
      const expected = await seeded.seeder.fakeVault.readBinary(samplePath);
      const actual = await joiner.fakeVault.readBinary(samplePath);
      assertEquals(
        [...actual],
        [...expected],
        `sampled file ${samplePath} content mismatch`,
      );
    } finally {
      // 3. Clean teardown: no leaked servers/sockets; the process must exit.
      await seeded.stop();
    }
  },
});

/**
 * #319: while the replay buffer drains AFTER the transport is live, the
 * sync manager must emit "applying" progress { current, total } so the
 * status icon can show "applying N/M" instead of a false synced checkmark.
 * Proven headlessly via a status spy installed before the joiner starts.
 */
Deno.test({
  name: "large-vault-seed - replay drain emits applying progress up to total",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const COUNT = 50;
    const seeded = await seedLargeVault(COUNT);
    const applying: Array<{ current: number; total: number }> = [];
    try {
      const joiner = await seeded.join("joiner", (status, data) => {
        if (status === "applying") {
          applying.push(data as { current: number; total: number });
        }
      });

      // Wait for the drain to finish (all files applied to disk).
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (joiner.fakeVault.getAllLoadedFiles().length >= COUNT) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assertEquals(
        joiner.fakeVault.getAllLoadedFiles().length >= COUNT,
        true,
        `expected joiner to load >= ${COUNT} files, got ${joiner.fakeVault.getAllLoadedFiles().length}`,
      );

      // The drain emitted "applying" with strictly increasing current, ending at total.
      assertEquals(applying.length > 0, true, "expected at least one applying event");
      for (let i = 1; i < applying.length; i++) {
        assertEquals(
          applying[i].current === applying[i - 1].current + 1,
          true,
          `applying current must increase by 1 (got ${applying[i - 1].current} -> ${
            applying[i].current
          })`,
        );
      }
      assertEquals(applying[applying.length - 1].current, applying[applying.length - 1].total);
      assertEquals(applying[applying.length - 1].total, COUNT);
    } finally {
      await seeded.stop();
    }
  },
});
