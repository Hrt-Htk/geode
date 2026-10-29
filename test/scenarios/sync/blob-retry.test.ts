import { assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";
import { HeadRecord } from "../../../core/protocol.ts";
import { setTransportHttp, type TransportHttpRequest } from "../../../plugin/sync/http-client.ts";
import { rebuildFromScratch } from "../../../plugin/sync/recovery.ts";
import { openStateDB as openStateDBFromPlugin } from "../../../plugin/plumbing/state.ts";

/**
 * Test: transient blob-fetch failure does NOT drop a file.
 *
 * Uses setTransportHttp to inject failures that go through Transport.getBlob's
 * retry logic. Tests both transient (retry succeeds) and permanent (throws) cases.
 */
Deno.test({
  name: "blob-retry - transient failures are retried, permanent failures surface",
  sanitizeOps: false,
  sanitizeResources: false,
  timeout: 30_000,
  async fn() {
    const { A, stop } = await pair();
    try {
      // A creates 3 files
      A.fakeVault.write("file/a.md", "content alpha");
      A.fakeVault.write("file/b.md", "content beta");
      A.fakeVault.write("file/c.md", "content gamma");
      await A.flushPending();

      // Collect the chunk hashes we need to intercept
      const allHeads: HeadRecord[] = [];
      for await (const head of A.transport.getHeads(0)) {
        allHeads.push(head);
      }

      // Pick one file's first chunk hash to fail on
      const targetHead = allHeads.find((h) => !h.deleted && h.chunk_hashes.length > 0)!;
      const targetChunkHash = targetHead.chunk_hashes[0];

      // ── Part 1: transient failure on one blob → file still lands ──

      const failCounter = new Map<string, number>();
      failCounter.set(targetChunkHash, 2); // fail first 2 calls, succeed on 3rd

      const failingHttp = async (req: TransportHttpRequest) => {
        if (req.method === "GET" && req.url.includes(targetChunkHash)) {
          const count = failCounter.get(targetChunkHash) ?? 0;
          if (count > 0) {
            failCounter.set(targetChunkHash, count - 1);
            return {
              status: 503,
              ok: false,
              text: () => "Service Unavailable",
              arrayBuffer: () => new ArrayBuffer(0),
            };
          }
        }
        // Fall through to real HTTP
        const res = await fetch(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body,
        });
        return {
          status: res.status,
          ok: res.ok,
          text: () => res.text(),
          arrayBuffer: () => res.arrayBuffer(),
        };
      };

      setTransportHttp(failingHttp);

      const transportDeps = {
        vault: A.fakeVault as unknown as ConstructorParameters<
          typeof import("../../../plugin/sync/sync-manager.ts").SyncManager
        >[1]["vault"],
        transport: {
          getBlob: (hash: string) => A.transport.getBlob(hash),
          getHeads: async function* (afterSeq: number) {
            for await (const head of A.transport.getHeads(afterSeq)) {
              yield head;
            }
          },
        },
        state: openStateDBFromPlugin(A.settings.vaultId),
        keys: A.keys!,
        vaultId: A.settings.vaultId,
        isSyncable: () => true,
      };

      const result1 = await rebuildFromScratch(transportDeps);
      assertEquals(result1.appliedFiles, 3, "all 3 files should apply despite transient failure");
      assertEquals(
        A.fakeVault.files.get("file/a.md") !== undefined,
        true,
        "target file (with transient failure) should land",
      );
      transportDeps.state.close();

      // ── Part 2: permanent failure surfaces (throws) ──

      const permFailCounter = new Map<string, number>();
      permFailCounter.set(targetChunkHash, 10); // always fail (more than retry max)

      const permFailingHttp = async (req: TransportHttpRequest) => {
        if (req.method === "GET" && req.url.includes(targetChunkHash)) {
          const count = permFailCounter.get(targetChunkHash) ?? 0;
          if (count > 0) {
            permFailCounter.set(targetChunkHash, count - 1);
            return {
              status: 503,
              ok: false,
              text: () => "Service Unavailable",
              arrayBuffer: () => new ArrayBuffer(0),
            };
          }
        }
        const res = await fetch(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body,
        });
        return {
          status: res.status,
          ok: res.ok,
          text: () => res.text(),
          arrayBuffer: () => res.arrayBuffer(),
        };
      };

      setTransportHttp(permFailingHttp);

      const permDeps = {
        vault: A.fakeVault as unknown as ConstructorParameters<
          typeof import("../../../plugin/sync/sync-manager.ts").SyncManager
        >[1]["vault"],
        transport: {
          getBlob: (hash: string) => A.transport.getBlob(hash),
          getHeads: async function* (afterSeq: number) {
            for await (const head of A.transport.getHeads(afterSeq)) {
              yield head;
            }
          },
        },
        state: openStateDBFromPlugin(A.settings.vaultId),
        keys: A.keys!,
        vaultId: A.settings.vaultId,
        isSyncable: () => true,
      };

      let threw = false;
      try {
        await rebuildFromScratch(permDeps);
      } catch {
        threw = true;
      }
      assertEquals(threw, true, "permanent blob failure should throw, not be silently skipped");
      permDeps.state.close();
    } finally {
      await stop();
    }
  },
});
