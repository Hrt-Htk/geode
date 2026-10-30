import { assert, assertEquals } from "@std/assert";
import { hashPathHex } from "../../../core/hash.ts";
import { pair, type PairedVaults, waitFor } from "../../two-vault-driver.ts";
import {
  ALL_CONFIG_CATEGORIES,
  configCategoryScopePrefixes,
} from "../../../plugin/plumbing/settings-types.ts";
import { catchUpOrDefer } from "../../../plugin/plumbing/scope-pending.ts";

// #454: per-category config sync scope, two-vault semantics:
//  - a category off on B means A's config changes there don't reach B, and
//    nothing is deleted (local, server, other devices)
//  - switching a category back on catches up to the server heads (reuses #342)
//  - graph.json never syncs even with every category on

let p: PairedVaults;

Deno.test({
  name:
    "config categories - B turns Hotkeys + snippets off: A edits, B unaffected, re-enable converges",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    p = await pair();
    const { A, B, server } = p;
    try {
      A.pluginSettings.syncObsidianConfig = true;
      B.pluginSettings.syncObsidianConfig = true;

      // Seed: hotkeys.json + a snippet converge on both devices.
      A.fakeVault.write(".obsidian/hotkeys.json", '{"seed":1}');
      A.fakeVault.write(".obsidian/snippets/base.css", "body{}");
      await A.flushPending();
      await B.waitForVersion(".obsidian/hotkeys.json");
      await B.waitForVersion(".obsidian/snippets/base.css");
      assertEquals(content(B, ".obsidian/hotkeys.json"), '{"seed":1}');
      assertEquals(content(B, ".obsidian/snippets/base.css"), "body{}");

      // B switches Hotkeys and CSS snippets off.
      B.pluginSettings.configCategories = B.pluginSettings.configCategories.filter(
        (c) => c !== "hotkeys" && c !== "snippets",
      );

      // A changes hotkeys.json and a snippet while B is out of scope.
      A.fakeVault.write(".obsidian/hotkeys.json", '{"seed":2}');
      A.fakeVault.write(".obsidian/snippets/base.css", "body{color:red}");
      await A.flushPending();
      await B.waitForCaughtUp(await serverSeq(server, A.keys, ".obsidian/hotkeys.json"));

      // B's disk is untouched; the server holds A's v2 heads.
      assertEquals(content(B, ".obsidian/hotkeys.json"), '{"seed":1}');
      assertEquals(content(B, ".obsidian/snippets/base.css"), "body{}");
      assertEquals(serverHead(server, A.keys, ".obsidian/hotkeys.json")?.version, 2);

      // B switches the categories back on: catch-up brings A's edits.
      B.pluginSettings.configCategories = [...ALL_CONFIG_CATEGORIES];
      await catchUpOrDefer(
        sinkFor(B),
        configCategoryScopePrefixes("hotkeys", ".obsidian"),
        () => {},
      );
      await catchUpOrDefer(
        sinkFor(B),
        configCategoryScopePrefixes("snippets", ".obsidian"),
        () => {},
      );
      await B.waitForVersion(".obsidian/hotkeys.json", 2);
      await B.waitForVersion(".obsidian/snippets/base.css", 2);
      assertEquals(content(B, ".obsidian/hotkeys.json"), '{"seed":2}');
      assertEquals(content(B, ".obsidian/snippets/base.css"), "body{color:red}");
    } finally {
      await p.stop();
    }
  },
});

Deno.test({
  name: "config categories - local delete while off never propagates; re-enable restores",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    p = await pair();
    const { A, B, server } = p;
    try {
      A.pluginSettings.syncObsidianConfig = true;
      B.pluginSettings.syncObsidianConfig = true;

      A.fakeVault.write(".obsidian/hotkeys.json", '{"seed":1}');
      await A.flushPending();
      await B.waitForVersion(".obsidian/hotkeys.json");

      // B turns Hotkeys off and deletes its local copy.
      B.pluginSettings.configCategories = B.pluginSettings.configCategories.filter((c) =>
        c !== "hotkeys"
      );
      B.fakeVault.delete(".obsidian/hotkeys.json");
      await B.reconcileNow();
      await A.waitForIdle();

      // Nothing propagated: A keeps the file, the server head is untouched.
      assert(A.fakeVault.fileExists(".obsidian/hotkeys.json"));
      assertEquals(serverHead(server, A.keys, ".obsidian/hotkeys.json")?.deleted, false);

      // Re-enable: the file is restored from the server head.
      B.pluginSettings.configCategories = [...ALL_CONFIG_CATEGORIES];
      await catchUpOrDefer(
        sinkFor(B),
        configCategoryScopePrefixes("hotkeys", ".obsidian"),
        () => {},
      );
      await B.waitForVersion(".obsidian/hotkeys.json");
      assertEquals(content(B, ".obsidian/hotkeys.json"), '{"seed":1}');
    } finally {
      await p.stop();
    }
  },
});

