import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert";
import {
  pair,
  type TestPlugin,
  type TestServer,
  versionCount,
  waitFor,
} from "../../two-vault-driver.ts";
import { b64encode } from "../../../core/protocol.ts";
import { hashPathHex } from "../../../core/hash.ts";
import { setTransportHttp, type TransportHttpFn } from "../../../plugin/sync/http-client.ts";
import { withVaultIdentity } from "../../../plugin/plumbing/settings-types.ts";
import { toArrayBuffer } from "../../../plugin/plumbing/bytes.ts";

// #701: a rejoin over an old copy. The device joins again with its old state still in
// place (a new device token, the months old folder untouched), the server has since
// deleted, edited and moved notes. Rules under test, per path:
//
//   untouched since the last sync  → the server version, deletes and moves included
//   changed since the last sync    → the normal commit/merge/conflict path
//   doubtful (no row, closed row)  → the bytes are copied out of the vault, the server
//                                    wins, and nothing is uploaded over a delete
//
// The second variant is the reported device: local-files.json is gone while the cursor
// survived (test/unit/plugin/state-persistence.test.ts pins that split), so every file
// on disk looks like an untracked local edit to today's rules.

const KEEP = 30;
const GONE = 10;
const MOVED = 5;
const TEMPLATES = 2;
const EDIT = "keep/edited.md";

const KEEP_BODY_BEFORE = (i: number) => `keep ${i} summer\n`;
const KEEP_BODY_AFTER = (i: number) => `keep ${i} winter\n`;
// The offline edit and the server edit sit in different regions, so the merge is clean
// when the row survives (variant one) and the backup is the only home when it does not.
const EDIT_BEFORE = "first line\nsecond line\n";
const EDIT_AFTER = "first line\nsecond line\nserver line\n";
const EDIT_OFFLINE = "first line offline\nsecond line\n";
const MOVED_BODY_AFTER = (i: number) => `moved ${i} winter\n`;

const keepPath = (i: number) => `keep/n${i}.md`;
const gonePath = (i: number) => `gone/n${i}.md`;
const movedOldPath = (i: number) => `moved/old${i}.md`;
const movedNewPath = (i: number) => `moved/new${i}.md`;
const templatePath = (i: number) => `templates/t${i}.md`;

const BACKUP_PREFIX = "Geode backup/";

function text(files: Map<string, Uint8Array>, path: string): string {
  const data = files.get(path);
  return data ? new TextDecoder().decode(data) : "";
}

function maxSeq(server: TestServer, vaultId: string): number {
  const row = server.db
    .prepare("SELECT MAX(seq) AS s FROM file_versions WHERE vault_id = ?")
    .get(vaultId) as { s: number | null };
  return row.s ?? 0;
}

function headOf(server: TestServer, vaultId: string, pathHash: string) {
  // The server binds path_hash as the hex string the client sent; older rows may hold a
  // blob, so both spellings are accepted.
  return server.db
    .prepare(
      "SELECT version, deleted FROM file_versions WHERE vault_id = ? " +
        "AND (path_hash = ? OR lower(hex(path_hash)) = ?) ORDER BY version DESC LIMIT 1",
    )
    .get(vaultId, pathHash.toLowerCase(), pathHash.toLowerCase()) as
      | { version: number; deleted: number }
      | null;
}

function authoredBy(server: TestServer, vaultId: string, deviceId: string): number {
  const row = server.db
    .prepare("SELECT COUNT(*) AS n FROM file_versions WHERE vault_id = ? AND device_id = ?")
    .get(vaultId, deviceId) as { n: number };
  return row.n;
}

