import { assertEquals, assertRejects } from "@std/assert";
import { executeResolution, planResolution } from "../../../plugin/sync/conflict-resolve.ts";
import { commitOp, waitForInFlightCommit } from "../../../plugin/sync/commit.ts";
import { openStateDB } from "../../../plugin/plumbing/state.ts";
import { deriveKeys } from "../../../core/crypto.ts";
import { FakeVault } from "../../two-vault-driver.ts";

// #432: the resolution executor must never swallow a failed commit and must
// never drop a resolution that races another commit of the same path. A failed
// commitOp returns false, so the executor throws (the modal catch shows the
// error Notice and reloads instead of "Resolved"). commitOp's in-flight dedup
// previously returned true as a silent no-op; it now waits for the in-flight
// commit of the same path and then runs, so a resolution racing the
// reconciler's first commit of the fresh conflict file still deletes/overwrites
// as asked.

const PATH = "notes.md";
const CONFLICT = "notes (conflict Laptop 2026-10-12 140205).md";
const MINE = { path: PATH, conflictPath: CONFLICT, conflictFileIsMine: true };

type FakeTransport = {
  headBlob: () => Promise<boolean>;
  putBlob: () => Promise<void>;
  commit: (req: { deleted: boolean }) => Promise<unknown>;
};

async function makeDeps(_transport: FakeTransport) {
  const vault = new FakeVault();
  vault.write(PATH, "server copy");
  vault.write(CONFLICT, "local copy");
  const state = openStateDB();
  const keys = await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
  // The conflict file already synced (the reconciler committed it or will), so
  // a committed delete actually reaches the server instead of being a no-op.
  state.upsertLocalFile({
    path: CONFLICT,
    path_hash: "h-cf",
    size: 9,
    mtime: Date.now(),
    plaintext_hash: "ph-cf",
    last_seen_version: 1,
    chunk_hashes: [],
    deleted: false,
  });
  return { vault, state, keys };
}

function resolveDeps(
  deps: Awaited<ReturnType<typeof makeDeps>>,
  transport: FakeTransport,
  deleted: string[],
) {
  return {
    vault: { adapter: deps.vault.adapter },
    state: deps.state,
    keys: deps.keys,
    transport: transport as never,
    onConflict: () => {},
    onConflictFileDeleted: (p: string) => deleted.push(p),
  };
}

function commitDeps(deps: Awaited<ReturnType<typeof makeDeps>>, transport: FakeTransport) {
  return {
    vault: { adapter: deps.vault.adapter },
    state: deps.state,
    keys: deps.keys,
    transport: transport as never,
    onConflict: () => {},
    pendingRenameTarget: () => undefined,
  };
}

Deno.test("a failed commit throws on the delete path (the modal catch shows an error Notice)", async () => {
  const transport: FakeTransport = {
    headBlob: () => Promise.resolve(true),
    putBlob: async () => {},
    commit: () => Promise.resolve({ kind: "error", message: "boom" }),
  };
  const deps = await makeDeps(transport);
  const deleted: string[] = [];
  await assertRejects(
    () =>
      executeResolution(planResolution(MINE, "keep-theirs"), resolveDeps(deps, transport, deleted)),
    Error,
    "failed to commit",
  );
  assertEquals(deleted, [], "the count hook must not fire for a commit that failed");
});

Deno.test("a failed commit throws on the write path (keep mine overwrites then deletes)", async () => {
  const transport: FakeTransport = {
    headBlob: () => Promise.resolve(true),
    putBlob: async () => {},
    commit: () => Promise.resolve({ kind: "error", message: "boom" }),
  };
  const deps = await makeDeps(transport);
  await assertRejects(
    () => executeResolution(planResolution(MINE, "keep-mine"), resolveDeps(deps, transport, [])),
    Error,
    "failed to commit",
  );
});

Deno.test("a resolution racing an in-flight commit of the same path waits, then performs the delete", async () => {
  const commits: Array<{ deleted: boolean; version: number }> = [];
  let release: (() => void) | null = null;
  const transport: FakeTransport = {
    headBlob: () => Promise.resolve(true),
    putBlob: async () => {},
    commit: (req) => {
      const n = commits.length + 1;
      commits.push({ deleted: req.deleted, version: n });
      if (n === 1) {
        // Hold the first commit (the reconciler's) in flight at the server.
        return new Promise((res) => {
          release = () => res({ kind: "ack", seq: n, version: n });
        });
      }
      return Promise.resolve({ kind: "ack", seq: n, version: n });
    },
  };
  const deps = await makeDeps(transport);
  // The reconciler's commit of the fresh conflict file starts; let it read and
  // chunk the file and reach the held transport.commit before the resolution
  // deletes the file.
  const inFlight = commitOp({ path: CONFLICT, kind: "commit" }, commitDeps(deps, transport));
  await new Promise((r) => setTimeout(r, 20));
  const deleted: string[] = [];
  let resolved = false;
  const resolution = executeResolution(
    planResolution(MINE, "keep-theirs"),
    resolveDeps(deps, transport, deleted),
  ).then(() => {
    resolved = true;
  });
  // While the conflict file commit is in flight the resolution must wait, not
  // be silently dropped.
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(resolved, false, "resolution waits for the in-flight commit of the same path");
  release!();
  await inFlight;
  await resolution;
  assertEquals(resolved, true);
  assertEquals(commits.length, 2, "the in-flight commit and the resolution's delete both commit");
  assertEquals(
    commits[1].deleted,
    true,
    "the resolution commits a delete after the in-flight commit",
  );
  assertEquals(deleted, [CONFLICT], "the count hook fires once the delete is committed");
  assertEquals(deps.vault.fileExists(CONFLICT), false, "the conflict file is gone locally");
});

Deno.test("waiting on a commit that never settles reports a timeout instead of a silent success", async () => {
  let release: (() => void) | null = null;
  const transport: FakeTransport = {
    headBlob: () => Promise.resolve(true),
    putBlob: async () => {},
    commit: () =>
      new Promise((res) => {
        release = () => res({ kind: "ack", seq: 1, version: 1 });
      }),
  };
  const deps = await makeDeps(transport);
  const stuck = commitOp({ path: CONFLICT, kind: "commit" }, commitDeps(deps, transport));
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(await waitForInFlightCommit(deps.state, CONFLICT, 30), false);
  release!();
  await stuck;
  assertEquals(await waitForInFlightCommit(deps.state, CONFLICT, 30), true);
});
