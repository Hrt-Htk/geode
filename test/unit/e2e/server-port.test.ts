// Pure parse/decide logic for the fixed E2E server port (#519): a SIGKILLed
// runner orphans its spawned `deno run … server/main.ts --port 8099` child and
// the next run fails fast with EADDRINUSE. Global setup/teardown frees the port
// via ss output → listener pids, /proc/<pid>/cmdline → is it OURS? The kill
// orchestration itself is exercised by the repro script, not here.

import { assertEquals } from "@std/assert";
import { isGeodeE2EServer, parseListenerPids } from "../../e2e/server-port.ts";

const SS = `State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
LISTEN 0      511                        0.0.0.0:8090      0.0.0.0:*    users:(("deno",pid=111,fd=20))
LISTEN 0      511                      127.0.0.1:8099      0.0.0.0:*    users:(("deno",pid=222,fd=3))
LISTEN 0      4096                 127.0.0.53%lo:53        0.0.0.0:*
LISTEN 0      511                          [::]:8099         [::]:*    users:(("deno",pid=333,fd=7))
`;

Deno.test("parseListenerPids: pids listening on the port, other ports ignored", () => {
  assertEquals(parseListenerPids(SS, 8099), [222, 333]);
  assertEquals(parseListenerPids(SS, 8090), [111]);
  assertEquals(parseListenerPids(SS, 53), []);
});

Deno.test("parseListenerPids: no process info (no -p permission) → no pids", () => {
  assertEquals(parseListenerPids("LISTEN 0 511 0.0.0.0:8099 0.0.0.0:*\n", 8099), []);
});

Deno.test("parseListenerPids: no listeners → empty", () => {
  assertEquals(
    parseListenerPids("State Recv-Q Send-Q Local Address:Port Peer Address:Port\n", 8099),
    [],
  );
});

// The fixture's argv shape: the admin token rides the child's env, not a flag (#680 L-4).
const OURS = [
  "deno",
  "run",
  "--allow-all",
  "server/main.ts",
  "--data-dir",
  "/tmp/geode-e2e-server-abc123",
  "--port",
  "8099",
];

Deno.test("isGeodeE2EServer: fixture-spawned deno server", () => {
  assertEquals(isGeodeE2EServer(OURS, 8099), true);
});

Deno.test("isGeodeE2EServer: absolute entry path", () => {
  assertEquals(
    isGeodeE2EServer(
      OURS.map((a) => (a === "server/main.ts" ? "/srv/geode/server/main.ts" : a)),
      8099,
    ),
    true,
  );
});

Deno.test("isGeodeE2EServer: wrong port is not ours", () => {
  assertEquals(isGeodeE2EServer(OURS, 8090), false);
});

Deno.test("isGeodeE2EServer: non-e2e data dir is not ours", () => {
  assertEquals(
    isGeodeE2EServer(
      OURS.map((a) => (a.startsWith("/tmp/geode-e2e-server-") ? "/var/lib/geode" : a)),
      8099,
    ),
    false,
  );
});

Deno.test("isGeodeE2EServer: unrelated listeners are not ours", () => {
  assertEquals(isGeodeE2EServer(["python3", "-m", "http.server", "8099"], 8099), false);
  assertEquals(isGeodeE2EServer(["deno", "run", "server/main.ts", "--port", "8099"], 8099), false); // no data dir
  assertEquals(isGeodeE2EServer([], 8099), false);
});