function newToken(): string {
  return b64encode(crypto.getRandomValues(new Uint8Array(32)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/** The seed: what both devices hold before the device goes offline for months. */
async function seedVault(A: TestPlugin) {
  for (let i = 0; i < KEEP; i++) A.fakeVault.write(keepPath(i), KEEP_BODY_BEFORE(i));
  A.fakeVault.write(EDIT, EDIT_BEFORE);
  for (let i = 0; i < GONE; i++) A.fakeVault.write(gonePath(i), `gone ${i}\n`);
  for (let i = 0; i < MOVED; i++) A.fakeVault.write(movedOldPath(i), `moved ${i}\n`);
  for (let i = 0; i < TEMPLATES; i++) A.fakeVault.write(templatePath(i), `template ${i}\n`);
  await A.pushNow();
}

/** A pause on the frozen device, then a fresh device identity: what a join does
 * (plugin/sync/join-admin.ts): a new device row and token, the old folder and old state
 * untouched. Returns the new device id so the assertions can count its uploads. */
function rejoinDevice(B: TestPlugin, server: TestServer, vaultId: string): string {
  B.stop();
  const deviceId = crypto.randomUUID();
  const token = newToken();
  server.db.run(
    "INSERT INTO devices(id, vault_id, name, token) VALUES(?,?,?,?)",
    deviceId,
    vaultId,
    "device-B-rejoin",
    token,
  );
  // The wizard's join writes the identity through `withVaultIdentity` (flows.ts), then runs
  // the rebuild, so the marker is already dropped when the rebuild starts.
  B.settings = withVaultIdentity(B.settings, { vaultId, deviceId, deviceToken: token });
  return deviceId;
}

/** What the other devices did while this one was offline: edits, deletes and a move the
 * server records as delete plus create (the pre rename marker shape from the issue). */
async function changeVaultOnA(A: TestPlugin) {
  for (let i = 0; i < KEEP; i++) A.fakeVault.write(keepPath(i), KEEP_BODY_AFTER(i));
  A.fakeVault.write(EDIT, EDIT_AFTER);
  for (let i = 0; i < GONE; i++) await A.fakeVault.delete(gonePath(i));
  for (let i = 0; i < MOVED; i++) {
    await A.fakeVault.delete(movedOldPath(i));
    A.fakeVault.write(movedNewPath(i), MOVED_BODY_AFTER(i));
  }
  for (let i = 0; i < TEMPLATES; i++) await A.fakeVault.delete(templatePath(i));
  await A.pushNow();
  // A second pass settles whatever the first one queued after its scan.
  await A.pushNow();
  return A.transport!.getLastSeenSeq();
}

/** Everything the rejoin had to learn from the server, whatever the variant. */
function assertServerWon(B: TestPlugin) {
  for (let i = 0; i < KEEP; i++) {
    const path = keepPath(i);
    if (path === EDIT) continue;
    assertEquals(text(B.fakeVault.files, path), KEEP_BODY_AFTER(i), `${path} kept the stale copy`);
  }
  for (let i = 0; i < MOVED; i++) {
    assertEquals(
      text(B.fakeVault.files, movedNewPath(i)),
      MOVED_BODY_AFTER(i),
      `${movedNewPath(i)} did not arrive`,
    );
  }
  for (let i = 0; i < GONE; i++) {
    assertFalse(B.fakeVault.fileExists(gonePath(i)), `${gonePath(i)} was resurrected`);
  }
  for (let i = 0; i < MOVED; i++) {
    assertFalse(B.fakeVault.fileExists(movedOldPath(i)), `${movedOldPath(i)} was resurrected`);
  }
  for (let i = 0; i < TEMPLATES; i++) {
    assertFalse(B.fakeVault.fileExists(templatePath(i)), `${templatePath(i)} was resurrected`);
  }
  for (const path of B.fakeVault.files.keys()) {
    assertFalse(/conflict/i.test(path), `conflict copy created: ${path}`);
  }
}

/** The server's own history is unchanged: no delete was overwritten by an upload. */
function assertNoResurrection(server: TestServer, vaultId: string, B: TestPlugin) {
  for (let i = 0; i < GONE; i++) {
    assertDeleteStands(server, vaultId, B, gonePath(i));
  }
  for (let i = 0; i < MOVED; i++) {
    assertDeleteStands(server, vaultId, B, movedOldPath(i));
  }
  for (let i = 0; i < TEMPLATES; i++) {
    assertDeleteStands(server, vaultId, B, templatePath(i));
  }
}

function assertDeleteStands(
  server: TestServer,
  vaultId: string,
  B: TestPlugin,
  path: string,
) {
  const head = headOf(server, vaultId, hashPathHex(B.keys!.mac_key, path));
  assert(head !== null, `${path} has no version at all`);
  assertEquals(head!.deleted, 1, `${path} was uploaded over its delete`);
}

Deno.test({
  name:
    "rejoin-over-stale-copy - rows intact: the server wins and the offline edit merges (merge compatibility guard)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      await seedVault(A);
      await B.waitForCaughtUp(maxSeq(server, vaultId));
      const before = maxSeq(server, vaultId);

      const deviceId = rejoinDevice(B, server, vaultId);
      // A genuine offline edit: content that matches no version the server holds.
      B.fakeVault.write(EDIT, EDIT_OFFLINE);
      const target = await changeVaultOnA(A);
      assert(target > before, "the server head did not move");

      const stats = await B.rejoinOverOldCopy();
      await B.waitForCaughtUp(target);
      assertEquals(stats.backup?.count ?? 0, 0, "a trusted row never goes to the backup folder");

      // The offline edit merges instead of being overwritten or backed up.
      for (let round = 0; round < 20; round++) {
        await A.pushNow();
        await B.pushNow();
        const merged = text(B.fakeVault.files, EDIT);
        const onA = text(A.fakeVault.files, EDIT);
        if (merged.includes("server line") && merged.includes("offline") && onA === merged) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert(text(B.fakeVault.files, EDIT).includes("server line"), "the server line was lost");
      assert(text(B.fakeVault.files, EDIT).includes("offline"), "the offline edit was lost");
      await A.waitForConvergence(B, EDIT);
      assertEquals(text(A.fakeVault.files, EDIT), text(B.fakeVault.files, EDIT));

      assertServerWon(B);
      assertNoResurrection(server, vaultId, B);
      assert(authoredBy(server, vaultId, deviceId) >= 1, "the merged edit was never uploaded");
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rejoin-over-stale-copy - cursor without rows: doubtful bytes are backed up, not uploaded",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      await seedVault(A);
      await B.waitForCaughtUp(maxSeq(server, vaultId));

      const deviceId = rejoinDevice(B, server, vaultId);
      // The reported split: the row table is gone, the cursor survived.
      B.fakeVault.pluginData.delete(".obsidian/plugins/geode/local-files.json");
      B.fakeVault.write(EDIT, EDIT_OFFLINE);
      const target = await changeVaultOnA(A);

      const stats = await B.rejoinOverOldCopy();
      await B.waitForCaughtUp(target);

      // Only the bytes the server cannot vouch for left the vault.
      assertEquals(stats.backup?.count, 1, "the backup holds exactly the doubtful path");
      const folder = stats.backup!.folder;
      assert(folder.startsWith(BACKUP_PREFIX), `backup folder ${folder}`);
      assertEquals(text(B.fakeVault.files, `${folder}/${EDIT}`), EDIT_OFFLINE);
      assertEquals(text(B.fakeVault.files, EDIT), EDIT_AFTER, "the server version did not land");

      assertServerWon(B);
      assertNoResurrection(server, vaultId, B);
      assertEquals(authoredBy(server, vaultId, deviceId), 0, "the rejoin uploaded something");

      // One forced reconcile pass finds nothing: no untracked create is left on disk.
      const settled = versionCount(server, vaultId);
      await B.reconcileNow();
      await B.pushNow();
      assertEquals(versionCount(server, vaultId), settled, "the reconciler uploaded a leftover");
      assertEquals(B.syncManager?.getPendingOps().length ?? 0, 0);
      assertEquals(B.eventHandler?.getPendingOps().length ?? 0, 0);
      await waitFor(
        () => (B.syncManager?.getPendingOps().length ?? 0) === 0,
        "the commit queue to stay drained",
      );
    } finally {
      await stop();
    }
  },
});

/** The real HTTP layer, for a test that intercepts one request. */
const passThroughHttp: TransportHttpFn = async ({ url, method, headers, body }) => {
  const res = await fetch(url, { method, headers, body: body ? toArrayBuffer(body) : undefined });
  return {
    status: res.status,
    ok: res.ok,
    text: () => res.text(),
    arrayBuffer: () => res.arrayBuffer(),
  };
};

/** Fail one blob permanently: getBlob retries a transient status and then throws. */
function failBlob(hash: string): TransportHttpFn {
  return async (request) => {
    if (request.method === "GET" && request.url.includes(hash)) {
      return {
        status: 503,
        ok: false,
        text: () => "Service Unavailable",
        arrayBuffer: () => new ArrayBuffer(0),
      };
    }
    return await passThroughHttp(request);
  };
}

function filesContaining(files: Map<string, Uint8Array>, needle: string): string[] {
  return [...files.entries()]
    .filter(([, data]) => new TextDecoder().decode(data).includes(needle))
    .map(([path]) => path);
}

Deno.test({
  name: "rejoin-over-stale-copy - a failed rejoin pauses sync instead of re-arming the stale state",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("keep/a.md", "alpha\n");
      A.fakeVault.write("keep/b.md", "beta\n");
      A.fakeVault.write("keep/c.md", "gamma\n");
      await A.pushNow();
      await B.waitForCaughtUp(maxSeq(server, vaultId));

      // The chunk the rejoin's rebuild cannot fetch: one failed head is enough.
      const hashes: string[] = [];
      for await (const head of A.transport!.getHeads(0)) {
        if (!head.deleted) hashes.push(...head.chunk_hashes);
      }
      const deviceId = rejoinDevice(B, server, vaultId);
      B.fakeVault.pluginData.delete(".obsidian/plugins/geode/local-files.json");
      await A.pushNow();
      const versionsBefore = versionCount(server, vaultId);

      setTransportHttp(failBlob(hashes[0]));
      try {
        await assertRejects(() => B.rejoinOverOldCopy(), Error);
      } finally {
        setTransportHttp(passThroughHttp);
      }

      // The settings already carry the new device: only a persisted stop keeps the next
      // session from replaying the months old rows over the server.
      assert(B.settings.pauseAt > 0, "a failed rejoin must leave sync paused");
      assert(B.settings.rejoinIncomplete, "and mark the rejoin incomplete");

      // The next session start finishes the rejoin instead of replaying those rows.
      await B.restartUnlockedSession();
      assertEquals(B.isLive(), true, "the next session start finishes the rejoin");
      await B.reconcileNow();
      await new Promise((resolve) => setTimeout(resolve, 500));
      assertEquals(
        versionCount(server, vaultId),
        versionsBefore,
        "the stale state was replayed to the server",
      );
      assertEquals(authoredBy(server, vaultId, deviceId), 0, "the stale state was uploaded");
    } finally {
      setTransportHttp(passThroughHttp);
      await stop();
    }
  },
});

