import { assert } from "@std/assert";
import { SyncManager } from "../../../plugin/sync/sync-manager.ts";
import { ReplayPipeline } from "../../../plugin/sync/replay.ts";
import { FakeVault } from "../../two-vault-driver.ts";
import { DEFAULT_SETTINGS } from "../../../plugin/plumbing/settings-types.ts";

Deno.test("sync-manager-versioncache - versionCache stays bounded", async () => {
  const transport = { getState: () => "syncing", addEventListener: () => {} } as never;
  const vault = new FakeVault();
  const settings = { ...DEFAULT_SETTINGS };
  const sm = new SyncManager(transport, {
    vault: vault as never,
    settings: settings as never,
    configDir: ".obsidian",
    reconnect: () => Promise.resolve(),
  });

  const max = (ReplayPipeline as unknown as { VERSION_CACHE_MAX: number }).VERSION_CACHE_MAX;
  // Drive far more versions than the cap; syncing state buffers (never applies)
  // but still populates the cache.
  for (let i = 0; i < max * 3; i++) {
    await sm.handleVersion({
      type: "server_version",
      vault_id: "v",
      seq: i,
      path_hash: `h${i}`,
      parent_version: null,
      enc_metadata: "",
      chunk_hashes: [],
      deleted: false,
      device_id: "d",
      version: i,
    });
  }

  const cache =
    (sm as unknown as { replay: { versionCache: Map<string, unknown> } }).replay.versionCache;
  assert(cache.size <= max, `versionCache size ${cache.size} must stay <= ${max}`);
});
