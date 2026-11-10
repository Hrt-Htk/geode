import { assertEquals, assertRejects } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { withTimeout } from "../../../plugin/plumbing/timeout.ts";

// #59: the sync pipeline runs inside one version queue, so an await that never settles
// (a dead mobile FS bridge, a socket that stops answering) must fail into the retry
// instead of holding every later apply.

Deno.test("timeout - work that never settles is rejected with what timed out", async () => {
  const time = new FakeTime();
  try {
    const pending = new Promise<void>(() => {});
    let error: Error | null = null;
    const run = withTimeout(pending, 500, "state write").catch((err) => {
      error = err as Error;
    });
    await Promise.resolve();
    time.tick(500);
    await run;
    assertEquals(error?.message, "state write timed out after 500ms");
  } finally {
    time.restore();
  }
});

Deno.test("timeout - work that lands in time resolves, and its own failure wins", async () => {
  const time = new FakeTime();
  try {
    assertEquals(await withTimeout(Promise.resolve(7), 500, "apply"), 7);
    await assertRejects(
      () => withTimeout(Promise.reject(new Error("blob 404")), 500, "apply"),
      Error,
      "blob 404",
    );
  } finally {
    // A timer left behind would make restore() report it.
    time.restore();
  }
});