/** A rejoin whose rebuild fails, leaving the plugin paused. `allBlobs` fails every chunk
 * so nothing at all is applied before the failure. */
async function failedRejoin(
  p: {
    A: TestPlugin;
    B: TestPlugin;
    server: TestServer;
    vaultId: string;
    stop: () => Promise<void>;
  },
  opts: { allBlobs?: boolean } = {},
): Promise<string> {
  const { A, B, server, vaultId } = p;
  A.fakeVault.write("gone.md", "doomed\n");
  A.fakeVault.write("keep.md", "keep\n");
  await A.pushNow();
  await B.waitForCaughtUp(maxSeq(server, vaultId));
  const deviceId = rejoinDevice(B, server, vaultId);
  B.fakeVault.pluginData.delete(".obsidian/plugins/geode/local-files.json");
  B.fakeVault.write("offline.md", "written while offline\n");
  await A.fakeVault.delete("gone.md");
  await A.pushNow();
  await A.pushNow();
  const hashes: string[] = [];
  for await (const head of A.transport!.getHeads(0)) {
    if (!head.deleted) hashes.push(...head.chunk_hashes);
  }
  setTransportHttp(failBlob(opts.allBlobs ? "/blobs/" : hashes[0]));
  try {
    await assertRejects(() => B.rejoinOverOldCopy(), Error);
  } finally {
    setTransportHttp(passThroughHttp);
  }
  assert(B.settings.pauseAt > 0, "a failed rejoin must leave sync paused");
  return deviceId;
}

