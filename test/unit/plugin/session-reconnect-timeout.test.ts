import { assert, assertRejects } from "@std/assert";
import { DEFAULT_SETTINGS } from "../../../plugin/plumbing/settings-types.ts";
import { openStateDB } from "../../../plugin/plumbing/state.ts";
import { reconnectAndWaitLive, type SyncSessionHost } from "../../../plugin/session.ts";
import { Transport } from "../../../plugin/sync/transport.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.test({
  name: "session - a decision's reconnect gives up when it never goes live",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const transport = new Transport();
    const state = openStateDB();
    const host = {
      transport,
      state,
      manifest: { version: "0.0.0" },
      pluginSettings: {
        ...DEFAULT_SETTINGS,
        serverUrl: "http://127.0.0.1:1",
        vaultId: "vault",
        deviceId: "device",
        deviceToken: "token",
      },
    } as unknown as SyncSessionHost;

    const started = Date.now();
    await assertRejects(
      () => reconnectAndWaitLive(host, 50),
      Error,
      "needs a connection",
    );
    assert(Date.now() - started < 5_000, "the timeout fired, no live event ever came");

    transport.stop();
    await sleep(100);
    state.close();
  },
});
