import { assertEquals } from "@std/assert";
import { pair, type PairedVaults } from "../../two-vault-driver.ts";
import {
  executeResolution,
  planResolution,
  type ResolutionAction,
} from "../../../plugin/sync/conflict-resolve.ts";
import { conflictFileIsMine } from "../../../plugin/sync/conflict-list.ts";
import { isConflictPath } from "../../../plugin/sync/conflicts.ts";

/**
 * #432: conflict resolution converges on both devices with no marker content.
 *
 * A real conflict is created the same way production makes one: B disconnects,
 * A commits a newer version, B makes an untracked divergent edit on disk, and
 * B's reconnect hits the apply guard (binary-style divergence → conflict file).
 * The original path then holds A's (server) version and the conflict file holds
 * B's (local) version. Conflict files sync like any file, so the conflict file
 * reaches A too. Resolutions are done on BOTH devices:
 *  - on B (creating device, conflict file = mine) and
 *  - on A (receiving device, conflict file = the creator's, so Keep mine /
 *    Keep theirs invert).
 * Each resolution must converge on BOTH devices, delete the conflict file, and
 * never commit marker content (hard rule 6).
 */

const PATH = "notes.md";
const BASE = "line 1\nline 2\nline 3\n";
const SERVER_WINNER = "line 1\nA edited line 2\nline 3\n";
const LOCAL_LOSER = "line 1\nB edited line 2\nline 3\n";

async function makeConflict(A: PairedVaults["A"], B: PairedVaults["B"]): Promise<string> {
  // Name the devices so the conflict file embeds the creator's name, as a real
  // user's device would (pair() registers the DB names but leaves settings blank).
  A.pluginSettings.deviceName = "device-A";
  B.pluginSettings.deviceName = "device-B";
  A.fakeVault.write(PATH, BASE);
  await A.flushPending();
  await B.waitForVersion(PATH, 1);
  B.disconnect();
  A.fakeVault.write(PATH, SERVER_WINNER);
  await A.flushPending();
  B.fakeVault.write(PATH, LOCAL_LOSER, { mtime: Date.now() + 1_000 });
  await B.reconnect();
  const conflictPath = await waitForConflictFile(B, "notes", ".md");
  // The main file must be the server winner; the conflict file the local bytes.
  assertEquals(await B.fakeVault.readBinary(PATH), new TextEncoder().encode(SERVER_WINNER));
  assertEquals(await B.fakeVault.readBinary(conflictPath), new TextEncoder().encode(LOCAL_LOSER));
  return conflictPath;
}

/** A conflict whose conflict file has also synced to the receiving device A. */
async function makeConflictSynced(A: PairedVaults["A"], B: PairedVaults["B"]): Promise<string> {
  const conflictPath = await makeConflict(A, B);
  // B commits the conflict file (it syncs like any file) so A receives it.
  await B.reconcileNow();
  await A.waitForVersion(conflictPath);
  // A's copy holds the creator's content (B's losing edit).
  assertEquals(await A.fakeVault.readBinary(conflictPath), new TextEncoder().encode(LOCAL_LOSER));
  return conflictPath;
}

async function resolve(
  plugin: PairedVaults["A"] | PairedVaults["B"],
  path: string,
  conflictPath: string,
  action: ResolutionAction,
  mine: boolean,
): Promise<void> {
  // Assert the attribution the list model derives, then resolve with it.
  assertEquals(
    conflictFileIsMine(
      conflictPath,
      plugin.pluginSettings.deviceName,
      null,
      plugin.pluginSettings.deviceId,
    ),
    mine,
  );
  const plan = planResolution({ path, conflictPath, conflictFileIsMine: mine }, action);
  await executeResolution(plan, {
    vault: { adapter: plugin.fakeVault.adapter },
    state: plugin.state,
    keys: plugin.keys,
    transport: plugin.transport,
    onConflict: (p, head) => plugin.syncManager.handleConflict(p, head),
    onConflictFileDeleted: (p) => plugin.syncManager.onConflictFileDeleted(p),
  });
  // The commit queue and replay must drain so the peer receives the resolution.
  await plugin.waitForIdle();
}

// ── On the creating device B (conflict file = mine) ─────────────────────

Deno.test({
  name: "gate432 keep mine (on B): B's version wins on both devices, conflict file gone",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      const conflictPath = await makeConflict(A, B);
      await resolve(B, PATH, conflictPath, "keep-mine", true);

      await A.waitForConvergence(B, PATH);
      assertEquals([...await A.fakeVault.readBinary(PATH)], [
        ...new TextEncoder().encode(LOCAL_LOSER),
      ]);
      assertEquals([...await B.fakeVault.readBinary(PATH)], [
        ...new TextEncoder().encode(LOCAL_LOSER),
      ]);
      await waitForNoConflictFiles(A, B);
      assertEquals(B.syncManager.getConflictCount(), 0);
      await assertNoMarkerContent(A, B);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "gate432 keep theirs (on B): A's version stays on both devices, conflict file gone",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      const conflictPath = await makeConflict(A, B);
      await resolve(B, PATH, conflictPath, "keep-theirs", true);

      await A.waitForConvergence(B, PATH);
      assertEquals([...await A.fakeVault.readBinary(PATH)], [
        ...new TextEncoder().encode(SERVER_WINNER),
      ]);
      assertEquals([...await B.fakeVault.readBinary(PATH)], [
        ...new TextEncoder().encode(SERVER_WINNER),
      ]);
      await waitForNoConflictFiles(A, B);
      assertEquals(B.syncManager.getConflictCount(), 0);
      await assertNoMarkerContent(A, B);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name:
    "gate432 keep both (on B): original keeps A's version, kept copy of B's lands on both devices",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      const conflictPath = await makeConflict(A, B);
      const kept = "notes (kept copy).md";
      await resolve(B, PATH, conflictPath, "keep-both", true);

      // Original converges on A's (server) version.
      await A.waitForConvergence(B, PATH);
      assertEquals([...await A.fakeVault.readBinary(PATH)], [
        ...new TextEncoder().encode(SERVER_WINNER),
      ]);
      // The kept copy of B's version lands on both devices.
      await B.waitForVersion(kept);
      await A.waitForVersion(kept);
      assertEquals([...await A.fakeVault.readBinary(kept)], [
        ...new TextEncoder().encode(LOCAL_LOSER),
      ]);
      assertEquals([...await B.fakeVault.readBinary(kept)], [
        ...new TextEncoder().encode(LOCAL_LOSER),
      ]);
      await waitForNoConflictFiles(A, B);
      assertEquals(B.syncManager.getConflictCount(), 0);
      await assertNoMarkerContent(A, B);
    } finally {
      await stop();
    }
  },
});