Deno.test({
  name: "config categories - a new core config created while off catches up on re-enable",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    p = await pair();
    const { A, B, server } = p;
    try {
      A.pluginSettings.syncObsidianConfig = true;
      B.pluginSettings.syncObsidianConfig = true;

      // B turns Core plugin settings off before A creates daily-notes.json.
      B.pluginSettings.configCategories = B.pluginSettings.configCategories.filter((c) =>
        c !== "corePlugins"
      );
      A.fakeVault.write(".obsidian/daily-notes.json", '{"folder":"Daily"}');
      await A.flushPending();
      await B.waitForCaughtUp(await serverSeq(server, A.keys, ".obsidian/daily-notes.json"));

      // B never saw the file; the server holds it.
      assert(!B.fakeVault.fileExists(".obsidian/daily-notes.json"));
      assertEquals(serverHead(server, A.keys, ".obsidian/daily-notes.json")?.version, 1);

      // Re-enable: the static core-plugin prefix list covers daily-notes.json.
      B.pluginSettings.configCategories = [...ALL_CONFIG_CATEGORIES];
      await catchUpOrDefer(
        sinkFor(B),
        configCategoryScopePrefixes("corePlugins", ".obsidian"),
        () => {},
      );
      await B.waitForVersion(".obsidian/daily-notes.json");
      assertEquals(content(B, ".obsidian/daily-notes.json"), '{"folder":"Daily"}');
    } finally {
      await p.stop();
    }
  },
});

Deno.test({
  name:
    "config categories - an unknown root file created while Other is off catches up on re-enable",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    p = await pair();
    const { A, B, server } = p;
    try {
      A.pluginSettings.syncObsidianConfig = true;
      B.pluginSettings.syncObsidianConfig = true;

      // B turns Other settings off before A creates an unknown config-root file.
      B.pluginSettings.configCategories = B.pluginSettings.configCategories.filter((c) =>
        c !== "other"
      );
      A.fakeVault.write(".obsidian/someplugin-token.json", '{"token":"abc"}');
      await A.flushPending();
      await B.waitForCaughtUp(await serverSeq(server, A.keys, ".obsidian/someplugin-token.json"));

      // B never saw the file; the server holds it.
      assert(!B.fakeVault.fileExists(".obsidian/someplugin-token.json"));
      assertEquals(serverHead(server, A.keys, ".obsidian/someplugin-token.json")?.version, 1);

      // Re-enable: the classifier-matched `other` scope covers the unknown file,
      // not just app.json (the pre-fix prefix list missed it).
      B.pluginSettings.configCategories = [...ALL_CONFIG_CATEGORIES];
      await catchUpOrDefer(
        sinkFor(B),
        configCategoryScopePrefixes("other", ".obsidian"),
        () => {},
      );
      await B.waitForVersion(".obsidian/someplugin-token.json");
      assertEquals(content(B, ".obsidian/someplugin-token.json"), '{"token":"abc"}');
    } finally {
      await p.stop();
    }
  },
});

Deno.test({
  name: "config categories - graph.json never syncs even with every category on",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    p = await pair();
    const { A, B, server } = p;
    try {
      A.pluginSettings.syncObsidianConfig = true;
      B.pluginSettings.syncObsidianConfig = true;

      A.fakeVault.write(".obsidian/graph.json", '{"never":1}');
      await A.flushPending();
      await B.waitForIdle();

      // A's own graph.json is out of scope: no server version, never on B.
      assert(A.fakeVault.fileExists(".obsidian/graph.json"));
      assert(!B.fakeVault.fileExists(".obsidian/graph.json"));
      const ph = hashPathHex(A.keys.mac_key, ".obsidian/graph.json");
      const row = server.db
        .prepare("SELECT seq FROM file_versions WHERE vault_id = ? AND path_hash = ?")
        .get(p.vaultId, ph) as { seq: number } | undefined;
      assertEquals(row, undefined, "graph.json must never be uploaded");
    } finally {
      await p.stop();
    }
  },
});

function content(vault: PairedVaults["A"], path: string): string | undefined {
  const bytes = vault.fakeVault.files.get(path);
  return bytes ? new TextDecoder().decode(bytes) : undefined;
}

/** Build a coordinator sink backed by a real test plugin. */
function sinkFor(plugin: PairedVaults["A"]): Parameters<typeof catchUpOrDefer>[0] {
  return {
    settings: plugin.pluginSettings,
    saveSettings: async () => {},
    catchUpFolders: (folders) => plugin.syncManager.catchUpFolders(folders),
  };
}

/** Poll the server DB until the path has a version; return its latest seq. */
async function serverSeq(
  server: PairedVaults["server"],
  keys: typeof p.A.keys,
  path: string,
): Promise<number> {
  const ph = hashPathHex(keys.mac_key, path);
  let seq = 0;
  await waitFor(
    () => {
      const row = server.db
        .prepare(
          "SELECT seq FROM file_versions WHERE vault_id = ? AND path_hash = ? ORDER BY seq DESC LIMIT 1",
        )
        .get(p.vaultId, ph) as { seq: number } | undefined;
      seq = row?.seq ?? 0;
      return seq > 0;
    },
    `server version for ${path}`,
    15_000,
  );
  return seq;
}

/** Current server head (max version) for a path. */
function serverHead(
  server: PairedVaults["server"],
  keys: typeof p.A.keys,
  path: string,
): { version: number; deleted: boolean } | null {
  const ph = hashPathHex(keys.mac_key, path);
  const row = server.db
    .prepare(
      "SELECT version, deleted FROM file_versions WHERE vault_id = ? AND path_hash = ? ORDER BY version DESC LIMIT 1",
    )
    .get(p.vaultId, ph) as { version: number; deleted: number } | undefined;
  if (!row) return null;
  return { version: row.version, deleted: !!row.deleted };
}
