import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  pair,
  type TestPlugin,
  type TestServer,
  trashCount,
  waitFor,
} from "../../two-vault-driver.ts";
import { hashPathHex } from "../../../core/hash.ts";
import type { VersionRecord } from "../../../core/protocol.ts";
import { commitOp } from "../../../plugin/sync/commit.ts";
import { reconstructVersion } from "../../../plugin/sync/history-fetch.ts";
import { RestoreBusy, RestorePaused } from "../../../plugin/sync/history-restore.ts";

// #465: restore a past version as a NEW head version (non-destructive: the old
// content is appended, history is never rewritten), at the file's current name,
// and it reaches the peer as one new version. A local edit that never reached the
// server lands as its own version first, so a restore never destroys it.

type Row = { version: number; deleted: number; rename_mark: number };

function chain(server: TestServer, vaultId: string, path: string, macKey: Uint8Array): Row[] {
  return server.db
    .prepare(
      "SELECT version, deleted, rename_mark FROM file_versions WHERE vault_id = ? AND path_hash = ? ORDER BY version",
    )
    .all(vaultId, hashPathHex(macKey, path)) as Row[];
}

function content(plugin: TestPlugin, path: string): string {
  const bytes = plugin.fakeVault.files.get(path);
  return bytes ? new TextDecoder().decode(bytes) : "";
}

async function record(
  plugin: TestPlugin,
  path: string,
  version: number,
): Promise<VersionRecord> {
  const rows = await plugin.transport!.getVersionChain(hashPathHex(plugin.keys!.mac_key, path));
  const row = rows.find((r) => r.version === version);
  assert(row, `expected version ${version} of ${path}`);
  return row;
}

