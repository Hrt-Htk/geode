import { assert, assertEquals } from "@std/assert";
import { pair, type TestPlugin } from "../../two-vault-driver.ts";
import { isConflictPath } from "../../../plugin/sync/conflicts.ts";

// #590: a rename to a name another device created at the same time, and two
// independent creates of one name, must never drop a side: the bytes on disk are
// an edit even when the local state row knows nothing about them yet.

const A_BODY = "head\nedit-by-A\nbody\n";
const B_BODY = "head\nedit-by-B\nbody\n";

/** Write a file straight to disk, bypassing vault events: no commit op exists. */
function writeUntracked(plugin: TestPlugin, path: string, body: string): void {
  plugin.fakeVault.files.set(path, new TextEncoder().encode(body));
  plugin.fakeVault.mtimes.set(path, Date.now() + 1_000);
}

/** Reconnect and drain the replay stream WITHOUT starting the reconciler, so the
 * server's head lands in a vault that already holds the untracked local file,
 * the race this bug is, in the order that loses bytes. */
async function replayOnly(plugin: TestPlugin): Promise<void> {
  const live = new Promise<void>((resolve) =>
    plugin.transport!.addEventListener("live", () => resolve())
  );
  plugin.transport!.start(
    plugin.pluginSettings.serverUrl,
    plugin.pluginSettings.vaultId,
    plugin.pluginSettings.deviceId,
    plugin.pluginSettings.deviceToken,
    plugin.state!.getSyncCursor(),
    plugin.manifest.version,
  );
  await live;
  await plugin.syncManager!.flushReplayBuffer();
}

function text(plugin: TestPlugin): string {
  const decoder = new TextDecoder();
  return [...plugin.fakeVault.files.values()].map((data) => decoder.decode(data)).join("\n");
}

function read(plugin: TestPlugin, path: string): string {
  const data = plugin.fakeVault.files.get(path);
  return data ? new TextDecoder().decode(data) : "";
}

function conflictFiles(plugin: TestPlugin): string[] {
  return [...plugin.fakeVault.files.keys()].filter(isConflictPath);
}

function mapsEqual(a: TestPlugin, b: TestPlugin): boolean {
  const decoder = new TextDecoder();
  const describe = (plugin: TestPlugin) =>
    [...plugin.fakeVault.files.entries()]
      .map(([path, data]) => `${path}\u0000${decoder.decode(data)}`)
      .sort()
      .join("\u0001");
  return describe(a) === describe(b);
}

/** Push both devices until their vaults are byte-identical. */
async function settle(a: TestPlugin, b: TestPlugin): Promise<void> {
  for (let round = 0; round < 20; round++) {
    await a.pushNow();
    await b.pushNow();
    if (mapsEqual(a, b)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("devices did not converge");
}

function assertBothSidesKept(a: TestPlugin, b: TestPlugin, tokenA: string, tokenB: string): void {
  for (const [label, plugin] of [["A", a], ["B", b]] as const) {
    const all = text(plugin);
    assert(all.includes(tokenA), `${label} lost the first side's content`);
    assert(all.includes(tokenB), `${label} lost the second side's content`);
  }
}

Deno.test({
  name: "create-vs-rename - the rename's new name lands first, the peer's create is kept",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      A.fakeVault.write("n2.md", "rename-me\n");
      await A.flushPending();
      await B.waitForVersion("n2.md");

      B.disconnect();
      A.fakeVault.rename("n2.md", "n1.md");
      await A.flushPending();
      writeUntracked(B, "n1.md", B_BODY);

      await replayOnly(B);
      await settle(A, B);

      assertBothSidesKept(A, B, "rename-me", "edit-by-B");
      assertEquals(read(A, "n1.md"), "rename-me\n", "the rename owns the name");
      assert(conflictFiles(B).length > 0, "B's create is kept as a conflict file");
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "create-vs-rename - the peer's create lands first, the renamed file is kept",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      A.fakeVault.write("n2.md", "rename-me\n");
      await A.flushPending();
      await B.waitForVersion("n2.md");

      A.disconnect();
      B.fakeVault.write("n1.md", B_BODY);
      await B.flushPending();
      A.fakeVault.rename("n2.md", "n1.md");

      await replayOnly(A);
      await settle(A, B);

      assertBothSidesKept(A, B, "rename-me", "edit-by-B");
      assertEquals(read(B, "n1.md"), B_BODY, "the create owns the name");
      assert(conflictFiles(A).length > 0, "A's renamed bytes are kept as a conflict file");
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "create-vs-create - the peer's head never overwrites a local create of the same name",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      B.disconnect();
      A.fakeVault.write("n1.md", A_BODY);
      await A.flushPending();
      writeUntracked(B, "n1.md", B_BODY);

      await replayOnly(B);
      await settle(A, B);

      assertBothSidesKept(A, B, "edit-by-A", "edit-by-B");
      assertEquals(read(B, "n1.md"), A_BODY);
      assert(conflictFiles(B).length > 0, "B's create is kept as a conflict file");
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "create-vs-create - identical content is a clean apply, not a conflict",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      B.disconnect();
      A.fakeVault.write("n1.md", A_BODY);
      await A.flushPending();
      writeUntracked(B, "n1.md", A_BODY);

      await replayOnly(B);
      await B.waitForIdle();

      assertEquals(conflictFiles(B), []);
      assertEquals(read(B, "n1.md"), A_BODY);
      assertEquals(B.state.getLocalFile("n1.md")!.last_seen_version, 1);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "create-vs-create - a binary create is never overwritten by the peer's head",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      B.disconnect();
      A.fakeVault.write("img.png", "PNG-SERVER-BYTES");
      await A.flushPending();
      writeUntracked(B, "img.png", "PNG-LOCAL-BYTES");

      await replayOnly(B);
      await settle(A, B);

      assertBothSidesKept(A, B, "PNG-SERVER-BYTES", "PNG-LOCAL-BYTES");
      assertEquals(read(B, "img.png"), "PNG-SERVER-BYTES", "the server copy is canonical");
      assert(conflictFiles(B).length > 0, "B's binary is kept as a conflict sibling");
    } finally {
      await stop();
    }
  },
});