Deno.test({
  name: "rejoin-over-stale-copy - joining again after a failure syncs, the pause is lifted",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const p = await pair();
    const { B, server, vaultId, stop } = p;
    try {
      await failedRejoin(p);
      assertEquals(B.isPaused(), true);

      // The user does what the notice says: join again. That rewrites the identity first
      // (as the wizard's flow does) and only then rebuilds. A paused session never goes
      // live, so this is bounded rather than awaited straight.
      const secondDevice = rejoinDevice(B, server, vaultId);
      assertEquals(B.settings.rejoinIncomplete, false, "the identity write drops the marker");
      const second = await Promise.race([
        B.rejoinOverOldCopy().then(() => "joined"),
        new Promise((resolve) => setTimeout(() => resolve("never went live"), 20_000)),
      ]);
      assertEquals(second, "joined", "the second join never went live");
      assertEquals(B.settings.pauseAt, 0, "a finished rejoin must lift the pause it set");
      assertEquals(B.isLive(), true, "a finished rejoin must be live");
      assert(
        B.fakeVault.fileExists("Geode backup") === false ||
          [...B.fakeVault.files.keys()].some((k) => k.includes("offline.md")),
        "the doubtful note is in the backup folder",
      );

      // An edit made after the join reaches the server.
      const before = versionCount(server, vaultId);
      B.fakeVault.write("keep.md", "keep edited after the rejoin\n");
      for (let round = 0; round < 20 && versionCount(server, vaultId) === before; round++) {
        await B.pushNow();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert(versionCount(server, vaultId) > before, "a post join edit never reached the server");
      assert(
        authoredBy(server, vaultId, secondDevice) >= 1,
        "the rejoined device uploaded nothing",
      );
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name:
    "rejoin-over-stale-copy - resume after a failure finishes the rejoin, never replays the rows",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const p = await pair();
    const { A, B, server, vaultId, stop } = p;
    try {
      const deviceId = await failedRejoin(p, { allBlobs: true });
      const versionsAfterFail = versionCount(server, vaultId);

      // What the Resume button does: clear the pause and start again. Without the marker
      // routing this never comes back up (the failed rebuild disposed the session).
      B.settings.pauseAt = 0;
      await Promise.race([
        B.resume(),
        new Promise((resolve) => setTimeout(resolve, 20_000)),
      ]);
      assertEquals(B.isLive(), true, "resume must bring sync back");
      for (let round = 0; round < 20; round++) {
        await B.pushNow();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assertEquals(authoredBy(server, vaultId, deviceId), 0, "the stale rows were uploaded");
      assert(A.fakeVault.fileExists("gone.md") === false, "a delete was resurrected on A");
      assertEquals(
        versionCount(server, vaultId),
        versionsAfterFail,
        "the stale state was replayed",
      );
      assertEquals(B.settings.rejoinIncomplete, false, "a finished rejoin clears the marker");
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rejoin-over-stale-copy - a transiently unreadable stale file still respects a delete",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("gone.md", "doomed\n");
      A.fakeVault.write("keep.md", "keep\n");
      await A.pushNow();
      await B.waitForCaughtUp(maxSeq(server, vaultId));
      const deviceId = rejoinDevice(B, server, vaultId);
      B.fakeVault.pluginData.delete(".obsidian/plugins/geode/local-files.json");
      await A.fakeVault.delete("gone.md");
      await A.pushNow();
      await A.pushNow();
      const target = maxSeq(server, vaultId);

      // One transient read failure at prepare time, readable again for the head loop.
      const original = B.fakeVault.readBinary.bind(B.fakeVault);
      let failuresLeft = 1;
      B.fakeVault.readBinary = (path: string) => {
        if (path === "gone.md" && failuresLeft > 0) {
          failuresLeft--;
          return Promise.reject(new Error("EIO"));
        }
        return original(path);
      };

      await B.rejoinOverOldCopy();
      await B.waitForCaughtUp(target);
      for (let round = 0; round < 10; round++) {
        await B.reconcileNow();
        await B.pushNow();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      assertFalse(B.fakeVault.fileExists("gone.md"), "the delete was kept as an edit");
      assertFalse(A.fakeVault.fileExists("gone.md"), "the note came back on A");
      assertEquals(authoredBy(server, vaultId, deviceId), 0, "the stale file was uploaded");
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rejoin-over-stale-copy - a stale marker never rebuilds a join of another vault",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const p = await pair();
    const { B, server, stop } = p;
    try {
      await failedRejoin(p);
      assertEquals(B.settings.rejoinIncomplete, true);
      // The failed attempt itself may have written a partial backup before it died.
      const backupsBefore = [...B.fakeVault.files.keys()].filter((k) =>
        k.startsWith("Geode backup/")
      );

      // The user joins a different vault: a new identity over the same folder, which is
      // what createVaultFlow and the plain join rewrite (flows.ts).
      const otherVault = crypto.randomUUID();
      server.db.run(
        "INSERT INTO vaults(id, name, salt, created_at) VALUES(?,?,?,?)",
        otherVault,
        "other-vault",
        crypto.getRandomValues(new Uint8Array(16)),
        Date.now(),
      );
      const token = b64encode(crypto.getRandomValues(new Uint8Array(16)))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
      const otherDevice = crypto.randomUUID();
      server.db.run(
        "INSERT INTO devices(id, vault_id, name, token) VALUES(?,?,?,?)",
        otherDevice,
        otherVault,
        "device-B-other",
        token,
      );
      B.settings = withVaultIdentity(B.settings, {
        vaultId: otherVault,
        deviceId: otherDevice,
        deviceToken: token,
      });
      await B.restartUnlockedSession();

      assertEquals(B.fakeVault.fileExists("offline.md"), true, "the note was hijacked");
      assertEquals(
        [...B.fakeVault.files.keys()].filter((k) => k.startsWith("Geode backup/")).sort(),
        backupsBefore.sort(),
        "a plain join of another vault must not copy anything out",
      );
      assertEquals(B.settings.rejoinIncomplete, false, "a new identity drops the marker");
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rejoin-over-stale-copy - a rejoin keeps a pause the user set",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("keep/a.md", "alpha\n");
      await A.pushNow();
      await B.waitForCaughtUp(maxSeq(server, vaultId));
      rejoinDevice(B, server, vaultId);
      await A.pushNow();

      // A pause the user set, with no failed rejoin behind it.
      B.settings.pauseAt = Date.now();
      await B.restartUnlockedSession();
      assertEquals(B.isLive(), false, "a paused device does not go live");

      await B.rejoinOverOldCopy();
      assertEquals(B.isLive(), false, "a rejoin must not unpause a device by itself");
      assert(B.settings.pauseAt > 0, "the user pause survives the rejoin");
      assertEquals(B.settings.rejoinIncomplete, false);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rejoin-over-stale-copy - a carried edit survives the parallel head apply",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      // One note, renamed and rewritten on A while B is away: the server's heads are a
      // rename marker for the old name plus a content version at the new one.
      A.fakeVault.write("p.md", "P BODY\n");
      await A.pushNow();
      await B.waitForCaughtUp(maxSeq(server, vaultId));
      const deviceId = rejoinDevice(B, server, vaultId);
      A.fakeVault.rename("p.md", "dest.md");
      A.fakeVault.write("dest.md", `${"x".repeat(200_000)}\nDEST BODY\n`);
      await A.pushNow();
      await A.pushNow();
      const target = maxSeq(server, vaultId);
      // B's genuine offline edit of the old name, which the marker must carry to dest.md.
      B.fakeVault.write("p.md", "P BODY\nB edit\n");

      await B.rejoinOverOldCopy();
      await B.waitForCaughtUp(target);
      for (let round = 0; round < 20; round++) {
        await A.pushNow();
        await B.pushNow();
        if (
          filesContaining(B.fakeVault.files, "B edit").length > 0 &&
          authoredBy(server, vaultId, deviceId) >= 1
        ) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      assert(
        filesContaining(B.fakeVault.files, "B edit").length > 0,
        "the carried edit was overwritten by the parallel head apply",
      );
      assertEquals(
        authoredBy(server, vaultId, deviceId) >= 1,
        true,
        "the carried edit never landed",
      );
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rejoin-over-stale-copy - a file the prepare could not read is kept, never pruned",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("keep/a.md", "alpha\n");
      await A.pushNow();
      await B.waitForCaughtUp(maxSeq(server, vaultId));
      rejoinDevice(B, server, vaultId);
      B.fakeVault.pluginData.delete(".obsidian/plugins/geode/local-files.json");
      B.fakeVault.write("locked.md", "bytes the adapter refused\n");
      await A.pushNow();
      const target = maxSeq(server, vaultId);

      // The adapter cannot read that one path (a permission or IO failure at prepare time).
      const original = B.fakeVault.readBinary.bind(B.fakeVault);
      B.fakeVault.readBinary = (path: string) =>
        path === "locked.md" ? Promise.reject(new Error("EIO")) : original(path);

      await B.rejoinOverOldCopy();
      await B.waitForCaughtUp(target);

      assert(
        B.fakeVault.fileExists("locked.md"),
        "an unreadable file must be kept, never pruned: nothing could be copied out",
      );
    } finally {
      await stop();
    }
  },
});