Deno.test({
  name: "history-restore - a markdown version lands as one new head version and reaches the peer",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      const path = "notes/restore.md";
      for (const body of ["first\n", "second\n", "third\n"]) {
        A.fakeVault.write(path, body);
        await A.flushPending();
      }
      await A.waitForConvergence(B, path);

      const outcome = await A.syncManager!.restoreVersion(await record(A, path, 1), path);

      assertEquals(outcome, "restored");
      assertEquals(content(A, path), "first\n");
      const rows = chain(server, vaultId, path, A.keys!.mac_key);
      assertEquals(rows.map((r) => r.version), [1, 2, 3, 4], "append only, never rewritten");
      assertEquals(rows[3], { version: 4, deleted: 0, rename_mark: 0 }, "never a rename marker");
      assertEquals(A.activity.entries.get(path)?.kind, "restore");

      await B.waitForConvergence(A, path);
      assertEquals(content(B, path), "first\n");
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "history-restore - a binary version restores its bytes on both devices",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      const path = "attachments/scan.pdf";
      const first = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10]);
      const second = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x01, 0x02, 0x03, 0x04]);
      for (const bytes of [first, second]) {
        A.fakeVault.writeBinary(path, bytes);
        await A.flushPending();
      }
      await A.waitForConvergence(B, path);

      const outcome = await A.syncManager!.restoreVersion(await record(A, path, 1), path);

      assertEquals(outcome, "restored");
      assertEquals(A.fakeVault.files.get(path), first);
      assertEquals(chain(server, vaultId, path, A.keys!.mac_key).length, 3);
      await B.waitForConvergence(A, path);
      assertEquals(B.fakeVault.files.get(path), first);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name:
    "history-restore - a local edit that never reached the server lands as its own version first",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      const path = "notes/unsaved.md";
      A.fakeVault.write(path, "first\n");
      await A.flushPending();
      A.fakeVault.write(path, "second\n");
      await A.flushPending();
      await A.waitForConvergence(B, path);
      // Written but never flushed: the edit exists only on this disk.
      A.fakeVault.write(path, "unsaved edit\n");

      const outcome = await A.syncManager!.restoreVersion(await record(A, path, 1), path);

      assertEquals(outcome, "restored");
      assertEquals(content(A, path), "first\n");
      const rows = chain(server, vaultId, path, A.keys!.mac_key);
      assertEquals(rows.map((r) => r.version), [1, 2, 3, 4], "the edit took version 3");
      const edit = await record(A, path, 3);
      assertEquals(edit.deleted, 0);
      await B.waitForCaughtUp(A.transport!.getLastSeenSeq());
      assertEquals(content(B, path), "first\n");
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "history-restore - a version from before a rename lands at the current name",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      const before = "notes/Old name.md";
      const after = "notes/New name.md";
      A.fakeVault.write(before, "old content\n");
      await A.flushPending();
      A.fakeVault.rename(before, after);
      await A.flushPending();
      A.fakeVault.write(after, "new content\n");
      await A.flushPending();
      await A.waitForConvergence(B, after);

      const outcome = await A.syncManager!.restoreVersion(await record(A, before, 1), after);

      assertEquals(outcome, "restored");
      assertEquals(content(A, after), "old content\n");
      const rows = chain(server, vaultId, after, A.keys!.mac_key);
      assertEquals(rows.at(-1)?.rename_mark, 0, "a restore is content, never a rename link");
      await B.waitForConvergence(A, after);
      assertEquals(content(B, after), "old content\n");
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name:
    "history-restore - a deleted file's version comes back at its last name and leaves the trash",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      const path = "notes/Retired.md";
      A.fakeVault.write(path, "draft\n");
      await A.flushPending();
      A.fakeVault.write(path, "final\n");
      await A.flushPending();
      await A.waitForConvergence(B, path);
      await A.fakeVault.delete(path);
      await A.flushPending();
      await B.waitForDeleted(path);
      assertEquals(trashCount(server, vaultId), 1);

      const outcome = await A.syncManager!.restoreVersion(await record(A, path, 1), path);

      assertEquals(outcome, "restored");
      assert(A.fakeVault.fileExists(path), "the file is back at its last name");
      assertEquals(content(A, path), "draft\n");
      assertEquals(trashCount(server, vaultId), 0, "the name is no longer in the trash");
      await B.waitForConvergence(A, path);
      assertEquals(content(B, path), "draft\n");
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "history-restore - restoring the content already on disk writes no version",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, server, vaultId, stop } = await pair();
    try {
      const path = "notes/same.md";
      A.fakeVault.write(path, "first\n");
      await A.flushPending();
      A.fakeVault.write(path, "second\n");
      await A.flushPending();

      const outcome = await A.syncManager!.restoreVersion(await record(A, path, 2), path);

      assertEquals(outcome, "unchanged");
      assertEquals(content(A, path), "second\n");
      assertEquals(chain(server, vaultId, path, A.keys!.mac_key).length, 2);
      assertEquals(A.activity.entries.get(path)?.kind, "upload");
    } finally {
      await stop();
    }
  },
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A real commit that only lands when the test says so: for the races below. */
function holdFirstCommit(plugin: TestPlugin): void {
  const transport = plugin.transport!;
  const real = transport.commit.bind(transport);
  let held = true;
  (transport as unknown as { commit: typeof real }).commit = (msg) =>
    held
      ? new Promise((resolve) => {
        held = false;
        (globalThis as { releaseCommit?: () => void }).releaseCommit = () => resolve(real(msg));
      })
      : real(msg);
}

function releaseHeldCommit(): void {
  const release = (globalThis as { releaseCommit?: () => void }).releaseCommit;
  assert(release, "expected a held commit");
  release();
}

/** The queued commit reaches the transport only after its own awaits. */
function commitHeld(): boolean {
  return (globalThis as { releaseCommit?: () => void }).releaseCommit !== undefined;
}

