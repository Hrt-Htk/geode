import { assertEquals, assertRejects } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";
import { reconstructVersion } from "../../../plugin/sync/history-fetch.ts";

// #463: a past version must reconstruct from the server exactly as `apply`
// reassembles the current one: decrypt metadata, fetch chunks, decrypt,
// reassemble, verify against the metadata's plaintext hash.
Deno.test({
  name: "history - an older version's bytes reconstruct from the real chain",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, stop } = await pair();
    try {
      const path = "notes/history.md";
      A.fakeVault.write(path, "first revision\n");
      await A.flushPending();
      A.fakeVault.write(path, "second revision, much longer\n");
      await A.flushPending();
      A.fakeVault.write(path, "third\n");
      await A.flushPending();

      const pathHash = A.state!.getLocalFile(path)!.path_hash;
      const chain = await A.transport!.getVersionChain(pathHash);
      assertEquals(chain.map((r) => r.version), [3, 2, 1]);
      assertEquals(chain[0].compacted_range, null);

      const getBlob = (hash: string) => A.transport!.getBlob(hash);
      const oldest = chain[2];
      const { meta, bytes } = await reconstructVersion(oldest, A.keys!, getBlob);
      assertEquals(new TextDecoder().decode(bytes), "first revision\n");
      assertEquals(meta.path, path);
      assertEquals(meta.size, "first revision\n".length);
      assertEquals(meta.mime, "text/markdown");

      // ── a chunk missing on the server must surface as an error, never as
      // partial content the preview could render.
      const broken = { ...oldest, chunk_hashes: [...oldest.chunk_hashes, "f".repeat(64)] };
      await assertRejects(() => reconstructVersion(broken, A.keys!, getBlob), Error, "404");
    } finally {
      await stop();
    }
  },
});
