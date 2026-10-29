import { assertEquals } from "@std/assert";
import { pair, waitFor } from "../../two-vault-driver.ts";

/**
 * Issue #283: a mid-flush apply failure must not abort the rest of the flush.
 *
 * Before coalescing, each replayed version applied in its own queue task, so one
 * transient failure (e.g. a blob fetch) never blocked the other paths. After
 * coalescing the winners applied in a single awaited loop; without hardening, a
 * throw from one winner aborted the loop and skipped every later winner.
 *
 * Here f1.md's winner fails its blob fetch (first getBlob throws) while f2.md's
 * winner must still apply and land on disk.
 */
Deno.test({
  name: "replay-coalesce-midflush - one winner failure does not abort later winners",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      A.fakeVault.write("f1.md", "f1 base");
      A.fakeVault.write("f2.md", "f2 base");
      await A.flushPending();
      await B.waitForVersion("f1.md");
      await B.waitForVersion("f2.md");

      B.disconnect();

      // A commits one edit to each path while B is offline. f1 commits first, so
      // it is the first winner in the replay flush and the first getBlob caller.
      A.fakeVault.write("f1.md", "edit a");
      await A.flushPending();
      A.fakeVault.write("f2.md", "edit b");
      await A.flushPending();

      // Make the FIRST blob fetch throw (f1's reassemble); subsequent ones work.
      let calls = 0;
      const origGetBlob = B.transport.getBlob.bind(B.transport);
      B.transport.getBlob = (hash: string) => {
        calls++;
        if (calls === 1) throw new Error("transient blob fetch failure");
        return origGetBlob(hash);
      };

      await B.reconnect();
      // f2 must apply despite f1's mid-flush failure (poll until it lands).
      await waitFor(() => {
        const d = B.fakeVault.files.get("f2.md");
        return !!d && new TextDecoder().decode(d) === "edit b";
      }, "f2.md to apply after mid-flush failure");

      // f2 must still apply despite f1's failure mid-flush.
      assertEquals(
        new TextDecoder().decode(await B.fakeVault.readBinary("f2.md")),
        "edit b",
        "later winner f2.md must apply even though f1.md failed mid-flush",
      );
      // f1's winner failed, so its disk content is left behind (not advanced).
      assertEquals(
        new TextDecoder().decode(await B.fakeVault.readBinary("f1.md")),
        "f1 base",
        "failed winner f1.md must not be applied on this flush",
      );
    } finally {
      await stop();
    }
  },
});