Deno.test({
  name: "history-restore - a save landing during the in-flight wait is its own version",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, server, vaultId, stop } = await pair();
    try {
      const path = "notes/race.md";
      A.fakeVault.write(path, "first\n");
      await A.flushPending();
      A.fakeVault.write(path, "second\n");
      await A.flushPending();
      // A save whose commit is in flight: the restore must wait for it, and the
      // NEXT save (written while it waits) must still become a version.
      A.fakeVault.write(path, "in flight\n");
      holdFirstCommit(A);
      const inFlight = A.syncManager!.handlePendingOps([{ path, kind: "commit" }]);
      await waitFor(commitHeld, "the commit to reach the transport");
      const restore = A.syncManager!.restoreVersion(await record(A, path, 1), path);
      await sleep(50);
      A.fakeVault.write(path, "late save\n");
      releaseHeldCommit();
      await inFlight;
      assertEquals(await restore, "restored");

      const contents: string[] = [];
      for (const row of chain(server, vaultId, path, A.keys!.mac_key)) {
        const v = await record(A, path, row.version);
        const { bytes } = await reconstructVersion(v, A.keys!, (h) => A.transport!.getBlob(h));
        contents.push(new TextDecoder().decode(bytes));
      }
      assert(contents.includes("late save\n"), `the late save is a version: ${contents}`);
      assertEquals(content(A, path), "first\n");
      assertEquals(contents.at(-1), "first\n");
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "history-restore - a paused session refuses and leaves the file alone",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, server, vaultId, stop } = await pair();
    try {
      const path = "notes/paused.md";
      A.fakeVault.write(path, "first\n");
      await A.flushPending();
      A.fakeVault.write(path, "second\n");
      await A.flushPending();
      A.pause();

      await assertRejects(
        () => A.syncManager!.restoreVersion(record(A, path, 1), path),
        RestorePaused,
      );
      assertEquals(content(A, path), "second\n");
      assertEquals(chain(server, vaultId, path, A.keys!.mac_key).length, 2);
    } finally {
      await A.resume();
      await stop();
    }
  },
});

Deno.test({
  name: "history-restore - a commit stuck in flight reports busy, not restored",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, server, vaultId, stop } = await pair();
    try {
      const path = "notes/busy.md";
      A.fakeVault.write(path, "first\n");
      await A.flushPending();
      A.fakeVault.write(path, "second\n");
      await A.flushPending();
      A.fakeVault.write(path, "in flight\n");
      // A same-path commit that never lands, held at the transport so it really is
      // in flight. The restore's bounded wait must give up instead of dropping its
      // own commit into commitOp's dedup.
      const transport = A.transport!;
      let armed = () => {};
      const held = new Promise<void>((resolve) => (armed = resolve));
      (transport as unknown as { commit: () => Promise<never> }).commit = () => {
        armed();
        return new Promise(() => {});
      };
      const inFlight = commitOp({ path, kind: "commit" }, {
        vault: A.fakeVault as never,
        state: A.state!,
        keys: A.keys!,
        transport,
        onConflict: () => {},
        pendingRenameTarget: () => undefined,
      });
      await held;
      await sleep(20);

      const restored = await record(A, path, 1);
      await assertRejects(() => A.syncManager!.restoreVersion(restored, path), RestoreBusy);
      assertEquals(content(A, path), "in flight\n", "the disk is untouched");
      assertEquals(chain(server, vaultId, path, A.keys!.mac_key).length, 2);
      void inFlight;
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "history-restore - a rename since the window opened restores at the current name",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      const before = "notes/Old name.md";
      const after = "notes/New name.md";
      A.fakeVault.write(before, "old content\n");
      await A.flushPending();
      // The window was opened on the old name; the file moved out from under it.
      A.fakeVault.rename(before, after);
      await A.flushPending();
      A.fakeVault.write(after, "new content\n");
      await A.flushPending();
      await A.waitForConvergence(B, after);

      const outcome = await A.syncManager!.restoreVersion(await record(A, before, 1), before);

      assertEquals(outcome, "restored");
      assert(!A.fakeVault.fileExists(before), "the old name stays closed");
      assertEquals(content(A, after), "old content\n");
      assertEquals(A.fakeVault.files.size, 1, "never a sibling conflict file");
      const head = chain(server, vaultId, after, A.keys!.mac_key).at(-1);
      assertEquals(head?.rename_mark, 0);
      assertEquals(head?.deleted, 0);
      await B.waitForConvergence(A, after);
      assertEquals(content(B, after), "old content\n");
    } finally {
      await stop();
    }
  },
});
