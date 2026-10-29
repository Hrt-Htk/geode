import { assertEquals } from "@std/assert";
import { commitOp, waitForInFlightCommit } from "../../../plugin/sync/commit.ts";
import { openStateDB } from "../../../plugin/plumbing/state.ts";
import { deriveKeys } from "../../../core/crypto.ts";
import { FakeVault } from "../../two-vault-driver.ts";

// #583: commitOp dedupes "one commit per path" so two writes of one file never
// race. That guard is per vault: the module is shared by every plugin instance in
// a process (and by every device the fuzz driver runs), so keying it on the path
// alone lets one vault's hung commit swallow another vault's op: the other vault
// reports success, never uploads, and the file stays divergent forever.

const PATH = "notes.md";

type FakeTransport = {
  headBlob: () => Promise<boolean>;
  putBlob: () => Promise<void>;
  commit: () => Promise<unknown>;
};

async function depsWith(transport: FakeTransport) {
  const vault = new FakeVault();
  vault.write(PATH, "body");
  const state = openStateDB();
  const keys = await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
  return {
    vault: { adapter: vault.adapter },
    state,
    keys,
    transport: transport as never,
    onConflict: () => {},
    pendingRenameTarget: () => undefined,
    vaultObj: vault,
  };
}

Deno.test("commit-inflight - a hung commit in one vault does not swallow another vault's", async () => {
  let release = () => {};
  const stuck = await depsWith({
    headBlob: () => Promise.resolve(true),
    putBlob: async () => {},
    commit: () =>
      new Promise((res) => {
        release = () => res({ kind: "ack", seq: 1, version: 1 });
      }),
  });
  let otherCommits = 0;
  const other = await depsWith({
    headBlob: () => Promise.resolve(true),
    putBlob: async () => {},
    commit: () => {
      otherCommits++;
      return Promise.resolve({ kind: "ack", seq: 1, version: 1 });
    },
  });

  const hung = commitOp({ path: PATH, kind: "commit" }, stuck);
  await new Promise((r) => setTimeout(r, 10));

  assertEquals(await commitOp({ path: PATH, kind: "commit" }, other), true);
  assertEquals(otherCommits, 1, "the other vault's commit must reach its server");

  release();
  await hung;
  assertEquals(await waitForInFlightCommit(other.state, PATH, 10), true);
});

Deno.test("commit-inflight - the same vault still dedupes one commit per path", async () => {
  let release = () => {};
  let commits = 0;
  const deps = await depsWith({
    headBlob: () => Promise.resolve(true),
    putBlob: async () => {},
    commit: () => {
      commits++;
      return new Promise((res) => {
        release = () => res({ kind: "ack", seq: 1, version: 1 });
      });
    },
  });

  const hung = commitOp({ path: PATH, kind: "commit" }, deps);
  await new Promise((r) => setTimeout(r, 10));
  assertEquals(await commitOp({ path: PATH, kind: "commit" }, deps), true);
  assertEquals(commits, 1, "the second op is deduped, not sent twice");

  release();
  await hung;
  assertEquals(await waitForInFlightCommit(deps.state, PATH, 10), true);
});
