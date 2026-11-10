import { assertEquals, assertRejects } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { HttpClient, setTransportHttp } from "../../../plugin/sync/http-client.ts";

// #59: an apply fetches before it writes. A request that never answers must fail there, so
// the version is retried (its cursor stays behind) instead of holding the sync queue, and
// nothing half-downloaded ever reaches the disk. Each test installs its own platform HTTP.

Deno.test("http-client - a request that never answers is bounded", async () => {
  const time = new FakeTime();
  setTransportHttp(() => new Promise(() => {}));
  try {
    const http = new HttpClient("http://localhost:9999", "vault", "token");

    let error: Error | null = null;
    const chain = http.getVersionChain("hash-a").catch((err) => {
      error = err as Error;
    });
    await Promise.resolve();
    time.tick(60_000);
    await chain;
    assertEquals(error?.message, "versions GET timed out after 60000ms");

    // The head fetch a torn download waits on is bounded the same way.
    const head = http.headBlob("hash-a").catch((err) => {
      error = err as Error;
    });
    await Promise.resolve();
    time.tick(60_000);
    await head;
    assertEquals(error?.message, "blob HEAD hash-a timed out after 60000ms");
  } finally {
    time.restore();
  }
});

Deno.test("http-client - a request that answers keeps working", async () => {
  setTransportHttp(() =>
    Promise.resolve({
      status: 200,
      ok: true,
      text: () => Promise.resolve("[]"),
      arrayBuffer: () => new TextEncoder().encode("body").buffer,
    })
  );
  const http = new HttpClient("http://localhost:9999", "vault", "token");
  assertEquals(new TextDecoder().decode(await http.getBlob("hash-a")), "body");
  assertEquals(await http.getVersionChain("hash-a"), []);
  assertEquals(await http.headBlob("hash-a"), true);
});

Deno.test("http-client - a request that rejects fails the caller", async () => {
  setTransportHttp(() => Promise.reject(new Error("socket closed")));
  const http = new HttpClient("http://localhost:9999", "vault", "token");
  await assertRejects(() => http.getVersionChain("hash-a"), Error, "socket closed");
});
