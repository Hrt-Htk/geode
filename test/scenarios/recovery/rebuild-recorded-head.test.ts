import { assertEquals } from "@std/assert";
import { blake3Hex, hashPathHex } from "../../../core/hash.ts";
import { normalizeForHash } from "../../../core/normalize.ts";
import { openSessionStateDB } from "../../helpers/state.ts";
import { type InFlightWrite } from "../../../plugin/plumbing/state.ts";
import { rebuildFromScratch } from "../../../plugin/sync/recovery.ts";
import { pair, restartPlugin } from "../../two-vault-driver.ts";

// #59: a resync rebuild applies every head. A head whose path a killed session left recorded
// must NOT be parked there: the rebuild then counts it as applied and jumps the cursor past
// the very version it skipped. The rebuild resolves the record first.

const PATH = "recorded.md";
const BODY = `# recorded\n${"line\n".repeat(40)}`;
const FRAGMENT = "# rec";

const identity = (path: string, content: string) =>
  blake3Hex(normalizeForHash(path, new TextEncoder().encode(content)));

Deno.test({
  name: "rebuild - a recorded head is applied, not skipped by the cursor jump",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const p = await pair();
    let B = p.B;
    try {
      p.A.fakeVault.write(PATH, BODY);
      await p.A.flushPending();
      await B.waitForVersion(PATH, 1);

      // The kill: a torn file, no row, a record for it, and a rebuild to run.
      const entry: InFlightWrite = {
        path: PATH,
        path_hash: hashPathHex(B.keys!.mac_key, PATH),
        expected_plaintext_hash: identity(PATH, BODY),
        expected_size: BODY.length,
      };
      B.fakeVault.files.set(PATH, new TextEncoder().encode(FRAGMENT));
      B.stop();
      const rowsFile = B.pluginDataPath("local-files.json");
      B = await restartPlugin(B, p.server, {
        prepare: (fresh) => {
          fresh.fakeVault.pluginData.delete(rowsFile);
        },
      });
      const state = openSessionStateDB(null, 0, null, [entry]);
      const transport = B.transport!;
      const vaultId = B.pluginSettings.vaultId;
      try {
        const stats = await rebuildFromScratch({
          vault: B.fakeVault as never,
          transport,
          state,
          keys: B.keys!,
          vaultId,
          isSyncable: () => true,
        });
        assertEquals(stats.appliedFiles, 1, "the head is applied");
        assertEquals(
          new TextDecoder().decode(B.fakeVault.files.get(PATH)),
          BODY,
          "the recorded head landed on disk",
        );
        assertEquals(state.getInterruptedWrites(), [], "the record is resolved");
      } finally {
        state.close();
      }
    } finally {
      try {
        B.stop();
      } catch { /* teardown is best-effort */ }
      await p.stop();
    }
  },
});