// ── On the receiving device A (conflict file = the creator's, so inverted) ──

Deno.test({
  name: "gate432 keep mine (on A): A's/server version stays on both devices, conflict file gone",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      const conflictPath = await makeConflictSynced(A, B);
      // On A the conflict file is the creator's (B), so keep mine keeps the
      // original (A's/server copy) and only deletes the conflict file.
      await resolve(A, PATH, conflictPath, "keep-mine", false);

      await B.waitForConvergence(A, PATH);
      assertEquals([...await A.fakeVault.readBinary(PATH)], [
        ...new TextEncoder().encode(SERVER_WINNER),
      ]);
      assertEquals([...await B.fakeVault.readBinary(PATH)], [
        ...new TextEncoder().encode(SERVER_WINNER),
      ]);
      await waitForNoConflictFiles(A, B);
      assertEquals(A.syncManager.getConflictCount(), 0);
      assertEquals(B.syncManager.getConflictCount(), 0);
      await assertNoMarkerContent(A, B);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name:
    "gate432 keep theirs (on A): the creator's version wins on both devices, conflict file gone",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      const conflictPath = await makeConflictSynced(A, B);
      // On A, keep theirs keeps the creator's (B's) version: write the conflict
      // file over the original, commit it, then delete the conflict file.
      await resolve(A, PATH, conflictPath, "keep-theirs", false);

      await B.waitForConvergence(A, PATH);
      assertEquals([...await A.fakeVault.readBinary(PATH)], [
        ...new TextEncoder().encode(LOCAL_LOSER),
      ]);
      assertEquals([...await B.fakeVault.readBinary(PATH)], [
        ...new TextEncoder().encode(LOCAL_LOSER),
      ]);
      await waitForNoConflictFiles(A, B);
      assertEquals(A.syncManager.getConflictCount(), 0);
      assertEquals(B.syncManager.getConflictCount(), 0);
      await assertNoMarkerContent(A, B);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name:
    "gate432 keep both (on A): original keeps A's version, kept copy of the creator's lands on both",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      const conflictPath = await makeConflictSynced(A, B);
      const kept = "notes (kept copy).md";
      await resolve(A, PATH, conflictPath, "keep-both", false);

      await B.waitForConvergence(A, PATH);
      assertEquals([...await A.fakeVault.readBinary(PATH)], [
        ...new TextEncoder().encode(SERVER_WINNER),
      ]);
      await B.waitForVersion(kept);
      await A.waitForVersion(kept);
      assertEquals([...await A.fakeVault.readBinary(kept)], [
        ...new TextEncoder().encode(LOCAL_LOSER),
      ]);
      assertEquals([...await B.fakeVault.readBinary(kept)], [
        ...new TextEncoder().encode(LOCAL_LOSER),
      ]);
      await waitForNoConflictFiles(A, B);
      assertEquals(A.syncManager.getConflictCount(), 0);
      assertEquals(B.syncManager.getConflictCount(), 0);
      await assertNoMarkerContent(A, B);
    } finally {
      await stop();
    }
  },
});

// ── helpers ──────────────────────────────────────────────────────────────

async function waitForConflictFile(
  plugin: PairedVaults["B"],
  prefix: string,
  ext: string,
  timeoutMs = 20_000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = [...plugin.fakeVault.files.keys()].find(
      (p) => isConflictPath(p) && p.startsWith(prefix) && p.endsWith(ext),
    );
    if (found) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for conflict file with prefix "${prefix}"`);
}

async function waitForNoConflictFiles(A: PairedVaults["A"], B: PairedVaults["B"]): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    const a = [...A.fakeVault.files.keys()].filter((p) => isConflictPath(p));
    const b = [...B.fakeVault.files.keys()].filter((p) => isConflictPath(p));
    if (a.length === 0 && b.length === 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("conflict files remain on A or B after resolution");
}

function assertNoMarkerContent(A: PairedVaults["A"], B: PairedVaults["B"]): void {
  for (const plugin of [A, B]) {
    for (const [p, data] of plugin.fakeVault.files) {
      const text = new TextDecoder().decode(data);
      assertEquals(
        text.includes("<<<<<<<") || text.includes(">>>>>>>") || text.includes("======="),
        false,
        `marker content committed in ${p}`,
      );
    }
  }
}
