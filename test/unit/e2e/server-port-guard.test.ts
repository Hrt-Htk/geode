// startServer port-contention guard (#496). When the requested port is already
// taken (a leaked throwaway server from a killed run), the spawned child fails
// to bind, but the readiness probe used to hit the FOREIGN server's healthy
// response and silently attach to it, so `shutdown()` became a no-op and phone
// specs expecting an offline transition stayed "live". The fixture must fail
// fast with a clear error instead.

import { assertRejects } from "@std/assert";
import { startServer } from "../../../test/e2e/fixtures/server.ts";

Deno.test("startServer fails fast when the port is already taken", async () => {
  const first = await startServer();
  try {
    const port = Number(new URL(first.url).port);
    await assertRejects(
      () => startServer({ port }),
      Error,
      "already in use",
    );
  } finally {
    await first.stop();
  }
});
