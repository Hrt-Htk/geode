// Runs `deno test` with a hard wall-clock timeout so a hung/leaked test can
// never wedge CI indefinitely (a `deno task ci` run once hung 103 min because a
// scenario test's WebSocket reconnect never settled: many scenario tests set
// `sanitizeOps:false`, so a leaked timer/socket keeps the event loop alive
// forever after "pass"). On timeout the child is SIGKILLed and we exit 124.
//
// Usage: `deno run -A scripts/test-timeout.ts [extra deno-test args...]`
// Override the cap with GEODE_TEST_TIMEOUT_MS (default 15 min).

const TIMEOUT_MS = Number(Deno.env.get("GEODE_TEST_TIMEOUT_MS") ?? 900_000);
const baseArgs = ["test", "--allow-all", "--no-check", "--ignore=test/fuzz"];

const child = new Deno.Command(Deno.execPath(), {
  args: [...baseArgs, ...Deno.args],
  stdout: "inherit",
  stderr: "inherit",
}).spawn();

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  console.error(`\n[test-timeout] test run exceeded ${TIMEOUT_MS}ms: killing.`);
  try {
    child.kill("SIGKILL");
  } catch { /* already exited */ }
}, TIMEOUT_MS);

const status = await child.status;
clearTimeout(timer);
Deno.exit(timedOut ? 124 : status.code);
