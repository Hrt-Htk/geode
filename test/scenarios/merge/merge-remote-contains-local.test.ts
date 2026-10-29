import { assertEquals } from "@std/assert";
import { blake3Hex } from "../../../core/hash.ts";
import { pair } from "../../two-vault-driver.ts";

Deno.test({
  name:
    "merge-remote-contains-local - merged == remote but local differs → write remote, keep state hash in sync",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      const path = "doc.md";

      // Base
      const base = "a\nb\nc\nd";
      A.fakeVault.write(path, base);
      await A.flushPending();
      await B.waitForVersion(path);

      // B disconnects
      B.disconnect();

      // A makes the bigger edit (remote): changes b→B2, c→C2, adds e
      const remote = "a\nB2\nC2\nd\ne";
      A.fakeVault.write(path, remote);
      await A.flushPending();

      // B makes a local edit that is a SUBSET of the remote edit: only b→B2.
      // merge(local, ancestor, remote) == remote (clean), but local !== remote.
      const local = "a\nB2\nc\nd";
      B.fakeVault.write(path, local);
      B.markLocalEdit(path);

      // B reconnects → replays A's version → hasLocalEdits → merge
      await B.reconnect();
      await B.commitDirect(path);

      await sleep(1500);

      // B's disk must converge to the remote/merged text, not stay on stale local
      const bDisk = new TextDecoder().decode(await B.fakeVault.readBinary(path));
      assertEquals(bDisk, remote, "B disk should hold merged (== remote) text");

      // B's state hash must match disk (and the server version), not the stale local hash
      const row = B.state.getLocalFile(path)!;
      assertEquals(
        row.plaintext_hash,
        blake3Hex(new TextEncoder().encode(remote)),
        "B state hash must match the on-disk merged content",
      );

      // A also converges to the same content
      await A.waitForConvergence(B, path);
    } finally {
      await stop();
    }
  },
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
