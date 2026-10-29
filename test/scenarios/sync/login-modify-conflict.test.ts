import { assertEquals } from "@std/assert";
import { pair, waitFor } from "../../two-vault-driver.ts";
import { setDebugLogging } from "../../../plugin/plumbing/log.ts";
import { isConflictPath } from "../../../plugin/sync/conflicts.ts";

setDebugLogging(true);

// ── Helpers ────────────────────────────────────────────────────────────

function hasConflict(vault: Awaited<ReturnType<typeof pair>>["A"]): boolean {
  return [...vault.fakeVault.files.keys()].some((p) => isConflictPath(p));
}

// ── Test 1: A authors, both restart, A modifies → no spurious conflict ──

Deno.test({
  name: "login-modify-conflict - modify after restart (A authors) creates no spurious conflict",
  sanitizeOps: false,
  sanitizeResources: false,
  // Hangs on Windows local: the restart→reconnect WS handshake never settles
  // there (deterministic). Linux CI runs it fine. Tracked in #316.
  ignore: Deno.build.os === "windows",
  async fn() {
    const p = await pair();
    try {
      const path = "notes/doc.md";

      // Step 1: A creates a file
      p.A.fakeVault.write(path, "v1 from A");
      await p.A.flushPending();

      // Step 2: B receives it
      await p.B.waitForVersion(path);

      // Step 3: Simulate BOTH restarting (fresh empty state + replay)
      await p.A.resetLocalState();
      await p.A.reconnect();
      await p.B.resetLocalState();
      await p.B.reconnect();
      await waitFor(() => p.A.isLive() && p.B.isLive(), "both to reconnect and go live");

      // Step 4: A modifies the file
      p.A.fakeVault.write(path, "v2 from A");
      await p.A.flushPending();
      await p.A.waitForConvergence(p.B, path);

      // Step 5: Assert NO conflict in either vault
      assertEquals(hasConflict(p.A), false, "A should have no conflict files");
      assertEquals(hasConflict(p.B), false, "B should have no conflict files");

      // Step 6: Assert conflict counts zero
      assertEquals(p.A.syncManager.getConflictCount(), 0, "A conflict count should be 0");
      assertEquals(p.B.syncManager.getConflictCount(), 0, "B conflict count should be 0");

      // Step 7: Assert both files equal "v2 from A"
      assertEquals(
        new TextDecoder().decode(await p.A.fakeVault.readBinary(path)),
        "v2 from A",
        "A should have v2 content",
      );
      await p.A.waitForConvergence(p.B, path);
      assertEquals(
        new TextDecoder().decode(await p.B.fakeVault.readBinary(path)),
        "v2 from A",
        "B should have v2 content after convergence",
      );
    } finally {
      await p.stop();
    }
  },
});

// ── Test 2: B authors, both restart, B modifies → no spurious conflict ──

Deno.test({
  name: "login-modify-conflict - modify after restart (B authors) creates no spurious conflict",
  sanitizeOps: false,
  sanitizeResources: false,
  // Hangs on Windows local: the restart→reconnect WS handshake never settles
  // there (deterministic). Linux CI runs it fine. Tracked in #316.
  ignore: Deno.build.os === "windows",
  async fn() {
    const p = await pair();
    try {
      const path = "notes/doc.md";

      // Step 1: B creates a file
      p.B.fakeVault.write(path, "v1 from B");
      await p.B.flushPending();

      // Step 2: A receives it
      await p.A.waitForVersion(path);

      // Step 3: Simulate BOTH restarting (fresh empty state + replay)
      await p.A.resetLocalState();
      await p.A.reconnect();
      await p.B.resetLocalState();
      await p.B.reconnect();
      await waitFor(() => p.A.isLive() && p.B.isLive(), "both to reconnect and go live");

      // Step 4: B modifies the file
      p.B.fakeVault.write(path, "v2 from B");
      await p.B.flushPending();
      await p.B.waitForConvergence(p.A, path);

      // Step 5: Assert NO conflict in either vault
      assertEquals(hasConflict(p.A), false, "A should have no conflict files");
      assertEquals(hasConflict(p.B), false, "B should have no conflict files");

      // Step 6: Assert conflict counts zero
      assertEquals(p.A.syncManager.getConflictCount(), 0, "A conflict count should be 0");
      assertEquals(p.B.syncManager.getConflictCount(), 0, "B conflict count should be 0");

      // Step 7: Assert both files equal "v2 from B"
      assertEquals(
        new TextDecoder().decode(await p.B.fakeVault.readBinary(path)),
        "v2 from B",
        "B should have v2 content",
      );
      await p.B.waitForConvergence(p.A, path);
      assertEquals(
        new TextDecoder().decode(await p.A.fakeVault.readBinary(path)),
        "v2 from B",
        "A should have v2 content after convergence",
      );
    } finally {
      await p.stop();
    }
  },
});

// ── Test 3: Author's edit after restart still propagates to peer ──

Deno.test({
  name: "login-modify-conflict - author edit after restart propagates to peer",
  sanitizeOps: false,
  sanitizeResources: false,
  // Hangs on Windows local: the restart→reconnect WS handshake never settles
  // there (deterministic). Linux CI runs it fine. Tracked in #316.
  ignore: Deno.build.os === "windows",
  async fn() {
    const p = await pair();
    try {
      const path = "notes/doc.md";

      // Step 1: A creates a file
      p.A.fakeVault.write(path, "v1 from A");
      await p.A.flushPending();

      // Step 2: B receives it
      await p.B.waitForVersion(path);

      // Step 3: Simulate BOTH restarting (fresh empty state + replay)
      await p.A.resetLocalState();
      await p.A.reconnect();
      await p.B.resetLocalState();
      await p.B.reconnect();
      await waitFor(() => p.A.isLive() && p.B.isLive(), "both to reconnect and go live");

      // Step 4: A modifies the file
      p.A.fakeVault.write(path, "v2 from A");
      await p.A.flushPending();

      // Step 5: Wait for B to converge: this catches the case where A's edit
      // is swallowed into a self-conflict and never reaches B
      await p.A.waitForConvergence(p.B, path);

      // Step 6: B must have the NEW content
      assertEquals(
        new TextDecoder().decode(await p.B.fakeVault.readBinary(path)),
        "v2 from A",
        "B must have A's new content (not swallowed into self-conflict)",
      );
    } finally {
      await p.stop();
    }
  },
});
